/**
 * 扩展 webview 在渲染层的状态与消息路由。
 *
 * main 是面板元数据的真身，renderer 只是把它画成 sandbox iframe：
 *   - `webview.create` / `webview.update` / `webview.html` 更新本地视图；
 *   - iframe 里的页面通过 `postMessage` 说话，renderer 按 event.source 认出是哪个
 *     面板，再转成 `webview.message` 发给 main（main 按记录里的扩展 ID 路由）；
 *   - 扩展发来的消息在页面就绪（`imark:ready`）之前排队，避免面板首帧丢消息。
 *
 * iframe 的 origin 是 `imark-webview://<extensionId>`，与应用不同源；主题变量与
 * bootstrap 都只能用 postMessage 送进去，不能碰它的 DOM。
 */

import { reactive } from 'vue'
import { EXTENSION_WEBVIEW_SCHEME } from '@shared/extensionProtocol'
import type { MainToRendererMessage, WebviewPanelStateDto } from '@shared/extensionProtocol'
import { api } from './api'
import { readTheme } from './editorBridge'

export interface RendererWebviewPanel extends WebviewPanelStateDto {
  extensionId: string
  viewType: string
  retainContextWhenHidden: boolean
  html: string
  token: string
  /** 每次 html 更新 +1；iframe 的 src 带上它强制重载 */
  rev: number
}

export const webviewStore = reactive<{ panels: Record<string, RendererWebviewPanel> }>({
  panels: {}
})

const frames = new Map<string, HTMLIFrameElement>()
const ready = new Set<string>()
const queues = new Map<string, unknown[]>()

function panelOf(panelId: string): RendererWebviewPanel | null {
  return webviewStore.panels[panelId] ?? null
}

function removePanel(panelId: string): void {
  delete webviewStore.panels[panelId]
  frames.delete(panelId)
  ready.delete(panelId)
  queues.delete(panelId)
}

function upsertPanel(
  panel: WebviewPanelStateDto & {
    extensionId: string
    viewType: string
    retainContextWhenHidden: boolean
    html: string
    token: string
  }
): void {
  const existing = panelOf(panel.panelId)
  const next: RendererWebviewPanel = {
    ...panel,
    rev: existing?.rev ?? 0
  }
  // HTML 或 token 变了：iframe 需要重载，重载期间的消息重新排队
  if (existing && (existing.html !== panel.html || existing.token !== panel.token)) {
    next.rev = existing.rev + 1
    ready.delete(panel.panelId)
  }
  webviewStore.panels[panel.panelId] = next
}

function applyMainMessage(message: MainToRendererMessage): void {
  switch (message.type) {
    case 'extensions.webviewPanels': {
      const seen = new Set<string>()
      for (const panel of message.panels) {
        seen.add(panel.panelId)
        upsertPanel(panel)
      }
      // 快照就是全量：不在这里面的面板已经不存在于 main 的登记表
      for (const panelId of Object.keys(webviewStore.panels)) {
        if (!seen.has(panelId)) removePanel(panelId)
      }
      return
    }
    case 'webview.create':
      upsertPanel(message.panel)
      return
    case 'webview.update': {
      const current = panelOf(message.panel.panelId)
      if (!current) return
      webviewStore.panels[message.panel.panelId] = { ...current, ...message.panel }
      return
    }
    case 'webview.html': {
      const current = panelOf(message.panelId)
      if (!current) return
      webviewStore.panels[message.panelId] = {
        ...current,
        html: message.html,
        rev: current.rev + 1
      }
      ready.delete(message.panelId)
      return
    }
    case 'webview.postMessage':
      sendToFrame(message.panelId, { type: 'imark:message', message: message.message })
      return
    case 'webview.dispose':
      removePanel(message.panelId)
      return
    case 'webview.injectTheme':
      sendToFrame(message.panelId, {
        type: 'imark:theme',
        theme: { kind: readTheme().kind, colors: message.colors }
      })
      return
    default:
      return
  }
}

function targetOrigin(panel: RendererWebviewPanel): string {
  return `${EXTENSION_WEBVIEW_SCHEME}://${panel.extensionId}`
}

function sendToFrame(panelId: string, payload: unknown): void {
  const panel = panelOf(panelId)
  if (!panel) return
  const iframe = frames.get(panelId)
  if (!iframe || !ready.has(panelId)) {
    const queue = queues.get(panelId) ?? []
    queue.push(payload)
    queues.set(panelId, queue)
    return
  }
  iframe.contentWindow?.postMessage(payload, targetOrigin(panel))
}

// ---------- 供组件调用 ----------

export function frameUrl(panel: RendererWebviewPanel): string {
  const token = encodeURIComponent(panel.token)
  return `${EXTENSION_WEBVIEW_SCHEME}://${panel.extensionId}/__imark_panel__/index.html?token=${token}&rev=${panel.rev}`
}

export function allPanels(): RendererWebviewPanel[] {
  return Object.values(webviewStore.panels)
}

export function attachFrame(panelId: string, element: HTMLIFrameElement | null): void {
  if (element) frames.set(panelId, element)
  else {
    frames.delete(panelId)
    ready.delete(panelId)
  }
}

export function closePanel(panelId: string): void {
  if (!panelOf(panelId)) return
  // 先告诉 main：它会移除记录并通知扩展 panel.onDidDispose
  api.sendExtensionMessage({ type: 'webview.disposed', panelId })
  removePanel(panelId)
}

function markReady(panelId: string): void {
  const panel = panelOf(panelId)
  if (!panel) return
  ready.add(panelId)
  const iframe = frames.get(panelId)
  if (iframe) {
    iframe.contentWindow?.postMessage(
      {
        type: 'imark:bootstrap',
        panelId,
        extensionId: panel.extensionId,
        theme: readTheme()
      },
      targetOrigin(panel)
    )
  }
  const queue = queues.get(panelId)
  queues.delete(panelId)
  for (const payload of queue ?? []) {
    iframe?.contentWindow?.postMessage(payload, targetOrigin(panel))
  }
  // 页面就绪即视为可见且活动；隐藏由组件在切换时报告
  api.sendExtensionMessage({ type: 'webview.viewState', panelId, visible: true, active: true })
}

export type PanelDragPhase = 'start' | 'move' | 'end'

/** 浮动面板的拖动事件；x/y 已换算成窗口坐标 */
export interface PanelDragEvent {
  panelId: string
  frame: HTMLIFrameElement
  x: number
  y: number
}

const dragListeners = new Set<(phase: PanelDragPhase, event: PanelDragEvent) => void>()

/**
 * 订阅浮动面板的拖动事件。
 *
 * 透明小人的按下区域在跨源 iframe 里，指针一旦移出 iframe 就收不到事件。页面负责
 * 报告 start/move/end，WebviewHost 在 window 上接管 iframe 外的移动（必要时铺一层
 * 全窗口遮罩，防止指针重新进入 iframe 后丢失事件）。
 */
export function onPanelDrag(
  listener: (phase: PanelDragPhase, event: PanelDragEvent) => void
): () => void {
  dragListeners.add(listener)
  return () => dragListeners.delete(listener)
}

const DRAG_TYPES = new Set([
  'imark:panelDragStart',
  'imark:panelDragMove',
  'imark:panelDragEnd'
])

function onWindowMessage(event: MessageEvent): void {
  const data = event.data as
    | { type?: unknown; message?: unknown; clientX?: unknown; clientY?: unknown }
    | null
    | undefined
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return
  if (data.type !== 'imark:ready' && data.type !== 'imark:message' && !DRAG_TYPES.has(data.type)) {
    return
  }

  // 必须来自某个登记在案的 iframe，且 origin 与它归属的扩展一致
  let panel: RendererWebviewPanel | null = null
  let sourceFrame: HTMLIFrameElement | null = null
  for (const [panelId, iframe] of frames) {
    if (iframe.contentWindow === event.source) {
      panel = panelOf(panelId)
      if (panel && event.origin !== targetOrigin(panel)) return
      if (panel) {
        sourceFrame = iframe
        break
      }
    }
  }
  if (!panel) return

  if (data.type === 'imark:ready') {
    markReady(panel.panelId)
    return
  }
  if (DRAG_TYPES.has(data.type)) {
    // 只有浮动面板可以拖；start/move 的坐标是 iframe 视口内的 client 坐标
    if (panel.presentation !== 'floating' || !sourceFrame) return
    const phase: PanelDragPhase =
      data.type === 'imark:panelDragStart'
        ? 'start'
        : data.type === 'imark:panelDragMove'
          ? 'move'
          : 'end'
    const rect = sourceFrame.getBoundingClientRect()
    let x = rect.left
    let y = rect.top
    if (phase !== 'end') {
      if (typeof data.clientX !== 'number' || typeof data.clientY !== 'number') return
      if (!Number.isFinite(data.clientX) || !Number.isFinite(data.clientY)) return
      x += data.clientX
      y += data.clientY
    }
    const payload: PanelDragEvent = { panelId: panel.panelId, frame: sourceFrame, x, y }
    for (const listener of dragListeners) listener(phase, payload)
    return
  }
  api.sendExtensionMessage({
    type: 'webview.message',
    panelId: panel.panelId,
    message: data.message
  })
}

export function initWebviews(): () => void {
  const off = api.onExtensionMessage(applyMainMessage)
  window.addEventListener('message', onWindowMessage)
  return () => {
    off()
    window.removeEventListener('message', onWindowMessage)
  }
}
