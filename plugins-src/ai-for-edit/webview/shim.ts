/**
 * 旧 render-layer API 在 webview 里的实现。
 *
 * render.ts 是按「同步拿 CM6 视图、同步 dispatch、同步读配置」写的。v2 里它跑在
 * 跨源 sandbox iframe 中，拿不到编辑器视图，于是这里伪造一个最小 API：
 *
 *   - `imk.plugin.getConfig()`     读扩展宿主随 HTML 注入、配置变化时推送的快照；
 *   - `imk.main.send/onMessage`    映射成 postMessage（消息形状与 v1 相同）；
 *   - `imk.markdown.render()`      请求宿主调用应用自己的 markdown-it；
 *   - `imk.editor.getView()`       用宿主推送的文档快照拼出伪 EditorView；
 *   - `view.dispatch()`            本地乐观更新 + 请求宿主执行 TextEditor.edit。
 *
 * 文档快照由扩展宿主在活动编辑器/选区/内容变化时推送；版本号只用于诊断，
 * 真正的一致性判断仍然是 render.ts 自己的「original === 当前文本」。
 */

import type {
  ImkRenderLayerApi,
  LegacyDocState,
  LegacyDocumentRef,
  LegacyEditorView,
  LegacyPluginHooks
} from '../legacy'
import { announceReady, applyTheme, postToHost, readBootstrap } from './shared'

interface DocSnapshot {
  key: string
  fileName: string
  filePath: string | null
  version: number
  text: string
  selectionHead: number
  editable: boolean
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: number
}

const bootstrap = readBootstrap()
let config: Record<string, unknown> = bootstrap.config
let hooks: LegacyPluginHooks | null = null
let started = false

let doc: DocSnapshot = {
  key: 'no-document',
  fileName: '未关联文档',
  filePath: null,
  version: 0,
  text: '',
  selectionHead: 0,
  editable: false
}

const requestSeq = { value: 0 }
const pending = new Map<string, PendingRequest>()
const messageListeners = new Set<(channel: string, data: unknown) => void>()
const docListeners = new Set<() => void>()
const MARKDOWN_TIMEOUT_MS = 30_000
const EDIT_TIMEOUT_MS = 10_000

/** `state.facet(editable)` 的哨兵；只有它返回快照里的 editable */
const EDITABLE_FACET = Object.freeze({ name: 'imark.editable' })

function nextRequestId(): string {
  requestSeq.value += 1
  return `w${Date.now().toString(36)}-${requestSeq.value}`
}

function request(
  kind: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const id = nextRequestId()
  return new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error('编辑器没有响应，请重试'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    postToHost({ type: 'request', id, kind, ...payload })
  })
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), length)
}

function notifyDocChanged(): void {
  for (const listener of docListeners) {
    try {
      listener()
    } catch {
      /* 界面代码自己的异常不应该打断文档同步 */
    }
  }
}

function replaceDoc(next: Partial<DocSnapshot>): void {
  doc = {
    ...doc,
    ...next,
    text: typeof next.text === 'string' ? next.text : doc.text,
    selectionHead: clampOffset(
      typeof next.selectionHead === 'number' ? next.selectionHead : doc.selectionHead,
      typeof next.text === 'string' ? next.text.length : doc.text.length
    )
  }
}

const state: LegacyDocState = {
  get doc() {
    return {
      length: doc.text.length,
      toString: () => doc.text
    }
  },
  get selection() {
    return { main: { head: doc.selectionHead } }
  },
  facet: facet => (facet === EDITABLE_FACET ? doc.editable : undefined)
}

const view: LegacyEditorView = {
  state,
  dispatch(spec) {
    const changes = spec.changes
    if (!changes) {
      if (spec.selection) replaceDoc({ selectionHead: spec.selection.anchor })
      return
    }
    const from = clampOffset(changes.from, doc.text.length)
    const to = clampOffset(changes.to ?? changes.from, doc.text.length)
    const insert = typeof changes.insert === 'string' ? changes.insert : ''
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    const text = `${doc.text.slice(0, start)}${insert}${doc.text.slice(end)}`
    replaceDoc({
      text,
      version: doc.version + 1,
      selectionHead:
        spec.selection?.anchor ?? start + insert.length
    })
    // 宿主会返回权威快照；这里的本地更新只为让确认按钮、上下文条立刻反映结果
    void request(
      'doc.applyEdits',
      {
        key: doc.key,
        edits: [{ from: start, to: end, insert }],
        ...(spec.selection ? { selection: spec.selection.anchor } : {})
      },
      EDIT_TIMEOUT_MS
    ).catch(() => undefined)
    notifyDocChanged()
  }
}

const imk: ImkRenderLayerApi = {
  plugin: {
    log(level, message) {
      postToHost({ type: 'legacy', channel: 'log', data: { level, message } })
    },
    getConfig<T>(): T {
      return config as T
    },
    handle(next) {
      hooks = next
      if (started) return
      started = true
      hooks.onEnable?.()
      // onEnable 已装好监听、创建面板 DOM；此后 renderer 才会发 bootstrap 与文档
      announceReady()
    },
    close() {
      postToHost({ type: 'close' })
    }
  },
  main: {
    send(channel, payload) {
      postToHost({ type: 'legacy', channel, data: payload })
      return Promise.resolve()
    },
    onMessage(callback) {
      messageListeners.add(callback)
      return () => messageListeners.delete(callback)
    }
  },
  markdown: {
    render(text) {
      return request('markdown.render', { text }, MARKDOWN_TIMEOUT_MS).then(value => {
        if (typeof value !== 'string') throw new Error('Markdown 预览返回了非文本内容')
        return value
      })
    }
  },
  editor: {
    getView() {
      return view
    },
    getDocumentRef(): LegacyDocumentRef {
      return { key: doc.key, fileName: doc.fileName, filePath: doc.filePath }
    },
    onDocChanged(callback) {
      docListeners.add(callback)
      return () => docListeners.delete(callback)
    },
    kit: {
      view: {
        EditorView: { editable: EDITABLE_FACET }
      }
    }
  }
}

function onHostMessage(message: unknown): void {
  if (!message || typeof message !== 'object') return
  const data = message as Record<string, unknown>
  switch (data.type) {
    case 'legacy': {
      const channel = typeof data.channel === 'string' ? data.channel : ''
      if (!channel) return
      for (const listener of messageListeners) {
        try {
          listener(channel, data.data)
        } catch {
          /* 单个处理器失败不影响其他处理器 */
        }
      }
      return
    }
    case 'response': {
      const id = typeof data.id === 'string' ? data.id : ''
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      window.clearTimeout(entry.timer)
      if (data.ok === false) {
        entry.reject(new Error(typeof data.error === 'string' ? data.error : '请求失败'))
      } else {
        entry.resolve(data.value)
      }
      return
    }
    case 'doc': {
      const next = data.doc
      if (!next || typeof next !== 'object') return
      replaceDoc(next as Partial<DocSnapshot>)
      notifyDocChanged()
      return
    }
    case 'config': {
      if (!data.config || typeof data.config !== 'object') return
      config = data.config as Record<string, unknown>
      try {
        hooks?.onConfigChange?.()
      } catch {
        /* 配置变化引发的界面异常不应该打断后续更新 */
      }
      return
    }
    default:
      return
  }
}

window.addEventListener('message', event => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  const type = (data as { type?: unknown }).type
  if (type === 'imark:bootstrap') {
    applyTheme((data as { theme?: unknown }).theme)
    return
  }
  if (type === 'imark:theme') {
    applyTheme((data as { theme?: unknown }).theme)
    return
  }
  if (type === 'imark:message') {
    onHostMessage((data as { message?: unknown }).message)
  }
})

// render.ts 在模块末尾调用 `imk.plugin.handle(...)`，因此这个全局必须在它之前就绪
;(globalThis as typeof globalThis & { imk: ImkRenderLayerApi }).imk = imk
