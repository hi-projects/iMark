/**
 * 扩展图标的渲染层缓存。
 *
 * 图标是安装包里的静态文件,由主进程读成 data URL。设置页左栏、扩展设置页头与
 * 市场已安装列表可能同时要同一个扩展的图标,这里按 ID 只请求一次;取不到就
 * 记 null,不在每次渲染时反复重试。
 */

import { reactive } from 'vue'
import { api } from './api'

const icons = reactive<Record<string, string | null>>({})
const pending = new Set<string>()

export function ensureExtensionIcon(id: string): void {
  if (id in icons || pending.has(id)) return
  pending.add(id)
  void api
    .extensionIcon(id)
    .catch(() => null)
    .then(url => {
      icons[id] = url
    })
    .finally(() => {
      pending.delete(id)
    })
}

export function extensionIconOf(id: string): string | null {
  return icons[id] ?? null
}
