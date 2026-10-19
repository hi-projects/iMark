/**
 * **render 层**执行端(主窗口渲染进程)。
 *
 * 它是主进程 `renderLayer.ts` 的对端:
 *   主进程注入 `(function (imk) { … })(window.__imkRenderLayerApi(nonce))`
 *   → 这里的 `takeApi(nonce)` 把一次性 nonce 换成绑定到该插件的 API 对象。
 *
 * 设计要点:
 *   1. **nonce 一次性、只存在于注入字符串里**。其他页面脚本观察不到它,也伪造不了
 *      "我是插件 B"(拿不到 B 的 nonce)。API 对象是冻结的。
 *   2. **render 层没有任何宿主系统能力**。它拿到的只有:编辑器(CM6/DOM)、配置快照、
 *      setState/log,以及与**自己** main 层的消息。文件/网络/git/密钥全部走 main。
 *   3. 插件脚本必须**同步**调用 `imk.plugin.handle({...})`:主进程在注入完成后
 *      立刻要求执行 onEnable。
 *   4. 停用/卸载时,它注册的 CM6 扩展由 `pluginExtensions.ts` 按插件 id 精确移除;
 *      插件自己挂的 DOM/定时器靠它实现的 onDisable 收敛(尽力而为,彻底干净需重载窗口)。
 */
import type { Extension } from '@codemirror/state'
import type {
  ImkLayerChannel,
  ImkLogLevel,
  ImkRenderLayerApi,
  ImkRenderLayerEditorApi,
  RenderLayerImpl
} from '@shared/pluginApi'
import type { PluginState, RenderHalfMessage, RendererOpRequest } from '@shared/plugins'
import { editorKit, getEditorView, onEditorDocChanged } from '../editor/pluginSdk'
import { registerPluginExtension, unregisterAllPluginExtensions } from '../editor/pluginExtensions'
import { appStore } from '../stores/app'
import { renderMarkdownFragment } from './exportHtml'
import { api } from './api'

interface Session {
  id: string
  name: string
  version: string
  config: Record<string, unknown>
  hasMain: boolean
  impl: RenderLayerImpl | null
  nonce: string | null
  messageListeners: Set<(channel: string, data: unknown) => void>
}

const sessions = new Map<string, Session>()
/** nonce → pluginId(一次性;取走即删) */
const nonceOwners = new Map<string, string>()
let installed = false

const CHANNEL_RE = /^[A-Za-z0-9._-]{1,64}$/

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function logLocal(id: string, ...args: unknown[]): void {
  console.warn(`[plugin:${id}]`, ...args)
}

/** nonce 换 API。**一次性**:第二个调用者(包括同一插件的重复调用)只能拿到 null。 */
function takeApi(nonce: string): ImkRenderLayerApi | null {
  const id = nonceOwners.get(nonce)
  if (!id) return null
  nonceOwners.delete(nonce)
  const session = sessions.get(id)
  if (!session) return null
  return makeApi(session)
}

function makeApi(session: Session): ImkRenderLayerApi {
  const id = session.id

  const main: ImkLayerChannel = Object.freeze({
    send: async (channel: string, data: unknown): Promise<void> => {
      if (!session.hasMain) throw new Error('这个插件没有 main 层,消息无处投递')
      if (!CHANNEL_RE.test(channel)) {
        throw new Error('channel 只能包含字母、数字与 . _ -(≤64 字符)')
      }
      api.sendRenderMessage(id, channel, data ?? null)
    },
    onMessage: (handler: (channel: string, data: unknown) => void): (() => void) => {
      session.messageListeners.add(handler)
      return () => {
        session.messageListeners.delete(handler)
      }
    }
  })

  const editor: ImkRenderLayerEditorApi = Object.freeze({
    getView: () => getEditorView(),
    onDocChanged: (handler: () => void) => onEditorDocChanged(id, handler),
    registerExtension: (extension: Extension) => {
      if (!extension || typeof extension !== 'object') {
        throw new Error('registerExtension 需要一个 CM6 扩展对象(用 imk.editor.kit 里的构造器构建)')
      }
      return registerPluginExtension(id, extension)
    },
    kit: editorKit
  })

  /**
   * Markdown → HTML 片段。用宿主自己的 markdown-it 实例渲染，插件不必也不应该
   * 自带一份；`html:false` 保证原始 HTML 被转义，链接也走宿主默认的白名单校验。
   */
  const markdown = Object.freeze({
    render: (text: string): Promise<string> =>
      renderMarkdownFragment(String(text ?? ''), appStore.theme === 'light' ? 'light' : 'dark')
  })

  return Object.freeze({
    plugin: Object.freeze({
      id,
      name: session.name,
      version: session.version,
      getConfig: <T,>() => session.config as T,
      setState: (patch: {
        status?: 'idle' | 'running' | 'ok' | 'error'
        lastMessage?: string
        lastDetail?: string
      }): void => {
        api.notifyRenderState(id, patch as Partial<PluginState>)
      },
      handle: (impl: RenderLayerImpl): void => {
        session.impl = impl && typeof impl === 'object' ? impl : {}
      },
      log: (level: ImkLogLevel, ...args: unknown[]): void => {
        api.notifyRenderLog(id, level, args.map(stringify).join(' ').slice(0, 4000))
      }
    }),
    editor,
    markdown,
    main
  })
}

// ---------- 宿主调用入口(pluginHostOps 把它接在 RendererOpRequest 上) ----------

function prepare(id: string, raw: unknown): null {
  const args = (raw ?? {}) as {
    nonce?: unknown
    config?: unknown
    hasMain?: unknown
    name?: unknown
    version?: unknown
  }
  if (typeof args.nonce !== 'string' || args.nonce.length < 16) {
    throw new Error('render.prepare 缺少合法的 nonce')
  }
  const previous = sessions.get(id)
  if (previous?.nonce) nonceOwners.delete(previous.nonce)
  const session: Session = {
    id,
    name: typeof args.name === 'string' ? args.name : id,
    version: typeof args.version === 'string' ? args.version : '',
    config: (args.config && typeof args.config === 'object' ? args.config : {}) as Record<
      string,
      unknown
    >,
    hasMain: args.hasMain === true,
    impl: null,
    nonce: args.nonce,
    messageListeners: new Set()
  }
  sessions.set(id, session)
  nonceOwners.set(args.nonce, id)
  return null
}

async function enable(id: string): Promise<null> {
  const session = sessions.get(id)
  if (!session) throw new Error('render 层还没有准备好(宿主没有登记 nonce)')
  if (!session.impl) {
    throw new Error('插件没有调用 imk.plugin.handle({...}) —— 生命周期必须在脚本顶层同步登记')
  }
  await session.impl.onEnable?.()
  return null
}

async function config(id: string, raw: unknown): Promise<null> {
  const session = sessions.get(id)
  if (!session) return null
  const next = (raw as { config?: unknown } | null)?.config
  session.config =
    next && typeof next === 'object' ? (next as Record<string, unknown>) : {}
  await session.impl?.onConfigChange?.(session.config)
  return null
}

async function runAction(id: string, raw: unknown): Promise<unknown> {
  const args = (raw ?? {}) as { actionId?: unknown; targetId?: unknown; payload?: unknown }
  const session = sessions.get(id)
  if (!session?.impl?.runAction) {
    return { ok: false, message: '插件没有实现这个动作(render 层没有 runAction)' }
  }
  return session.impl.runAction(
    String(args.actionId ?? ''),
    (args.targetId as string | null | undefined) ?? null,
    args.payload ?? null
  )
}

async function unload(id: string): Promise<null> {
  const session = sessions.get(id)
  if (!session) return null
  try {
    await session.impl?.onDisable?.()
  } catch (err) {
    logLocal(id, 'onDisable 抛错(已忽略):', err)
  }
  // CM6 扩展按插件 id 精确移除;插件自己挂的 DOM/定时器只能靠它自己的 onDisable
  unregisterAllPluginExtensions(id)
  if (session.nonce) nonceOwners.delete(session.nonce)
  sessions.delete(id)
  return null
}

/** pluginHostOps 把 render.* 请求转到这里 */
export function handleRenderOp(req: RendererOpRequest): unknown {
  switch (req.op) {
    case 'render.prepare':
      return prepare(req.pluginId, req.args)
    case 'render.enable':
      return enable(req.pluginId)
    case 'render.config':
      return config(req.pluginId, req.args)
    case 'render.runAction':
      return runAction(req.pluginId, req.args)
    case 'render.unload':
      return unload(req.pluginId)
    default:
      return undefined
  }
}

/** 主进程推来的 main → render 消息 */
export function deliverRenderMessage(message: RenderHalfMessage): void {
  const session = sessions.get(message.pluginId)
  if (!session) return
  for (const handler of session.messageListeners) {
    try {
      handler(message.channel, message.data)
    } catch (err) {
      logLocal(message.pluginId, '消息处理器抛错:', err)
    }
  }
}

/**
 * 启动时安装一次:
 *   - 用不可写/不可配置的属性装 `__imkRenderLayerApi`(后加载的插件改不掉它);
 *   - 订阅主进程推来的"main → render"消息。
 */
export function initRenderLayer(): void {
  if (installed) return
  installed = true
  Object.defineProperty(window, '__imkRenderLayerApi', {
    value: takeApi,
    writable: false,
    configurable: false
  })
  api.onRenderMessage(deliverRenderMessage)
}
