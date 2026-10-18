/**
 * 插件面向宿主的能力契约(主进程实现见 main/plugins/api.ts,插件源码见 plugins-src/)。
 *
 * 放在 shared 而不是 main,是为了让 plugins-src 里的插件源码也能 import 它 ——
 * 插件源码只允许依赖 @shared/*,不许伸手进主进程内部。两边共用同一个接口,
 * 任何漂移都会变成 typecheck 报错,而不是运行时才发现某个方法不存在。
 *
 * 设计取向:不新造一套平行 API,而是让 ImkApi **继承** PluginContext。
 * 这样node main拿到的 `imk` 同时就是生命周期回调里的 `ctx`,一个对象、无别名,
 * 现有插件的移植接近逐行 —— 原来写 ctx.setState() 的地方一个字都不用改。
 */

import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type {
  PluginActionPayload,
  PluginActionResult,
  PluginCommand,
  PluginEvent,
  PluginEventMap,
  PluginMenuItem,
  PluginState,
  PluginStatusItem
} from './plugins'

/** 宿主交给插件的运行时能力(生命周期回调的入参,也是 ImkApi 的基座) */
export interface PluginContext {
  readonly pluginId: string
  /** 当前生效配置(已按字段表归一化,含默认值) */
  getConfig<T = Record<string, unknown>>(): T
  /** 更新状态并广播给渲染层 */
  setState(patch: Partial<PluginState>): void
  /** 让渲染层先把脏文档落盘(带超时兜底,无窗口时立即返回) */
  flushDocument(): Promise<void>
  isEnabled(): boolean
  /** 该插件是否已被宿主熔断(连续失败太多次);node main可据此自行收敛 */
  isDisabledByHost(): boolean
}

/** git 命令的返回形状(与 main/git.ts 的 GitResult 同一份定义) */
export interface ImkGitResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  /** 超时/中止 */
  aborted: boolean
}

/** git 命令的通用选项(与 main/git.ts 的 GitOptions 同一份定义) */
export interface ImkGitOptions {
  cwd: string
  timeoutMs?: number
  /** 撤销这次调用:超时或插件停用时,正在跑的 git 子进程会被一起杀掉 */
  signal?: AbortSignal
  /**
   * 追加到子进程的环境变量(凭据用,配 credentialEnv 一起用)。
   * **只对node main开放** —— 对restricted main来说它和 `-c` 是同一个"执行任意程序"的口子
   * (GIT_SSH_COMMAND 之类),而 restricted 也没有凭据注入可用。
   */
  env?: Record<string, string>
}

export interface ImkGitApi {
  /** git 是否可用(未安装时给可读错误,而不是 ENOENT 堆栈) */
  available(): Promise<boolean>
  run(args: string[], opts: ImkGitOptions): Promise<ImkGitResult>
  /** 一次性凭据 helper 参数:token 不出现在命令行里,从环境变量读(配 credentialEnv 用) */
  credentialArgs(token: string): string[]
  credentialEnv(user: string, token: string): Record<string, string>
  /** 把 `scheme://user:token@host` 洗成 `scheme://user:***@host`;所有对外文本都要过这层 */
  redact(text: string): string
  /** 输出摘要:脱敏 + 压成几行 */
  summarize(text: string, maxLines?: number): string
}

/**
 * 密钥读取接口。
 *
 * **作用域**:插件只能读自己名下的密钥(宿主拼 secretKey(自己的 id, fieldKey, targetId)),
 * 且 fieldKey 必须是清单里声明过的 password 字段、或带 targetSecret 的目标字段。
 *
 * **只读**:写入只走设置界面。这是刻意的限制,后续要做 OAuth 之类的流程
 * 需要宿主提供中介式写入。
 *
 * **诚实的边界说明**:node main拥有完整 Node 能力,可以直接读数据根下的 secrets.json(`~/.imark/secrets.json`)。
 * 这里的作用域是防误用与 API 卫生,**不是安全边界**;真正的边界是安装时那次知情确认。
 */
export interface ImkSecretsApi {
  get(fieldKey: string, targetId?: string): Promise<string | null>
  has(fieldKey: string, targetId?: string): Promise<boolean>
}

export type ImkLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 两层之间的消息接口:main 层用 `imk.render`,render 层用 `imk.main`。
 *
 * 传的是**数据**,不是能力:文件/网络/git/密钥仍然只能由 main 层经宿主闸门申请。
 * 没有另一层时 `send` 会明确报错。
 */
export interface ImkLayerChannel {
  /** 发给同一插件的另一层(单向,不等待回执) */
  send(channel: string, data: unknown): Promise<void>
  /** 收另一层发来的消息;返回取消订阅 */
  onMessage(handler: (channel: string, data: unknown) => void): () => void
}

/**
 * render 层插件的生命周期实现 —— 与 restricted main 的 `imark.plugin.handle(...)` 同构。
 *
 * 约定:插件脚本必须在**顶层同步**调用 `imk.plugin.handle({...})`,因为宿主在
 * 注入完成后会立刻调用 `onEnable`。
 */
export interface RenderLayerImpl {
  onEnable?(): void | Promise<void>
  onDisable?(): void | Promise<void>
  onConfigChange?(config: Record<string, unknown>): void | Promise<void>
  runAction?(
    actionId: string,
    targetId: string | null,
    payload: unknown
  ): unknown | Promise<unknown>
}

/**
 * restricted main 页面里的生命周期实现。
 *
 * 与 node main 的 `PluginRuntime` 不同:页面里没有 `ctx` 对象(能力都从
 * `window.imark` 上取),所以 `runAction` 只有三个参数:
 * `(actionId, targetId, payload)`。
 */
export interface RestrictedPluginImpl {
  onEnable?(): void | Promise<void>
  onDisable?(): void | Promise<void>
  onConfigChange?(config: Record<string, unknown>): void | Promise<void>
  runAction?(
    actionId: string,
    targetId: string | null,
    payload: PluginActionPayload | null
  ): unknown | Promise<unknown>
}

/** render 层拿到的编辑器能力。没有权限概念 —— 它已经在编辑器环境里了。 */
export interface ImkRenderLayerEditorApi {
  /** 宿主同一个 EditorView 实例(没有打开文档时为 null) */
  getView(): EditorView | null
  /** 文档内容变化(节流由调用方自己决定;这里只保证每次变更都会通知) */
  onDocChanged(handler: () => void): () => void
  /**
   * 注册一段 CM6 扩展,返回注销函数。
   *
   * **必须**使用 `kit` 里的构造器构建扩展:宿主与插件必须是同一份 `@codemirror/*`
   * 模块实例,否则 facet 身份对不上,扩展会**静默失效**(不报错,也不生效)。
   */
  registerExtension(extension: Extension): () => void
  /** 宿主那一份 CM6 模块(不要自己 bundle `@codemirror/*`) */
  readonly kit: {
    state: typeof import('@codemirror/state')
    view: typeof import('@codemirror/view')
    language: typeof import('@codemirror/language')
    commands: typeof import('@codemirror/commands')
  }
}

/**
 * 注入给 render 层的 API。
 *
 * **它没有任何宿主系统能力**:没有 vault / net / git / secrets / commands。
 * 需要这些时,消息发给 main 层,由 main 层向闸门申请。
 *
 * 安全边界必须说清楚:render 层与主界面跑在同一个 realm 里,能改界面、读文档、
 * 看到窗口里的键盘输入 —— 这是这个形态本身的代价,不是可以用参数关掉的开关。
 */
export interface ImkRenderLayerApi {
  readonly plugin: {
    readonly id: string
    readonly name: string
    readonly version: string
    /** 配置快照(同步读;变化时宿主调用 onConfigChange 并更新快照) */
    getConfig<T = Record<string, unknown>>(): T
    /** 更新状态卡(宿主会再校验一次) */
    setState(patch: {
      status?: 'idle' | 'running' | 'ok' | 'error'
      lastMessage?: string
      lastDetail?: string
    }): void
    /** 登记生命周期实现(必须在顶层同步调用) */
    handle(impl: RenderLayerImpl): void
    log(level: ImkLogLevel, ...args: unknown[]): void
  }
  readonly editor: ImkRenderLayerEditorApi
  /** 与 main 层的消息;插件没有 main 层时 `send` 会报错 */
  readonly main: ImkLayerChannel
}

/**
 * 注入给 **node main 层**主入口的完整 API。
 *
 * 用法(插件 main.js 必须是 CommonJS):
 *   module.exports = (imk) => ({
 *     onEnable(ctx) { … },
 *     async runAction(actionId, ctx, targetId) { … }
 *   })
 */
export interface ImkApi extends PluginContext {
  readonly plugin: {
    readonly id: string
    readonly name: string
    readonly version: string
    /** 插件的安装目录(要读自带的静态资源时用) */
    readonly dir: string
  }
  /** 仅当清单 permissions 含 'vault:read' 时注入,否则为 undefined */
  readonly vault?: {
    /** 当前仓库根目录(未打开仓库时为 null)。设置是异步载入的,故此处统一为异步 */
    path(): Promise<string | null>
    /** 路径是否存在;不传参数时判断仓库根目录本身 */
    exists(p?: string): Promise<boolean>
  }
  /** 仅当清单 permissions 含 'secrets' 时注入,否则为 undefined */
  readonly secrets?: ImkSecretsApi
  /** 仅当清单 permissions 含 'git' 时注入,否则为 undefined */
  readonly git?: ImkGitApi
  /** 有 render 层时注入;没有 render 层时为 undefined */
  readonly render?: ImkLayerChannel
  /**
   * 界面槽位:通知 / 状态栏。
   *
   * **不要权限,永远注入。** 理由见 main/plugins/api.ts 里 ui 那一段的注释:
   * 不触碰用户数据的界面上动作不该要权限,否则权限提示会被稀释成噪音。
   */
  readonly ui: ImkUiApi
  /**
   * 命令面板与右键菜单。同样不要权限。
   *
   * 与 `on` 同理:注册的内容在停用/重载时被整体清掉,常驻的注册写在 `onEnable` 里。
   */
  readonly commands: ImkCommandsApi
  /**
   * 订阅宿主里发生的事。返回取消订阅的函数。
   *
   * 事件是**单向通知**,不是可以拦的钩子 —— 没有「取消保存」这种能力。
   *
   * **停用/重载时宿主会把这些订阅整体清掉**,不必自己取消;但也就意味着
   * 要常驻的订阅得写在 `onEnable` 里(写在外层只有第一次启用之后才作数)。
   * 返回的取消函数留给「暂时不听了」这种用法。
   */
  readonly on: <E extends PluginEvent>(
    event: E,
    handler: (payload: PluginEventMap[E]) => void | Promise<void>
  ) => () => void
  /** 写日志:进主进程控制台,同时留在该插件的日志缓冲里供设置界面查看 */
  log(level: ImkLogLevel, ...args: unknown[]): void
}

/**
 * 通知的档位。它决定气泡的颜色和**停留多久** ——
 * 错误要留着让人看清,成功可以很快过去。
 */
export type ImkNoticeLevel = 'info' | 'success' | 'warn' | 'error'

export interface ImkUiApi {
  /**
   * 右下角弹一条通知。
   *
   * 用它的场合是「用户此刻不看插件界面,但这件事他需要知道」——
   * 同步完成、有文件被外部改动、某个远端连不上。
   * **不要在循环里发**:每个插件每分钟限 10 条,超出的会被丢掉并记进插件日志。
   * 插件自己的周期性进展应当用 setState 走状态栏/设置页,那里本来就在展示。
   */
  notify(message: string, level?: ImkNoticeLevel): void
  /**
   * 在状态栏占一个位置(传 null 收回)。
   *
   * **一个插件只有一条**,再次调用是替换。状态栏是全应用最挤的地方,
   * 一个插件占两格就必然要挤掉别人的。
   *
   * `onClick` 是点这一条时要跑的事。它和 `imk.commands.register` 的第二个参数
   * 是同一种东西 —— 走 API 注册的条目自带执行体,不必再绕回 `runAction`
   * (清单声明的条目做不到这件事,那条路的 `action` 必须在清单里写死)。
   */
  statusItem(item: PluginStatusItem | null, onClick?: () => void | Promise<void>): void
}

/**
 * 执行一条命令/菜单条目时的现场。
 *
 * 命令从哪儿被点的不影响它该干什么,但**右键菜单不一样**:
 * 用户指的是那个文件。拿不到 filePath 的话,"对右键的这个文件做点什么"就无从谈起 ——
 * 那正是右键菜单存在的全部意义。
 */
export interface ImkCommandContext {
  /** 从文件列表右键点进来时的那个文件(绝对路径);从命令面板进来时为 null */
  filePath: string | null
  /** 从编辑器里点进来时的行号(1 起);暂时没有编辑器菜单,恒为 null */
  line: number | null
  /** 当前开着仓库 */
  hasVault: boolean
}

export interface ImkCommandsApi {
  /**
   * 往命令面板里加一条命令。
   *
   * 两种用法二选一:
   *   - `register({id, label, action: 'my-action'})` —— 执行时回到 runAction,
   *     这条命令的表现与清单里声明的完全一样
   *   - `register({id, label}, ctx => {...})` —— 直接给一个函数,当场执行
   *
   * 清单能声明的东西这里都能注册,而且能**根据配置动态决定**要不要注册、
   * 叫什么名字 —— 那正是清单做不到的部分。
   *
   * 返回取消注册的函数;插件重载时所有注册自动失效。
   */
  register(
    command: PluginCommand,
    handler?: (ctx: ImkCommandContext) => void | Promise<void>
  ): () => void
  /** 撤掉一条命令 */
  remove(id: string): void
  /**
   * 往右键菜单里加一条(返回取消注册的函数)。
   *
   * `onClick` 与 `register` 的第二个参数同义:走 API 注册的条目自带执行体。
   * 它需要知道用户右键的是哪个文件 —— 从 `ctx.filePath` 里拿。
   */
  menuItem(
    item: PluginMenuItem,
    onClick?: (ctx: ImkCommandContext) => void | Promise<void>
  ): () => void
}

/**
 * restricted main 页面里 `window.imark` 的形状。
 *
 * 它是受限层的**全部**能力面:没有 Node、没有 editor、没有 window。
 * 文件/网络/git/密钥按清单权限塑形;每次调用都经主进程闸门。
 */
export interface ImkRestrictedApi {
  readonly plugin: {
    readonly id: string
    /** hello 到达前为 null(页面可以先用 id) */
    readonly info: {
      pluginId: string
      name: string
      version: string
      permissions: string[]
      theme: string
      vaultPath: string | null
      config: Record<string, unknown>
      mode: 'restricted' | 'node'
      hasRender: boolean
    } | null
    /** 注册生命周期。必须在脚本顶层同步调用 */
    handle(impl: RestrictedPluginImpl): void
  }
  log(level: ImkLogLevel, ...args: unknown[]): void
  getConfig<T = Record<string, unknown>>(): T
  setState(patch: Partial<PluginState>): void
  on<E extends PluginEvent>(
    event: E,
    handler: (payload: PluginEventMap[E]) => void
  ): () => void
  ui: ImkUiApi
  commands: {
    register(command: PluginCommand, run?: () => void): void
    remove(id: string): void
  }
  menus: {
    add(item: PluginMenuItem, run?: () => void): void
  }
  document: {
    flush(): Promise<unknown>
  }
  schedule: {
    every(ms: number, name: string): void
    clear(name: string): void
  }
  /** 仅当清单 permissions 含 'vault:read' */
  vault?: {
    path(): Promise<string | null>
    exists(path?: string): Promise<boolean>
    read(path: string): Promise<{ path: string; text: string }>
    list(path?: string): Promise<{ name: string; dir: boolean }[]>
    /** 仅当清单 permissions 含 'vault:write' */
    write?(path: string, text: string, opts?: { force?: boolean }): Promise<{ path: string }>
    remove?(path: string): Promise<null>
  }
  /** 仅当清单 permissions 含 'secrets' */
  secrets?: ImkSecretsApi
  /** 仅当清单 permissions 含 'network' */
  net?: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string }
    ): Promise<{
      status: number
      ok: boolean
      url: string
      headers: Record<string, string>
      body: string
      bodyBytes: number
    }>
  }
  /** 仅当清单 permissions 含 'git';受限层没有 credentialEnv / env */
  git?: {
    available(): Promise<boolean>
    run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ImkGitResult>
    redact(text: string): Promise<string>
    summarize(text: string, maxLines?: number): Promise<string>
  }
  /** 有 render 层时注入 */
  render?: ImkLayerChannel
}

/** 插件生命周期。node main、restricted main、render 层与声明式能力都产出这一形状 */
export interface PluginRuntime {
  onEnable?(ctx: PluginContext): void | Promise<void>
  onDisable?(ctx: PluginContext): void | Promise<void>
  onConfigChange?(config: unknown, ctx: PluginContext): void | Promise<void>
  /**
   * targetId 只在 descriptor.targetActions 里的动作上出现(对目标列表的某一行执行);
   * payload 只在行首菜单的动作上出现(带对话框里填的值与触发那一行的快照)。
   * 想要往文档里写字,就返回 `editor` —— 文档由宿主改,插件只出文本。
   */
  runAction?(
    actionId: string,
    ctx: PluginContext,
    targetId?: string,
    payload?: PluginActionPayload
  ): Promise<PluginActionResult>
}
