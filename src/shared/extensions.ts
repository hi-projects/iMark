/**
 * 扩展的**视图类型**(主进程 → 渲染层的 DTO)。
 *
 * 与 extensionApi.ts 的分工:那边是扩展作者写代码时看到的接口,这里是 iMark 自己的
 * 界面(设置页、命令面板、状态栏、市场页)看到的数据。两边不共享实现,只共享
 * 几个配置字段形状(PluginField / PluginTarget…)与清单类型。
 *
 * 一条硬规则:这里出现的任何结构都**不能携带密钥明文**。密钥只有掩码,真正的值
 * 留在主进程 safeStorage 与扩展宿主进程里。
 */

import type {
  ExtensionManifest,
  ExtensionCapabilities,
  ExtensionContribution,
  ExtensionConfigurationProperty
} from './extensionPackage'
import type {
  PluginField,
  PluginLogEntry,
  PluginOperation,
  PluginStatus,
  PluginTargetResult
} from './plugins'

export type ExtensionSource = 'bundled' | 'market' | 'local' | 'dev'

/** 扩展当前在哪个生命周期阶段 */
export type ExtensionRuntimeStatus =
  | 'disabled'
  | 'inactive'
  | 'activating'
  | 'active'
  | 'failed'
  | 'crashed'
  | 'crash-loop'

export interface ExtensionInstallInfo {
  version: string
  installedAt: number
  /** 整包 integrity(sha256),安装确认框里让用户比对的也是它 */
  integrity: string
  /** 主入口文件 sha256(纯声明式扩展为 null) */
  mainSha256: string | null
  publisher: string | null
  source: ExtensionSource
  /** 市场来源地址;内置/本地为 null */
  registryUrl?: string | null
}

/** 宿主分组视图(设置页「宿主」区) */
export interface ExtensionHostGroupView {
  /** 组号;isolated 模式下每个扩展一个组 */
  hostId: number
  extensionIds: string[]
  pid: number | null
  memoryBytes: number | null
  state: 'stopped' | 'starting' | 'running' | 'crashed' | 'crash-loop'
}

/** 单个扩展的运行信息 */
export interface ExtensionRuntimeInfo {
  status: ExtensionRuntimeStatus
  hostId: number | null
  pid: number | null
  /** 最近一次激活失败的说明;成功时为 null */
  lastError: string | null
  /** 连续激活失败次数 */
  activationFailures: number
  /** 宿主意外退出后,是否已停止自动重启 */
  autoRestartDisabled?: boolean
}

export interface ExtensionStatusSnapshot {
  status: PluginStatus
  lastRunAt: number | null
  lastMessage: string
  lastDetail?: string
  targetResults?: Record<string, PluginTargetResult>
}

/**
 * 设置页用的扩展描述。
 *
 * `settingsFields` 是主进程把 `contributes.configuration` 翻译成现有
 * PluginField 之后的表单描述 —— 设置界面因此不需要认识 JSON Schema。
 */
export interface ExtensionDescriptor {
  id: string
  publisher: string
  name: string
  displayName: string
  description: string
  version: string
  engine: string
  main: string | null
  icon: string | null
  activationEvents: readonly string[]
  extensionDependencies: readonly string[]
  capabilities: ExtensionCapabilities
  contributes: ExtensionContribution
  /** configuration 属性的原始声明,市场详情页展示用 */
  configuration: Readonly<Record<string, ExtensionConfigurationProperty>>
  settingsFields: PluginField[]
}

/** 设置页/市场页看到的一行扩展 */
export interface ExtensionView {
  descriptor: ExtensionDescriptor
  enabled: boolean
  source: ExtensionSource
  installed?: ExtensionInstallInfo
  runtime: ExtensionRuntimeInfo
  status: ExtensionStatusSnapshot
  /** 非密配置,key 为**完整配置键**(`<extensionId>.<property>`) */
  config: Record<string, unknown>
  /** 密钥掩码,key 为 `<extensionId>:<property>` / `<extensionId>:<property>:<targetId>` */
  secrets: Record<string, string>
  logs?: PluginLogEntry[]
  recentOps?: PluginOperation[]
  /** 开发模式挂载的目录(不是安装进来的) */
  dev?: boolean
  /** 加载/校验期失败;此时 descriptor 可能是宿主合成的最小描述 */
  loadError?: string
}

export interface ExtensionCommandView {
  extensionId: string
  extensionName: string
  command: string
  title: string
  category?: string
  detail?: string
  /** 由清单贡献还是运行时注册 */
  source: 'manifest' | 'runtime'
  keybinding?: string
  /** when 子句原文;空 = 总是可用 */
  when?: string
  /** 当前上下文下是否可用(主进程算好再下发) */
  available: boolean
}

export interface ExtensionKeybindingView {
  extensionId: string
  command: string
  key: string
  mac?: string
  when?: string
  /** 与应用已有快捷键或更早的扩展冲突时被摘掉 */
  dropped?: boolean
}

export interface ExtensionStatusItemView {
  /** 全局唯一:`<extensionId>:<runtimeId>` */
  id: string
  extensionId: string
  extensionName: string
  alignment: 'left' | 'right'
  priority: number
  text: string
  tooltip?: string
  command?: string
  color?: string
  backgroundColor?: string
  name?: string
  visible: boolean
  /**
   * 该扩展最近一次 `imark.reportStatus()` 的结果。
   *
   * 状态栏的着色与悬停说明直接用它 —— 否则渲染层还得为「这条条目属于哪个
   * 扩展、它现在是什么状态」再拉一次完整的扩展视图,而状态栏是最高频刷新的
   * 界面之一。
   */
  status?: ExtensionStatusSnapshot
}

export interface ExtensionLineMenuView {
  id: string
  extensionId: string
  extensionName: string
  label: string
  command: string
  dialog?: {
    title: string
    confirmLabel?: string
    fields: PluginField[]
  }
}

export interface ExtensionActionView {
  extensionId: string
  extensionName: string
  command: string
  label: string
  scope: 'global' | 'target'
  targetSetting?: string
  primary: boolean
}

export interface ExtensionMenuView {
  extensionId: string
  extensionName: string
  command: string
  /** 菜单位置,目前只有命令面板与行首菜单 */
  where: 'commandPalette'
  when?: string
  available: boolean
}

/** 渲染层计算 UI 状态所需的上下文(真身在主进程) */
export interface ExtensionContextKeys {
  hasEditor: boolean
  hasVault: boolean
  isDirty: boolean
  editorFocus: boolean
  editorTextFocus: boolean
  resourceLangId: string | null
  workspaceFolderCount: number
  [key: string]: boolean | string | number | null
}

/**
 * 一次贡献点快照。
 *
 * `extensions` 只含**启用中**的扩展;`context` 与它必须同一次计算,否则渲染层会
 * 拿着 A 时刻的清单配 B 时刻的状态算可用性。
 */
export interface ExtensionContributionsSnapshot {
  commands: ExtensionCommandView[]
  keybindings: ExtensionKeybindingView[]
  statusItems: ExtensionStatusItemView[]
  lineMenu: ExtensionLineMenuView[]
  actions: ExtensionActionView[]
  menus: ExtensionMenuView[]
  context: ExtensionContextKeys
  hostGroups: ExtensionHostGroupView[]
}

/** 渲染层请主进程执行一条扩展命令 */
export interface ExtensionCommandInvocation {
  command: string
  args?: unknown[]
  from: 'commandPalette' | 'keybinding' | 'lineMenu' | 'statusBar' | 'action' | 'code'
}

/**
 * 命令执行的结果。
 *
 * 走 IPC 时不抛错（抛错会被 Electron 包上一层英文前缀），`message` 是已经
 * 可以直接显示给用户的中文说明；`value` 必须可结构化克隆。
 */
export interface ExtensionCommandResult {
  ok: boolean
  value?: unknown
  message?: string
}

/** 扩展可选的宿主模式 */
export type ExtensionHostMode = 'isolated' | 'shared'

export interface ExtensionHostSettings {
  mode: ExtensionHostMode
  /**
   * 用户设置的 affinity:相同正整数 → 同一宿主;未列出 → 跟随 mode 的默认分组。
   * 与 VS Code 的 `extensions.experimental.affinity` 同义,但 0 也允许(0 = 默认组),
   * 因为 isolated 模式下每一组本来就是一个扩展。
   */
  affinity: Record<string, number>
}

/** 设置页「宿主」区提交的变更 */
export interface ExtensionHostSettingsPatch {
  mode?: ExtensionHostMode
  affinity?: Record<string, number>
}

/** settings.extensions 的一行:启用态 + 非密配置(值用完整配置键) */
export interface ExtensionPreference {
  enabled: boolean
  config: Record<string, unknown>
}

/** 运行中面板的视图(渲染层据此挂 iframe) */
export interface ExtensionWebviewPanelView {
  panelId: string
  extensionId: string
  viewType: string
  title: string
  presentation: 'sidebar' | 'overlay' | 'floating'
  width: number
  height: number
  transparent: boolean
  anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  visible: boolean
  active: boolean
}

/** 扩展的安装记录(installed.json 的一行,不含配置) */
export interface ExtensionRecord {
  id: string
  publisher: string
  name: string
  version: string
  main: string | null
  activationEvents: string[]
  capabilities: ExtensionCapabilities
  integrity: string
  mainSha256: string | null
  installedAt: number
  source: Exclude<ExtensionSource, 'dev'>
  registryUrl: string | null
}

export type { ExtensionManifest }
