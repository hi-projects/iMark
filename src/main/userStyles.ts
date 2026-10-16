/**
 * 用户自定义样式:家目录 `~/.imark/css/` 下的 .css 文件。
 *
 * 与插件系统是同一条思路 —— **磁盘是权威**:目录里有什么就生效什么。应用不保存
 * 任何「已启用的样式」清单,也不在设置里另开一个编辑器。于是备份 = 拷目录,
 * 恢复 = 拷回来,用任意编辑器改完保存即生效。
 *
 * 三条纪律:
 *
 * 1. **读清单永不抛**。一个读不动的文件只影响它自己(在界面上标红),不能让整个
 *    样式功能消失 —— 那会让用户以为是自己写错了什么。
 * 2. **路径不回家**。目录只在本模块里拼,渲染层拿到的永远是我们算好的绝对路径;
 *    它传回来的只有文件名,还要过一遍 basename 校验。
 * 3. **看门狗会自检**。Windows 上删掉正在监听的目录是个**静默**事件:`fs.watch`
 *    既不派发事件也不派发 'error',watcher 就此死掉。所以除了事件驱动,还有一个
 *    每 4 秒一次的存在性检查兜底(见 LIVENESS_INTERVAL),外加出错时的有上限重挂。
 *
 * 示例文件的正文在 userStyles.example.css 里,以 `?raw` 导入(理由同 market/bundled.ts:
 * 内联进主进程 bundle,绕开 asar 与 `files` 打包限制,不必区分 dev/prod 路径)。
 */

import { app, shell } from 'electron'
import { watch, type Dirent, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { UserStyleFile, UserStyleImportOutcome, UserStyleState } from '@shared/userStyles'
import { showConfirmDelete } from './dialogs'
import { getMainWindow } from './window'
import SAMPLE_CSS from './userStyles.example.css?raw'

/** 单个样式文件的体积上限:手写 CSS 到这个数已是十倍余量,再大就不是样式了 */
const MAX_CSS_BYTES = 512 * 1024

/** 首次创建目录时播种的示例文件名(用户删掉后不会再被塞回来) */
const SAMPLE_NAME = 'example.css'

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
 * 样式目录。
 *
 * 用 `app.getPath('home')` 而不是 `process.env.HOME` / `USERPROFILE`:Windows 上
 * 默认没有 `HOME`(只有 Git Bash 会设),而 Electron 三平台都归一化过;更要紧的是
 * **打包版与开发版返回同一个路径**,于是开发期验证过的行为对安装版直接成立
 * (换成 userData 就会变成两个目录,「我在开发版里调好的样式装完就没了」)。
 */
export function userStylesDir(): string {
  return join(app.getPath('home'), '.imark', 'css')
}

/**
 * 确保目录存在,并且**只在目录本来不存在**时播种一份示例。
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
  try {
    await writeFile(join(dir, SAMPLE_NAME), SAMPLE_CSS, { encoding: 'utf8', flag: 'wx' })
  } catch {
    /* 写不进去(权限之类)不该拦住启动,用户自己建文件也一样能用 */
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
    return { dir, files: [] }
  }

  const files: UserStyleFile[] = []
  for (const entry of entries) {
    // isFile() 一条规则同时排掉子目录和「名字叫 x.css 的目录」
    if (!entry.isFile()) continue
    // 点文件是编辑器的备份(.foo.css.swp)或 macOS 的资源分叉(._foo.css),不是意图
    if (entry.name.startsWith('.')) continue
    if (!entry.name.toLowerCase().endsWith('.css')) continue
    files.push(await readOne(dir, entry.name))
  }

  // 文件名码位升序 —— 顺序即层叠顺序。不用 localeCompare(不同机器的 ICU 版本
  // 可能给出不同结果),也不用数字感知排序(1.css 与 01.css 会被判相等,顺序
  // 就变得不稳定,而「稳定」正是这个排序唯一的价值)
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { dir, files }
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
async function readOne(dir: string, name: string): Promise<UserStyleFile> {
  let size = 0
  try {
    size = (await stat(join(dir, name))).size
    // 先看大小再读:一个几百 MB 的文件不该被整个读进内存(同 market/ipc.ts 的规则)
    if (size > MAX_CSS_BYTES) {
      return { name, size, css: null, error: `文件过大(上限 ${MAX_CSS_BYTES / 1024} KiB)` }
    }
    const css = normalizeCss(await readFile(join(dir, name), 'utf8'))
    return { name, size, css, error: null }
  } catch (err) {
    return { name, size, css: null, error: `读取失败:${messageOf(err)}` }
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
 * 把一个文件夹**顶层**的 .css 全部导入。
 *
 * 不递归:递归会把 node_modules、构建产物里成百上千个 .css 一起拖进来,而
 * 「导入一个文件夹」的意图几乎总是「把这一层的样式拿过来」。
 */
export async function importUserStylesFromDir(dirPath: string): Promise<UserStyleImportOutcome> {
  let entries: Dirent<string>[] = []
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    throw new Error(`读不了这个文件夹:${messageOf(err)}`)
  }
  const paths = entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.css'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(e => join(dirPath, e.name))
  return importFiles(paths)
}

/** 逐个复制。单个文件的失败不影响其余文件 —— 这是「批量」该有的样子 */
async function importFiles(srcPaths: string[]): Promise<UserStyleImportOutcome> {
  const dir = userStylesDir()
  await mkdir(dir, { recursive: true })

  // 目录现有内容一次读齐,之后每复制一份就把它的内容并进这张表 ——
  // 同一个文件夹里两份一模一样的 .css 也要认出来,否则第二份会凭空多出一个副本
  const known = new Map<string, string[]>()
  for (const file of (await readUserStyles()).files) {
    // css 为 null 的是读不动的文件,无从比较,自然也不算重复
    if (file.css === null) continue
    known.set(file.css, [...(known.get(file.css) ?? []), file.name])
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

/** 在目录里找一个不冲突的文件名(第一个候选就是原文件名) */
async function uniqueName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
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
 * 删除一个样式文件(移到系统回收站,与仓库里删文件同一套语义)。
 *
 * 名字来自渲染层,所以先做 basename 校验:它本应来自我们自己下发的清单,但
 * 「本应」不是防线 —— 一行判断换掉一整类路径穿越。
 */
export async function removeUserStyle(name: string): Promise<void> {
  if (!name || basename(name) !== name || name.includes('..')) {
    throw new Error(`非法的样式文件名:${name}`)
  }
  const win = getMainWindow()
  if (win && !showConfirmDelete(win, name, false)) return
  await shell.trashItem(join(userStylesDir(), name))
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
    watcher = watch(userStylesDir(), { persistent: false }, () => scheduleReload())
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
