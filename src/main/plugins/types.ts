/**
 * 宿主侧的插件契约。
 *
 * 改造前 `MainPlugin` 直接带着 onEnable/onDisable/... 四个方法;引入外部插件后,
 * 「插件是什么」与「插件怎么被加载」被拆开了:
 *   - `PluginRuntime`  —— 插件能做什么(四个生命周期方法),定义在 shared/pluginApi.ts
 *   - `MainPlugin`     —— 宿主眼里一个可注册的插件(标识 + 描述符 + 运行时 + 来源)
 * 脚本插件(script.ts)与声明式插件(declarative.ts)各自是薄适配器,产出同一个
 * `PluginRuntime`,宿主从此只认运行时,不再关心它从哪来。
 */

import type { PluginRuntime } from '@shared/pluginApi'
import type { PluginDescriptor, PluginInstallInfo } from '@shared/plugins'

// PluginContext 已移到 shared/pluginApi.ts(插件源码要 import 它)。
// 这里做一次类型中转,免得 main 侧各处都要改 import 路径。
export type { PluginContext, PluginRuntime } from '@shared/pluginApi'

export interface MainPlugin {
  readonly id: string
  readonly descriptor: PluginDescriptor
  /** 生命周期实现 */
  readonly runtime: PluginRuntime
  /** 外部安装的插件才有;内置核心插件为 undefined */
  readonly meta?: PluginInstallInfo
  /** 包所在的安装目录(外部插件才有) */
  readonly dir?: string
}
