/**
 * 宿主分组规划:决定哪些扩展跑在同一个 utility process 里。
 *
 * 这不是扩展作者能控制的契约(清单里没有 execution 字段),而是**用户设置**:
 *
 *   extensionHost.mode = 'shared'(默认)      所有扩展一个宿主
 *   extensionHost.mode = 'isolated'          每个扩展一个宿主
 *   extensionHost.affinity: { id: n }        正整数相同的扩展进同一组
 *
 * 无论哪种模式,以下两条都会强制合并(与 VS Code 一致):
 *   - `extensionDependencies`:有依赖关系的扩展必须同组,依赖才能先激活;
 *   - 清单里的 `extensionAffinity`:作者声明的“请和我放在一起”提示。
 *
 * 分组是纯函数,不碰磁盘也不碰进程 —— 这样测试可以直接断言分组结果,
 * 而不用为了“三个扩展是不是三个 PID”去启动 Electron。
 */

import type { ExtensionHostMode } from '@shared/extensions'

export interface HostPlannerExtension {
  id: string
  enabled: boolean
  /** 纯声明式扩展(没有 main)不需要宿主进程 */
  hasMain: boolean
  extensionDependencies: readonly string[]
  extensionAffinity: readonly string[]
}

export interface HostPlanGroup {
  hostId: number
  extensionIds: string[]
}

export interface HostPlan {
  groups: HostPlanGroup[]
  byExtension: Map<string, number>
}

class UnionFind {
  private readonly parent = new Map<string, string>()

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key)
  }

  find(key: string): string {
    this.add(key)
    let root = key
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    let cursor = key
    while (cursor !== root) {
      const next = this.parent.get(cursor)!
      this.parent.set(cursor, root)
      cursor = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

/**
 * 组内按 `extensionDependencies` 拓扑排序;依赖在前。
 * 环不会让规划失败 —— 真实清单可能出现互相依赖,启动时按字典序兜底并让宿主自己报错。
 */
export function topologicalExtensionOrder(
  ids: readonly string[],
  dependenciesOf: (id: string) => readonly string[]
): string[] {
  const present = new Set(ids)
  const indegree = new Map<string, number>()
  const edges = new Map<string, string[]>()
  for (const id of ids) {
    indegree.set(id, 0)
    edges.set(id, [])
  }
  for (const id of ids) {
    for (const dep of dependenciesOf(id)) {
      if (!present.has(dep) || dep === id) continue
      edges.get(dep)!.push(id)
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
    }
  }
  const ready = ids.filter(id => (indegree.get(id) ?? 0) === 0).sort()
  const out: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    out.push(id)
    for (const next of edges.get(id) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1
      indegree.set(next, left)
      if (left === 0) {
        ready.push(next)
        ready.sort()
      }
    }
  }
  if (out.length < ids.length) {
    out.push(...ids.filter(id => !out.includes(id)).sort())
  }
  return out
}

export function planHosts(
  extensions: readonly HostPlannerExtension[],
  mode: ExtensionHostMode,
  affinity: Readonly<Record<string, number>> = {}
): HostPlan {
  const candidates = extensions.filter(item => item.enabled && item.hasMain)
  const candidateIds = new Set(candidates.map(item => item.id))
  const uf = new UnionFind()
  const keyOf = new Map<string, string>()

  for (const item of candidates) {
    const n = affinity[item.id]
    let key: string
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
      key = `affinity:${n}`
    } else if (mode === 'shared') {
      key = 'mode:shared'
    } else {
      key = `extension:${item.id}`
    }
    keyOf.set(item.id, key)
    uf.add(key)
  }

  for (const item of candidates) {
    const key = keyOf.get(item.id)!
    for (const dep of item.extensionDependencies) {
      if (candidateIds.has(dep)) uf.union(key, keyOf.get(dep)!)
    }
    for (const peer of item.extensionAffinity) {
      if (candidateIds.has(peer)) uf.union(key, keyOf.get(peer)!)
    }
  }

  const buckets = new Map<string, string[]>()
  for (const item of candidates) {
    const root = uf.find(keyOf.get(item.id)!)
    const list = buckets.get(root)
    if (list) list.push(item.id)
    else buckets.set(root, [item.id])
  }

  const depOf = (id: string): readonly string[] =>
    candidates.find(item => item.id === id)?.extensionDependencies ?? []

  const planned: { ids: string[]; base: boolean; root: string }[] = []
  for (const [root, ids] of buckets) {
    const base = ids.some(id => {
      const n = affinity[id]
      return !(typeof n === 'number' && Number.isInteger(n) && n > 0)
    })
    planned.push({
      ids: topologicalExtensionOrder(ids, depOf),
      base,
      root
    })
  }

  // 编号要确定:同一次设置下反复计算必须得到同样的 hostId,否则“没变化的宿主”
  // 会因为没有意义的编号抖动而被重启。
  planned.sort((a, b) => {
    if (mode === 'shared' && a.base !== b.base) return a.base ? -1 : 1
    return (a.ids[0] ?? '').localeCompare(b.ids[0] ?? '')
  })

  const groups: HostPlanGroup[] = planned.map((item, index) => ({
    hostId: mode === 'shared' && item.base ? 0 : index,
    extensionIds: item.ids
  }))

  // 排序已经保证 shared 模式的 base 组在最前,所以 index 本身就是连续且确定的
  // hostId;不再做第二轮编号,避免出现空洞或编号抖动。

  const byExtension = new Map<string, number>()
  for (const group of groups) {
    for (const id of group.extensionIds) byExtension.set(id, group.hostId)
  }
  return { groups, byExtension }
}

/** 比较两次规划里“哪些组的成员变了”;服务据此只重启受影响的宿主 */
export function changedHostIds(prev: HostPlan, next: HostPlan): number[] {
  const before = new Map(prev.groups.map(group => [group.hostId, group.extensionIds.join('\0')]))
  const after = new Map(next.groups.map(group => [group.hostId, group.extensionIds.join('\0')]))
  const changed = new Set<number>()
  for (const [hostId, signature] of before) {
    if (after.get(hostId) !== signature) changed.add(hostId)
  }
  for (const [hostId, signature] of after) {
    if (before.get(hostId) !== signature) changed.add(hostId)
  }
  return [...changed]
}
