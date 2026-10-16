/**
 * 沙箱插件的**窗口、会话与协议**(阶段三 §3.1 / §3.2 / §3.4)。
 *
 * 一个沙箱插件 = 恰好一个 renderer:
 *   - 带界面(`ui.entry`)的,那个 renderer 加载作者写的 HTML;
 *   - 纯后台的,加载宿主生成的 `__imark/exec.html`(隐藏窗口 + 不进任务栏)。
 *
 * 作者因此不必为"有时有窗口"写两套代码:两种情况下 `window.imark` 一模一样。
 *
 * ## 安全模型的三根支柱
 *
 * 1. **每个插件一个独立 session**(`persist:imk-plugin-<id>`)。`protocol.handle` 是按
 *    session 注册的,所以必须在建窗**之前**注册 —— 注册晚了,第一次加载就是一片空白
 *    (而症状是"插件界面打不开",看不出跟注册顺序有关)。
 *    `setPermissionRequestHandler(() => false)` 关掉全部 Web 权限(摄像头、定位、通知…),
 *    附赠 localStorage / IndexedDB 的天然隔离。
 * 2. **CSP 由我们下发**,`registerSchemesAsPrivileged` **绝不给 `bypassCSP`** ——
 *    整个"插件页只能加载自己包里的东西"就靠这一条。网络因此只能走 RPC(见 §3.3),
 *    宿主才看得见它连了哪儿。
 * 3. **路径三重校验**(见 resolvePluginFile):逐段 decode 后拒 `''`/`.`/`..`、
 *    `isSafeRelPath` + safeJoin、`realpath` 挡符号链接逃逸。少一层就漏。
 *    再加一条:锁死 `url.host` 必须是本插件的 id —— 否则 A 插件能读 B 插件的文件。
 */

import { BrowserWindow, protocol, screen, session, shell, type Session } from 'electron'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { isSafeRelPath, type PluginUiSpec } from '@shared/pluginPackage'
import tokensCss from '@shared/theme/tokens.css?raw'
import { getSettingsSync } from '../settings'

export const PLUGIN_SCHEME = 'imk-plugin'

/** 宿主往插件目录里放的保留资源(包内路径禁止出现 `__imark`,所以不会撞名) */
const RESERVED = '__imark'

/**
 * 扩展名 → MIME。
 *
 * `js` 一律 `text/javascript`(**不是** `application/javascript`):浏览器对后者的处理
 * 是按"未知类型"来的,模块脚本会被拒,而报错只有一句 "Failed to load module script"。
 * 全量带 `nosniff`:类型就是我们说了算,别让浏览器去猜。
 */
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2'
}

/**
 * 插件文档的 CSP。
 *
 * `style-src 'unsafe-inline'` 是给 Vue 之类的运行时注入 `<style>` 用的 ——
 * 它的污染范围**仅限插件自己的文档**(每个插件一个 session),拿不到应用主界面。
 * `connect-src 'self'` 把 `fetch('https://…')` 直接掐死:插件要联网必须走 RPC,
 * 于是宿主能看到它连了哪儿、也能按权限拒绝。
 */
const DOC_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/**
 * 注册自定义协议的特权。**必须在 app ready 之前调用**(Electron 的硬性要求)。
 * 绝不给 `bypassCSP`:那会让插件页用自己的 CSP 覆盖我们下发的这一份。
 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true, // 视作安全上下文:否则 crypto.subtle / 部分 API 直接不可用
        supportFetchAPI: true,
        stream: true,
        // 不给 corsEnabled:插件页只该同源取自己的东西
      }
    }
  ])
}

// ---------- 谁在哪个目录 ----------

/**
 * 插件 id → 它的根目录。
 *
 * 由 host.ts 填(只有它同时知道安装目录与 `--plugin-dev` 的开发目录);
 * 沙箱插件必须在这里查得到,查不到就不建窗 —— 那说明宿主状态不自洽。
 */
const roots = new Map<string, string>()
/** 插件 id → 窗口标题要用的显示名 */
const displayNames = new Map<string, string>()

export function setPluginRoot(id: string, dir: string, name: string): void {
  roots.set(id, dir)
  displayNames.set(id, name)
}

export function forgetPluginRoot(id: string): void {
  roots.delete(id)
  displayNames.delete(id)
}

// ---------- 会话 ----------

const sessions = new Map<string, Session>()

function sessionFor(id: string): Session {
  const existing = sessions.get(id)
  if (existing) return existing
  const s = session.fromPartition(`persist:${PLUGIN_SCHEME}-${id}`)
  // 关掉全部 Web 权限请求(摄像头 / 麦克风 / 定位 / 通知 / 剪贴板读…)。
  // 插件要什么东西都得走宿主的能力表 —— 那是一张看得见的清单,
  // 而这里的默认放开是一张看不见的清单。
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  s.setPermissionCheckHandler(() => false)
  s.setDisplayMediaRequestHandler((_request, callback) => callback({} as never))
  resolveProtocolFor(id, s)
  sessions.set(id, s)
  return s
}

/**
 * 给这个插件的 session 装上 `imk-plugin://` 的处理器。
 *
 * 必须在建窗之前 —— `protocol.handle` 是按 session 生效的,晚一步那次加载就没人应答。
 */
function resolveProtocolFor(id: string, s: Session): void {
  s.protocol.handle(PLUGIN_SCHEME, async request => {
    try {
      return await serve(id, request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[iMark] 插件 ${id} 的资源请求失败:${message}`)
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
  })
}

/** 一次资源请求的处理:身份 → 路径 → 内容 → 头 */
async function serve(pluginId: string, request: Request): Promise<Response> {
  const url = new URL(request.url)

  // ① 锁死 host:每个插件一个 session 已经挡住了大部分跨插件访问,
  //    但如果插件页里写 `<img src="imk-plugin://别的插件/x.png">`,用的还是**自己的**
  //    session,handler 会拿 host 去查根目录 —— 于是别人的文件就被读走了。
  if (url.hostname !== pluginId) {
    return forbidden('跨插件访问被拒绝')
  }

  // ② 再来一道:请求的来源必须是本插件自己的文档(initiatorOrigin 在部分平台上才有,
  //    没有就退化成"只信 host 那一道";两道都在时两道都要过)
  const initiator = (request as Request & { initiatorOrigin?: string }).initiatorOrigin
  if (initiator && initiator !== `${PLUGIN_SCHEME}://${pluginId}`) {
    return forbidden('来自其它来源的访问被拒绝')
  }

  const rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')

  // ③ 宿主保留资源(执行器页面、主题样式)
  if (rawPath === `${RESERVED}/exec.html`) {
    return html(execPage(pluginId))
  }
  if (rawPath === `${RESERVED}/ui.css`) {
    // 这个路径能过 `style-src 'self'` 的**唯一原因是同源**。
    // 挪到别的 origin(包括 data:、别的 scheme)都会被 CSP 拦掉。
    return new Response(tokensCss, {
      headers: { 'content-type': MIME.css as string, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    })
  }
  // 包内路径禁止 `__imark` 开头的段(validateManifest 已挡,这里是第二道)
  if (rawPath.split('/').includes(RESERVED)) {
    return forbidden('保留路径')
  }

  const file = await resolvePluginFile(pluginId, rawPath)
  if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })

  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  const mime = MIME[ext]
  if (!mime) return forbidden('不允许的文件类型')

  const body = await readFile(file)
  const isDoc = ext === 'html' || ext === 'htm'
  return new Response(body, {
    headers: {
      'content-type': mime,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // CSP 只在**文档**响应上给:子资源上的 CSP 会被浏览器忽略
      ...(isDoc ? { 'content-security-policy': DOC_CSP } : {})
    }
  })
}

function forbidden(reason: string): Response {
  return new Response(reason, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': MIME.html as string,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': DOC_CSP
    }
  })
}

/**
 * 包内路径 → 绝对路径。**三重校验**,顺序就是防线:
 *   1. 逐段 decodeURIComponent 后拒 `''` / `.` / `..`
 *   2. `isSafeRelPath` + 拼出来确认没跑出去
 *   3. `realpath` 挡符号链接逃逸(磁盘上的事实,前两步看不见)
 */
async function resolvePluginFile(pluginId: string, relPath: string): Promise<string | null> {
  if (!relPath) return null
  for (const segment of relPath.split('/')) {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (decoded === '' || decoded === '.' || decoded === '..') return null
  }
  if (!isSafeRelPath(relPath)) return null

  const root = roots.get(pluginId)
  if (!root) return null
  const full = resolve(join(root, normalize(relPath)))
  const base = resolve(root)
  if (full !== base && !full.startsWith(base.endsWith(sep) ? base : base + sep)) return null

  try {
    const real = await realpath(full)
    const realRoot = await realpath(base)
    if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return null
    if (!(await stat(real)).isFile()) return null
    return real
  } catch {
    return null
  }
}

/**
 * 纯后台插件的执行器页面。
 *
 * 它只做一件事:把作者写的 `main` 装进来。**不经过文档 fetch 之外的任何东西**,
 * 所以 CSP 的 `script-src 'self'` 正好够用。
 */
function execPage(pluginId: string): string {
  const manifestMain = mains.get(pluginId) ?? 'main.js'
  const src = `/${manifestMain.split('/').map(encodeURIComponent).join('/')}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(displayNames.get(pluginId) ?? pluginId)} — 后台执行</title>
<style>html,body{margin:0;height:100%;background:transparent}</style>
</head>
<body>
<!--
  宿主生成的执行器页面:作者不必为"没有界面"额外做任何事。

  按 ES 模块加载(而不是传统脚本):这样作者可以用 import/export 组织代码,
  也可以直接用 TS 编译出来的 ESM 产物。传统脚本在这里没有优势,反而会把
  "为什么我的 import 报错"变成一套要单独解释的规矩。
-->
<script type="module" src="${src}"></script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const mains = new Map<string, string>()

// ---------- 窗口几何 ----------

interface Geometry {
  width: number
  height: number
  x?: number
  y?: number
}

/**
 * 窗口几何存在**自己的文件**里(userData/plugin-ui.json),不混进 settings.json。
 *
 * 理由:它是纯界面的临时状态,与用户对插件的配置无关;混进 settings 的话,
 * 每次拖动窗口都要触发一次设置变更广播(插件会收到 config:change),纯属噪音。
 */
let geometryCache: Record<string, Geometry> | null = null

function geometryPath(): string {
  return join(app.getPath('userData'), 'plugin-ui.json')
}

async function loadGeometry(id: string): Promise<Geometry | null> {
  if (!geometryCache) {
    try {
      geometryCache = JSON.parse(await readFile(geometryPath(), 'utf8')) as Record<string, Geometry>
    } catch {
      geometryCache = {}
    }
  }
  return geometryCache[id] ?? null
}

async function saveGeometry(id: string, geo: Geometry): Promise<void> {
  if (!geometryCache) await loadGeometry(id)
  geometryCache = { ...(geometryCache ?? {}), [id]: geo }
  try {
    await mkdir(dirname(geometryPath()), { recursive: true })
    await writeFile(geometryPath(), JSON.stringify(geometryCache, null, 2), 'utf8')
  } catch (err) {
    console.error('[iMark] 保存插件窗口位置失败:', err)
  }
}

export async function forgetGeometry(id: string): Promise<void> {
  if (!geometryCache) await loadGeometry(id)
  if (!geometryCache) return
  const next = { ...geometryCache }
  delete next[id]
  geometryCache = next
  await writeFile(geometryPath(), JSON.stringify(next, null, 2), 'utf8').catch(() => {})
}

/** 把恢复出来的位置夹回某个显示器的工作区 —— 显示器拔了之后窗口不该出现在屏幕外 */
function clampToWorkArea(geo: Geometry): Geometry {
  const width = Math.max(240, Math.min(4000, Math.round(geo.width || 900)))
  const height = Math.max(240, Math.min(4000, Math.round(geo.height || 640)))
  if (geo.x === undefined || geo.y === undefined) return { width, height }
  const area = screen.getDisplayMatching({
    x: Math.round(geo.x),
    y: Math.round(geo.y),
    width,
    height
  }).workArea
  const x = Math.min(Math.max(Math.round(geo.x), area.x), area.x + area.width - 80)
  const y = Math.min(Math.max(Math.round(geo.y), area.y), area.y + area.height - 40)
  return { width, height, x, y }
}

// ---------- 窗口 ----------

export interface PluginWindowSpec {
  pluginId: string
  name: string
  dir: string
  main: string
  /** 有界面就给 ui 声明;纯后台传 null */
  ui: PluginUiSpec | null
  /**
   * 已生效的权限。**只用于塑形** preload 里 `window.imark` 的命名空间 ——
   * 真正的判定每次都在主进程的闸门里(见 gate.ts)。放在 additionalArguments
   * 里是因为 preload 拿不到别的东西;这里**不能**放任何密钥(Linux 上
   * `/proc/<pid>/cmdline` 能读到进程参数)。
   */
  permissions: readonly string[]
  /**
   * 窗口对象刚建好、**还没开始加载页面**时回调。
   *
   * 存在的理由是身份绑定:页面里的脚本可能在 loadURL 的过程中就跑起来并开口说话,
   * 而"这个 webContents 是哪个插件的"必须先登记好 —— 晚一步,页面最早的那几次调用
   * 会以"没有绑定到任何插件"被丢掉(其中就有 plugin.ready 这个握手)。
   */
  onCreated?(win: BrowserWindow): void
  /** 页面就绪(执行器或作者页面里的脚本已经跑起来)时回调 */
  onReady(): void
  /** 页面崩了/被销毁 */
  onGone(reason: string): void
}

interface OpenWindow {
  win: BrowserWindow
  spec: PluginWindowSpec
  /** 关窗时正在等的那个 resolve */
  closing: (() => void) | null
}

const openWindows = new Map<string, OpenWindow>()

export function pluginWindowOf(pluginId: string): BrowserWindow | null {
  const open = openWindows.get(pluginId)
  if (!open || open.win.isDestroyed()) return null
  return open.win
}

export function isPluginWindowOpen(pluginId: string): boolean {
  return pluginWindowOf(pluginId) !== null
}

/**
 * 建窗(不显示)。带 ui 的插件由它自己调 `imark.window.show()` 显示 ——
 * 一个只想在用户点命令时才露面的插件,不该在启用的一瞬间弹出来。
 */
export async function openPluginWindow(spec: PluginWindowSpec): Promise<BrowserWindow> {
  setPluginRoot(spec.pluginId, spec.dir, spec.name)
  mains.set(spec.pluginId, spec.main)

  const existing = pluginWindowOf(spec.pluginId)
  if (existing) return existing

  const s = sessionFor(spec.pluginId)
  const saved = await loadGeometry(spec.pluginId)
  const geo = clampToWorkArea(
    saved ?? {
      width: spec.ui?.width ?? spec.ui?.minWidth ?? 900,
      height: spec.ui?.height ?? spec.ui?.minHeight ?? 640
    }
  )

  const win = new BrowserWindow({
    ...geo,
    minWidth: Math.max(240, spec.ui?.minWidth ?? 320),
    minHeight: Math.max(240, spec.ui?.minHeight ?? 240),
    show: false,
    // 标题栏里必须能看出这是插件 —— 钓鱼窗口的风险就在这里,界面上要如实标出
    title: `${spec.name} — iMark 插件`,
    // 纯后台插件不进任务栏:它没有界面,占一个任务栏图标只会让人困惑
    skipTaskbar: spec.ui === null,
    backgroundColor: getSettingsSync()?.theme === 'black' ? '#000000' : '#0d1117',
    webPreferences: {
      session: s,
      preload: join(__dirname, '../preload/plugin.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏页面会被节流到 1Hz→每 60 秒一次(见 §3.5)。关掉它 = 作者自己写的
      // setInterval 还能跑得动;官方推荐仍然是宿主调度器 imark.schedule.every
      backgroundThrottling: false,
      spellcheck: false,
      additionalArguments: [
        `--imark-plugin-id=${spec.pluginId}`,
        `--imark-plugin-perms=${spec.permissions.join(',')}`,
        `--imark-plugin-theme=${getSettingsSync()?.theme ?? 'dark'}`
      ]
    }
  })

  const entry = { win, spec, closing: null as (() => void) | null }
  openWindows.set(spec.pluginId, entry)
  // 身份绑定必须发生在 loadURL **之前**(见 spec.onCreated 的说明)
  spec.onCreated?.(win)

  // 页面里的身份只给页面自己看日志用 —— 主进程**永不采信**它(身份靠 sender.id 反查)
  win.webContents.on('did-finish-load', () => {
    entry.spec.onReady()
  })

  /**
   * 插件页面的控制台转发到主进程。
   *
   * 不是锦上添花:插件页面是**独立**的 renderer,它的 console 默认没有任何人看得见 ——
   * 作者写错一行、某个资源 404、CSP 拦了一个请求,全都静默消失,表现是"插件没反应"。
   * 这条转发是作者唯一能拿到现场的地方。
   */
  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron 35 起改成了单参数对象(event.message),旧版是 (event, level, message)
    const first = args[0] as { message?: string; level?: unknown } | undefined
    const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
    if (message) console.log(`[plugin:${spec.pluginId}] 页面:${message}`)
  })

  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[iMark] 插件 ${spec.pluginId} 的资源加载失败:${description}(${code}) ${url}`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 插件页里点外链:交给系统浏览器,绝不在应用里开新窗口
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    // 只许在自己插件的范围内导航
    if (!url.startsWith(`${PLUGIN_SCHEME}://${spec.pluginId}/`)) {
      event.preventDefault()
      entry.spec.onGone('页面试图离开插件自己的范围')
      void closePluginWindow(spec.pluginId, 'navigate-away')
    }
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[iMark] 插件 ${spec.pluginId} 的页面崩了:${details.reason}`)
    entry.spec.onGone(details.reason)
    openWindows.delete(spec.pluginId)
  })

  win.on('close', () => {
    void saveGeometry(spec.pluginId, {
      width: win.getBounds().width,
      height: win.getBounds().height,
      x: win.getBounds().x,
      y: win.getBounds().y
    })
  })

  win.on('closed', () => {
    entry.closing?.()
    openWindows.delete(spec.pluginId)
  })

  const target =
    spec.ui === null
      ? `${PLUGIN_SCHEME}://${spec.pluginId}/${RESERVED}/exec.html`
      : `${PLUGIN_SCHEME}://${spec.pluginId}/${spec.ui.entry.split('/').map(encodeURIComponent).join('/')}`

  try {
    await win.loadURL(target)
  } catch (err) {
    // 加载失败(入口文件不在包里、CSP 拦了……):窗口留着但说清楚为什么
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[iMark] 插件 ${spec.pluginId} 的窗口加载失败:${message}`)
    entry.spec.onGone(`窗口加载失败:${message}`)
    win.webContents.once('did-finish-load', () => {})
  }
  return win
}

/**
 * 关窗。**默认是优雅的**:先请求关闭,2 秒还没关掉就强杀。
 *
 * 强杀那一步不是洁癖:插件页里可能有 `beforeunload`、可能正在跑一个死循环,
 * 而停用/卸载/升级都**必须**让窗口真的消失 —— 否则升级时目录被 rename 掉,
 * 页面还在,再点一下就是 404 的半旧半新状态。
 */
export async function closePluginWindow(pluginId: string, reason: string): Promise<void> {
  const open = openWindows.get(pluginId)
  if (!open) return
  void reason
  const { win } = open
  if (win.isDestroyed()) {
    openWindows.delete(pluginId)
    return
  }
  await new Promise<void>(resolve => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    open.closing = finish
    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.destroy()
      finish()
    }, 2000)
    win.once('closed', () => {
      clearTimeout(timer)
      finish()
    })
    win.close()
  })
  openWindows.delete(pluginId)
}

/**
 * 卸载后清掉这个插件的分区数据(localStorage / IndexedDB / 缓存)。
 *
 * `clearStorageData()` 只清**内容**,`userData/Partitions/<名字>/` 这个目录会留着 ——
 * 而"卸载之后这块地方还占着、下次同 id 的插件还能看见上一家的残留"正是要避免的。
 * 所以清完内容再把目录删掉;删的时候 session 对象可能还握着文件句柄,失败就算了
 * (内容已经清了,那才是关键)。
 */
export async function clearPluginStorage(pluginId: string): Promise<void> {
  await closePluginWindow(pluginId, 'uninstall')
  const s = sessions.get(pluginId)
  if (s) {
    await s.clearStorageData().catch(() => {})
    sessions.delete(pluginId)
  }
  const dir = join(app.getPath('userData'), 'Partitions', `${PLUGIN_SCHEME}-${pluginId}`)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await forgetGeometry(pluginId)
  forgetPluginRoot(pluginId)
  mains.delete(pluginId)
}

/** 退出时把所有插件窗口关掉(否则 app.quit() 会被它们拦住) */
export async function closeAllPluginWindows(): Promise<void> {
  for (const id of [...openWindows.keys()]) {
    await closePluginWindow(id, 'quit')
  }
}

export function pluginWindowTitle(pluginId: string): string {
  const name = displayNames.get(pluginId) ?? pluginId
  return `${name} — iMark 插件`
}

