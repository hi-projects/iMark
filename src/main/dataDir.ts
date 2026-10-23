/**
 * 数据目录的**唯一权威** —— 数据根在哪、Chromium 的 profile 在哪。
 *
 * 目标布局(见 README「数据都在哪」):
 *
 *   <应用目录>/.imark/        应用自有数据(可备份、可整份拷走)
 *   ├── css/                  自定义样式
 *   ├── plugins/              扩展包 + installed.json + .staging/ + <id>.old/
 *   ├── logs/extensions/      扩展完整日志(操作结果 + 扩展自己 log() 的行,按扩展分文件)
 *   ├── settings.json
 *   ├── secrets.json          扩展令牌 + 市场令牌(加密后)
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
 * 两条纪律,每条都对应一个真实的踩坑方式:
 *
 * 1. **永不抛**。路径问题不该拦住启动:建不出目录、setPath 失败,一律降级成
 *    "这次仍用可用的那套布局",只留一行日志,下次启动再试。
 * 2. **降级是整套的**。数据根与 profile 必须一起进退 —— 只切一半会出现
 *    "profile 换了地方但密钥留在原处"(表现为**已存的令牌解不开**)。
 *
 * 还有一个**只用于测试与高级用法**的开关 `--imark-data-dir=<目录>`:把数据放到别的
 * 盘、开并行实例、以及验收里把数据根指到沙箱内。单独使用时 profile 在
 * `<目录>/profile`;与 `--user-data-dir` 一起用时,数据根是它、profile 是后者。
 */

import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 数据根开关。带等号 / 空格分开两种写法都认 */
export const DATA_DIR_FLAG = '--imark-data-dir='

/**
 * 从命令行里挑出 `--imark-data-dir=<目录>`,两种写法都认。
 *
 * 认错了的表现是"参数没生效但也没报错",所以这里只按开关后面的值解析:
 * 后面跟的是另一个开关就不算值。
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
  /** 整体降级时退回的根 */
  fallbackRoot: string
  /** 整体降级时退回的 profile */
  fallbackProfile: string
  /** 这次走的是哪种布局(日志/验收用) */
  mode: 'app' | 'home' | 'override' | 'explicit'
  /** 不用应用目录的理由(只用于日志) */
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
  /** 家目录数据根(默认 `<home>/.imark`),降级目标 */
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
 * | 条件 | dataRoot | profileDir |
 * |---|---|---|
 * | `--imark-data-dir=D` | `D` | `D/profile`(给了 `--user-data-dir` 时是 `U`) |
 * | `--user-data-dir=U` | `U` | `U` |
 * | 应用目录可写 | `<appDir>/.imark` | `<root>/profile` |
 * | 应用目录不可写(darwin/UNC/探测失败) | `~/.imark` | `<root>/profile` |
 */
export function resolveDataPaths(input: DataPathsInput): DataPaths {
  const currentUserData = resolve(input.currentUserData)
  const homeDataRoot = resolve(input.homeDataRoot ?? join(resolve(input.home), '.imark'))
  const explicit = dataDirFromArgv(input.argv)

  if (explicit) {
    const dataRoot = resolve(explicit)
    const fallbackRoot = input.userDataOverridden ? currentUserData : homeDataRoot
    return {
      dataRoot,
      // 同时给了 --user-data-dir 时 profile 用后者(验收隔离靠这个)
      profileDir: input.userDataOverridden ? currentUserData : join(dataRoot, 'profile'),
      fallbackRoot,
      fallbackProfile: input.userDataOverridden ? currentUserData : join(homeDataRoot, 'profile'),
      mode: 'explicit'
    }
  }

  // `--user-data-dir`:数据根就是它(测试全靠它隔离)
  if (input.userDataOverridden) {
    return {
      dataRoot: currentUserData,
      profileDir: currentUserData,
      fallbackRoot: currentUserData,
      fallbackProfile: currentUserData,
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
    return {
      dataRoot,
      profileDir: join(dataRoot, 'profile'),
      fallbackRoot: homeDataRoot,
      fallbackProfile: join(homeDataRoot, 'profile'),
      mode: 'app'
    }
  }

  return {
    dataRoot: homeDataRoot,
    profileDir: join(homeDataRoot, 'profile'),
    fallbackRoot: homeDataRoot,
    fallbackProfile: join(homeDataRoot, 'profile'),
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
  // 两个路径之间用中文标点并写全「profile 目录」,否则
  // `…/.imark,profile …/.imark/profile` 看起来像一个被逗号拼起来的路径
  return same
    ? `${where}：${p.dataRoot}（profile 与数据同处）`
    : `${where}：${p.dataRoot}；profile 目录：${p.profileDir}`
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
    fallbackRoot: paths.fallbackRoot,
    fallbackProfile: paths.fallbackProfile,
    mode: 'home'
  }
}

/**
 * 启动早期调一次(**同步**,必须在 `app.whenReady()` 与 `requestSingleInstanceLock()`
 * 之前 —— 见 index.ts 里的说明)。永不抛:出了任何问题就退回可用的布局。
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

  try {
    mkdirSync(paths.dataRoot, { recursive: true })
  } catch (err) {
    degrade(paths, `数据根建不出来 ${paths.dataRoot}`, err)
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
    // 缓存、登录态、沙箱扩展的 Partitions/ 会全留在原目录 —— 看起来"设了",其实一半没设。
    app.setPath('userData', paths.profileDir)
    app.setPath('sessionData', paths.profileDir)
  } catch (err) {
    degrade(paths, 'profile 目录建不出来或 setPath 失败', err)
    return
  }

  cached = paths
}
