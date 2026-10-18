/**
 * restricted main 层的**隐藏执行页**、会话与协议。
 *
 * 一个 restricted 插件 = 恰好一个隐藏 renderer。它加载宿主生成的
 * `__imark/exec.html`,页面里的 `main.entry` 是作者写的 ES module。
 * 插件没有自有窗口/停靠页:UI 统一由 render 层直接操作 DOM。
 *
 * ## 安全模型的三根支柱
 *
 * 1. **每个插件一个独立 session**(`persist:imk-plugin-<id>`)。`protocol.handle` 是按
 *    session 注册的,所以必须在建窗**之前**注册 —— 注册晚了,第一次加载就是一片空白。
 *    `setPermissionRequestHandler(() => false)` 关掉全部 Web 权限。
 * 2. **CSP 由我们下发**,`registerSchemesAsPrivileged` **绝不给 `bypassCSP`**。
 *    网络因此只能走 RPC(见 gate.ts),宿主才看得见它连了哪儿。
 * 3. **路径三重校验**(见 resolvePluginFile):逐段 decode 后拒 `''`/`.`/`..`、
 *    `isSafeRelPath` + safeJoin、`realpath` 挡符号链接逃逸。再加一条:
 *    锁死 `url.host` 必须是本插件的 id —— 否则 A 插件能读 B 插件的文件。
 */

import {
  BrowserWindow,
  app,
  protocol,
  session,
  type Session,
  type WebContents
} from 'electron'
import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'
import { isSafeRelPath } from '@shared/pluginPackage'
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
 * `connect-src 'self'` 把 `fetch('https://…')` 直接掐死:插件要联网必须走 RPC。
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
        stream: true
      }
    }
  ])
}

// ---------- 谁在哪个目录 ----------

/**
 * 插件 id → 它的根目录。
 *
 * 由 host.ts 填(只有它同时知道安装目录与 `--plugin-dev` 的开发目录);
 * restricted 插件必须在这里查得到,查不到就不建页。
 */
const roots = new Map<string, string>()
/** 插件 id → 显示名(日志/执行页标题) */
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

/**
 * 插件的持久化分区名。建 session 与卸载时删磁盘目录都用它 ——
 * 各拼一次的话,哪天命名规则一动,删的就成了另一个目录(静默失效,最难发现)。
 */
function pluginPartition(id: string): string {
  return `persist:${PLUGIN_SCHEME}-${id}`
}

function sessionFor(id: string): Session {
  const existing = sessions.get(id)
  if (existing) return existing
  const s = session.fromPartition(pluginPartition(id))
  // 关掉全部 Web 权限请求(摄像头 / 麦克风 / 定位 / 通知 / 剪贴板读…)。
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  s.setPermissionCheckHandler(() => false)
  s.setDisplayMediaRequestHandler((_request, callback) => callback({} as never))
  resolveProtocolFor(id, s)
  sessions.set(id, s)
  return s
}

/**
 * 给这个插件的 session 装上 `imk-plugin://` 的处理器。
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
  //    但 `<img src="imk-plugin://别的插件/x.png">` 用的还是**自己的** session。
  if (url.hostname !== pluginId) {
    return forbidden('跨插件访问被拒绝')
  }

  // ② 请求的来源必须是本插件自己的文档
  const initiator = (request as Request & { initiatorOrigin?: string }).initiatorOrigin
  if (initiator && initiator !== `${PLUGIN_SCHEME}://${pluginId}`) {
    return forbidden('来自其它来源的访问被拒绝')
  }

  const rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')

  // ③ 宿主保留资源(执行器页面)
  if (rawPath === `${RESERVED}/exec.html`) {
    return html(execPage(pluginId))
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
 * 宿主生成的执行器页面。
 *
 * 它只做一件事:把作者写的 `main.entry` 装进来。**不经过文档 fetch 之外的任何东西**,
 * 所以 CSP 的 `script-src 'self'` 正好够用。
 */
function execPage(pluginId: string): string {
  const entry = mains.get(pluginId) ?? 'main.js'
  const src = `/${entry.split('/').map(encodeURIComponent).join('/')}`
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

  按 ES 模块加载:这样作者可以用 import/export 组织代码,
  也可以直接用 TS 编译出来的 ESM 产物。
-->
<script type="module" src="${src}"></script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const mains = new Map<string, string>()

// ---------- 隐藏执行页 ----------

export interface RestrictedPageSpec {
  pluginId: string
  name: string
  dir: string
  /** main.entry(包内相对路径) */
  entry: string
  /**
   * 已生效的权限。**只用于塑形** preload 里 `window.imark` 的命名空间 ——
   * 真正的判定每次都在主进程的闸门里。这里**不能**放任何密钥。
   */
  permissions: readonly string[]
  /** 有没有 render 层(页面据此决定是否注入 imark.render) */
  hasRender: boolean
  /** 页面载体刚建好、**还没开始加载页面**时回调(身份绑定必须早于 loadURL) */
  onCreated?(wc: WebContents): void
  /** 页面就绪时回调 */
  onReady(): void
  /** 页面崩了/被销毁 */
  onGone(reason: string): void
}

interface OpenPage {
  spec: RestrictedPageSpec
  wc: WebContents
  win: BrowserWindow
  closing: (() => void) | null
}

const openPages = new Map<string, OpenPage>()

/** 插件的页面(运行时发消息/调用时用) */
export function pluginWebContentsOf(pluginId: string): WebContents | null {
  const open = openPages.get(pluginId)
  if (!open || open.wc.isDestroyed()) return null
  return open.wc
}

/** restricted 页面的 webPreferences */
function restrictedWebPreferences(spec: RestrictedPageSpec): Electron.WebPreferences {
  return {
    session: sessionFor(spec.pluginId),
    preload: join(__dirname, '../preload/plugin.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // 隐藏页面会被节流到 1Hz→每 60 秒一次。关掉它 = 作者自己写的
    // setInterval 还能跑得动;官方推荐仍然是宿主调度器 imark.schedule.every
    backgroundThrottling: false,
    spellcheck: false,
    additionalArguments: [
      `--imark-plugin-id=${spec.pluginId}`,
      `--imark-plugin-perms=${spec.permissions.join(',')}`,
      `--imark-plugin-theme=${getSettingsSync()?.theme ?? 'dark'}`,
      `--imark-plugin-has-render=${spec.hasRender ? '1' : '0'}`
    ]
  }
}

/** 建隐藏执行页(不显示、不进任务栏) */
export async function openRestrictedPage(spec: RestrictedPageSpec): Promise<void> {
  setPluginRoot(spec.pluginId, spec.dir, spec.name)
  mains.set(spec.pluginId, spec.entry)

  if (pluginWebContentsOf(spec.pluginId)) return

  const win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    title: `${spec.name} — iMark 插件运行时`,
    webPreferences: restrictedWebPreferences(spec)
  })

  const open: OpenPage = { spec, wc: win.webContents, win, closing: null }
  openPages.set(spec.pluginId, open)
  // 身份绑定必须发生在 loadURL **之前**
  spec.onCreated?.(win.webContents)
  wireWebContents(open)

  win.on('closed', () => {
    open.closing?.()
    openPages.delete(spec.pluginId)
  })

  try {
    await win.loadURL(`${PLUGIN_SCHEME}://${spec.pluginId}/${RESERVED}/exec.html`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[iMark] 插件 ${spec.pluginId} 的执行页加载失败:${message}`)
    spec.onGone(`执行页加载失败:${message}`)
  }
}

/** 页面事件接线:控制台转发、禁止导航离开、崩溃上报 */
function wireWebContents(open: OpenPage): void {
  const { wc, spec } = open

  wc.on('did-finish-load', () => {
    spec.onReady()
  })

  /**
   * 插件页面的控制台转发到主进程。
   * 插件页面是**独立**的 renderer,它的 console 默认没有任何人看得见 ——
   * 作者写错一行、某个资源 404、CSP 拦了一个请求,全都静默消失。
   */
  wc.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { message?: string; level?: unknown } | undefined
    const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
    if (message) console.log(`[plugin:${spec.pluginId}] 页面:${message}`)
  })

  wc.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[iMark] 插件 ${spec.pluginId} 的资源加载失败:${description}(${code}) ${url}`)
  })

  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${PLUGIN_SCHEME}://${spec.pluginId}/`)) {
      event.preventDefault()
      spec.onGone('页面试图离开插件自己的范围')
      void closeRestrictedPage(spec.pluginId, 'navigate-away')
    }
  })

  wc.on('render-process-gone', (_e, details) => {
    console.error(`[iMark] 插件 ${spec.pluginId} 的页面崩了:${details.reason}`)
    spec.onGone(details.reason)
    openPages.delete(spec.pluginId)
  })
}

/**
 * 关掉执行页。**默认是优雅的**:先请求关闭,2 秒还没关掉就强杀。
 * 停用/卸载/升级都**必须**让它真的消失 —— 否则升级时目录被 rename 掉,
 * 页面还在,再点一下就是 404 的半旧半新状态。
 */
export async function closeRestrictedPage(pluginId: string, reason: string): Promise<void> {
  const open = openPages.get(pluginId)
  if (!open) return
  void reason

  const win = open.win
  if (!win || win.isDestroyed()) {
    openPages.delete(pluginId)
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
  openPages.delete(pluginId)
}

/**
 * 卸载后清掉这个插件的分区数据(localStorage / IndexedDB / 缓存)。
 *
 * `clearStorageData()` 只清**内容**,`Partitions/<名字>/` 这个目录会留着 ——
 * 而"卸载之后这块地方还占着、下次同 id 的插件还能看见上一家的残留"正是要避免的。
 */
export async function clearPluginStorage(pluginId: string): Promise<void> {
  await closeRestrictedPage(pluginId, 'uninstall')
  const s = sessions.get(pluginId)
  if (s) {
    await s.clearStorageData().catch(() => {})
    sessions.delete(pluginId)
  }
  const dir = join(app.getPath('sessionData'), 'Partitions', `${PLUGIN_SCHEME}-${pluginId}`)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  forgetPluginRoot(pluginId)
  mains.delete(pluginId)
}

/** 退出时把所有执行页关掉(否则 app.quit() 会被它们拦住) */
export async function closeAllRestrictedPages(): Promise<void> {
  for (const id of [...openPages.keys()]) {
    await closeRestrictedPage(id, 'quit')
  }
}
