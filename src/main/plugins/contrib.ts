/**
 * 界面贡献点的登记表(阶段二)。
 *
 * 插件往界面上放东西有**两条路**:
 *   ① 清单里写 `commands: [...]` / `statusBar: [...]` / `menus: [...]` —— 静态,装的时候就看得见
 *   ② 代码里调 `imark.commands.register(...)` / `imark.ui.statusItem(...)` —— 动态,onEnable 之后才有
 *
 * 两条路**产出同一种东西、走同一套派发**,差别只在登记时机。这个文件就是那个"同一种东西"
 * 落脚的地方,以及把两条路合并成一份快照的逻辑。
 *
 * 为什么 API 注册的要单独放一张表、而不是直接塞进清单那份数组:
 * 重载时要能干净地丢掉。入口文件换了一份新的,谁也不知道它这次会注册哪些命令 ——
 * 上一份代码注册的必须整体消失。清单那份是从 manifest 重新算出来的,天然是对的;
 * 而 API 那份挂在 entry 上,entry 一换就是空的。两者混在一起就没法区分"哪些该留"。
 *
 * 另外:API 注册的条目**同样要过校验**。清单是在安装时校验的,而 API 是运行时来的 ——
 * 插件可以注册一条 label 长到撑爆界面的命令,或者一个指向不存在动作的指针。
 * 校验逻辑用的是同一份(见 pluginPackage.ts 的 validateSlotList 家族),只是入口不同。
 */

import {
  KEYBINDING_RE,
  LIMITS,
  type PluginManifest
} from '@shared/pluginPackage'
import {
  type PluginCommand,
  type PluginContrib,
  type PluginMenuItem,
  type PluginStatusItem
} from '@shared/plugins'

/** id 的字符集与动作一致 */
const SLOT_ID_RE = /^[a-z0-9-]{1,40}$/

/** label/detail 的长度上限。为什么要有:它是**画在界面上**的,长度就是版面 */
const LABEL_MAX = 40
const DETAIL_MAX = 120

export interface ContribRejection {
  problems: string[]
}

/** API 注册的条目的执行体。返回 void 或 Promise 皆可,宿主统一包超时与异常 */
export type ContribHandler = (ctx: ContribInvokeContext) => unknown

/**
 * 条目的种类。三者的 id 命名空间互相独立(校验也是各查各的重复),
 * 所以执行体也必须按种类分开存 —— 见 ContribRegistry.handlers 处的说明。
 */
export type ContribKind = 'command' | 'status' | 'menu'

/** 交给执行体的现场:界面上点的是哪儿 */
export interface ContribInvokeContext {
  /** 从文件列表右键点进来时的那个文件(绝对路径) */
  filePath: string | null
  /** 从编辑器右键点进来时的行号(1 起) */
  line: number | null
  hasVault: boolean
}

export type ContribResult = { ok: true; value: PluginCommand } | { ok: false; errors: string[] }

/**
 * 一个插件当前登记的全部贡献点。
 *
 * `api*` 那几张表是插件在 onEnable 里注册进来的;清单那份不在里面 ——
 * 合并成快照时才从 manifest 读(见 mergeContrib)。
 */
export class ContribRegistry {
  private apiCommands = new Map<string, PluginCommand>()
  private apiStatus: PluginStatusItem | null = null
  private apiMenus = new Map<string, PluginMenuItem>()
  /**
   * API 注册的条目的**执行体**,按槽位分开存。
   *
   * 清单声明的条目走 runAction(action 是一个字符串 id),而代码注册的条目手里
   * 是一个真正的函数 —— 两者在界面上长得一模一样,派发时才分岔。
   * 这不改变"宿主不执行插件给的代码来决定界面长什么样"这条:这里跑的仍然是插件
   * 自己的动作,只是没绕一圈回到 runAction。
   *
   * **为什么分三张表而不是一张**:三张表的 id 是三个独立的命名空间(校验也是各查各的
   * 重复),而"同名"在插件里是常态 —— 一条命令和一条右键菜单条目都叫 `sync` 完全正常。
   * 共用一张表的话,后注册的那个会悄悄顶掉前一个的执行体,症状是"点菜单执行了命令"。
   */
  private handlers: Record<ContribKind, Map<string, ContribHandler>> = {
    command: new Map(),
    status: new Map(),
    menu: new Map()
  }

  /**
   * 注册一条命令。id 重复时**覆盖**而不是报错:
   * 插件在 onEnable 里连着重载两次、或者用同一个 id 覆盖自己的旧定义,都是正当用法。
   */
  addCommand(cmd: PluginCommand, handler?: ContribHandler): ContribResult {
    const errors = checkCommand(cmd)
    if (errors.length > 0) return { ok: false, errors }
    if (!this.apiCommands.has(cmd.id) && this.apiCommands.size >= LIMITS.commands) {
      return { ok: false, errors: [`命令数已达上限 ${LIMITS.commands} 条`] }
    }
    const value: PluginCommand = { ...cmd, id: cmd.id, label: cmd.label.slice(0, LABEL_MAX) }
    if (value.detail) value.detail = value.detail.slice(0, DETAIL_MAX)
    this.apiCommands.set(cmd.id, value)
    if (handler) this.handlers.command.set(cmd.id, handler)
    return { ok: true, value }
  }

  removeCommand(id: string): void {
    this.apiCommands.delete(id)
    this.handlers.command.delete(id)
  }

  /** 条目自己带的执行体;没有就说明它指向的是 runAction 里那个 action */
  handlerFor(kind: ContribKind, id: string): ContribHandler | undefined {
    return this.handlers[kind].get(id)
  }

  /**
   * 登记状态栏条目。**一个插件只有一条** —— 第二次调用是替换,不是新增。
   * 传 null 表示收回。
   *
   * `handler` 与 addCommand 的那一个是同一张表(见 handlers 的说明):
   * 状态栏条目的 id 与命令的 id 共用一个命名空间,点了之后找的也是同一个执行体。
   */
  setStatusItem(item: PluginStatusItem | null, handler?: ContribHandler): ContribRejection {
    if (item === null) {
      // 收条目的同时把它的执行体也收走 —— 留着就是一具没人认领的尸体,
      // 而且下次同 id 的条目会莫名其妙地"能点"。
      if (this.apiStatus) this.handlers.status.delete(this.apiStatus.id)
      this.apiStatus = null
      return { problems: [] }
    }
    const problems = checkStatusItem(item)
    if (problems.length > 0) return { problems }
    // 换了 id 就把旧 id 的执行体删掉,理由同上
    if (this.apiStatus && this.apiStatus.id !== item.id) {
      this.handlers.status.delete(this.apiStatus.id)
    }
    this.apiStatus = { ...item, label: item.label.slice(0, LABEL_MAX) }
    if (handler) this.handlers.status.set(item.id, handler)
    return { problems: [] }
  }

  addMenuItem(item: PluginMenuItem, handler?: ContribHandler): ContribRejection {
    const problems = checkMenuItem(item)
    if (problems.length > 0) return { problems }
    if (!this.apiMenus.has(item.id) && this.apiMenus.size >= LIMITS.menuItems) {
      return { problems: [`右键菜单条目已达上限 ${LIMITS.menuItems} 条`] }
    }
    this.apiMenus.set(item.id, { ...item, label: item.label.slice(0, LABEL_MAX) })
    if (handler) this.handlers.menu.set(item.id, handler)
    return { problems: [] }
  }

  removeMenuItem(id: string): void {
    this.apiMenus.delete(id)
    this.handlers.menu.delete(id)
  }

  /**
   * 丢掉**本次运行注册的全部内容**(停用时调用)。
   *
   * 只清 API 那几个表:清单那份是 merge 时现读 manifest 算出来的,没有可清的东西 ——
   * 这正是「停用后清单声明的东西也跟着消失、启用后又回来」能自动成立的原因。
   */
  resetApi(): void {
    this.apiCommands.clear()
    this.apiStatus = null
    this.apiMenus.clear()
    this.handlers.command.clear()
    this.handlers.status.clear()
    this.handlers.menu.clear()
  }

  /** 与清单声明合并成下发给渲染层的那一份 */
  merge(manifest: PluginManifest | null): Omit<PluginContrib, 'pluginId' | 'pluginName'> {
    // 清单那份以 API 那份**打底**:同一个 id 时 API 赢。
    // 理由是时机 —— 清单是"作者当初写的",API 是"这次跑起来之后决定的",
    // 后者更贴近当前意图(比如根据配置把命令名改成「上传到 公司仓库」)。
    const commands = new Map<string, PluginCommand>()
    for (const cmd of manifest?.commands ?? []) commands.set(cmd.id, cmd)
    for (const [id, cmd] of this.apiCommands) commands.set(id, cmd)

    const menus = new Map<string, PluginMenuItem>()
    for (const item of manifest?.menus ?? []) menus.set(item.id, item)
    for (const [id, item] of this.apiMenus) menus.set(id, item)

    return {
      // 状态栏同理:清单那一条是默认,API 显式设过就以 API 为准
      statusItem: this.apiStatus ?? manifest?.statusBar?.[0] ?? null,
      commands: [...commands.values()],
      menus: [...menus.values()]
    }
  }
}

// ---------------------------------------------------------------- 校验

function checkLabel(value: unknown, errors: string[], where: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${where} 不能为空`)
    return
  }
  if (value.length > LABEL_MAX) {
    errors.push(`${where} 过长(上限 ${LABEL_MAX} 字,现在 ${value.length} 字)`)
  }
}

function checkId(value: unknown, errors: string[]): void {
  if (typeof value !== 'string' || !SLOT_ID_RE.test(value)) {
    errors.push('id 非法(小写字母/数字/连字符,1-40 字符)')
  }
}

export function checkCommand(cmd: unknown): string[] {
  const errors: string[] = []
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return ['命令必须是对象']
  const c = cmd as Partial<PluginCommand>
  checkId(c.id, errors)
  checkLabel(c.label, errors, 'label')
  if (c.action !== undefined && (typeof c.action !== 'string' || !SLOT_ID_RE.test(c.action))) {
    errors.push('action 非法')
  }
  if (c.detail !== undefined && typeof c.detail !== 'string') errors.push('detail 必须是字符串')
  if (c.when !== undefined && !['always', 'editor', 'vault'].includes(c.when)) {
    errors.push('when 只能是 always / editor / vault')
  }
  // 快捷键也要在这里挡一道:清单那条路在安装时校验过,而 API 这条路是运行时来的,
  // 一个形状不对的组合键会直接递给 Electron 的原生菜单 —— 那不是报错就是静默失效
  if (
    c.keybinding !== undefined &&
    (typeof c.keybinding !== 'string' || !KEYBINDING_RE.test(c.keybinding))
  ) {
    errors.push('keybinding 非法(形如 Ctrl+Shift+P)')
  }
  return errors
}

export function checkStatusItem(item: unknown): string[] {
  const errors: string[] = []
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['状态栏条目必须是对象']
  const s = item as Partial<PluginStatusItem>
  checkId(s.id, errors)
  checkLabel(s.label, errors, 'label')
  // icon 是**名字**不是路径:宿主在白名单里查,查不到就退化成纯文字。
  // 校验字符集是为了让"查不到"这件事有确定的形状(而不是拿到一段 HTML 去想办法)
  if (s.icon !== undefined && (typeof s.icon !== 'string' || !/^[a-z0-9-]{1,32}$/.test(s.icon))) {
    errors.push('icon 必须是图标名(小写字母/数字/连字符)')
  }
  if (s.action !== undefined && (typeof s.action !== 'string' || !SLOT_ID_RE.test(s.action))) {
    errors.push('action 非法')
  }
  return errors
}

export function checkMenuItem(item: unknown): string[] {
  const errors: string[] = []
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['菜单条目必须是对象']
  const m = item as Partial<PluginMenuItem>
  checkId(m.id, errors)
  checkLabel(m.label, errors, 'label')
  // 取值表与 pluginPackage.ts 的 MENU_WHERES 对齐(那里是清单校验用的)
  if (m.where !== 'files') errors.push('where 只能是 files(编辑器右键菜单暂时没有)')
  if (m.action !== undefined && (typeof m.action !== 'string' || !SLOT_ID_RE.test(m.action))) {
    errors.push('action 非法')
  }
  if (m.danger !== undefined && typeof m.danger !== 'boolean') errors.push('danger 必须是布尔值')
  return errors
}
