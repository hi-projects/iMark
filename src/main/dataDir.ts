/**
 * 数据目录的**唯一权威** —— 数据根在哪、Chromium 的 profile 在哪、以及一次性搬迁。
 *
 * 目标布局(见 README「数据都在哪」):
 *
 *   <应用目录>/.imark/        应用自有数据(可备份、可整份拷走)
 *   ├── css/                  自定义样式
 *   ├── plugins/              插件包 + installed.json + .staging/ + <id>.old/
 *   ├── logs/plugins/         插件完整日志(操作结果 + 插件自己 log() 的行,按插件分文件)
 *   ├── settings.json
 *   ├── secrets.json          插件令牌 + 市场令牌(加密后)
 *   └── profile/              Chromium 的 userData 整体搬进来
 *       ├── Local State       safeStorage 的解密密钥在这里,必须跟着 profile 走
 *       ├── Cache/ Network/ Partitions/ …
 *
 * **应用目录**怎么定:
 *   - 安装版 = `app.getPath('exe')` 所在目录(用户把 iMark 装在 D:\imark,数据就在 D:\imark\.imark);
 *   - 开发版 = `app.getAppPath()`(仓库根,即 `<仓库>/.imark`,已加入 .gitignore);
 *   - 应用目录**不可写**时(Program Files、Linux AppImage 只读挂载、macOS 的 .app 包)
 *     回退到家目录 `~/.imark`,启动日志里写明实际用的哪个。
 *
 * 四条纪律,每条都对应一个真实的踩坑方式:
 *
 * 1. **永不抛**。路径问题不该拦住启动:建不出目录、搬不动、setPath 失败,一律
 *    降级成"这次仍用可用的那套布局",只留一行日志,下次启动再试。
 * 2. **降级是整套的**。数据根与 profile 必须一起进退 —— 只切一半会出现
 *    "新根生效但数据没搬完"(表现为设置、插件、令牌全没了)或
 *    "profile 换了地方但密钥留在原处"(表现为**已存的令牌解不开**)。
 * 3. **先搬 profile,再搬自有数据**。profile 完整性守卫不通过时,一个自有数据文件都不动。
 * 4. **能删源才删源**。同盘用 rename(瞬间完成);跨盘(EXDEV)才退化成拷贝 ——
 *    拷贝后校验文件数,对得上才删源。校验不上就保留源、本次降级,下次再来。
 *    这样既能把家目录那一份腾走(C 盘空间),又不会出现"两边都没了"。
 *
 * 还有一个**只用于测试与高级用法**的开关 `--imark-data-dir=<目录>`:把数据放到别的
 * 盘、开并行实例、以及验收里把搬迁跑在沙箱内。⚠️ 它单独使用时,搬迁来源是这个构建
 * 真实的 userData —— 所以**它必须配 `--user-data-dir` 一起用**(run.mjs 每次都传),
 * 否则就是在搬用户的真实数据。
 */

import { app } from 'electron'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 数据根开关。写法与 `--plugin-dev` 保持一致(带等号 / 空格分开都认) */
export const DATA_DIR_FLAG = '--imark-data-dir='

/**
 * 应用自有数据:搬迁时从旧位置挪到数据根的这几项。
 * **`css` 一定要在里面** —— 自定义样式目录也是数据根的一部分,漏了它用户的样式
 * 会在新根里"消失",然后被 ensureUserStylesDir 重新播种一份示例。
 */
const APP_ITEMS = ['plugins', 'settings.json', 'secrets.json', 'css', 'logs'] as const

/** Chromium profile 的痕迹。`Local State` 里有 safeStorage 的解密密钥,所以它是最要紧的那个 */
const PROFILE_MARKERS = ['Local State', 'Network'] as const

/**
 * 从命令行里挑出 `--imark-data-dir=<目录>`,两种写法都认。
 *
 * 认错了的表现是"参数没生效但也没报错",所以这里与 `plugins/dev.ts` 的
 * `devDirsFromArgv` 用同一套规则:后面跟的是另一个开关就不算值。
 */
export function dataDirFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(DATA_DIR_FLAG)) {
      const value = arg.slice(DATA_DIR_FLAG.length).trim()
      if (value) return resolve(value)
      continue
    }
    if (arg === '--imark-data-dir') {
      const value = (argv[i + 1] ?? '').trim()
      if (value && !value.startsWith('--')) return resolve(value)
    }
  }
  return null
}

export interface DataPaths {
  /** 应用自有数据的根 */
  dataRoot: string
  /** Chromium 的 profile(userData 与 sessionData 都指它) */
  profileDir: string
  /** 搬迁来源(有序:家目录数据根 → 旧 userData) */
  sources: string[]
  /** 整体降级时退回的根(家目录布局) */
  fallbackRoot: string
  /** 整体降级时退回的 profile(家目录布局是 <root>/profile;旧 userData 是它自己) */
  fallbackProfile: string
  /** 要不要搬迁。`dataRoot === legacyDir` 时不用(测试的覆盖模式) */
  migrate: boolean
  /** 这次走的是哪种布局(日志/验收用) */
  mode: 'app' | 'home' | 'override' | 'explicit'
  /** 不搬的理由(只用于日志;搬的时候为空) */
  skipReason?: string
}

export interface DataPathsInput {
  argv: readonly string[]
  home: string
  /** `app.getPath('userData')` 当前的值 */
  currentUserData: string
  /** 命令行里有没有 `--user-data-dir`(注意:要看开关,不是看值) */
  userDataOverridden: boolean
  /** 应用所在目录:打包版 = exe 所在目录;开发版 = 仓库根 */
  appDir: string
  /**
   * 应用目录能不能写。纯函数默认 true;`prepareDataDirs()` 会真的试着建目录,
   * 失败后用 false 重新解析,回退到家目录。
   */
  appDirWritable?: boolean
  /** 家目录旧数据根(默认 `<home>/.imark`),搬迁来源与降级目标 */
  homeDataRoot?: string
}

/** Windows 上大小写不敏感,路径比较统一走这里 */
function samePath(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

function isUnc(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//')
}

/**
 * **纯函数**:只算路径,不碰文件系统、不碰 Electron 的 setPath。
 *
 * 抽成纯函数是为了验收 —— 各种命令行/平台组合能用假输入直接断言,零风险。
 *
 * | 条件 | dataRoot | profileDir | 迁移来源 |
 * |---|---|---|---|
 * | `--imark-data-dir=D` | `D` | `D/profile`(给了 `--user-data-dir` 时例外) | 旧 userData |
 * | `--user-data-dir=U` | `U` | `U` | 不迁移(测试隔离) |
 * | 应用目录可写 | `<appDir>/.imark` | `<root>/profile` | 家目录 `.imark` → 旧 userData |
 * | 应用目录不可写(darwin/UNC/探测失败) | `~/.imark` | `<root>/profile` | 旧 userData |
 */
export function resolveDataPaths(input: DataPathsInput): DataPaths {
  const legacyDir = resolve(input.currentUserData)
  const homeDataRoot = resolve(input.homeDataRoot ?? join(resolve(input.home), '.imark'))
  const explicit = dataDirFromArgv(input.argv)

  if (explicit) {
    const dataRoot = resolve(explicit)
    const profileDir = input.userDataOverridden ? legacyDir : join(dataRoot, 'profile')
    return {
      dataRoot,
      profileDir,
      sources: [legacyDir],
      // 显式指定时,降级退回旧 userData(与改造前的语义一致)
      fallbackRoot: legacyDir,
      fallbackProfile: legacyDir,
      migrate: !samePath(dataRoot, legacyDir),
      mode: 'explicit'
    }
  }

  // `--user-data-dir`:今天的行为原样保留(测试全靠它隔离),数据根就是它,不搬
  if (input.userDataOverridden) {
    return {
      dataRoot: legacyDir,
      profileDir: legacyDir,
      sources: [],
      fallbackRoot: legacyDir,
      fallbackProfile: legacyDir,
      migrate: false,
      mode: 'override'
    }
  }

  const appDir = resolve(input.appDir)
  const canUseApp =
    input.appDirWritable !== false &&
    process.platform !== 'darwin' && // 写进 .app 包会破坏签名
    !isUnc(appDir) // 网络盘上的 Chromium profile 是明确降级

  if (canUseApp) {
    const dataRoot = join(appDir, '.imark')
    const profileDir = join(dataRoot, 'profile')
    const sources = [homeDataRoot, legacyDir].filter(
      (s, i, all) =>
        !samePath(s, dataRoot) &&
        !samePath(s, profileDir) &&
        all.findIndex(x => samePath(x, s)) === i
    )
    return {
      dataRoot,
      profileDir,
      sources,
      fallbackRoot: homeDataRoot,
      fallbackProfile: join(homeDataRoot, 'profile'),
      migrate: true,
      mode: 'app'
    }
  }

  // 回退:家目录数据根(改造前的布局)。来源是更早的 userData。
  return {
    dataRoot: homeDataRoot,
    profileDir: join(homeDataRoot, 'profile'),
    sources: [legacyDir].filter(s => !samePath(s, homeDataRoot) && !samePath(s, join(homeDataRoot, 'profile'))),
    fallbackRoot: homeDataRoot,
    fallbackProfile: join(homeDataRoot, 'profile'),
    migrate: !samePath(legacyDir, homeDataRoot),
    mode: 'home',
    skipReason:
      process.platform === 'darwin'
        ? 'macOS 的应用包不可写,数据放在家目录'
        : input.appDirWritable === false
          ? '应用目录不可写,回退到家目录'
          : isUnc(appDir)
            ? '应用目录在网络盘上,数据放在家目录'
            : undefined
  }
}

// ---------- 给全应用用的两个取值口 ----------

let cached: DataPaths | null = null

/** 应用所在目录:安装版 = exe 所在目录;开发版 = 仓库根 */
function appDirOf(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()
}

function baseInput(): DataPathsInput {
  const home = app.getPath('home')
  return {
    argv: process.argv,
    home,
    currentUserData: app.getPath('userData'),
    userDataOverridden: app.commandLine.hasSwitch('user-data-dir'),
    appDir: appDirOf(),
    homeDataRoot: join(resolve(home), '.imark')
  }
}

/**
 * 现算。**不写缓存** —— `prepareDataDirs()` 之前就有人调(验收里直接调
 * `userStylesDir()` 之类)也必须算对;而 harness 会在 ready 之前改 home,
 * 把值提前固化下来就会拿到错的。
 */
function current(): DataPaths {
  if (cached) return cached
  return resolveDataPaths(baseInput())
}

/** 应用自有数据的根。plugins/、settings.json、secrets.json、css/ 都挂在它下面 */
export function dataRoot(): string {
  return current().dataRoot
}

/** Chromium 的 profile 目录(userData 与 sessionData 都指它) */
export function profileDir(): string {
  return current().profileDir
}

/** 一行日志用的描述(dev 启动时打印,出问题时一眼能看出它在用哪个目录) */
export function describeDataPaths(): string {
  const p = current()
  const where =
    p.mode === 'app'
      ? '应用目录'
      : p.mode === 'override'
        ? '测试隔离目录'
        : p.mode === 'explicit'
          ? '命令行指定的数据目录'
          : '家目录(应用目录不可写)'
  const same = samePath(p.dataRoot, p.profileDir)
  return same
    ? `${where}:${p.dataRoot}(profile 与数据同处)`
    : `${where}:${p.dataRoot},profile ${p.profileDir}`
}

// ---------- 搬迁 ----------

function isEmptyDir(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path).length === 0
  } catch {
    return false
  }
}

function hasProfileMarker(dir: string): boolean {
  return PROFILE_MARKERS.some(m => existsSync(join(dir, m)))
}

/** 数一数目录里有多少个文件(跨盘拷贝后用它校验完整性) */
function countFiles(dir: string): number {
  let n = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) n += countFiles(full)
      else if (entry.isFile()) n += 1
    }
  } catch {
    /* 读不动的目录按 0 算;校验不上会保留源 */
  }
  return n
}

/**
 * 把 src 移到 dst。同盘 rename;跨盘(EXDEV)拷贝 + 校验文件数,对得上才删源。
 * 失败只记 warning,不抛 —— 由调用方决定是否降级。
 */
function movePath(src: string, dst: string, label: string, report: MigrationReport): boolean {
  try {
    if (existsSync(dst)) {
      report.skipped.push(`${label}(目标已有)`)
      return false
    }
    try {
      renameSync(src, dst)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      // 跨盘:C 盘 → 程序所在盘。**先拷到临时目录,校验完整后再原子改名** ——
      // 直接往最终路径拷,中途失败会留下"半份 profile",下次启动会把它当成
      // 已经就位(尤其 Local State 恰好拷完了),然后带着损坏的数据库切过去。
      const staging = `${dst}.imark-partial`
      rmSync(staging, { recursive: true, force: true })
      const before = countFiles(src)
      cpSync(src, staging, { recursive: true, force: true })
      const after = countFiles(staging)
      if (after < before) {
        rmSync(staging, { recursive: true, force: true })
        report.warnings.push(
          `${label} 跨盘拷贝不完整(${after}/${before} 个文件),已保留源,下次启动再试`
        )
        return false
      }
      renameSync(staging, dst)
      try {
        rmSync(src, { recursive: true, force: true })
      } catch (err) {
        // 已经拷到新位置了,只是旧文件被占用删不掉 —— 报 warning 但仍算搬成功
        report.warnings.push(
          `${label} 已拷贝到新位置,但旧目录删不掉(可能被占用):${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return true
  } catch (err) {
    try {
      rmSync(`${dst}.imark-partial`, { recursive: true, force: true })
    } catch {
      /* 清不掉临时目录也不致命 */
    }
    report.warnings.push(
      `${label} 没能搬到 ${dst}:${err instanceof Error ? err.message : String(err)}(下次启动再试)`
    )
    return false
  }
}

export interface MigrationReport {
  /** profile(含缓存、登录态、分区数据、解密密钥)是否整体搬过来了 */
  profileMoved: boolean
  /** 成功搬走的项 */
  moved: string[]
  /** 没动的(目标已存在 / 源不存在) */
  skipped: string[]
  /** 单项失败的原因,只记日志用 */
  warnings: string[]
}

/**
 * 真的搬东西。**同步、逐项、幂等**。
 *
 * 两种来源布局都要认:
 *   - **数据根型**(家目录 `~/.imark`):自有数据在根上,profile 在 `<root>/profile`;
 *   - **旧 userData 型**(%APPDATA%/iMark / imarkdown):profile 就在根上。
 *
 * 顺序:先搬 profile(它就是密钥所在),再用完整性守卫确认;通过后才搬自有数据。
 * 目标已存在就跳过 —— 磁盘上有什么就是什么,搬了一半的进程下次启动接着搬。
 *
 * 导出是为了验收能拿临时目录直接跑,不必真的启动应用。
 */
export function migrateDataLayout(
  sources: readonly string[],
  dataRootDir: string,
  profileDirPath: string
): MigrationReport {
  const report: MigrationReport = { profileMoved: false, moved: [], skipped: [], warnings: [] }

  const roots = [...new Set(sources.map(s => resolve(s)))].filter(
    s => !samePath(s, dataRootDir) && !samePath(s, profileDirPath) && existsSync(s)
  )
  const homeStyle = (root: string): boolean => hasProfileMarker(join(root, 'profile'))
  const legacyStyle = (root: string): boolean => hasProfileMarker(root)
  const sourcesWithProfile = roots.filter(r => homeStyle(r) || legacyStyle(r))

  // 目标里已经有一个"看起来不像 profile"的目录(旧的半份拷贝 / 占位目录):
  // 它会让下面的 movePath 直接跳过,而完整性守卫又不允许切过去 —— 于是永远卡住。
  // 把它改名保留(不删),再重试搬迁。
  if (
    !hasProfileMarker(profileDirPath) &&
    sourcesWithProfile.length > 0 &&
    existsSync(profileDirPath)
  ) {
    try {
      const stale = `${profileDirPath}.stale-${Date.now()}`
      renameSync(profileDirPath, stale)
      report.warnings.push(`目标 profile 不完整,已改名为 ${stale} 保留,本次重新搬迁`)
    } catch (err) {
      report.warnings.push(
        `目标 profile 不完整且改不掉名:${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ① profile:只搬第一份;后面的来源把它当历史副本,不合并
  if (!hasProfileMarker(profileDirPath)) {
    for (const root of roots) {
      if (homeStyle(root)) {
        if (movePath(join(root, 'profile'), profileDirPath, 'profile', report)) {
          report.profileMoved = true
          break
        }
      } else if (legacyStyle(root)) {
        // 旧 userData:整个目录就是 profile;搬完后自有数据会从 profileDir 里上移
        if (movePath(root, profileDirPath, 'profile', report)) {
          report.profileMoved = true
          break
        }
      }
    }
  } else {
    report.skipped.push('profile(目标已是一份 profile)')
  }

  // ② 完整性守卫:**密钥在哪里,profile 就必须在哪里**。
  //    目标里没有 profile 痕迹、而来源里有一份 —— 这时绝不能切过去,也绝不能
  //    先把自有数据搬走(否则应用仍读旧目录,插件/令牌看起来就"消失"了)。
  const usableProfile =
    hasProfileMarker(profileDirPath) || sourcesWithProfile.length === 0
  if (!usableProfile) {
    report.warnings.push('来源里有一份 profile 而新目录里没有,这次一个文件都不动(下次启动再试)')
    return report
  }

  // ③ 自有数据:先看各来源根,再看(旧 userData 搬过来的)profileDir
  const itemRoots = [...roots, profileDirPath]
  for (const name of APP_ITEMS) {
    const dst = join(dataRootDir, name)
    if (existsSync(dst)) {
      report.skipped.push(`${name}(目标已有)`)
      continue
    }
    const src = itemRoots.map(r => join(r, name)).find(p => existsSync(p))
    if (!src) {
      report.skipped.push(`${name}(来源没有)`)
      continue
    }
    if (movePath(src, dst, name, report)) report.moved.push(name)
  }

  // ④ 搬空的源目录顺手删掉(只删空目录,释放家目录/系统盘) —— 有残留就留着,
  //    用户能自己看见;绝不递归删非空目录。
  for (const root of roots) {
    try {
      if (existsSync(root) && isEmptyDir(root)) rmdirSync(root)
    } catch {
      /* 删不掉就算了 */
    }
  }

  return report
}

/** 整套路径回落 —— 只切一半比不切更糟(见文件头纪律 2) */
function degrade(paths: DataPaths, why: string, detail?: unknown): void {
  console.warn(
    `[iMark] 数据目录这次没能切到 ${paths.dataRoot}(${why}),本次改用 ${paths.fallbackRoot};下次启动会再试`,
    detail ?? ''
  )
  cached = {
    dataRoot: paths.fallbackRoot,
    profileDir: paths.fallbackProfile,
    sources: [],
    fallbackRoot: paths.fallbackRoot,
    fallbackProfile: paths.fallbackProfile,
    migrate: false,
    mode: 'home'
  }
}

/** 来源里有没有任何一份 profile(用于完整性守卫) */
function anySourceHasProfile(sources: readonly string[]): boolean {
  return sources.some(s => hasProfileMarker(s) || hasProfileMarker(join(s, 'profile')))
}

/**
 * 启动早期调一次(**同步**,必须在 `app.whenReady()` 与 `requestSingleInstanceLock()`
 * 之前 —— 见 index.ts 里的说明)。永不抛:出了任何问题就退回可用的旧布局。
 */
export function prepareDataDirs(): void {
  let paths = resolveDataPaths(baseInput())

  // 应用目录可写性:真的试建一次。失败就用 home 布局重新解析。
  if (paths.mode === 'app') {
    try {
      mkdirSync(paths.dataRoot, { recursive: true })
    } catch (err) {
      console.warn(
        `[iMark] 应用目录不可写(${err instanceof Error ? err.message : String(err)}),数据改放家目录`
      )
      paths = resolveDataPaths({ ...baseInput(), appDirWritable: false })
    }
  }

  if (!paths.migrate) {
    cached = paths
    return
  }

  try {
    mkdirSync(paths.dataRoot, { recursive: true })
  } catch (err) {
    degrade(paths, `数据根建不出来 ${paths.dataRoot}`, err)
    return
  }

  const report = migrateDataLayout(paths.sources, paths.dataRoot, paths.profileDir)
  if (report.moved.length > 0 || report.profileMoved) {
    console.log(
      `[iMark] 数据目录已迁到 ${paths.dataRoot}` +
        (report.profileMoved ? '(profile 一并搬走)' : '') +
        (report.moved.length > 0 ? `(上移:${report.moved.join(', ')})` : '')
    )
  }
  for (const w of report.warnings) console.warn(`[iMark] 搬迁提示:${w}`)

  // 完整性守卫的二道确认(搬迁函数内部已经拦过一次;这里兜住"调用方传了怪来源"的情况)
  if (!hasProfileMarker(paths.profileDir) && anySourceHasProfile(paths.sources)) {
    degrade(paths, 'profile 没能整体搬过来(密钥还在原处,现在切过去会让已存的令牌解不开)')
    return
  }

  try {
    // setPath 对不存在的目录会直接抛(全新安装时 profile 还没建出来),先建
    mkdirSync(paths.profileDir, { recursive: true })
    // crashpad 的数据库显式放在 profile 下,避免它去写一个不存在/不可写的默认目录
    const crashDumps = join(paths.profileDir, 'Crashpad')
    mkdirSync(crashDumps, { recursive: true })
    app.setPath('crashDumps', crashDumps)
    // userData 与 sessionData **都要设**:Electron 文档写得很清楚,cookie 与缓存看的是
    // sessionData(默认等于 userData,但覆盖 userData 不会带动它)。只设前者的话,
    // 缓存、登录态、沙箱插件的 Partitions/ 会全留在旧目录 —— 看起来"搬了",其实一半没搬。
    app.setPath('userData', paths.profileDir)
    app.setPath('sessionData', paths.profileDir)
  } catch (err) {
    degrade(paths, 'profile 目录建不出来或 setPath 失败', err)
    return
  }

  cached = paths
}

/** 仅验收使用:把缓存清掉,让下一次调用重新解析 */
export function resetDataPathsCache(): void {
  cached = null
}
