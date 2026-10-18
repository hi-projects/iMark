/**
 * 插件「运行状态」的统一说法 —— 侧栏圆点、市场列表圆点、设置页状态卡共用。
 *
 * 关键区分:**启用态 ≠ 上一次操作的成败**。
 * `state.status` 只描述操作(idle/running/ok/error),而像 Advanced Table 这种只在
 * 行首菜单里被点一下的插件,启用后可能永远没有「操作」,但它确实已经跑起来了。
 * 所以圆点先看 enabled,再让 error/running 覆盖它 —— 否则一个正常工作的插件
 * 会一直挂着一颗灰点,状态卡还写着「待运行 / 尚未运行」。
 */

import type { PluginState } from '@shared/plugins'

/** 与 `plugin-status-*` / `plugin-status-card-*` 的类名后缀一致 */
export type PluginStatusTone = 'idle' | 'running' | 'ok' | 'error'

/**
 * 圆点与状态卡左侧色条的颜色。
 *
 * - error 优先:哪怕已经被熔断停用,失败也必须看得见
 * - 启用中且没有正在跑的操作 → 绿点(它在运行,只是此刻没有操作)
 * - 停用 → 灰点;running → 蓝点
 */
export function pluginStatusTone(
  state: Pick<PluginState, 'enabled' | 'status'>
): PluginStatusTone {
  if (state.status === 'error' || state.status === 'partial') return 'error'
  if (state.status === 'running') return 'running'
  return state.enabled ? 'ok' : 'idle'
}

/** 状态卡左上角那两个字 */
export function pluginStatusLabel(
  state: Pick<PluginState, 'enabled' | 'status'>
): string {
  // 用户关掉的插件不该继续显示「成功」—— 那句话描述的是它停止前的最后一次操作
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
 * 状态卡正文。插件自己报过消息就照它说的;没有消息时说的是**启用态本身**,
 * 不用「尚未运行」—— 启用中的插件已经在跑,只是还没执行过操作。
 */
export function pluginStatusMessage(
  state: Pick<PluginState, 'enabled' | 'lastMessage'>
): string {
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
  state: Pick<PluginState, 'lastRunAt'>,
  format: (ts: number) => string
): string {
  return state.lastRunAt ? format(state.lastRunAt) : ''
}
