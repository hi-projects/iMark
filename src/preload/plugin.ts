/**
 * 沙箱插件页面的 preload —— **作者看到的 `window.imark` 就是这里造出来的**。
 *
 * 三条纪律(违反任意一条都会以很难查的方式坏掉):
 *
 * 1. **只 import `electron` 与 `@shared` 的类型/常量。** 别的依赖会被
 *    `externalizeDepsPlugin()` 变成运行时的 `require(...)`,而沙箱 preload 里没有
 *    require —— 报错是 `require is not defined`,在插件页面的控制台里,作者看不到。
 *    构建后 grep 一次产物里的 `require(`,应该只有 electron。
 * 2. **没有通用 invoke 透传。** 每个能力都是显式方法、显式 op 名。给一个
 *    `imark.request(op, args)` 就等于把主进程的能力表变成"只要知道名字就能调",
 *    而那正是权限闸门要挡的东西。
 * 3. **缺权限的能力不注入**(与 trusted 插件的 `imk.git === undefined` 同义)。
 *    这只是**塑形** —— 真正的判定每次都发生在主进程的闸门里,注入与否不影响安全,
 *    只影响作者看到的 API 形状。
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  PLUGIN_PAGE_EVENTS,
  RPC_BRIDGE,
  RPC_EVENT,
  RPC_INVOKE,
  type PluginBridgeCall,
  type PluginBridgeReply,
  type PluginHello,
  type PluginHostEvent,
  type PluginHostEventType,
  type PluginRpcResult
} from '@shared/pluginRpc'
import tokensCss from '@shared/theme/tokens.css?raw'

// ---------- 身份与权限(仅用于塑形;授权判定全在主进程) ----------

function argValue(prefix: string): string {
  const hit = process.argv.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ''
}

const pluginId = argValue('--imark-plugin-id=')
const pluginPerms = argValue('--imark-plugin-perms=')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const hasPerm = (p: string): boolean => pluginPerms.includes(p)

// 主题:令牌由 webFrame.insertCSS 注入 —— **不经过文档 fetch,CSP 的 style-src 拦不到它**。
// 另有一条同源的 /__imark/ui.css 供显式 <link>(见 windows.ts 的说明)。
webFrame.insertCSS(tokensCss)

/**
 * 主题在 `<html data-theme="…">` 上,令牌文件里的 `:root[data-theme='dark']` 才生效。
 *
 * preload 跑在文档存在**之前**,所以只能在 DOM 就绪后再写;而宿主推送的
 * hello / theme 事件会再覆盖一次(那是权威值)。
 *
 * 这里刻意不引入 DOM 的 lib 类型:preload 与主进程共用一份 tsconfig(node),
 * 为一个 `dataset` 把整个 DOM lib 打开,会让主进程里那些本该报错的
 * `document.xxx` 全都编译通过 —— 代价比收益大。
 */
interface MinimalDom {
  readyState: string
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void
  documentElement: { dataset: Record<string, string> }
}

const dom = (globalThis as { document?: MinimalDom }).document

function applyTheme(theme: string): void {
  const set = (): void => {
    if (dom) dom.documentElement.dataset.theme = theme || 'dark'
  }
  if (!dom) return
  if (dom.readyState === 'loading') dom.addEventListener('DOMContentLoaded', set, { once: true })
  else set()
}
applyTheme(argValue('--imark-plugin-theme='))

let callId = 0
async function call<T>(op: string, args?: unknown): Promise<T> {
  const id = ++callId
  const result = (await ipcRenderer.invoke(RPC_INVOKE, { id, op, args: args ?? {} })) as PluginRpcResult<T>
  if (result?.ok) return result.value
  const err = new Error(result?.error?.message ?? `调用 ${op} 失败`) as Error & { code?: string }
  err.code = result?.error?.code
  throw err
}

/** 调一次,失败只记日志(给"通知"这类不该打断流程的调用用) */
function callQuiet(op: string, args?: unknown): void {
  void call(op, args).catch(err => console.warn(`[imark] ${op} 失败:`, (err as Error).message))
}

// ---------- 宿主推来的事件 ----------

type HostEventName = PluginHostEventType

const listeners = new Map<HostEventName, Set<(payload: unknown) => void>>()
/** 每个类型的最后一份 payload:**晚订阅也能立刻拿到**(见 sandbox.ts 的说明) */
const lastPayload = new Map<HostEventName, unknown>()
/** 配置的本地缓存 —— getConfig() 是同步语义最常用的读法 */
let configCache: Record<string, unknown> = {}

ipcRenderer.on(RPC_EVENT, (_e, event: PluginHostEvent) => {
  const type = event?.type as HostEventName
  if (!type) return
  // 先缓存:晚订阅的人要靠它拿到"最后一份"(见 subscribe)
  lastPayload.set(type, event.payload)
  if (type === 'hello') {
    const hello = event.payload as PluginHello
    configCache = hello.config ?? configCache
    applyTheme(hello.theme)
    lastPayload.set('config', hello.config ?? {})
  }
  if (type === 'config') {
    configCache = (event.payload as { config: Record<string, unknown> })?.config ?? configCache
  }
  if (type === 'theme') applyTheme((event.payload as { theme: string })?.theme ?? 'dark')

  // **分发给订阅者**。少了这一段的话事件会被安静地缓存起来、谁也不知道 ——
  // 表现是"插件订阅了 tick,定时器也在跑,就是一个回调都不进"(验收实测过)。
  const set = listeners.get(type)
  if (!set) return
  for (const handler of set) {
    try {
      handler(event.payload)
    } catch (err) {
      console.error(`[imark] ${type} 的订阅回调抛错:`, err)
    }
  }
})

function subscribe(type: HostEventName, handler: (payload: unknown) => void): () => void {
  const set = listeners.get(type) ?? new Set()
  set.add(handler)
  listeners.set(type, set)
  // 已经有过的最后一份立刻补一发:作者在 onEnable 之后才订阅是常态
  if (lastPayload.has(type)) {
    try {
      handler(lastPayload.get(type))
    } catch (err) {
      console.error(`[imark] ${type} 订阅回调抛错:`, err)
    }
  }
  return () => {
    set.delete(handler)
  }
}

// ---------- 宿主 → 页面的反向调用(就是沙箱版的 PluginRuntime) ----------

interface PluginImpl {
  onEnable?: () => void | Promise<void>
  onDisable?: () => void | Promise<void>
  onConfigChange?: (config: Record<string, unknown>) => void | Promise<void>
  runAction?: (
    actionId: string,
    targetId: string | null,
    payload: unknown
  ) => unknown | Promise<unknown>
}

let impl: PluginImpl = {}

ipcRenderer.on(RPC_BRIDGE, (_e, msg: PluginBridgeCall) => {
  void (async () => {
    const reply = (r: PluginBridgeReply): void => {
      ipcRenderer.send(RPC_BRIDGE, { id: msg.id, reply: r })
    }
    try {
      if (msg.method === 'runAction') {
        const [actionId, targetId, payload] = msg.args as [string, string | null, unknown]
        if (impl.runAction) {
          reply({ ok: true, value: await impl.runAction(actionId, targetId ?? null, payload ?? null) })
          return
        }
        // 条目自带执行体的情况(`commands.register(cmd, run)` / `ui.statusItem(item, onClick)`)
        // ——那是个页面里的函数,宿主看不见它,只能桥回来找。找不到才是"没实现"。
        const local = runLocalContrib(actionId)
        reply(
          local
            ? { ok: true, value: { ok: true, message: '已执行' } }
            : { ok: false, error: { code: 'E_UNKNOWN_OP', message: '插件没有实现这个动作' } }
        )
        return
      }
      const fn = impl[msg.method]
      if (!fn) {
        reply({ ok: false, error: { code: 'E_UNKNOWN_OP', message: `插件没有实现 ${msg.method}` } })
        return
      }
      const value = await (fn as (...a: unknown[]) => unknown)(...(msg.args ?? []))
      reply({ ok: true, value: value ?? null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply({ ok: false, error: { code: 'E_FAILED', message } })
    }
  })()
})

// ---------- 作者 API ----------

const ui = Object.freeze({
  notify: (message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info'): void =>
    callQuiet('ui.notify', { message: String(message), level }),
  statusItem: (item: unknown, onClick?: () => void): void => {
    if (onClick) statusClick.set((item as { id?: string })?.id ?? '', onClick)
    callQuiet('ui.statusItem', { item: item ?? null })
  }
})

/** 状态栏/命令/菜单条目的**本地**执行体:它们在页面里,点一下要走桥回来 */
const statusClick = new Map<string, () => void>()
const commandRuns = new Map<string, () => void>()
const menuRuns = new Map<string, () => void>()

const commands = Object.freeze({
  register: (cmd: { id: string }, run?: () => void): void => {
    if (run && cmd?.id) commandRuns.set(cmd.id, run)
    callQuiet('command.register', { command: cmd })
  },
  remove: (id: string): void => {
    commandRuns.delete(id)
    callQuiet('command.remove', { id })
  }
})

const menus = Object.freeze({
  add: (item: { id: string }, run?: () => void): void => {
    if (run && item?.id) menuRuns.set(item.id, run)
    callQuiet('menu.item', { item })
  }
})

/** 这些本地执行体由主进程通过 bridge 的 runAction 触发(见上面 handle 的说明) */
function runLocalContrib(id: string): boolean {
  const fn = statusClick.get(id) ?? commandRuns.get(id) ?? menuRuns.get(id)
  if (!fn) return false
  void fn()
  return true
}

const windowApi = hasPerm('ui')
  ? Object.freeze({
      open: (): void => callQuiet('window.open'),
      close: (): void => callQuiet('window.close'),
      show: (): void => callQuiet('window.show'),
      hide: (): void => callQuiet('window.hide'),
      setTitle: (title: string): void => callQuiet('window.setTitle', { title: String(title) })
    })
  : undefined

const vaultApi = hasPerm('vault:read')
  ? Object.freeze({
      path: (): Promise<string | null> => call('vault.path'),
      exists: (path?: string): Promise<boolean> => call('vault.exists', { path }),
      read: (path: string): Promise<{ path: string; text: string }> => call('vault.read', { path }),
      list: (path?: string): Promise<{ name: string; dir: boolean }[]> => call('vault.list', { path }),
      ...(hasPerm('vault:write')
        ? {
            write: (path: string, text: string, opts?: { force?: boolean }): Promise<{ path: string }> =>
              call('vault.write', { path, text, ...(opts ?? {}) }),
            remove: (path: string): Promise<null> => call('vault.remove', { path })
          }
        : {})
    })
  : undefined

const secretsApi = hasPerm('secrets')
  ? Object.freeze({
      get: (fieldKey: string, targetId?: string): Promise<string | null> =>
        call('secrets.get', { fieldKey, targetId }),
      has: (fieldKey: string, targetId?: string): Promise<boolean> =>
        call('secrets.has', { fieldKey, targetId })
    })
  : undefined

const netApi = hasPerm('network')
  ? Object.freeze({
      fetch: (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: string }
      ): Promise<{
        status: number
        ok: boolean
        url: string
        headers: Record<string, string>
        body: string
        bodyBytes: number
      }> => call('net.fetch', { url, ...(init ?? {}) })
    })
  : undefined

const gitApi = hasPerm('git')
  ? Object.freeze({
      available: (): Promise<boolean> => call('git.available'),
      run: (
        args: string[],
        opts?: { cwd?: string; timeoutMs?: number }
      ): Promise<{ ok: boolean; code: number; stdout: string; stderr: string; aborted: boolean }> =>
        call('git.run', { args, ...(opts ?? {}) }),
      redact: (text: string): Promise<string> => call('git.redact', { text }),
      summarize: (text: string, maxLines?: number): Promise<string> =>
        call('git.summarize', { text, maxLines })
    })
  : undefined

const editorApi = hasPerm('editor:write')
  ? Object.freeze({
      insert: (text: string, cursorOffset?: number): Promise<boolean> =>
        call('editor.insert', { text, cursorOffset })
    })
  : undefined

const api = {
  plugin: Object.freeze({
    id: pluginId,
    /** 名称/版本/主题/仓库在 hello 到达后由宿主补全(页面不必自己拼) */
    get info(): PluginHello | null {
      return (lastPayload.get('hello') as PluginHello) ?? null
    },
    /**
     * 注册生命周期。**必须在脚本一开始就调用** —— 宿主在页面 did-finish-load 之后
     * 就会开始调 onEnable。
     */
    handle(next: PluginImpl): void {
      impl = next ?? {}
      callQuiet('plugin.ready')
    },
    /** 条目被点击时,宿主会桥回来找这里注册的执行体(见 runLocalContrib) */
    hasWindow: hasPerm('ui')
  }),
  log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
    callQuiet('log', { level, parts: args.map(safe) })
  },
  getConfig: <T = Record<string, unknown>>(): T => configCache as T,
  setState: (patch: unknown): void => callQuiet('state.set', patch),
  /**
   * 订阅宿主那边发生的事。
   *
   * 不认识的名字**明确报出来**(而不是静默地永远不触发)—— 页面里没有类型系统,
   * 写错一个字母的后果本该是作者自己看得见的一句话,不是一场对着空白的排查。
   */
  on: (event: string, handler: (payload: unknown) => void): (() => void) => {
    if (!PLUGIN_PAGE_EVENTS.includes(event as HostEventName)) {
      console.warn(
        `[imark] 不认识的事件「${event}」。可用:${PLUGIN_PAGE_EVENTS.join(' / ')}` +
          `(一次性事件——主题、仓库、打开文件——订阅时会立刻收到当前值)`
      )
      return () => {}
    }
    return subscribe(event as HostEventName, handler)
  },
  ui,
  commands,
  menus,
  document: Object.freeze({ flush: (): Promise<null> => call('document.flush') }),
  schedule: Object.freeze({
    every: (ms: number, name: string): void => callQuiet('schedule.every', { ms, name }),
    clear: (name: string): void => callQuiet('schedule.clear', { name })
  }),
  ...(windowApi ? { window: windowApi } : {}),
  ...(vaultApi ? { vault: vaultApi } : {}),
  ...(secretsApi ? { secrets: secretsApi } : {}),
  ...(netApi ? { net: netApi } : {}),
  ...(gitApi ? { git: gitApi } : {}),
  ...(editorApi ? { editor: editorApi } : {})
}

/** 参数过一遍 JSON,跨 contextBridge 时不会因为函数/循环引用直接抛 */
function safe(v: unknown): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

contextBridge.exposeInMainWorld('imark', Object.freeze(api))
