/**
 * 插件面向宿主的能力契约(主进程实现见 main/plugins/api.ts,插件源码见 plugins-src/)。
 *
 * 放在 shared 而不是 main,是为了让 plugins-src 里的插件源码也能 import 它 ——
 * 插件源码只允许依赖 @shared/*,不许伸手进主进程内部。两边共用同一个接口,
 * 任何漂移都会变成 typecheck 报错,而不是运行时才发现某个方法不存在。
 *
 * 设计取向:不新造一套平行 API,而是让 ImkApi **继承** PluginContext。
 * 这样脚本插件拿到的 `imk` 同时就是生命周期回调里的 `ctx`,一个对象、无别名,
 * 现有插件的移植接近逐行 —— 原来写 ctx.setState() 的地方一个字都不用改。
 */

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
  /** 该插件是否已被宿主熔断(连续失败太多次);脚本插件可据此自行收敛 */
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
  signal?: AbortSignal
  /** 追加到子进程的环境变量(凭据用,配 credentialEnv 一起用) */
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
 * **诚实的边界说明**:脚本插件拥有完整 Node 能力,可以直接读 userData/secrets.json。
 * 这里的作用域是防误用与 API 卫生,**不是安全边界**;真正的边界是安装时那次知情确认。
 */
export interface ImkSecretsApi {
  get(fieldKey: string, targetId?: string): Promise<string | null>
  has(fieldKey: string, targetId?: string): Promise<boolean>
}

export type ImkLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 注入给脚本插件主入口的完整 API。
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

  /**
   * 把一块**自己写的界面**挂进主界面(仅脚本插件,见 README 的说明)。
   *
   * 挂进去的是 HTML 与 CSS:**那段 HTML 里跑不了脚本**(应用主窗口的 CSP 挡着
   * 内联脚本与 `onclick`),要交互就在元素上写 `data-imk-click="名字"`,
   * 再用下面的 `onClick` 接住 —— 于是"界面长什么样"与"点它做什么"是分开的两件事。
   *
   * 面板的**顶栏由宿主画**(插件名 + 形态标签),这部分不可定制:一块盖在主界面上的
   * 东西必须能一眼看出是谁的。
   *
   * 同一个 id 重复挂是替换。插件被停用时全部摘掉,不需要自己收拾。
   */
  mount(options: { id: string; html: string; side?: 'left' | 'right' | 'bottom'; title?: string }): void
  /** 换掉已挂载那块的内容(比先 remove 再 mount 少一次闪烁) */
  update(id: string, html: string): void
  /** 摘掉挂载 */
  remove(id: string): void
  /**
   * 注入样式。**只会作用在你标记过的元素上**(编辑器里的装饰、以及你挂进主界面
   * 的那几块),不会漏到应用的其它地方 —— 宿主用 `@scope` 圈住了作用域。
   */
  injectStyles(css: string): void
  /**
   * 接住注入界面里的点击。
   *
   * @param mountId 哪一块(`mount` 时给的 id)
   * @param handler 收到的是被点元素的 `data-imk-click` 值
   */
  onClick(mountId: string, handler: (name: string) => void | Promise<void>): () => void
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

/** 插件生命周期。脚本插件与声明式能力都产出这一形状,宿主只认它 */
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
