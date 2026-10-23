/**
 * 配置字段与运行状态的共享类型(主/渲染层共用,零运行时依赖)。
 *
 * 扩展作者 API 在 extensionApi.ts;这里只保留**界面与清单之间**的少数形状:
 * 设置表单的字段描述(由 `contributes.configuration` 翻译而来)、目标/地址列表、
 * 运行状态与日志。它们与扩展代码跑在哪一层无关。
 */

export type PluginFieldKind =
  | 'text'
  | 'textarea'
  | 'password'
  | 'number'
  | 'boolean'
  | 'select'
  /** 字符串列表:一行一个值,设置页用「+」逐条添加 */
  | 'list'
  | 'targets'
  | 'endpoints'
  /** 读写扩展包外的 JSON 配置文件(值是字符串);文件与键由清单的 imark 元数据声明 */
  | 'external'

export interface PluginFieldOption {
  value: string
  label: string
}

/**
 * 配置字段的保存范围。
 *
 * - `global`:全局一份(默认);
 * - `workspace`:每个仓库各存一份覆盖值。未覆盖时回落到全局值,再回落到默认值。
 *
 * 密钥永远是全局的;这里只描述非密配置。
 */
export type PluginFieldScope = 'global' | 'workspace'

export interface PluginField {
  key: string
  kind: PluginFieldKind
  label: string
  /** 清单里声明 `imark.scope` 时才有;缺省视为 global */
  scope?: PluginFieldScope
  /** 分组标题:相邻且同名(含都为空)的字段会被归到一组,渲染时插入标题与分隔线 */
  section?: string
  /** 联动显示:只有当另一个字段等于某个值时才显示本字段 */
  showWhen?: { key: string; value: unknown }
  /** 字段下方的说明文字 */
  description?: string
  default: string | number | boolean | string[] | PluginTarget[] | PluginEndpoint[]
  placeholder?: string
  min?: number
  max?: number
  /** textarea 的显示行数(不影响取值) */
  rows?: number
  /** 在字段标题旁显示「恢复默认」图标;当前值与 default 相同时图标置灰 */
  resettable?: boolean
  /** 文本类字段失焦时若为空,自动恢复 default */
  required?: boolean
  /** 地址列表(kind: 'endpoints')里每一行的模型输入 */
  endpointModel?: { label: string; placeholder?: string }
  options?: PluginFieldOption[]
  /** 目标列表里每一行各自的密钥槽位(如每个远端一个 token) */
  targetSecret?: { label: string; placeholder?: string }
  /** kind: 'external' 的文件位置与 JSON 指针 */
  external?: {
    /** 展开 `~` 后的绝对路径;与 dirEnv 同时存在时,dirEnv 优先 */
    file: string
    /** 用这个环境变量的值替换文件的父目录(例如 CLAUDE_CONFIG_DIR) */
    dirEnv?: string
    /** JSON 指针,如 `/env/ANTHROPIC_BASE_URL` */
    pointer: string
    /** 输入框按密码显示 */
    secret?: boolean
  }
}

/**
 * 地址列表里的一行(kind: 'endpoints')。
 *
 * 与 git 的「远端」列表分开:这里一行是「地址 + 模型」,API 密钥按行单独存
 * (字段上的 targetSecret)。正常请求会用这个顺序逐个尝试,前一个失败再试下一个。
 */
export interface PluginEndpoint {
  id: string
  url: string
  /** 该地址使用的模型名;Azure 的部署名在路径里,可以留空 */
  model: string
}

/** 认证方式:token = 访问令牌(默认);password = 账号 + 密码;ssh = 用本机 SSH 密钥 */
export type PluginAuthMode = 'token' | 'password' | 'ssh'

/** 一个同步目标 / 远端(仓库地址 + 本地/远端分支 + 认证方式) */
export interface PluginTarget {
  id: string
  /** 仓库地址(必填):HTTPS 或 SSH 均可,推送时直接用它 */
  url: string
  /** 要推送的本地分支(必填) */
  localBranch: string
  /** 推送到的远端分支;留空表示与本地分支同名 */
  remoteBranch: string
  /** 认证方式;token / password 需要一个密钥(password 另需 username),ssh 不需要 */
  auth: PluginAuthMode
  /** 仅「账号 + 密码」认证时使用 */
  username: string
}

/**
 * 某一行目标的**最近一次操作结果**(推送 / 测试连接)。
 *
 * 设置页据此给目标卡片上色:ok = 绿、error = 红;没有记录 = 还没对它操作过(灰)。
 */
export type PluginTargetResult = 'ok' | 'error'

/** 行首「+」菜单的对话框参数表单(字段 kind 是一次性表单能装下的那几种) */
export interface PluginLineMenuDialog {
  title: string
  /**
   * 只允许 text / number / boolean / select ——
   * 对话框是一次性的,出现密钥与目标列表说不通,校验里会挡掉。
   */
  fields: PluginField[]
  confirmLabel?: string
}

export type PluginStatus = 'idle' | 'running' | 'ok' | 'partial' | 'error'

/**
 * 一条扩展日志的级别。
 *
 * 前四档来自扩展自己的 `log()`(以及宿主替它写的安全审计);
 * `operation` 是宿主在动作结束后记的摘要 —— 它和扩展日志进同一个尾巴、同一个文件。
 */
export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'operation'

/** 设置页「扩展日志」的一条;磁盘文件由宿主用同一套字段拼成 `时间戳 [级别] 正文` */
export interface PluginLogEntry {
  /** 产生时间(epoch ms) */
  at: number
  level: PluginLogLevel
  /** 正文;操作记录可能带换行(第一行是摘要,后面是明细) */
  message: string
}

/** 提示条级别(扩展通知、应用提示共用) */
export type PluginNoticeLevel = 'info' | 'success' | 'warn' | 'error'

/** 密钥在主进程加密存储时使用的 key(与渲染层 secrets 映射一致) */
export function secretKey(extensionId: string, fieldKey: string, targetId?: string): string {
  return targetId ? `${extensionId}:${fieldKey}:${targetId}` : `${extensionId}:${fieldKey}`
}

/**
 * 远端密钥的「槽位」:访问令牌与密码分开存。
 * 这样切换认证方式时不会互相串台 —— 切到账号密码时密码是空的,
 * 清除密码也不会把手里的访问令牌删掉。token 用目标 id 本身,password 另开一个槽。
 */
export function targetSecretSlot(target: { id: string; auth?: PluginAuthMode }): string {
  return target.auth === 'password' ? `${target.id}#password` : target.id
}
