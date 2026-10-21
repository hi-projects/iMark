/**
 * 扩展贡献点在界面上的只读投影:命令面板、状态栏、图标。
 *
 * 这里**不解析扩展给的任何东西**:主进程已经把清单削成
 * 「命令 id、标题、能不能用」「状态栏文本、点击执行哪条命令」。
 * 图标名只走白名单 —— 扩展给的是名字,不是一段要宿主渲染的界面。
 */

import { computed, type Component } from 'vue'
import {
  AlertTriangle,
  ArrowUpCircle,
  Bell,
  Check,
  CloudUpload,
  Clock,
  FileText,
  GitBranch,
  Link,
  List,
  Pin,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Terminal,
  Zap
} from 'lucide-vue-next'
import type {
  ExtensionCommandView,
  ExtensionStatusItemView,
  ExtensionStatusSnapshot
} from '@shared/extensions'
import { extensionById, extensionStore, openExtensionSettings, runExtensionCommand } from './extensionService'
import { fuzzyScore } from './vaultService'

const ICONS: Record<string, Component> = {
  'cloud-upload': CloudUpload,
  refresh: RefreshCw,
  sync: RefreshCw,
  git: GitBranch,
  clock: Clock,
  check: Check,
  alert: AlertTriangle,
  bell: Bell,
  list: List,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  star: Star,
  terminal: Terminal,
  zap: Zap,
  link: Link,
  pin: Pin,
  file: FileText,
  update: ArrowUpCircle
}

/**
 * 状态栏文本里的 codicon 记法(`$(sync)` / `$(git~spin)`)。
 *
 * 只认白名单里那几个;认不出就原样显示文字。`~spin` 之类的修饰不参与匹配 ——
 * 宿主没有义务实现整套 codicon 动画,但也不该让一个后缀把整条文本吃掉。
 */
export function statusIcon(text: string): Component | null {
  const match = /^\$\(([a-z0-9-]+)(?:~[a-z-]+)?\)/.exec(text.trim())
  return match ? (ICONS[match[1]!] ?? null) : null
}

export function statusLabel(text: string): string {
  return text.replace(/^\$\([a-z0-9-]+(?:~[a-z-]+)?\)\s*/, '')
}

/**
 * 扩展给的颜色只接受「值」,不接受任意 CSS 片段。
 * 与编辑器装饰同一份白名单:hex/rgb()/hsl() 与主题变量。
 */
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|var\(--[\w-]+\))$/i

export function statusColor(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text && COLOR.test(text) ? text : undefined
}

export interface PaletteCommand extends ExtensionCommandView {
  usable: boolean
}

export const paletteCommands = computed<PaletteCommand[]>(() =>
  (extensionStore.contribs?.commands ?? []).map(command => ({
    ...command,
    usable: command.available
  }))
)

/**
 * 按关键词排序:标题 ×2、扩展名 ×1、说明 ×0.5。
 *
 * 不可用的命令照样列出来(排在后面、标「不可用」)——「为什么没有这条命令」
 * 的答案,比一个干净的空列表有用。
 */
export function searchExtensionCommands(query: string, limit = 12): PaletteCommand[] {
  const q = query.trim()
  const all = paletteCommands.value
  if (!q) return all.slice(0, limit)
  const scored: Array<{ cmd: PaletteCommand; score: number }> = []
  for (const cmd of all) {
    const s = Math.max(
      fuzzyScore(q, cmd.title) * 2,
      fuzzyScore(q, cmd.extensionName),
      cmd.detail ? fuzzyScore(q, cmd.detail) : -1
    )
    if (s >= 0) scored.push({ cmd, score: s + (cmd.usable ? 0 : -1) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(item => item.cmd)
}

/** 状态栏条目(只含 `visible: true` 的) */
export const statusEntries = computed<ExtensionStatusItemView[]>(() =>
  (extensionStore.contribs?.statusItems ?? []).filter(item => item.visible)
)

export function statusTitle(item: ExtensionStatusItemView): string {
  const lines = [item.tooltip || item.extensionName]
  const status = item.status
  if (status?.lastMessage) lines.push(status.lastMessage)
  if (status?.lastRunAt) {
    lines.push(`上次 ${new Date(status.lastRunAt).toLocaleString('zh-CN', { hour12: false })}`)
  }
  if (status?.lastDetail) lines.push(status.lastDetail)
  return lines.join('\n')
}

/** 状态栏着色直接读扩展最近一次 `reportStatus` 的结论 */
export function statusTone(
  status: ExtensionStatusSnapshot | undefined
): 'ok' | 'running' | 'error' | 'idle' {
  switch (status?.status) {
    case 'ok':
      return 'ok'
    case 'running':
      return 'running'
    case 'error':
    case 'partial':
      return 'error'
    default:
      return 'idle'
  }
}

/**
 * 点状态栏条目:失败/部分失败时进设置看原因,其余情况执行条目声明的命令。
 *
 * 这条规则对**所有**扩展一致:出错时再点一次同一条命令只会再失败一次,
 * 用户真正需要的是「为什么」。
 */
export function clickStatusItem(item: ExtensionStatusItemView): void {
  const tone = statusTone(item.status)
  if (tone === 'error' || !item.command) {
    openExtensionSettings(item.extensionId)
    return
  }
  void runExtensionCommand(item.command, [], 'statusBar')
}

/** 设置页导航圆点的颜色:先看启用态,再让运行/失败覆盖它 */
export function extensionTone(id: string): 'ok' | 'running' | 'error' | 'idle' {
  const view = extensionById(id)
  if (!view) return 'idle'
  if (view.runtime.status === 'failed' || view.runtime.status === 'crashed' || view.runtime.status === 'crash-loop') {
    return 'error'
  }
  if (view.runtime.status === 'activating') return 'running'
  if (view.status.status === 'error' || view.status.status === 'partial') return 'error'
  if (view.enabled && view.runtime.status === 'active') return 'ok'
  return view.enabled ? 'ok' : 'idle'
}
