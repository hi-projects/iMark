/**
 * 渲染半插件注册的 CM6 扩展(按插件分桶)。
 *
 * 为什么要有这一层:
 *   - `loadDocument()` 每次打开文件都会**重建 state**,扩展必须在 buildExtensions 里
 *     重新装一遍 —— 所以注册表是模块级的,每次建 state 都重新收集;
 *   - 停用插件时要能精确移除它注册的扩展。CM6 的 `Compartment` 正好做这件事:
 *     把聚合后的扩展放进一个 compartment,增删后 reconfigure 一次即可。
 *
 * 只有这一条路:render 层自己写 CM6 扩展。宿主不再提供"代渲染装饰"通道。
 */
import { Compartment, type Extension } from '@codemirror/state'
import { editorHolder } from '../stores/app'

const compartment = new Compartment()
const registry = new Map<string, Extension[]>()

function collect(): Extension[] {
  return [...registry.values()].flat()
}

/** 放进 buildExtensions:每次新建/重建 editor state 时都把当前注册表装进去 */
export function pluginExtensionsCompartment(): Extension {
  return compartment.of(collect())
}

function reconfigure(): void {
  const view = editorHolder.view
  if (!view) return
  view.dispatch({ effects: compartment.reconfigure(collect()) })
}

/**
 * 注册一段扩展,返回注销函数。
 * 同一个插件可以注册多段;注销只移除这一段,不影响其他扩展。
 */
export function registerPluginExtension(pluginId: string, extension: Extension): () => void {
  const current = registry.get(pluginId) ?? []
  registry.set(pluginId, [...current, extension])
  reconfigure()

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const list = registry.get(pluginId)
    if (!list) return
    const index = list.indexOf(extension)
    if (index === -1) return
    const next = [...list]
    next.splice(index, 1)
    if (next.length === 0) registry.delete(pluginId)
    else registry.set(pluginId, next)
    reconfigure()
  }
}

/** 停用/卸载:把这个插件注册过的扩展一次收干净 */
export function unregisterAllPluginExtensions(pluginId: string): void {
  if (!registry.delete(pluginId)) return
  reconfigure()
}

/** 仅验收用:当前这个插件注册了几段扩展(不参与运行时逻辑) */
export function countPluginExtensions(pluginId: string): number {
  return registry.get(pluginId)?.length ?? 0
}
