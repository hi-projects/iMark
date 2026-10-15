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

import type { PluginActionResult, PluginState } from './plugins'

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
  readonly vault: {
    /** 当前仓库根目录(未打开仓库时为 null)。设置是异步载入的,故此处统一为异步 */
    path(): Promise<string | null>
    /** 路径是否存在;不传参数时判断仓库根目录本身 */
    exists(p?: string): Promise<boolean>
  }
  /** 仅当清单 permissions 含 'secrets' 时注入,否则为 undefined */
  readonly secrets?: ImkSecretsApi
  /** 仅当清单 permissions 含 'git' 时注入,否则为 undefined */
  readonly git?: ImkGitApi
  /** 写日志:进主进程控制台,同时留在该插件的日志缓冲里供设置界面查看 */
  log(level: ImkLogLevel, ...args: unknown[]): void
}

/** 插件生命周期。脚本插件与声明式能力都产出这一形状,宿主只认它 */
export interface PluginRuntime {
  onEnable?(ctx: PluginContext): void | Promise<void>
  onDisable?(ctx: PluginContext): void | Promise<void>
  onConfigChange?(config: unknown, ctx: PluginContext): void | Promise<void>
  /** targetId 只在 descriptor.targetActions 里的动作上出现(对目标列表的某一行执行) */
  runAction?(actionId: string, ctx: PluginContext, targetId?: string): Promise<PluginActionResult>
}
