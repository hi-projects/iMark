/**
 * chat 与 character 两个 webview 共用的启动代码。
 *
 * 扩展宿主把面板配置写成页面里的 `<script type="application/json"
 * id="imark-bootstrap">`，这里只负责读它、应用主题变量，以及向父页面发消息。
 * 不依赖任何宿主模块，也不在模块加载时产生副作用。
 */

export interface ThemePayload {
  kind?: string
  colors?: Record<string, string>
}

export interface BootstrapPayload {
  mode: 'chat' | 'character'
  panelId: string
  extensionId: string
  config: Record<string, unknown>
  theme?: ThemePayload
}

export function readBootstrap(): BootstrapPayload {
  const el = document.getElementById('imark-bootstrap')
  const fallback: BootstrapPayload = {
    mode: 'chat',
    panelId: '',
    extensionId: '',
    config: {}
  }
  if (!el || !el.textContent) return fallback
  try {
    const parsed = JSON.parse(el.textContent) as Partial<BootstrapPayload>
    return {
      ...fallback,
      ...parsed,
      config:
        parsed.config && typeof parsed.config === 'object'
          ? (parsed.config as Record<string, unknown>)
          : {}
    }
  } catch {
    return fallback
  }
}

/** 把宿主注入的 CSS 变量写到根元素；页面自己的样式全部走 var(--…) */
export function applyTheme(theme: unknown): void {
  if (!theme || typeof theme !== 'object') return
  const colors = (theme as ThemePayload).colors
  if (!colors || typeof colors !== 'object') return
  const root = document.documentElement
  for (const [key, value] of Object.entries(colors)) {
    if (!key.startsWith('--') || typeof value !== 'string') continue
    root.style.setProperty(key, value)
  }
}

/** iframe → 渲染层；渲染层只接受这两种 type，其他字段原样转给扩展 */
export function postToHost(message: unknown): void {
  parent.postMessage({ type: 'imark:message', message }, '*')
}

export function announceReady(): void {
  parent.postMessage({ type: 'imark:ready' }, '*')
}

/**
 * 开始拖动整个浮动面板。
 *
 * 透明小人面板没有标题栏，唯一能按住的区域在 iframe 里面；跨源 iframe 一旦把
 * 指针移出自身就收不到事件，所以这里只把「按下」交给宿主，由宿主铺一层全窗口
 * 遮罩接管后续 pointermove/pointerup。坐标是 iframe 视口内的 client 坐标，
 * 宿主会加上 iframe 的位置还原成窗口坐标。
 */
export function postPanelDragStart(clientX: number, clientY: number): void {
  parent.postMessage({ type: 'imark:panelDragStart', clientX, clientY }, '*')
}

/** 指针仍在 iframe 内时继续报告位置；离开后由宿主接管 */
export function postPanelDragMove(clientX: number, clientY: number): void {
  parent.postMessage({ type: 'imark:panelDragMove', clientX, clientY }, '*')
}

export function postPanelDragEnd(): void {
  parent.postMessage({ type: 'imark:panelDragEnd' }, '*')
}
