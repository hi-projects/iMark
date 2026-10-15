/**
 * 插件系统的共享类型(主/渲染层共用,零运行时依赖)。
 *
 * 设计取向:插件的配置用**声明式字段表**描述,设置面板据此通用渲染表单,
 * 这样新增一个插件不必再写一个 Vue 组件;需要特殊交互的字段(如 git 的远端列表)
 * 通过新增 field kind 扩展,而不是让插件自带 UI。
 */

export type PluginFieldKind = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'targets'

// 插件形态与权限词表定义在 pluginPackage.ts(它们本来就是清单的概念)。
// 这里只做类型中转,方便渲染层从一处 import。
import type { PluginKind, PluginPermission } from './pluginPackage'

export type { PluginKind, PluginPermission }

export interface PluginFieldOption {
  value: string
  label: string
}

export interface PluginField {
  key: string
  kind: PluginFieldKind
  label: string
  /** 分组标题:相邻且同名(含都为空)的字段会被归到一组,渲染时插入标题与分隔线 */
  section?: string
  /** 联动显示:只有当另一个字段等于某个值时才显示本字段(如"仅当开启自动初始化时") */
  showWhen?: { key: string; value: unknown }
  /** 字段下方的说明文字 */
  description?: string
  default: string | number | boolean | PluginTarget[]
  placeholder?: string
  min?: number
  max?: number
  options?: PluginFieldOption[]
  /**
   * 该字段的每个目标各自带一个密钥(如远端列表里每个远端一个 token)。
   * 仅对 kind: 'targets' 有意义,密钥 key 形如 `<pluginId>:<fieldKey>:<targetId>`。
   */
  targetSecret?: { label: string; placeholder?: string }
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

export type PluginStatus = 'idle' | 'running' | 'ok' | 'error'

export interface PluginState {
  enabled: boolean
  status: PluginStatus
  /** 上次运行结束时间(epoch ms),从未运行为 null */
  lastRunAt: number | null
  /** 一句话结果,如「已推送到 2 个远端」「无改动」 */
  lastMessage: string
  /** 失败详情(已脱敏,可能较长) */
  lastDetail?: string
}

export interface PluginDescriptor {
  id: string
  name: string
  description: string
  version: string
  fields: PluginField[]
  actions: { id: string; label: string }[]
  /**
   * 针对「目标列表」里每一行单独执行的动作(如"测试连接"),渲染在那一行后面。
   * 执行时会把目标 id 一起传给插件。
   */
  targetActions?: { id: string; label: string }[]
  /** 该插件的目标列表字段 key(有 targetActions 时用于定位是哪种列表) */
  targetFieldKey?: string
}

/** 插件来源:内置核心插件 / 市场安装 / 应用自带的兜底包 / 手动放进插件目录 */
export type PluginSource = 'builtin' | 'market' | 'bundled' | 'local'

/** 已安装插件的来源信息(持久化在 userData/plugins/installed.json) */
export interface PluginInstallInfo {
  version: string
  installedAt: number
  /** 整包 integrity(sha256),也是安装确认框里让用户比对的那个值 */
  integrity: string
  /** 发布者用户名(本机手动安装为 null) */
  publisher: string | null
  source: PluginSource
}

/** 主进程返回给渲染层的插件视图:含配置与状态,但**永远不含密钥明文** */
export interface PluginView {
  descriptor: PluginDescriptor
  config: Record<string, unknown>
  /**
   * 密钥的**掩码**(形如 `ab****23`;'' 表示未配置),key 为完整密钥路径(见 PluginField.targetSecret)。
   * 主进程算好掩码再下发 —— 明文不出主进程,渲染层只拿到首尾各 2 个字符用于辨认。
   */
  secrets: Record<string, string>
  state: PluginState
  // ---------- 以下均为可选:内置核心插件不填,外部安装的插件才有 ----------
  /** 'script' 会在主进程执行代码,'declarative' 不含代码 */
  kind?: PluginKind
  source?: PluginSource
  permissions?: PluginPermission[]
  installed?: PluginInstallInfo
  /** 连续失败次数(宿主熔断计数,见 host.ts 的 safeCall) */
  failures?: number
  /** 已被宿主熔断:连续失败过多,需要用户在设置里显式重新启停才会再跑 */
  disabledByHost?: boolean
  /** 插件自己 log() 的最近若干行,设置界面用来排查第三方插件 */
  logs?: string[]
  /**
   * **加载期**失败(如 main.js 抛异常)—— 这种插件连 descriptor 都不可信,
   * 由宿主合成一个最小描述符并置此项,让它在设置界面里可见、可卸载。
   */
  loadError?: string
}

export interface PluginActionResult {
  ok: boolean
  message: string
  detail?: string
}

/** 插件配置的持久化形态(存于 settings.json 的 plugins 字段) */
export interface PluginConfigEntry {
  enabled: boolean
  config: Record<string, unknown>
}

/** 密钥在主进程加密存储时使用的 key(与渲染层 secrets 映射一致) */
export function secretKey(pluginId: string, fieldKey: string, targetId?: string): string {
  return targetId ? `${pluginId}:${fieldKey}:${targetId}` : `${pluginId}:${fieldKey}`
}

/**
 * 远端密钥的「槽位」:访问令牌与密码分开存。
 * 这样切换认证方式时不会互相串台 —— 切到账号密码时密码是空的,
 * 清除密码也不会把手里的访问令牌删掉。token 用目标 id 本身(兼容既有数据),password 另开一个槽。
 */
export function targetSecretSlot(target: { id: string; auth?: PluginAuthMode }): string {
  return target.auth === 'password' ? `${target.id}#password` : target.id
}
