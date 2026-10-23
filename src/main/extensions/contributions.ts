/**
 * 从已启用的扩展清单 + 运行时注册表生成**一次贡献点快照**。
 *
 * 纯函数、不碰磁盘、不碰进程：这样命令面板、状态栏、行首菜单看到的是同一份数据，
 * 而测试可以直接拿几个清单对象断言结果。
 *
 * 两条约定：
 * - 只有 `enabled` 的扩展出现在快照里。禁用之后界面上的命令/菜单/按钮必须立刻消失，
 *   不能靠“调用时再报错”来兜底。
 * - `available` 在这里算好。`when` 子句的真身在 main（上下文来自渲染层），
 *   渲染层只负责画灰不灰。
 */

import type {
  ExtensionDescriptor,
  ExtensionActionView,
  ExtensionCommandView,
  ExtensionContextKeys,
  ExtensionContributionsSnapshot,
  ExtensionHostGroupView,
  ExtensionHostMode,
  ExtensionInstallInfo,
  ExtensionKeybindingView,
  ExtensionLineMenuView,
  ExtensionMenuView,
  ExtensionSource,
  ExtensionStatusItemView,
  ExtensionStatusSnapshot
} from '@shared/extensions'
import type { ExtensionManifest } from '@shared/extensionPackage'
import type { StatusBarItemDto } from '@shared/extensionProtocol'
import { evaluateWhenClause } from '@shared/whenClause'

/** main 里一个已安装扩展的静态信息 */
export interface ExtensionEntry {
  id: string
  /** 扩展目录 */
  root: string
  manifest: ExtensionManifest
  descriptor: ExtensionDescriptor
  enabled: boolean
  source: ExtensionSource
  installed: ExtensionInstallInfo | null
  loadError?: string
}

export interface RuntimeCommandRegistration {
  extensionId: string
  title?: string
}

interface ContributionsInput {
  entries: Iterable<ExtensionEntry>
  context: ExtensionContextKeys
  hostGroups: ExtensionHostGroupView[]
  /** 状态栏条目：extensionId → itemId → DTO */
  statusItems: ReadonlyMap<string, ReadonlyMap<string, StatusBarItemDto>>
  /** 运行时注册的命令：command → 归属扩展 */
  runtimeCommands: ReadonlyMap<string, RuntimeCommandRegistration>
  /** 应用已有的快捷键（小写、`+` 连接）；冲突的扩展快捷键会被标成 dropped */
  reservedKeys?: ReadonlySet<string>
  /** 当前分组等同于哪个模式按钮的默认行为；都不是则 `custom` */
  hostModeState: ExtensionHostMode | 'custom'
  /** 本次运行宿主的 PID（宿主组视图用） */
  pidOf?: (hostId: number) => number | null
  /** 扩展最近一次上报的状态（状态栏着色与悬停说明用） */
  statusOf?: (extensionId: string) => ExtensionStatusSnapshot | undefined
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const

/**
 * 把一条快捷键写成可比较的规范形式。
 *
 * 扩展作者写的是 VS Code 风格(`ctrl+alt+s`、`CmdOrCtrl+S`),Electron 菜单写的是
 * `CmdOrCtrl+S`;两边要能撞车就必须先归一到同一种写法。规则:
 * - 大小写、空格无所谓;
 * - `CmdOrCtrl` 在当前平台落成 `ctrl`(Windows/Linux)或 `meta`(macOS);
 * - `cmd` / `command` 归一成 `meta`,`option` 归一成 `alt`,`control` 归一成 `ctrl`;
 * - 修饰键按固定顺序排列,`Shift+Ctrl+S` 与 `Ctrl+Shift+S` 视为同一条。
 */
export function normalizeKeybinding(key: string): string {
  const parts = key
    .trim()
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
  const modifiers = new Set<string>()
  const rest: string[] = []
  for (const part of parts) {
    if (
      part === 'commandorcontrol' ||
      part === 'commandorctrl' ||
      part === 'cmdorctrl' ||
      part === 'cmdorcontrol'
    ) {
      modifiers.add(process.platform === 'darwin' ? 'meta' : 'ctrl')
    } else if (part === 'cmd' || part === 'command' || part === 'super' || part === 'meta') {
      modifiers.add('meta')
    } else if (part === 'control') {
      modifiers.add('ctrl')
    } else if (part === 'option') {
      modifiers.add('alt')
    } else if (part === 'ctrl' || part === 'alt' || part === 'shift') {
      modifiers.add(part)
    } else {
      rest.push(part === 'return' ? 'enter' : part)
    }
  }
  // 没有主键(只写了修饰键)时保留原样,避免几条坏声明互相“相等”
  if (rest.length === 0) return [...modifiers].join('+')
  return [...MODIFIER_ORDER.filter(m => modifiers.has(m)), ...rest].join('+')
}

export function buildContributions(input: ContributionsInput): ExtensionContributionsSnapshot {
  const enabled = [...input.entries]
    .filter(entry => entry.enabled && !entry.loadError)
    .sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map(enabled.map(entry => [entry.id, entry]))

  // ---------- 命令 ----------
  const commands: ExtensionCommandView[] = []
  const commandWhen = new Map<string, string | undefined>()
  for (const entry of enabled) {
    for (const item of entry.manifest.contributes?.menus?.commandPalette ?? []) {
      if (!commandWhen.has(item.command)) commandWhen.set(item.command, item.when)
    }
  }
  const keybindingOf = new Map<string, string>()
  for (const entry of enabled) {
    for (const binding of entry.manifest.contributes?.keybindings ?? []) {
      if (!keybindingOf.has(binding.command)) keybindingOf.set(binding.command, binding.key)
    }
  }
  const seenCommands = new Set<string>()
  for (const entry of enabled) {
    for (const item of entry.manifest.contributes?.commands ?? []) {
      if (seenCommands.has(item.command)) continue
      seenCommands.add(item.command)
      const when = commandWhen.get(item.command)
      commands.push({
        extensionId: entry.id,
        extensionName: entry.descriptor.displayName,
        command: item.command,
        title: item.title,
        category: item.category,
        detail: item.detail,
        source: 'manifest',
        keybinding: keybindingOf.get(item.command),
        when,
        available: evaluateWhenClause(when, input.context)
      })
    }
  }
  for (const [command, registration] of input.runtimeCommands) {
    if (seenCommands.has(command)) continue
    const entry = byId.get(registration.extensionId)
    if (!entry) continue
    seenCommands.add(command)
    commands.push({
      extensionId: entry.id,
      extensionName: entry.descriptor.displayName,
      command,
      title: registration.title ?? command,
      source: 'runtime',
      available: true
    })
  }
  commands.sort(
    (a, b) =>
      a.extensionName.localeCompare(b.extensionName) ||
      (a.category ?? '').localeCompare(b.category ?? '') ||
      a.title.localeCompare(b.title)
  )

  // ---------- 快捷键 ----------
  const keybindings: ExtensionKeybindingView[] = []
  const used = new Set<string>(
    input.reservedKeys ? [...input.reservedKeys].map(normalizeKeybinding) : []
  )
  for (const entry of enabled) {
    for (const binding of entry.manifest.contributes?.keybindings ?? []) {
      const key = normalizeKeybinding(binding.key)
      const dropped = used.has(key)
      if (!dropped) used.add(key)
      keybindings.push({
        extensionId: entry.id,
        command: binding.command,
        key: binding.key,
        mac: binding.mac,
        when: binding.when,
        ...(dropped ? { dropped: true } : {})
      })
    }
  }

  // ---------- 状态栏 ----------
  const statusItems: ExtensionStatusItemView[] = []
  for (const entry of enabled) {
    const items = input.statusItems.get(entry.id)
    if (!items) continue
    const status = input.statusOf?.(entry.id)
    for (const item of items.values()) {
      statusItems.push({
        id: `${entry.id}:${item.id}`,
        extensionId: entry.id,
        extensionName: entry.descriptor.displayName,
        alignment: item.alignment,
        priority: item.priority,
        text: item.text,
        tooltip: item.tooltip,
        command: item.command,
        color: item.color,
        backgroundColor: item.backgroundColor,
        name: item.name,
        visible: item.visible,
        ...(status ? { status } : {})
      })
    }
  }
  statusItems.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  // ---------- 行首菜单 ----------
  const lineMenu: ExtensionLineMenuView[] = []
  for (const entry of enabled) {
    for (const item of entry.manifest.contributes?.['imark.lineMenu'] ?? []) {
      lineMenu.push({
        id: `${entry.id}:${item.id}`,
        extensionId: entry.id,
        extensionName: entry.descriptor.displayName,
        label: item.label,
        command: item.command,
        ...(item.dialog ? { dialog: item.dialog } : {})
      })
    }
  }

  // ---------- 设置页动作 ----------
  const actions: ExtensionActionView[] = []
  for (const entry of enabled) {
    for (const item of entry.manifest.contributes?.['imark.actions'] ?? []) {
      actions.push({
        extensionId: entry.id,
        extensionName: entry.descriptor.displayName,
        command: item.command,
        label: item.label,
        scope: item.scope ?? 'global',
        targetSetting: item.targetSetting,
        primary: item.primary === true
      })
    }
  }

  // ---------- 命令面板菜单项（与 commands 是两份数据：菜单管可见性） ----------
  const menus: ExtensionMenuView[] = []
  for (const entry of enabled) {
    for (const item of entry.manifest.contributes?.menus?.commandPalette ?? []) {
      menus.push({
        extensionId: entry.id,
        extensionName: entry.descriptor.displayName,
        command: item.command,
        where: 'commandPalette',
        when: item.when,
        available: evaluateWhenClause(item.when, input.context)
      })
    }
  }

  const hostGroups: ExtensionHostGroupView[] = input.hostGroups.map(group => ({
    ...group,
    pid: group.pid ?? input.pidOf?.(group.hostId) ?? null
  }))

  return {
    commands,
    keybindings,
    statusItems,
    lineMenu,
    actions,
    menus,
    context: { ...input.context },
    hostGroups,
    hostModeState: input.hostModeState
  }
}
