/**
 * 插件系统的共享类型(主/渲染层共用,零运行时依赖)。
 *
 * 设计取向:插件的配置用**声明式字段表**描述,设置面板据此通用渲染表单,
 * 这样新增一个插件不必再写一个 Vue 组件;需要特殊交互的字段(如 git 的远端列表)
 * 通过新增 field kind 扩展,而不是让插件自带 UI。
 */

export type PluginFieldKind =
  | 'text'
  | 'textarea'
  | 'password'
  | 'number'
  | 'boolean'
  | 'select'
  | 'targets'
  | 'endpoints'

// 插件层与权限词表定义在 pluginPackage.ts(它们本来就是清单的概念)。
// 这里只做类型中转,方便渲染层从一处 import。
import type { PluginMainMode, PluginPermission } from './pluginPackage'

export type { PluginMainMode, PluginPermission }

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
  default: string | number | boolean | PluginTarget[] | PluginEndpoint[]
  placeholder?: string
  min?: number
  max?: number
  /** textarea 的显示行数(不影响取值) */
  rows?: number
  /**
   * 在字段标题旁显示「恢复默认」图标;当前值与 default 相同时图标置灰。
   * 用于提示词这类长文本。
   */
  resettable?: boolean
  /** 文本类字段失焦时若为空,自动恢复 default,避免把空提示词存进配置 */
  required?: boolean
  /**
   * 地址列表(kind: 'endpoints')里每一行的模型输入。
   *
   * 模型是「每个服务地址一份」的,所以它不单独占一个字段,而是随每张地址卡片渲染。
   * 与 targetSecret 一样,标签和占位符由插件说明,宿主只负责画。
   */
  endpointModel?: { label: string; placeholder?: string }
  options?: PluginFieldOption[]
  /**
   * 该字段的每个目标各自带一个密钥(如远端列表里每个远端一个 token)。
   * 对 kind: 'targets' 与 'endpoints' 有意义,密钥 key 形如
   * `<pluginId>:<fieldKey>:<targetId>`。
   */
  targetSecret?: { label: string; placeholder?: string }
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
 * 输入是否填齐**不**由它表达 —— 那由设置页统一列出「还缺哪些输入」。
 */
export type PluginTargetResult = 'ok' | 'error'

/**
 * 编辑器行首「+」菜单里的一条。
 *
 * 这是插件**唯一**能影响编辑器的入口。方向是刻意的:插件声明「菜单里有什么、要问用户什么」,
 * 而按钮、菜单、对话框、以及最终改文档都由宿主实现 ——
 * 插件代码始终不参与决定自己长什么样,也拿不到文档。
 */
export interface PluginLineMenuItem {
  id: string
  label: string
  /**
   * 固定文本:宿主直接插入,不惊动插件(如 `> ` 引用块)。
   * 与 action **恰好二选一**。
   */
  template?: string
  /** 参数表单:点击后弹出来,确认后连同 editor 上下文一起交给插件 */
  dialog?: PluginLineMenuDialog
  /** 生成内容的动作 id,由插件在 runAction 里处理 */
  action?: string
}

export interface PluginLineMenuDialog {
  title: string
  /**
   * 只允许 text / number / boolean / select ——
   * 对话框是一次性的,出现密钥与目标列表说不通,校验里会挡掉。
   */
  fields: PluginField[]
  confirmLabel?: string
}

// ---------- 界面贡献点(阶段二) ----------
//
// 这一段是「功能型插件走槽位」的那批槽位。三件事值得先讲清楚:
//
// 1. **两条路径,一份实现**。清单里写 `commands: [...]` 和在代码里调
//    `imark.commands.register(...)` 产出的是同一种东西、走同一套派发。差别只在
//    「谁先声明」:清单是静态的、装的时候就看得见(安装确认框能如实列出来),
//    代码是动态的、要等 onEnable 跑起来才知道。所以代码路径能拿到清单给不了的东西
//    (比如根据配置决定命令叫什么),而清单路径能在插件还没跑起来时就把界面摆好。
//
// 2. **宿主不认识插件想干什么,只认识「一个 id 和一个动作」**。所有条目最终都指向
//    插件自己的 runAction —— 宿主不解释、不执行插件给的任何代码来决定界面长什么样。
//
// 3. **数量有上限**。状态栏尤其:它是全应用最挤的一条,被插件塞满就没法用了。

/** 命令面板里的一条。点了之后走 `runAction(action)` 那条老路 */
export interface PluginCommand {
  id: string
  label: string
  /** 一句话说明,显示在命令面板里条目右侧 */
  detail?: string
  /**
   * 快捷键,形如 `Ctrl+Shift+P` / `Cmd+Alt+1`。
   *
   * **它由宿主注册成原生菜单项(隐藏的),不是渲染层监听 keydown。**
   * 原因是 Electron 的原生加速键在 keydown 到达页面之前就被截走了 ——
   * 只做渲染层监听的话,插件一旦用到 Ctrl+S / Ctrl+P 这类应用已占用的组合,
   * 表现就是「快捷键没反应」,而且极难查。
   * 与应用已有快捷键冲突时以应用为准,并在插件设置页里如实标出来。
   */
  keybinding?: string
  /** 什么时候这条命令才有意义。不填 = always */
  when?: PluginCommandWhen
  /** 执行的动作 id(必须在 actions 里声明过) */
  action?: string
}

/**
 * 命令的可用条件。
 *
 * 刻意是个**封闭的短枚举**,不是表达式也不是回调:宿主必须在任何时候都能算出
 * 「这条命令现在能不能用」,而插件代码不一定在跑(未启用、已熔断)。
 * 开放成回调就等于「界面状态取决于插件是否活着」,那正是要避免的。
 */
export type PluginCommandWhen = 'always' | 'editor' | 'vault'

/** 状态栏里的一条 */
export interface PluginStatusItem {
  id: string
  label: string
  /**
   * 图标名。**白名单**:宿主只认自己表里有的名字(见渲染层的 pluginIcons),
   * 认不出就只显示文字。这样插件无法让宿主去渲染任意组件。
   */
  icon?: string
  /** 悬停提示。不填由宿主用「插件名:当前状态」拼一句 */
  tooltip?: string
  /** 点击执行的动作 id */
  action?: string
}

/**
 * 右键菜单里的一条。
 *
 * `where` 决定它挂在哪张菜单上:`files` 是文件列表右键(带上下文:点的是哪个文件),
 * `editor` 是编辑器正文右键(带上下文:光标在哪一行)。
 */
export interface PluginMenuItem {
  id: string
  label: string
  /** 挂在哪儿 */
  where: PluginMenuWhere
  /** 执行的动作 id */
  action?: string
  /** 危险操作(删除之类),界面上标红 */
  danger?: boolean
}

/**
 * 插件能挂右键菜单的地方。**与 pluginPackage.ts 的 MENU_WHERES 必须一致**
 * (那里是运行时校验的依据,那里不认的取值这里也不该有 —— 见那边的说明:
 * 编辑器菜单暂时没做,所以这里只有 files)。
 */
export type PluginMenuWhere = 'files'

/** 一条命令在「现在这个应用状态下」可不可以用 */
export interface PluginCommandContext {
  /** 有文档开着(未命名的新文档也算) */
  hasEditor: boolean
  /** 开着仓库 */
  hasVault: boolean
}

/**
 * 判定一条命令此刻能不能用。
 *
 * 主进程与渲染层共用同一份 —— 渲染层用它决定灰不灰,主进程在真正执行前再判一次
 * (界面状态可以被绕过,执行前的判定才是真的)。
 */
export function commandAvailable(
  when: PluginCommandWhen | undefined,
  ctx: PluginCommandContext
): boolean {
  switch (when) {
    case 'editor':
      return ctx.hasEditor
    case 'vault':
      return ctx.hasVault
    default:
      return true
  }
}

/**
 * 一个插件当前贡献的全部槽位(下发给渲染层的快照)。
 *
 * **只有启用中的插件才在列表里**。关掉的插件不该在界面上留东西,这跟行首「+」菜单
 * 现在的行为一致:停用 quick-edit(Advanced Table),那个「+」就没了。
 *
 * 刻意走单独一条通道、而不是塞进 PluginView:PluginView 是**高频**的
 * (插件每 setState 一次就广播一遍),而贡献点只在插件启停/重载时变。
 * 两者混在一起的话,一条状态栏进度更新也要把几十条命令的描述搬一遍。
 */
export interface PluginContrib {
  pluginId: string
  /** 界面上要显示「是谁加的」,所以带上名字而非只有 id */
  pluginName: string
  statusItem: PluginStatusItem | null
  commands: PluginCommand[]
  menus: PluginMenuItem[]
}

/**
 * 一次贡献点快照:`contribs` 是「现在有什么」,`context` 是「现在能不能用」。
 *
 * 两者必须一起发。分开发的话,渲染层会拿着 A 时刻的清单配 B 时刻的状态来算可用性,
 * 而这份状态(有没有文档、有没有仓库)的真身在主进程 —— 渲染层自己算不出同一个答案。
 */
export interface PluginContribsSnapshot {
  contribs: PluginContrib[]
  context: PluginCommandContext
}

/** 渲染层请主进程执行一次贡献点(命令/状态栏/右键菜单走的是同一条路) */
export interface PluginContribInvoke {
  pluginId: string
  itemId: string
  /** 从哪儿点进来的 —— 用于把上下文(文件路径/行号)一并带上 */
  from: PluginMenuWhere | 'command' | 'status'
  /** 上下文:右键文件列表时的那个文件 */
  filePath?: string
  /** 上下文:编辑器里光标所在行(1 起) */
  line?: number
}

/** 插件发出来的一条通知(右下角气泡) */
export interface PluginNotice {
  pluginId: string
  pluginName: string
  message: string
  level: PluginNoticeLevel
  /** 毫秒时间戳,渲染层据此排队 */
  at: number
}

export type PluginNoticeLevel = 'info' | 'success' | 'warn' | 'error'

/**
 * 插件能订阅的宿主事件。
 *
 * 每个事件都是**已经发生过的事**,不是可以拦的钩子 —— 没有「取消保存」这种能力,
 * 因为那会让一个坏插件卡住用户存盘。名字用 `域:动作`,与插件清单里的写法一致。
 */
export interface PluginEventMap {
  /** 文档落盘完成。ok=false 表示写失败 */
  'document:save': { filePath: string | null; ok: boolean }
  /** 文档内容变了(宿主已节流,最快约 400ms 一次) */
  'document:change': { filePath: string | null; dirty: boolean; words: number; chars: number }
  /** 打开了另一个文件 */
  'file:open': { filePath: string | null }
  /** 换了仓库 */
  'vault:change': { vaultPath: string | null }
  /** 换了主题 */
  'theme:change': { theme: string }
  /**
   * **本插件的**配置被改了。
   *
   * 刻意只说我自己的:告诉 A 插件「B 插件刚被改了配置」既没用又泄露用户装了谁。
   * 需要感知别的插件是另一回事(将来若要做,应当是一个显式的、用户可见的机制)。
   */
  'config:change': { config: Record<string, unknown> }
}

export type PluginEvent = keyof PluginEventMap

/** 事件名白名单(运行时校验用;TS 的类型在插件写完 JS 之后就不存在了) */
export const PLUGIN_EVENTS: PluginEvent[] = [
  'document:save',
  'document:change',
  'file:open',
  'vault:change',
  'theme:change',
  'config:change'
]

/** 交给插件的动作参数:对话框里填的值 + 这一行是什么 */
export interface PluginActionPayload {
  values?: Record<string, unknown>
  /**
   * 触发这次动作的那一行。给的是**快照**(行号与行文本),
   * 不是文档句柄 —— 插件要读整篇文档得走 vault 权限,不在这里开口子。
   */
  editor?: { line: number; lineText: string; filePath: string | null }
}

/** 插件返回的插入指令 —— 文档始终由宿主来改,插件只出内容 */
export interface PluginEditorInsert {
  /** 块级 Markdown 文本(宿主负责前后补空行) */
  text: string
  /** 光标落点(相对 text 起点的偏移);不填则落在插入内容末尾 */
  cursorOffset?: number
}

export type PluginStatus = 'idle' | 'running' | 'ok' | 'partial' | 'error'

export interface PluginState {
  enabled: boolean
  status: PluginStatus
  /** 上次运行结束时间(epoch ms),从未运行为 null */
  lastRunAt: number | null
  /**
   * 状态的**唯一**一段文本,如「已推送到 2 个远端」「部分失败\n\n第 1 个远端…」。
   * 多远端的结果直接在这里逐行罗列,不再另起一份摘要。
   */
  lastMessage: string
  /**
   * 失败详情(已脱敏,可能较长)。
   *
   * 仍保留在插件 API 里是为了不破坏已有插件;宿主会把它写进操作日志,
   * **不会**再挂回状态里重复显示(状态只有 lastMessage 一段文本)。
   */
  lastDetail?: string
  /**
   * 目标列表里每一行目标的最近一次操作结果(key 为目标 id)。
   *
   * 与 lastMessage 的分工:那里是「这次运行整体说了什么」,这里是「每一行现在是什么颜色」。
   * setState 写入时按目标**合并**,单目标动作只需报告自己那一行,不用重发其他目标的结果。
   */
  targetResults?: Record<string, PluginTargetResult>
}

/**
 * 一条插件日志的级别。
 *
 * 前四档来自插件自己的 `imk.log()`(以及宿主替它写的安全审计);
 * `operation` 是宿主在动作结束后记的摘要 —— 它和插件日志进同一个尾巴、同一个文件,
 * 这样设置页看到的行与磁盘日志始终是同一份内容。
 */
export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'operation'

/** 设置页「插件日志」的一条;磁盘文件由宿主用同一套字段拼成 `时间戳 [级别] 正文` */
export interface PluginLogEntry {
  /** 产生时间(epoch ms) */
  at: number
  level: PluginLogLevel
  /** 正文;操作记录可能带换行(第一行是摘要,后面是明细) */
  message: string
}

/** 一次已经结束的插件操作,设置页的「调试」模块用它;完整版另有日志文件 */
export interface PluginOperation {
  /** 结束时间(epoch ms) */
  at: number
  /** 按钮名(如「测试连接」「立即上传」);后台触发时为「后台任务」 */
  action: string
  /** 结束时的整体状态:成功 / 部分失败 / 失败 */
  status: 'ok' | 'partial' | 'error'
  /** 结果文本(逐项明细;整体状态由 status 或状态卡徽标负责) */
  message: string
  /** 更长的失败原因/逐项明细;与 message 相同的话宿主不会再存一份 */
  detail?: string
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
  /**
   * 编辑器行首「+」菜单的贡献条目。
   *
   * 注意这些条目的 `action` **不出现在 `actions` 里**:`actions` 是设置页里的全局按钮,
   * 而这里的是行内动作,混在一起会让插件设置页多出一个说不通的按钮。
   */
  lineMenu?: PluginLineMenuItem[]
}

/** 插件来源:内置核心插件 / 市场安装 / 应用自带的兜底包 / 手动放进插件目录 */
export type PluginSource = 'builtin' | 'market' | 'bundled' | 'local'

/** 已安装插件的来源信息(持久化在数据根下的 plugins/installed.json,即 ~/.imark/plugins/installed.json) */
export interface PluginInstallInfo {
  version: string
  installedAt: number
  /** 整包 integrity(sha256),也是安装确认框里让用户比对的那个值 */
  integrity: string
  /** 发布者用户名(本机手动安装为 null) */
  publisher: string | null
  source: PluginSource
  /** main 层模式;没有 main 层时为 null */
  mainMode?: PluginMainMode | null
  /** 是否有 render 层 */
  hasRender?: boolean
  /** 无代码插件绑定的宿主内置能力 */
  capability?: string | null
  /** main 入口的 sha256(没有 main 层时为 null) */
  mainSha256?: string | null
  /** render 入口的 sha256(没有 render 层时为 null) */
  renderSha256?: string | null
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
  /** main 层模式;没有 main 层时为 undefined */
  mainMode?: PluginMainMode
  /** 是否有 render 层 */
  hasRender?: boolean
  /** 无代码插件绑定的宿主内置能力 id */
  capability?: string
  /**
   * 受限 main 层:用户是否为它放开了「允许访问本机地址」。
   * 界面上要显示成一个开关 —— 它是用户做过的决定,得能看见、能改回来。
   */
  allowLocalNet?: boolean
  source?: PluginSource
  permissions?: PluginPermission[]
  installed?: PluginInstallInfo
  /** 连续失败次数(宿主熔断计数,见 host.ts 的 safeCall) */
  failures?: number
  /** 已被宿主熔断:连续失败过多,需要用户在设置里显式重新启停才会再跑 */
  disabledByHost?: boolean
  /**
   * 来自 `--plugin-dev=<目录>`(见 main/plugins/dev.ts):**不是安装进来的**,
   * 改文件即时生效,重启应用后如果没有那个启动参数就消失。
   *
   * 界面上必须把它标出来:开发中的插件和装进来的插件在列表里长得一模一样,
   * 用户会以为它一直都在,而下次启动它就不见了。
   */
  dev?: boolean
  /**
   * 日志尾巴(最近若干条):插件自己 log() 的行 + 宿主记录的操作摘要/警告。
   * 与 `logs/plugins/<id>.log` 的内容一一对应,只是没有磁盘上的完整历史。
   */
  logs?: PluginLogEntry[]
  /** 最近 3 次操作结果(新的在前);完整日志在数据根下的 logs/plugins/<id>.log */
  recentOps?: PluginOperation[]
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
  /**
   * 结果对应的状态;不填时由宿主按 `ok` 推断(成功 / 失败)。
   * 异步动作可以用 'running' 表示「已接受/已排队,还没结束」,
   * 多远端动作可以用 'partial' 表示部分失败。
   */
  status?: PluginStatus
  /**
   * 插件要求往文档里插入的内容(仅行首菜单的动作会用到)。
   *
   * 由**宿主**执行插入,插件只负责生成文本:插件跑在主进程、文档在渲染层,
   * 而且失败与熔断路径上宿主不会带上这个字段 —— 拿不到就什么都不插,这正是想要的。
   */
  editor?: PluginEditorInsert
}

// ---------- 宿主 → 渲染层的界面请求(编辑器扩展点 + 界面注入) ----------
//
// 这两件事都**必须**发生在渲染层:文档与 CodeMirror 在那儿,主界面也在那儿。
// 插件(不管跑在主进程还是自己的页面里)都只能请宿主转达 —— 插件代码本身
// 永远进不了渲染层,这条从改造之初就没有松动过。

/** 宿主请渲染层做的一次操作(只剩 render 层生命周期) */
export type RendererOpName =
  // 这几个不是"宿主替插件做事",而是**宿主把插件代码叫起来**。
  // 走同一条请求/回执通道是为了复用"渲染层不在就明确失败 + 超时清挂起"那套纪律。
  /** 为主进程即将注入的 render 层登记 nonce / 配置 */
  | 'render.prepare'
  /** 注入完成后调用插件登记的 onEnable */
  | 'render.enable'
  /** 配置变了 → 更新快照并调用 onConfigChange */
  | 'render.config'
  /** 宿主条目(菜单/命令/状态栏)的动作交给 render 层执行 */
  | 'render.runAction'
  /** 停用/卸载:调用 onDisable、移除它注册的扩展、丢掉会话 */
  | 'render.unload'

export interface RendererOpRequest {
  /** 请求序号(宿主生成,渲染层原样带回) */
  id: number
  /** 是谁要做的 —— 渲染层据此给元素打上归属标记(样式作用域靠它) */
  pluginId: string
  op: RendererOpName
  args: unknown
}

export type RendererOpReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string }

/**
 * 渲染半 ↔ 后端半的一条消息。
 *
 * **它不携带能力**:只是把数据从同一插件的一半送到另一半。真正的系统能力仍然由
 * 后端半经 `plugin:rpc` 向闸门申请。宿主只做校验(通道名、体积、频率)与转发。
 */
export interface RenderHalfMessage {
  pluginId: string
  /** 通道名:字母数字与 `. _ -`,≤64 字符 */
  channel: string
  data: unknown
}

/** 插件配置的持久化形态(存于 settings.json 的 plugins 字段) */
export interface PluginConfigEntry {
  enabled: boolean
  config: Record<string, unknown>
  /**
   * 是否为这个插件放开「允许访问本机/内网地址」。
   *
   * 默认一律拒(见 main/plugins/ops.ts 的 net.fetch):插件的网络请求由宿主代发,
   * 而"能连本机"等于能碰到这台机器上的其它服务(开发服务器、数据库、别的应用的管理端口)。
   * 需要它的场景真实存在(连本地跑的服务),所以给一个**显式**的开关,
   * 而不是让插件悄悄得逞。
   */
  allowLocalNet?: boolean
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
