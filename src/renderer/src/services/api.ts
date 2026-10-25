/**
 * 主窗口渲染层与宿主之间的桥(唯一入口)。
 *
 * preload 只暴露一个「只能取一次」的函数(见 src/preload/index.ts 的说明)。
 * 应用在这里、在**任何扩展代码加载之前**取走它并保存为模块常量 —— 之后同一个
 * realm 里的扩展再调用 `window.__imarkTakeApi()` 只能拿到 null。
 *
 * 两条纪律:
 * 1. 其他渲染层代码一律 `import { api } from '.../services/api'`,不要直接读
 *    `window.__imarkTakeApi`;env.d.ts 只声明这一个全局,类型检查会拦住绕行。
 * 2. **不要**把 `api` 挂回 window / globalThis / 任何扩展能读到的地方 ——
 *    那等于把整座桥重新交给页面脚本。
 */
import type { WindowApi } from '@shared/api'

const take = (window as unknown as { __imarkTakeApi?: () => WindowApi | null }).__imarkTakeApi
if (!take) throw new Error('宿主桥不存在:preload 没有加载')
const taken = take()
if (!taken) throw new Error('宿主桥已经被取走(应用初始化顺序有误)')

export const api: WindowApi = taken
