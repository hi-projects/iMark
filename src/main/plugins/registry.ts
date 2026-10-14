import { gitSyncPlugin } from './gitSync'
import type { MainPlugin } from './types'

/**
 * 内置核心插件清单(仿 Obsidian「核心插件」)。
 * 新增插件:实现 MainPlugin 接口后加进这个数组即可,设置面板与生命周期由宿主统一处理。
 */
export const builtinPlugins: MainPlugin[] = [gitSyncPlugin]
