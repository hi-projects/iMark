/**
 * webview 通用启动与消息层。
 *
 * - 应用渲染层送来的主题变量；
 * - 封装 request/response 与 host push；
 * - 不 import 任何宿主/Node 模块。
 */

export interface ThemePayload {
  colors?: Record<string, string>
}

export interface HostResponse {
  type: 'response'
  id: string
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string; detail?: string }
}

export interface HostPush {
  type: 'push'
  kind: string
  value: unknown
}

type PushHandler = (push: HostPush) => void

const pending = new Map<
  string,
  {
    resolve(value: unknown): void
    reject(error: Error & { code?: string; detail?: string }): void
    timer: number
  }
>()
const pushHandlers = new Set<PushHandler>()
let installed = false
let requestSeq = 0

function install(): void {
  if (installed) return
  installed = true
  window.addEventListener('message', event => {
    const data = event.data as
      | { type?: string; message?: unknown; theme?: unknown; panelId?: string }
      | undefined
    if (!data || typeof data !== 'object') return

    if (data.type === 'imark:bootstrap' || data.type === 'imark:theme') {
      applyTheme(data.theme)
      return
    }

    if (data.type !== 'imark:message') return
    const message = data.message as HostResponse | HostPush | undefined
    if (!message || typeof message !== 'object') return
    if (message.type === 'response') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      window.clearTimeout(entry.timer)
      if (message.ok) {
        entry.resolve(message.value)
      } else {
        const error = new Error(message.error?.message || '请求失败') as Error & {
          code?: string
          detail?: string
        }
        error.code = message.error?.code
        error.detail = message.error?.detail
        entry.reject(error)
      }
      return
    }
    if (message.type === 'push') {
      for (const handler of [...pushHandlers]) {
        try {
          handler(message)
        } catch (err) {
          console.error('[agent] push handler failed', err)
        }
      }
    }
  })
}

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

export function postToHost(message: unknown): void {
  parent.postMessage({ type: 'imark:message', message }, '*')
}

export function announceReady(): void {
  parent.postMessage({ type: 'imark:ready' }, '*')
}

export function onPush(handler: PushHandler): void {
  install()
  pushHandlers.add(handler)
}

export function request<T = unknown>(
  kind: string,
  payload?: unknown,
  timeoutMs = 30_000
): Promise<T> {
  install()
  requestSeq += 1
  const id = `r${Date.now().toString(36)}-${requestSeq}`
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error(`请求超时：${kind}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => resolve(value as T),
      reject,
      timer
    })
    postToHost({ type: 'request', id, kind, payload })
  })
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
