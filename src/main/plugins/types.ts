import type { PluginActionResult, PluginDescriptor, PluginState } from '@shared/plugins'

/** 宿主交给插件的运行时能力 */
export interface PluginContext {
  readonly pluginId: string
  /** 当前生效配置(已归一化,含字段默认值) */
  getConfig<T = Record<string, unknown>>(): T
  /** 更新状态并广播给渲染层 */
  setState(patch: Partial<PluginState>): void
  /** 让渲染层先把脏文档落盘(带超时兜底,无窗口时立即返回) */
  flushDocument(): Promise<void>
  isEnabled(): boolean
}

/**
 * 内置核心插件接口。
 *
 * 生命周期:onEnable(启用/应用启动时已启用)→ 可选 onConfigChange(改配置)→
 * onDisable(用户停用,或应用退出时)。定时器、子进程等资源必须在 onDisable 里释放。
 *
 * 将来要支持外部插件时,只需让外部模块实现同一接口再注册进 registry。
 */
export interface MainPlugin {
  readonly id: string
  readonly descriptor: PluginDescriptor
  onEnable?(ctx: PluginContext): void | Promise<void>
  onDisable?(ctx: PluginContext): void | Promise<void>
  onConfigChange?(config: unknown, ctx: PluginContext): void | Promise<void>
  /** targetId 只在 descriptor.targetActions 里的动作上出现(对目标列表的某一行执行) */
  runAction?(actionId: string, ctx: PluginContext, targetId?: string): Promise<PluginActionResult>
}
