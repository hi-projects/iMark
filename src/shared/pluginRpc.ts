/**
 * 沙箱插件的 RPC 契约 —— preload 与主进程共用的一份。
 *
 * 为什么值得单独成文件:这条通道的两端在两个不同的 JS 世界里(preload 是沙箱里
 * 唯一能碰 electron 的地方,主进程是唯一能做判断的地方),而它们必须对
 * 「通道名、请求形状、错误码、事件类型」逐字一致。任何一边私下改一个字,
 * 症状都是"插件静默收不到东西",而不是一个报错。
 *
 * 三条贯穿全程的设计:
 *
 * 1. **主进程永远 resolve,不 throw。** 请求失败也返回 `{ok:false, error}`。
 *    throw 会让异常信息跨不过 contextBridge(它只传结构化克隆得了的东西),
 *    作者看到的是 `Error: An object could not be cloned` —— 与真实原因毫无关系。
 * 2. **身份永远由主进程反查。** 通道里**没有 pluginId 字段**:主进程用
 *    `event.sender.id` 去自己的注册表里查这是谁。页面能伪造的只有自己的参数,
 *    伪造不了身份。
 * 3. **能力是 op 名 + 参数**,不是"把函数名传过来执行"。主进程只认自己表里的 op,
 *    表外的名字一律 `E_UNKNOWN_OP`。这就是"没有通用 invoke 透传"的实现方式。
 */

/** 插件页 → 主进程:一次能力调用(ipcRenderer.invoke) */
export const RPC_INVOKE = 'plugin:rpc'
/** 插件页 → 主进程:取消一个还在飞的调用(ipcRenderer.send) */
export const RPC_ABORT = 'plugin:rpc-abort'
/** 主进程 → 插件页:宿主里发生的事(hello / 配置变化 / 主题 / tick…) */
export const RPC_EVENT = 'plugin:event'
/** 主进程 → 插件页:反向调用插件(就是沙箱版的 PluginRuntime) */
export const RPC_BRIDGE = 'plugin:bridge'

/**
 * 错误码。
 *
 * 分这么细是为了让**作者能自己看懂**:`E_PERMISSION` 是"去清单里加权限并让用户重新确认",
 * `E_BAD_ARGS` 是"你参数写错了",`E_TIMEOUT` 是"你太慢了"。全都归成一个 'failed'
 * 的话,作者只能来问宿主作者。
 */
export type PluginRpcErrorCode =
  /** 清单里没声明这个能力 */
  | 'E_PERMISSION'
  /** 参数不合法(含超长、非法路径、越界数值) */
  | 'E_BAD_ARGS'
  /** 超过时限 */
  | 'E_TIMEOUT'
  /** 频率/并发超限,等会儿再试 */
  | 'E_BUSY'
  /** 不认识的 op(含宿主这版还没实现的能力) */
  | 'E_UNKNOWN_OP'
  /** op 本身失败(文件不存在、git 非零退出、网络错误…) */
  | 'E_FAILED'
  /** 宿主内部错误 */
  | 'E_INTERNAL'

export interface PluginRpcError {
  code: PluginRpcErrorCode
  /** 给作者看的一句话。**必须自包含**:作者手里只有这句话 */
  message: string
  /** 可选补充(如 git stderr、路径),已脱敏 */
  detail?: string
}

export type PluginRpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: PluginRpcError }

/** 一次调用的线上形状 */
export interface PluginRpcRequest {
  /**
   * 调用序号。**由 preload 生成、原样回传** —— 主进程只负责把它带回来,
   * 这样 preload 能对上号(并让 AbortSignal 知道该撤哪一次)。
   */
  id: number
  /** 能力名(见 main/plugins/ops.ts 的表) */
  op: string
  args: unknown
}

export interface PluginRpcAbort {
  id: number
}

// ---------- 主进程 → 插件页的事 ----------

/**
 * 推给插件页的事件类型。
 *
 * **都是通知,没有回执**:插件要么收到、要么还没订阅(所以 preload 会缓存
 * 每个类型的最后一份 payload,晚订阅也立刻能拿到)。
 */
export type PluginHostEventType =
  | 'hello'
  | 'config'
  | 'theme'
  | 'vault'
  | 'doc-saved'
  /** 打开了另一个文件(路径;未保存的新文档为 null) */
  | 'file-open'
  /**
   * 文档内容变了。**宿主已经节流**(最快约 400ms 一次)——
   * 它的粒度是"用户在写字",不是"每一次按键"。
   */
  | 'doc-changed'
  | 'tick'

/** 页面上能订阅的事件名白名单(写错了要报出来,而不是永远收不到) */
export const PLUGIN_PAGE_EVENTS: PluginHostEventType[] = [
  'hello',
  'config',
  'theme',
  'vault',
  'doc-saved',
  'file-open',
  'doc-changed',
  'tick'
]

export interface PluginHostEvent {
  type: PluginHostEventType
  payload: unknown
}

/** `hello`:页面一起来就给一份"我是谁、现在是什么状态" */
export interface PluginHello {
  pluginId: string
  name: string
  version: string
  /** 已生效的权限(注意是 effective = 用户同意的 ∩ 清单声明的) */
  permissions: string[]
  theme: string
  vaultPath: string | null
  /** 当前配置(已按字段表归一化);之后变更走 `config` 事件 */
  config: Record<string, unknown>
  /** main 层模式(restricted 页面永远看到 'restricted') */
  mode: 'restricted' | 'node'
  /** 有没有 render 层(有的话可以经 imark.render 发消息) */
  hasRender: boolean
}

/** `tick`:宿主调度器到点了(见 ops 的 schedule.every) */
export interface PluginTick {
  name: string
  /** 距离"本该到点"迟了多久。窗口被节流/休眠过时这个数会明显大于 0 */
  lateMs: number
}

/**
 * 反向调用:主进程请插件做一件事。
 *
 * 这就是沙箱版的 `PluginRuntime` —— 与 trusted 插件的 onEnable/onDisable/
 * onConfigChange/runAction 一一对应,所以 host.ts 的 `safeCall`(超时、失败计数、
 * 熔断、回滚)在沙箱插件上一行都不用改,两边共用同一套。
 */
export interface PluginBridgeCall {
  id: number
  /**
   * PluginRuntime 上的方法名;`renderMessage` 是同插件的 render 层发来的消息
   * (restricted main 用它接 render 的消息,不走生命周期)。
   */
  method: 'onEnable' | 'onDisable' | 'onConfigChange' | 'runAction' | 'renderMessage'
  args: unknown[]
}

/**
 * 页面对反向调用的应答。
 *
 * 页面没注册对应方法时返回 `{ok:false, error:{code:'E_UNKNOWN_OP'}}` ——
 * 与"插件没实现 runAction"同义,宿主那边会得到一句可读的话。
 */
export type PluginBridgeReply =
  | { ok: true; value: unknown }
  | { ok: false; error: PluginRpcError }

/** 一次请求的参数上限(JSON 归一之后的字节数) */
export const RPC_MAX_ARGS_BYTES = 1024 * 1024
/** 一次应答的上限(vault.read 之类会把内容带回来) */
export const RPC_MAX_RESULT_BYTES = 4 * 1024 * 1024
/** 页面等宿主应答的上限。宿主自己的 op 超时都小于它,这里只是兜底 */
export const RPC_CALL_TIMEOUT_MS = 30_000

/** 插件页日志进主进程控制台时的前缀 */
export const PLUGIN_LOG_PREFIX = '[plugin]'
