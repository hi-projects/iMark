/**
 * **宿主请渲染层替插件办事**的那一端(阶段四)。
 *
 * 两件事必须在这里做,因为只有渲染层有它们:
 *   - **编辑器**:文档在 CodeMirror 手里,读/改/加标记都得在这儿;
 *   - **主界面**:被挂进来的界面块长在主窗口的 DOM 里。
 *
 * 插件代码本身**永远进不了渲染层** —— 它只是发来"请替我读这段""请把这块界面挂上",
 * 具体做什么由这里决定。所以这里没有一行是"照插件说的执行代码"。
 *
 * 三条纪律:
 *
 * 1. **每个请求都必须回执**,包括出错的那种。主进程在等(`invokeOp` 的超时是按 op 配的),
 *    漏一次回执就是一个看起来像"插件卡住"的 5 秒等待。
 * 2. **插件画的东西要能一把收走**:停用/卸载时,它的标记、CSS、界面块一起消失。
 *    不然用户只能对着残留的高亮猜是谁干的。
 * 3. **样式作用域靠 `@scope`**,不靠"相信作者会加前缀":插件写的 CSS 会被包进
 *    `@scope ([data-imk-plugin="<id>"])`,只有它自己标出来/挂出来的元素在作用域里。
 */

import { reactive } from 'vue'
import type { PluginDockSide, RendererOpReply, RendererOpRequest } from '@shared/plugins'
import { appStore, editorHolder } from '../stores/app'
import { applyDecorations, clearPluginDecorations, type PluginDecorationSpec } from '../editor/pluginExt'
import { pluginStore } from './pluginService'

/** 挂进主界面的一块(仅脚本插件,见 README 的说明) */
export interface MountedPanel {
  id: string
  pluginId: string
  side: PluginDockSide
  title: string
  html: string
}

export const pluginHostState = reactive({
  mounts: [] as MountedPanel[],
  /** 被用户收起的面板(按插件 id) */
  collapsed: [] as string[],
  /** 停靠面板的槽位 DOM(由 PluginDock.vue 登记,宿主据此把原生视图摆过去) */
  slots: new Map<string, HTMLElement>()
})

/** 文档超过这个大小就不再整篇回给插件(它多半是要做全文分析,截断比卡死好) */
const READ_LIMIT = 1024 * 1024

function reply(value: RendererOpReply): void {
  window.api.replyHostRequest(value)
}

/** 处理一次请求。任何异常都变成结构化失败,绝不把异常漏回主进程 */
function handle(req: RendererOpRequest): unknown {
  switch (req.op) {
    case 'editor.read':
      return readEditor()
    case 'editor.replace':
      return replaceInEditor(req.args)
    case 'editor.decorate': {
      const view = editorHolder.view
      if (!view) return { applied: false }
      const specs = ((req.args as { specs?: PluginDecorationSpec[] })?.specs ?? []) as PluginDecorationSpec[]
      applyDecorations(view, req.pluginId, specs)
      return { applied: true }
    }
    case 'editor.clear': {
      clearPluginDecorations(editorHolder.view, req.pluginId)
      return { applied: true }
    }
    case 'editor.styles':
    case 'ui.styles':
      injectStyles(req.pluginId, String((req.args as { css?: string })?.css ?? ''))
      return { applied: true }
    case 'ui.mount':
      return mount(req.pluginId, req.args)
    case 'ui.update':
      return updateMount(req.pluginId, req.args)
    case 'ui.remove':
      return removeMount(req.pluginId, String((req.args as { id?: string })?.id ?? ''))
    case 'panel.collapse':
      setCollapsed(req.pluginId, Boolean((req.args as { collapsed?: boolean })?.collapsed))
      return { applied: true }
    default:
      return undefined
  }
}

// ---------- 编辑器 ----------

function readEditor(): unknown {
  const view = editorHolder.view
  if (!view) return { open: false }
  const doc = view.state.doc
  const selection = view.state.selection.main
  const full = doc.toString()
  return {
    open: true,
    /** 超过 1 MiB 时只给开头这一段,并且 truncated 为 true */
    text: full.length > READ_LIMIT ? full.slice(0, READ_LIMIT) : full,
    truncated: full.length > READ_LIMIT,
    /** 文档总长度(即使 text 被截断也是准的 —— 位置都能用它算) */
    length: doc.length,
    from: selection.from,
    to: selection.to,
    cursor: selection.head,
    selected: doc.sliceString(selection.from, selection.to),
    lineCount: doc.lines,
    filePath: appStore.filePath
  }
}

function replaceInEditor(args: unknown): unknown {
  const view = editorHolder.view
  if (!view) return { applied: false }
  const a = (args ?? {}) as { from?: number; to?: number; text?: string | null; select?: { from: number; to: number } | null }
  const docLength = view.state.doc.length
  // 插件的偏移可能是"读完之后用户又打了几行"的旧值:夹进范围,别让它把编辑器搞崩
  const from = Math.max(0, Math.min(docLength, Math.floor(Number(a.from ?? 0))))
  const to = Math.max(from, Math.min(docLength, Math.floor(Number(a.to ?? from))))
  const changes = typeof a.text === 'string' ? { from, to, insert: a.text } : { from, to, insert: undefined }
  const selection = a.select
    ? {
        anchor: Math.max(0, Math.min(docLength, Math.floor(a.select.from))),
        head: Math.max(0, Math.min(docLength, Math.floor(a.select.to)))
      }
    : undefined
  view.dispatch({ changes, ...(selection ? { selection } : {}) })
  view.focus()
  return { applied: true }
}

// ---------- 主界面注入(仅脚本插件) ----------

function mount(pluginId: string, args: unknown): unknown {
  const a = (args ?? {}) as { id?: string; side?: string; title?: string; html?: string }
  const id = String(a.id ?? '')
  const side = (a.side ?? 'right') as PluginDockSide
  const panel: MountedPanel = {
    id,
    pluginId,
    side,
    title: String(a.title ?? ''),
    html: String(a.html ?? '')
  }
  const index = pluginHostState.mounts.findIndex(m => m.pluginId === pluginId && m.id === id)
  if (index >= 0) pluginHostState.mounts.splice(index, 1, panel)
  else pluginHostState.mounts.push(panel)
  return { mounted: true }
}

function updateMount(pluginId: string, args: unknown): unknown {
  const a = (args ?? {}) as { id?: string; html?: string }
  const panel = pluginHostState.mounts.find(m => m.pluginId === pluginId && m.id === String(a.id ?? ''))
  if (!panel) return { mounted: false }
  panel.html = String(a.html ?? '')
  return { mounted: true }
}

function removeMount(pluginId: string, id: string): unknown {
  const index = pluginHostState.mounts.findIndex(m => m.pluginId === pluginId && m.id === id)
  if (index >= 0) pluginHostState.mounts.splice(index, 1)
  return { mounted: index >= 0 }
}

/**
 * 注入插件的 CSS,**用 `@scope` 圈住**。
 *
 * 这是整套设计里最省事也最要紧的一招:插件写的是普通 CSS(不用学什么前缀约定),
 * 但它的选择器只在 `[data-imk-plugin="<它自己的 id>"]` 里面生效 ——
 * 那是宿主标在它装饰过的文字、和它挂进来的界面块上的属性。
 * 于是"插件把自己的样式漏到整个应用上"这件事在结构上就不成立。
 */
function injectStyles(pluginId: string, css: string): void {
  const attr = `style-${pluginId}`
  let el = document.querySelector<HTMLStyleElement>(`style[data-imk-plugin="${attr}"]`)
  if (!el) {
    el = document.createElement('style')
    el.setAttribute('data-imk-plugin', attr)
    document.head.append(el)
  }
  el.textContent = `@scope ([data-imk-plugin="${pluginId}"]) {\n${css}\n}`
}

/** 插件被停用/卸载:把它画的东西全部收走 */
export function dropPluginArtifacts(pluginId: string): void {
  clearPluginDecorations(editorHolder.view, pluginId)
  const style = document.querySelector(`style[data-imk-plugin="style-${pluginId}"]`)
  style?.remove()
  for (let i = pluginHostState.mounts.length - 1; i >= 0; i--) {
    if (pluginHostState.mounts[i]!.pluginId === pluginId) pluginHostState.mounts.splice(i, 1)
  }
}

// ---------- 停靠面板 ----------

/** 当前该停靠的沙箱插件面板(渲染层按这份清单摆槽位) */
export interface DockPanel {
  pluginId: string
  name: string
  side: PluginDockSide
  width: number
  height: number
  collapsed: boolean
}

export function dockPanels(side: PluginDockSide): DockPanel[] {
  const out: DockPanel[] = []
  for (const view of pluginStore.list) {
    if (view.kind !== 'sandboxed' || !view.dock) continue
    if (!view.state.enabled) continue
    if (view.dock !== side) continue
    out.push({
      pluginId: view.descriptor.id,
      name: view.descriptor.name,
      side,
      width: view.dockWidth ?? 320,
      height: view.dockHeight ?? 220,
      collapsed: pluginHostState.collapsed.includes(view.descriptor.id)
    })
  }
  return out
}

export function toggleCollapsed(pluginId: string): void {
  const at = pluginHostState.collapsed.indexOf(pluginId)
  if (at >= 0) pluginHostState.collapsed.splice(at, 1)
  else pluginHostState.collapsed.push(pluginId)
}

/** 插件自己调 window.show()/hide() 时改的是同一个状态 */
export function setCollapsed(pluginId: string, collapsed: boolean): void {
  const at = pluginHostState.collapsed.indexOf(pluginId)
  if (collapsed && at < 0) pluginHostState.collapsed.push(pluginId)
  if (!collapsed && at >= 0) pluginHostState.collapsed.splice(at, 1)
}

/**
 * 把每个停靠槽位的当前位置报给主进程 —— 它照着这个矩形摆原生视图。
 *
 * 为什么是"渲染层量、主进程摆":三栏布局是 CSS 算出来的,主进程完全不知道
 * 侧栏多宽、状态栏多高。让主进程去猜布局,等于把一套布局算法写两遍。
 *
 * 槽位消失时补报一次"不可见":不补的话那个原生视图会留在原地,
 * 盖在一块已经不属于它的地方上(看起来就像界面卡住了)。
 */
let lastReported = new Set<string>()

export function reportDockRects(): void {
  const seen = new Set<string>()
  for (const el of document.querySelectorAll<HTMLElement>('[data-dock-slot]')) {
    const pluginId = el.dataset.dockSlot ?? ''
    if (!pluginId) continue
    seen.add(pluginId)
    const rect = el.getBoundingClientRect()
    window.api.notifyPluginDockRect({
      pluginId,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: rect.width > 1 && rect.height > 1
    })
  }
  for (const pluginId of lastReported) {
    if (seen.has(pluginId)) continue
    window.api.notifyPluginDockRect({ pluginId, x: 0, y: 0, width: 0, height: 0, visible: false })
  }
  lastReported = seen
}

/**
 * 位置同步的节拍。
 *
 * 三件事都会让槽位挪窝:窗口缩放、用户开合侧栏、切仓库换布局。前两件有事件可听,
 * 最后一件没有 —— 所以另有一个 1 秒一次的兜底扫描。几次 getBoundingClientRect
 * 的成本可以忽略,而"面板没跟着走"看起来像应用坏了。
 */
export function startDockRectSync(): () => void {
  let frame = 0
  const schedule = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      reportDockRects()
    })
  }
  window.addEventListener('resize', schedule)
  const observer = new ResizeObserver(schedule)
  observer.observe(document.body)
  const timer = window.setInterval(reportDockRects, 1000)
  return () => {
    window.removeEventListener('resize', schedule)
    observer.disconnect()
    window.clearInterval(timer)
    if (frame) cancelAnimationFrame(frame)
  }
}

// ---------- 装配 ----------

export function initPluginHostOps(): () => void {
  // 报到:主进程收到这条才会开始往这边发请求(窗口刚建好时页面还没跑起来)
  window.api.notifyPluginUiReady()
  const offRequest = window.api.onPluginHostRequest(req => {
    try {
      reply({ id: req.id, ok: true, value: handle(req) ?? null })
    } catch (err) {
      reply({ id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * 点击回传:注入的界面里带 `data-imk-click` 的元素被点了。
   *
   * 这是注入界面的**唯一**交互通道 —— 那段 HTML 里跑不了脚本(CSP 挡着内联脚本与
   * onclick),所以"点了某个按钮"必须回到插件自己的代码里去处理。
   */
  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    const hit = target?.closest?.('[data-imk-click]') as HTMLElement | null
    if (!hit) return
    const mountEl = hit.closest('[data-imk-mount]') as HTMLElement | null
    const ownerEl = hit.closest('[data-imk-plugin]') as HTMLElement | null
    const pluginId = ownerEl?.getAttribute('data-imk-plugin') ?? ''
    if (!pluginId) return
    window.api.notifyPluginUiClick({
      pluginId,
      mountId: mountEl?.getAttribute('data-imk-mount') ?? '',
      name: hit.getAttribute('data-imk-click') ?? ''
    })
  }
  document.addEventListener('click', onClick)

  // 插件被停用/卸载:收走它画的东西。盯的是**列表里还在不在**,而不是某个事件 ——
  // 停用、卸载、被熔断、升级换版本,最后都会体现成这一件事
  const stopWatch = watchPlugins()
  const stopRectSync = startDockRectSync()

  return () => {
    offRequest()
    document.removeEventListener('click', onClick)
    stopWatch()
    stopRectSync()
  }
}

/** 每 500ms 对一次"哪些插件还启着" —— 比让主进程挨个通知停用事件少一整条通道 */
function watchPlugins(): () => void {
  let known = new Set<string>()
  const tick = (): void => {
    const alive = new Set<string>()
    for (const view of pluginStore.list) {
      if (view.state.enabled) alive.add(view.descriptor.id)
    }
    for (const id of known) {
      if (!alive.has(id)) dropPluginArtifacts(id)
    }
    known = alive
  }
  const timer = window.setInterval(tick, 500)
  tick()
  return () => window.clearInterval(timer)
}
