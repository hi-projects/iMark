/**
 * 更新检查:本地已装的每个扩展,去市场上问一句「最新版是哪个」。
 *
 * 几条自我约束:
 *   - **只在被要求时跑**,而且结果缓存 10 分钟。绝不自建轮询 ——
 *     一个编辑器不该因为装了两个扩展就变成一台一直在敲网络的小机器。
 *   - **失败即静默**(逐扩展吞掉异常)。离线是正常状态,不是错误状态;
 *     更新检查失败不该在界面上留下任何痕迹。
 *   - **不自动安装、不自动下载**,只回答「有没有新的」。装不装是用户的事。
 */

import type { MarketUpdate } from '@shared/market'
import { isNewerVersion } from '@shared/extensionPackage'
import { getExtensionService } from '../extensions/service'
import { getRegistryUrl } from './config'
import { latest } from './registry'

/** 缓存 10 分钟:同一段会话里反复打开市场页不该反复打服务端 */
const CACHE_TTL = 10 * 60_000

let cache: { at: number; registry: string; updates: MarketUpdate[] } | null = null

/** 安装/卸载之后调用 —— 缓存里的结论已经不对了 */
export function invalidateUpdates(): void {
  cache = null
}

export async function checkUpdates(force = false): Promise<MarketUpdate[]> {
  const registry = await getRegistryUrl()
  if (!registry) return []
  if (!force && cache && cache.registry === registry && Date.now() - cache.at < CACHE_TTL) {
    return cache.updates
  }

  const service = getExtensionService()
  if (!service) return []
  const installed = service.listExtensions()

  const results = await Promise.allSettled(
    installed
      .filter(view => view.installed && view.descriptor.id)
      .map(async (view): Promise<MarketUpdate | null> => {
        const id = view.descriptor.id
        const currentVersion = view.installed?.version ?? ''
        const remote = await latest(id)
        // 注意参数顺序是 (新, 旧) —— isNewerVersion(b, a) 问的是「b 比 a 新吗」
        if (!isNewerVersion(remote.version, currentVersion)) return null

        return {
          id,
          name: remote.displayName || remote.name,
          currentVersion,
          latestVersion: remote.version,
          hasMain: remote.hasMain
        }
      })
  )

  // 被拒的那些(离线、404、服务端抽风)一律不出现 —— 见文件头
  const updates = results
    .map(r => (r.status === 'fulfilled' ? r.value : null))
    .filter((u): u is MarketUpdate => u !== null)
    .sort((a, b) => a.id.localeCompare(b.id))

  cache = { at: Date.now(), registry, updates }
  return updates
}
