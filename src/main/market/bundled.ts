/**
 * 应用内置的「兜底」插件包。
 *
 * 「定时上传（Git）」现在是一个普通的市场插件,但应用仍然自带一份它的包:
 *   - 离线、或市场服务没起来时,用户依然能装上它;
 *   - 老用户升级到本版本时,它是**自动补装**的,配置与密钥一个字节都不用改。
 *
 * 之所以用 `?raw` 字符串而不是 JSON 模块导入,见 src/main/env.d.ts 的说明。
 *
 * 关键:兜底包走的是与下载安装**完全相同**的校验与安装路径(verifyEnvelope →
 * installFromEnvelope)。这里没有任何「因为是内置的所以跳过校验」的近道 ——
 * 内置包坏了,用户看到的现象与下载到的包坏掉一模一样,这是有意的。
 */

import type { PluginPermission } from '@shared/pluginPackage'
import { installFromEnvelope } from './installer'
import type { PluginHost } from '../plugins/host'
import gitSyncPackage from './builtin/git-sync.imkpkg.json?raw'

/**
 * 内置包清单。加新包 = 跑一次 `npm run plugins:build` 再把生成的
 * `builtin/<id>.imkpkg.json` 加进来。
 */
const BUNDLED: string[] = [gitSyncPackage]

interface ParsedBundle {
  id: string
  permissions: PluginPermission[]
}

function peekId(raw: string): ParsedBundle | null {
  try {
    const manifest = (JSON.parse(raw) as { manifest?: { id?: unknown; permissions?: unknown } })
      .manifest
    if (!manifest || typeof manifest.id !== 'string' || !manifest.id) return null
    return {
      id: manifest.id,
      permissions: Array.isArray(manifest.permissions)
        ? (manifest.permissions as PluginPermission[])
        : []
    }
  } catch {
    // 包本身坏了:交给下面安装时的校验去报错,这里只是读不了 id 而已
    return null
  }
}

/**
 * 补装缺失的内置包。由插件宿主在启动流程里调用(扫描之后、启用之前)。
 *
 * 「已经有同 id 的插件」一律跳过 —— 不论它是从市场装的、还是用户手动放进去的。
 * 兜底包只在**真的什么都没有**的时候出现,绝不覆盖用户的安装。
 */
export async function ensureBundledProvisioned(host: PluginHost): Promise<void> {
  for (const raw of BUNDLED) {
    const parsed = peekId(raw)
    if (!parsed) {
      console.error('[iMark] 内置插件包无法解析,已跳过')
      continue
    }
    if (host.isInstalled(parsed.id)) continue

    try {
      const outcome = await installFromEnvelope(host, JSON.parse(raw), {
        source: 'bundled',
        publisher: null,
        registryUrl: null,
        // 内置包没有安装确认环节,授权集合就是它自己声明的权限
        grantedPermissions: parsed.permissions
      })
      console.log(`[iMark] 已补装内置插件 ${outcome.name} ${outcome.version}`)
    } catch (err) {
      console.error(`[iMark] 内置插件 ${parsed.id} 补装失败:`, err)
    }
  }
}

/** 设置界面用来区分「这是应用自带的」还是「从市场装的」 */
export function bundledIds(): string[] {
  return BUNDLED.map(peekId)
    .filter((x): x is ParsedBundle => x !== null)
    .map(x => x.id)
}
