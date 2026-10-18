/**
 * 用户自定义样式:家目录 `~/.imark/css/` 下的 .css 文件与样式目录。
 *
 * 与插件系统是同一条思路 —— **磁盘是权威**:目录里有什么就生效什么。应用不保存
 * 任何「已启用的样式」清单,也不在设置里另开一个编辑器。于是备份 = 拷目录,
 * 恢复 = 拷回来,用任意编辑器改完保存即生效。
 *
 * 顶层每一项都是候选项:`.css` 文件(单独生效),或子目录(**递归**收里面所有
 * `.css`,一起生效)。至多选中一项,靠名字标识 —— 同一个父目录下文件与目录不可能
 * 同名,所以名字本身就够,不必在设置里另存「是文件还是目录」。
 *
 * 三条纪律:
 *
 * 1. **读清单永不抛**。一个读不动的文件只影响它自己(在界面上标红),不能让整个
 *    样式功能消失 —— 那会让用户以为是自己写错了什么。目录里读不动的那几个文件
 *    同理:跳过并在行上说明,其余照常生效。
 * 2. **路径不回家**。目录只在本模块里拼,渲染层拿到的永远是我们算好的绝对路径;
 *    它传回来的只有名字(文件全名或目录名),还要过一遍 basename 校验。
 * 3. **看门狗会自检**。Windows 上删掉正在监听的目录是个**静默**事件:`fs.watch`
 *    既不派发事件也不派发 'error',watcher 就此死掉。所以除了事件驱动,还有一个
 *    每 4 秒一次的存在性检查兜底(见 LIVENESS_INTERVAL),外加出错时的有上限重挂。
 *
 * 示例文件的正文在 userStyles.example.css / userStyles.point.css 里,以 `?raw` 导入
 * (理由同 market/bundled.ts:内联进主进程 bundle,绕开 asar 与 `files` 打包限制,
 * 不必区分 dev/prod 路径)。
 */

import { shell } from 'electron'
import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { UserStyleImportOutcome, UserStyleItem, UserStyleState } from '@shared/userStyles'
import { showConfirmDelete } from './dialogs'
import { getMainWindow } from './window'
import { dataRoot } from './dataDir'
import SAMPLE_CSS from './userStyles.example.css?raw'
import POINT_CSS from './userStyles.point.css?raw'

/** 单个样式文件的体积上限:手写 CSS 到这个数已是十倍余量,再大就不是样式了 */
const MAX_CSS_BYTES = 512 * 1024

/**
 * 首次创建目录时播种的示例(用户删掉后不会再被塞回来)。
 *
 * example.css 是完整模板 —— 帮助面板里列出的每一类节点都有一条注释掉的规则,
 * 去掉注释即可生效;point.css 是一份**不需要修改就能用**的最小示例(列表圆点改黑色),
 * 让用户第一次点选时不必先学会怎么写 CSS。
 */
const SAMPLE_FILES: ReadonlyArray<{ name: string; css: string }> = [
  { name: 'example.css', css: SAMPLE_CSS },
  { name: 'point.css', css: POINT_CSS }
]

/** 防抖窗口:把「写临时文件 + rename」那一簇事件收敛成一次,短到用户感觉不到延迟 */
const WATCH_DEBOUNCE = 250

/** 看门狗重挂的间隔与次数上限(见文件头第 3 条) */
const REARM_DELAY = 2000
const MAX_REARM = 10

/**
 * 存在性自检的间隔。
 *
 * 不得不有这个定时器,原因在 Windows 的实测行为:**删掉正在监听的目录时,
 * `fs.watch` 既不派发任何事件、也不派发 'error'** —— watcher 就此静默死掉。
 * 而「把 ~/.imark/css 整个删掉」是用户再正常不过的动作,只靠事件驱动的话,
 * 页面会一直挂着已经不存在的样式,界面也停在旧的清单上。
 *
 * 代价是每 4 秒一次 `stat`:只查存在性、不读内容,拿的是元数据缓存,
 * 与「轮询文件内容」不是一回事。
 */
const LIVENESS_INTERVAL = 4000

/**
 * 样式目录:数据根下的 `css/`,正常运行时就是 `~/.imark/css`。
 *
 * 挂数据根而不是各自拼家目录,好处有三条:路径只有一个出处(见 main/dataDir.ts);
 * 与插件、设置、密钥在同一个可备份的目录里;验收里跟着 `--user-data-dir` 一起被隔离
 * (以前它不隔离,harness 只能去改 `app.getPath('home')` 来躲开用户的真实目录)。
 */
export function userStylesDir(): string {
  return join(dataRoot(), 'css')
}

/**
 * 确保目录存在,并且**只在目录本来不存在**时播种示例文件。
 *
 * 播种条件刻意是「目录不存在」而不是「文件不存在」:用户删掉 example.css 之后
 * 不该被下次启动又塞回来(目录还在,说明他已经接管了这个目录);而删掉整个目录
 * 时重建 + 恢复示例,才符合「恢复原状」的直觉。写入再加 `flag: 'wx'` 双保险,
 * 结构上不可能覆盖已有文件。
 */
export async function ensureUserStylesDir(): Promise<void> {
  const dir = userStylesDir()
  let existed = true
  try {
    await stat(dir)
  } catch {
    existed = false
  }
  await mkdir(dir, { recursive: true }).catch(() => {})
  if (existed) return
  for (const sample of SAMPLE_FILES) {
    try {
      await writeFile(join(dir, sample.name), sample.css, { encoding: 'utf8', flag: 'wx' })
    } catch {
      /* 写不进去(权限之类)不该拦住启动,用户自己建文件也一样能用 */
    }
  }
}

/**
 * 读整份清单。**永不抛** —— 目录读不到时返回一个空清单,界面照常渲染。
 *
 * 每次全量重读,不做缓存/增量:最多几个小文件,重读的成本远低于维护一套
 * 失效逻辑的成本。
 */
export async function readUserStyles(): Promise<UserStyleState> {
  const dir = userStylesDir()
  // 显式标注 Dirent<string>:不带标注时 TS 会挑 readdir 的最后一个重载(Buffer),
  // 于是 entry.name 变成 NonSharedBuffer,后面每个字符串操作都报错
  let entries: Dirent<string>[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { dir, items: [] }
  }

  const items: UserStyleItem[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isFile()) {
      if (!entry.name.toLowerCase().endsWith('.css')) continue
      items.push(await readOne(dir, entry.name))
    } else if (entry.isDirectory()) {
      // 目录里的 .css 不看扩展名之外的条件:目录名本身不需要是 .css
      items.push(await readDirItem(dir, entry.name))
    }
  }

  // 名字码位升序 —— 只管显示顺序(生效的只有选中那一项)。目录里的拼接顺序也走
  // 同一个比较(见 collectCss),两处的理由一样,所以只有这一份实现
  items.sort((a, b) => byCodePoint(a.name, b.name))
  return { dir, items }
}

/**
 * 码位升序比较。
 *
 * 不用 localeCompare:不同机器的 ICU 版本可能给出不同结果,而这里的顺序要么是
 * 显示顺序、要么是**层叠顺序**,后者必须每台机器都一样。也不用数字感知排序
 * (1.css 与 01.css 会被判相等,顺序就变得不稳定,而「稳定」正是它唯一的价值)。
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 读一个样式目录:递归收它下面所有层级的 .css,拼成一份文本。
 *
 * **目录是「一套样式」的单位**:分类、成套换外观、从别处整包拿过来,都是这个形状。
 * 递归而不只收一层,是因为目录一旦能当分类用,分类下面再分类就很自然(标题一套、
 * 表格一套),而「哪一层算数」这种规则用户记不住。
 *
 * 拼接顺序是**相对路径升序**,同一台机器上永远同一个结果 —— 目录内没有「只有一个
 * 生效」那条兜底,顺序必须由规则定死,不能靠 readdir 给的顺序(它不保证)。
 *
 * 单个文件读不动(过大、权限、编码炸了)只跳过它自己,其余照常生效:与「一个坏文件
 * 只影响它自己」一致。但跳过的名字要如实带回界面 —— 少了三条规则却一声不吭,
 * 用户会以为是自己写错了选择器。
 */
async function readDirItem(root: string, name: string): Promise<UserStyleItem> {
  const paths = await collectCss(join(root, name))
  const skipped: string[] = []
  const parts: string[] = []
  let fileCount = 0

  for (const rel of paths) {
    fileCount += 1
    const full = join(root, name, rel)
    try {
      const size = (await stat(full)).size
      if (size > MAX_CSS_BYTES) {
        skipped.push(`${rel}(超过 ${MAX_CSS_BYTES / 1024} KiB)`)
        continue
      }
      const css = normalizeCss(await readFile(full, 'utf8'))
      // 每份前面留一行出处:注入进去的是一整份文本,出了事只有这行注释能说清
      // 「这条规则是从哪个文件来的」
      parts.push(`/* === ${rel} === */\n${css.trim()}`)
    } catch {
      skipped.push(rel)
    }
  }

  if (fileCount === 0) {
    return { name, kind: 'dir', css: null, fileCount: 0, error: '目录里没有 .css', skipped: [] }
  }
  if (parts.length === 0) {
    return { name, kind: 'dir', css: null, fileCount, error: '目录里没有能用的 .css', skipped }
  }
  return { name, kind: 'dir', css: parts.join('\n\n'), fileCount, error: null, skipped }
}

/** 递归列出目录下所有 .css 的相对路径(正斜杠),升序。跳过点文件与点目录 */
async function collectCss(root: string, prefix = ''): Promise<string[]> {
  let entries: Dirent<string>[] = []
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      found.push(...(await collectCss(root, rel)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.css')) {
      found.push(rel)
    }
  }
  return found.sort(byCodePoint)
}

/**
 * 剥掉 BOM。
 *
 * 记事本存的 UTF-8 带它,留着会让第一个选择器解析失败并被静默丢弃 —— 用户只会
 * 看到「有一条规则死活不生效」。导入时的内容比对也走这一套,于是「带 BOM 的版本」
 * 与「不带 BOM 的版本」会被认成同一份样式。
 */
function normalizeCss(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/** 读一个样式文件。读不到也是一种结果,由界面展示,不往外抛 */
async function readOne(dir: string, name: string): Promise<UserStyleItem> {
  try {
    // 先看大小再读:一个几百 MB 的文件不该被整个读进内存(同 market/ipc.ts 的规则)
    if ((await stat(join(dir, name))).size > MAX_CSS_BYTES) {
      return { name, kind: 'file', css: null, fileCount: 0, error: `文件过大(上限 ${MAX_CSS_BYTES / 1024} KiB)`, skipped: [] }
    }
    const css = normalizeCss(await readFile(join(dir, name), 'utf8'))
    return { name, kind: 'file', css, fileCount: 0, error: null, skipped: [] }
  } catch (err) {
    return { name, kind: 'file', css: null, fileCount: 0, error: `读取失败:${messageOf(err)}`, skipped: [] }
  }
}

/**
 * 把一个外部 .css 复制进样式目录。
 *
 * **复制而不是引用**:目录即事实来源,原文件被搬走或改名不该影响已经生效的样式。
 *
 * **内容相同的直接不导**,并把「和哪几份相同」如实报出来。同一个文件点两次「导入」
 * 是最容易发生的事,而重复的样式除了让清单变长之外什么都不带来 —— 它连效果都不会变。
 * 比的是归一化后的文本(见 normalizeCss),所以换个文件名、带不带 BOM 都认得出来。
 *
 * 内容不同才谈重名:那时改叫 foo-2.css —— 不用 `foo (2).css`,路径里不带空格与
 * 括号,在日志和命令行里都更好认。不覆盖同名文件是刻意的:目录里的那一份可能已经
 * 被用户改过了,静默盖掉是最不该做的事。
 */
export async function importUserStyle(srcPath: string): Promise<UserStyleImportOutcome> {
  return importFiles([srcPath])
}

/**
 * 把一个文件夹**整个**导入,作为样式目录(可勾选的一项)。
 *
 * 与单个文件那条路径的区别:这里保留目录结构。目录本身是「一套样式」的单位,
 * 摊平会把分类信息丢掉,而且摊平后那些同名的 a.css 还得现起名。
 *
 * 只带 `.css`,跳过点文件与点目录:一个 `.git` 或 `node_modules` 跟着进来会成为
 * 永久噪音,而用户要的是样式,不是那份目录的完整拷贝。
 *
 * 内容与已有目录完全一致时不导(与单个文件同一条规矩):同一个文件夹点两次太常见了。
 * 重名但内容不同则改叫 `my-theme-2` —— 绝不覆盖,目录里那一份可能已经被改过。
 */
export async function importUserStyleDir(srcDir: string): Promise<UserStyleImportOutcome> {
  const outcome: UserStyleImportOutcome = { imported: [], duplicates: [], failed: [] }
  const name = basename(srcDir)
  if (!name) {
    outcome.failed.push({ name: srcDir, error: '这不是一个文件夹' })
    return outcome
  }

  const tree = await collectCss(srcDir)
  if (tree.length === 0) {
    outcome.failed.push({ name, error: '这个文件夹里没有 .css' })
    return outcome
  }

  const dir = userStylesDir()
  try {
    await mkdir(dir, { recursive: true })
    const signature = await treeSignature(srcDir, tree)
    if (signature === null) {
      outcome.failed.push({ name, error: '有文件读不动,没有导入' })
      return outcome
    }

    // 内容一模一样的目录不导。同名与否都算重复:同一个文件夹点两次是最常见的,
    // 换个名字再导一次同样不该凭空多出一份
    for (const item of (await readUserStyles()).items) {
      if (item.kind !== 'dir' || item.css === null) continue
      const own = join(dir, item.name)
      if ((await treeSignature(own, await collectCss(own))) === signature) {
        outcome.duplicates.push({ name, sameAs: [item.name] })
        return outcome
      }
    }

    const landed = await uniqueName(dir, name, true)
    await copyTree(srcDir, join(dir, landed), tree)
    outcome.imported.push(landed)
  } catch (err) {
    outcome.failed.push({ name, error: messageOf(err) })
  }
  return outcome
}

/**
 * 目录内容的指纹:相对路径 + 归一化后的正文,按路径排序拼起来。
 *
 * 比的是**内容**而不是体积与修改时间:同一个文件夹从别处再拷一份过来,时间戳必然不同,
 * 而用户的意思是「我已经有这个了」。读不动就返回 null —— 拿半份内容去比会得出
 * 一个看似正确的错误结论。
 */
async function treeSignature(root: string, paths: string[]): Promise<string | null> {
  const parts: string[] = []
  for (const rel of [...paths].sort(byCodePoint)) {
    try {
      const full = join(root, rel)
      if ((await stat(full)).size > MAX_CSS_BYTES) return null
      parts.push(`${rel}\u0000${normalizeCss(await readFile(full, 'utf8'))}`)
    } catch {
      return null
    }
  }
  return parts.join('\u0001')
}

/** 按收集好的相对路径整棵复制(目录按需创建) */
async function copyTree(srcRoot: string, destRoot: string, paths: string[]): Promise<void> {
  for (const rel of paths) {
    const dest = join(destRoot, rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(srcRoot, rel), dest)
  }
}

/** 逐个复制。单个文件的失败不影响其余文件 —— 这是「批量」该有的样子 */
async function importFiles(srcPaths: string[]): Promise<UserStyleImportOutcome> {
  const dir = userStylesDir()
  await mkdir(dir, { recursive: true })

  // 目录现有内容一次读齐,之后每复制一份就把它的内容并进这张表 ——
  // 同一个文件夹里两份一模一样的 .css 也要认出来,否则第二份会凭空多出一个副本。
  // 只跟**单个文件**比:目录项那份文本是拼出来的,跟一个文件碰巧相等不算一回事
  const known = new Map<string, string[]>()
  for (const item of (await readUserStyles()).items) {
    // css 为 null 的是读不动的文件,无从比较,自然也不算重复
    if (item.kind !== 'file' || item.css === null) continue
    known.set(item.css, [...(known.get(item.css) ?? []), item.name])
  }

  const outcome: UserStyleImportOutcome = { imported: [], duplicates: [], failed: [] }
  for (const src of srcPaths) {
    const name = basename(src) || 'imported.css'
    try {
      const info = await stat(src)
      if (info.size > MAX_CSS_BYTES) {
        throw new Error(`文件过大(上限 ${MAX_CSS_BYTES / 1024} KiB)`)
      }
      const css = normalizeCss(await readFile(src, 'utf8'))
      const sameAs = known.get(css)
      if (sameAs && sameAs.length > 0) {
        outcome.duplicates.push({ name, sameAs: [...sameAs] })
        continue
      }
      const landed = await uniqueName(dir, name)
      await copyFile(src, join(dir, landed))
      known.set(css, [landed])
      outcome.imported.push(landed)
    } catch (err) {
      outcome.failed.push({ name, error: messageOf(err) })
    }
  }
  return outcome
}

/**
 * 在目录里找一个不冲突的名字(第一个候选就是原名)。
 *
 * isDir 时**不拆扩展名**:目录名里的那个点不是扩展名(`my.theme` 改名成 `my-2.theme`
 * 会看不出来是什么),整个名字当主干、后缀加在末尾。
 */
async function uniqueName(dir: string, name: string, isDir = false): Promise<string> {
  const dot = isDir ? -1 : name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`
    const taken = await stat(join(dir, candidate)).then(
      () => true,
      () => false
    )
    if (!taken) return candidate
  }
  return `${stem}-${Date.now().toString(36)}${ext}`
}

/**
 * 删除一个样式项(文件或目录,移到系统回收站,与仓库里删文件同一套语义)。
 *
 * 名字来自渲染层,所以先做 basename 校验:它本应来自我们自己下发的清单,但
 * 「本应」不是防线 —— 一行判断换掉一整类路径穿越。
 */
export async function removeUserStyle(name: string): Promise<void> {
  if (!name || basename(name) !== name || name.includes('..')) {
    throw new Error(`非法的样式名:${name}`)
  }
  const target = join(userStylesDir(), name)
  const win = getMainWindow()
  // 确认框要说清是删一个文件夹还是删一个文件:文件夹是整套样式,话得说重一点
  if (win && !showConfirmDelete(win, name, await isDirectory(target))) return
  await shell.trashItem(target)
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    info => info.isDirectory(),
    () => false
  )
}

// ---------- 变更监听 ----------

let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let rearmTimer: ReturnType<typeof setTimeout> | null = null
let rearmCount = 0
let liveness: ReturnType<typeof setInterval> | null = null

/** 挂上看门狗。由 main/index.ts 在窗口创建后调用 */
export function startUserStylesWatch(): void {
  armWatch()
  liveness = setInterval(() => void checkAlive(), LIVENESS_INTERVAL)
  // 别让这个定时器把进程吊在退出前
  liveness.unref()
}

export function stopUserStylesWatch(): void {
  closeWatcher()
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
  if (rearmTimer) {
    clearTimeout(rearmTimer)
    rearmTimer = null
  }
  if (liveness) {
    clearInterval(liveness)
    liveness = null
  }
}

/** 目录还在吗?不在就重建、重挂、把「样式已全部撤下」播出去(见 LIVENESS_INTERVAL) */
async function checkAlive(): Promise<void> {
  const alive = await stat(userStylesDir()).then(
    () => true,
    () => false
  )
  if (alive) return
  await ensureUserStylesDir()
  armWatch()
  await notifyUserStyles()
}

function armWatch(): void {
  // 重挂前先放开旧的:它可能已经死了,也可能还活着(那样就是两个 watcher 同时在看)
  closeWatcher()
  try {
    // 不依赖事件里的 filename:Windows 上通常有、Linux 上常为 null 且可能是 Buffer。
    // 任何事件都全量重读,改名与删除天然被覆盖
    // recursive:目录项是「递归收 .css」的题型,子目录里存一次盘也得跟着生效
    watcher = watch(userStylesDir(), { recursive: true, persistent: false }, () => scheduleReload())
    watcher.on('error', onWatchError)
    rearmCount = 0
  } catch {
    onWatchError()
  }
}

function closeWatcher(): void {
  watcher?.close()
  watcher = null
}

/**
 * 目录被删掉或改名时 Windows 会给 EPERM,watcher 就此死掉。
 * 重挂几次(覆盖「用户删了又建」这种手速)还不行就放弃并留一句日志。
 */
function onWatchError(): void {
  closeWatcher()
  if (rearmCount >= MAX_REARM) {
    console.warn('[iMark] 样式目录监听已放弃(目录可能被删除或占用),可在设置里手动重新读取')
    return
  }
  rearmCount += 1
  rearmTimer = setTimeout(() => {
    rearmTimer = null
    void ensureUserStylesDir().then(() => {
      armWatch()
      void notifyUserStyles()
    })
  }, REARM_DELAY)
  // 别让这个定时器把进程吊在退出前
  rearmTimer.unref()
}

/** 尾沿防抖:一次保存会来好几个事件,250 ms 后统一重读一次 */
function scheduleReload(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    void notifyUserStyles()
  }, WATCH_DEBOUNCE)
}

/**
 * 把最新整份清单推给渲染层。
 *
 * 广播整份而不是「哪个文件变了」:删除与改名天然被覆盖(渲染层拿新列表与自己
 * 已注入的集合做 diff),也不必维护一套增量协议。节流放在渲染层的 diff 里,
 * 那边才知道「这段文本和上次是不是同一段」。
 */
export async function notifyUserStyles(): Promise<void> {
  const win = getMainWindow()
  if (!win || win.webContents.isDestroyed()) return
  win.webContents.send(IPC.UserStylesChanged, await readUserStyles())
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
