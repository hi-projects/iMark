/**
 * 扩展「运行状态」的统一说法 —— 设置页状态卡、市场已安装列表共用。
 *
 * 关键区分:**启用态 ≠ 上一次操作的成败**。
 * `status` 只描述扩展自己 `reportStatus()` 的结论(idle/running/ok/partial/error),
 * 而像 quick-edit 这种只在行首菜单里被点一下的扩展,启用后可能永远没有「操作」,
 * 但它确实已经跑起来了。所以圆点先看 enabled,再让 error/running 覆盖它。
 *
 * 扩展视图同时带 `runtime.status`(inactive/activating/active/failed/…);
 * 设置页会先把失败态折算成这里的 `error` 再调用这些函数。
 */

import type { PluginStatus } from '@shared/plugins'

/** 与 `plugin-status-*` / `plugin-status-card-*` 的类名后缀一致 */
export type PluginStatusTone = 'idle' | 'running' | 'ok' | 'error'

export interface PluginStatusState {
  enabled: boolean
  status: PluginStatus
}

export interface PluginStatusText {
  enabled: boolean
  lastMessage: string
}

export interface PluginStatusRun {
  lastRunAt: number | null
}

/**
 * 圆点与状态卡左侧色条的颜色。
 *
 * - error 优先:哪怕已经被熔断停用,失败也必须看得见
 * - 启用中且没有正在跑的操作 → 绿点(它在运行,只是此刻没有操作)
 * - 停用 → 灰点;running → 蓝点
 */
export function pluginStatusTone(state: PluginStatusState): PluginStatusTone {
  if (state.status === 'error' || state.status === 'partial') return 'error'
  if (state.status === 'running') return 'running'
  return state.enabled ? 'ok' : 'idle'
}

/** 状态卡左上角那两个字 */
export function pluginStatusLabel(state: PluginStatusState): string {
  // 用户关掉的扩展不该继续显示「成功」—— 那句话描述的是它停止前的最后一次操作
  if (!state.enabled && state.status !== 'error') return '已停用'
  switch (state.status) {
    case 'running':
      return '进行中'
    case 'error':
      return '失败'
    case 'partial':
      return '部分失败'
    case 'ok':
      return '成功'
    default:
      return '运行中'
  }
}

/**
 * 状态卡正文。扩展自己报过消息就照它说的;没有消息时说的是**启用态本身**,
 * 不用「尚未运行」—— 启用中的扩展已经在跑,只是还没执行过操作。
 */
export function pluginStatusMessage(state: PluginStatusText): string {
  if (state.lastMessage) return state.lastMessage
  return state.enabled ? '已启用' : '尚未启用'
}

/**
 * 状态卡右侧的时间:只显示**完成时间**。
 *
 * 正在执行时还没有完成时间,没跑过操作时也没有 —— 这两种情况都直接留空,
 * 不拿「执行中」「尚未执行操作」之类的文字去占位。
 */
export function pluginStatusTime(
  state: PluginStatusRun,
  format: (ts: number) => string
): string {
  return state.lastRunAt ? format(state.lastRunAt) : ''
}
