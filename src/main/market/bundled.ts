/**
 * 应用内置的「兜底」插件包。
 *
 * 「定时上传（Git）」现在是一个普通的市场插件,但应用仍然自带一份它的包:
 *   - 离线、或市场服务没起来时,用户依然能装上它;
 *   - 老用户升级到本版本时,它是**自动补装**的,配置与密钥一个字节都不用改。
 *
 * 「高级表格（Advanced Table）」也在这里,理由不同:它提供编辑器里那个「+」按钮,
 * 是**开箱即用**的一部分(见下面 `enable`)。
 *
 * 之所以用 `?raw` 字符串而不是 JSON 模块导入,见 src/main/env.d.ts 的说明。
 *
 * 关键:兜底包走的是与下载安装**完全相同**的校验与安装路径(verifyEnvelope →
 * installFromEnvelope)。这里没有任何「因为是内置的所以跳过校验」的近道 ——
 * 内置包坏了,用户看到的现象与下载到的包坏掉一模一样,这是有意的。
 */

import { compareVersions, isNewerVersion, type PluginPermission } from '@shared/pluginPackage'
import { installFromEnvelope } from './installer'
import { getRecord } from '../plugins/installed'
import { getSettings, saveSettings } from '../settings'
import type { PluginHost } from '../plugins/host'
import gitSyncPackage from './builtin/git-sync.imkpkg.json?raw'
import quickEditPackage from './builtin/quick-edit.imkpkg.json?raw'
import aiForEditPackage from './builtin/ai-for-edit.imkpkg.json?raw'

interface BundledPackage {
  raw: string
  /**
   * 补装后是否直接启用。
   *
   * 这是**宿主自己的策略**,不写进包 —— 「哪个自带插件默认开着」是应用的取舍,
   * 不该由包自己声明(否则包换个说法就能给自己开权限)。
   *
   * git-sync 为 false:它要填仓库地址与令牌才有意义,装上但默认关着,
   * 用户想用时在插件页打开即可(装之前它是配置对话框里的「去安装」)。
   */
  enable: boolean
}

/**
 * 内置包清单。加新包 = 跑一次 `npm run plugins:build` 再把生成的
 * `builtin/<id>.imkpkg.json` 加进来。
 */
const BUNDLED: BundledPackage[] = [
  { raw: gitSyncPackage, enable: false },
  // 全新用户也开箱就有「+」:它不配置也能用
  { raw: quickEditPackage, enable: true },
  // AI 需要用户填服务地址与密钥才有意义,和 git-sync 一样装上但默认关着
  { raw: aiForEditPackage, enable: false }
]

interface ParsedBundle {
  /** 包本身的原文(升级时要原样交给安装路径,不能是重新序列化过的一份) */
  raw: string
  id: string
  version: string
  permissions: PluginPermission[]
}

function peekId(raw: string): ParsedBundle | null {
  try {
    const manifest = (
      JSON.parse(raw) as { manifest?: { id?: unknown; version?: unknown; permissions?: unknown } }
    ).manifest
    if (!manifest || typeof manifest.id !== 'string' || !manifest.id) return null
    return {
      raw,
      id: manifest.id,
      version: typeof manifest.version === 'string' ? manifest.version : '',
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
 * 已经在装的**内置**插件,版本落后就跟上。
 *
 * 为什么必须有这一段:内置插件的补装逻辑是「有同 id 就完全不碰」,而插件的新能力
 * (比如 git-sync 后来才有的状态栏条目与命令)是**跟着应用版本一起来**的。
 * 没有这段的后果不是「用户晚一点看到新功能」,而是**界面直接缺一块** ——
 * 应用这边已经把写死的按钮换成插件声明的了,插件那边还停在没声明的老版本。
 *
 * 三条自我约束:
 *   - **只升不降**,且只在应用自带的这一份更新的前提下动手。
 *   - **只碰从内置包装的那些**(`source === 'bundled'`)。从市场装的有市场自己的
 *     更新流程,拿应用自带的那份去盖,可能盖成一个**比市场还旧**的版本,
 *     还把 registryUrl 这些溯源信息一起抹了;手动放进去的目录同理,不动。
 *   - **授权集合原样继承,只做收缩不做扩张**。升个版本不该顺手把权限变大 ——
 *     新增的权限要等用户重新确认(阶段三的 `effective = granted ∩ declared`)。
 *
 * 启用态不用管:`host.install()` 会自己恢复原样,用户关掉的插件升级后仍是关着的。
 */
async function upgradeBundled(host: PluginHost, parsed: ParsedBundle): Promise<void> {
  const record = await getRecord(parsed.id)
  // 没有登记 = 不是装进来的(开发模式挂的目录、手放的文件夹)。那是用户的安装,不碰
  if (!record || record.source !== 'bundled') return
  if (!parsed.version || !isNewerVersion(parsed.version, record.version)) return

  // 默认值只在「这个字段从未保存过」时生效；插件启用过一次之后，整份配置就已经
  // 落进了 settings.json。默认值变化必须在这里补一次，否则老用户会一直停在旧地址。
  await migrateStoredConfig(parsed.id, record.version, parsed.version)

  const granted = record.grantedPermissions ?? []
  const added = parsed.permissions.filter(p => !granted.includes(p))
  if (added.length > 0) {
    console.warn(
      `[iMark] 插件 ${parsed.id} 的新版本声明了新权限(${added.join('、')}),` +
        `在你确认之前不会生效`
    )
  }

  const outcome = await installFromEnvelope(host, JSON.parse(parsed.raw), {
    source: 'bundled',
    publisher: null,
    registryUrl: null,
    grantedPermissions: granted
  })
  console.log(`[iMark] 已升级插件 ${outcome.name} ${record.version} → ${outcome.version}`)
}

/**
 * 内置插件默认值的一次性迁移。
 *
 * 只有「整份配置仍然完全是旧默认值」时才动手：用户只要改过端点或模型，哪怕
 * 又改回了同样的字符串，我们也无法区分，所以规则必须保守到只认这对完整组合。
 * 迁移点用版本号卡住，之后的升级不会再跑第二遍。
 */
const CONFIG_MIGRATIONS: Record<
  string,
  {
    /** 从低于这个版本升级上来时迁移一次 */
    untilVersion: string
    /** 返回 null 表示这套配置不该动 */
    apply: (config: Record<string, unknown>) => Record<string, unknown> | null
  }
> = {
  'ai-for-edit': {
    untilVersion: '1.1.0',
    apply: config => {
      if (
        config.endpoint !== 'https://api.openai.com/v1/chat/completions' ||
        config.model !== 'gpt-4o-mini'
      ) {
        return null
      }
      return {
        ...config,
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-flash'
      }
    }
  }
}

async function migrateStoredConfig(
  id: string,
  fromVersion: string,
  toVersion: string
): Promise<void> {
  const migration = CONFIG_MIGRATIONS[id]
  if (!migration) return
  if (compareVersions(fromVersion, migration.untilVersion) >= 0) return
  if (compareVersions(toVersion, migration.untilVersion) < 0) return

  const settings = await getSettings()
  const entry = settings.plugins[id]
  if (!entry) return
  const next = migration.apply(entry.config ?? {})
  if (!next) return

  await saveSettings({
    plugins: { ...settings.plugins, [id]: { ...entry, config: next } }
  })
  console.log(`[iMark] 插件 ${id} 的旧默认配置已迁移`)
}

/**
 * 补装缺失的内置包。由插件宿主在启动流程里调用(扫描之后、启用之前)。
 *
 * 「已经有同 id 的插件」一律跳过安装 —— 不论它是从市场装的、还是用户手动放进去的。
 * 兜底包只在**真的什么都没有**的时候出现,绝不覆盖用户的安装。
 * 唯一的例外是同为内置来源、且版本落后的一份:那种情况交给上面的 upgradeBundled。
 */
export async function ensureBundledProvisioned(host: PluginHost): Promise<void> {
  for (const item of BUNDLED) {
    const parsed = peekId(item.raw)
    if (!parsed) {
      console.error('[iMark] 插件包无法解析,已跳过')
      continue
    }
    // 已经在里面了(从市场装的、用户手放的、或上一轮补装的)就不重新补装:
    // 尤其是**不重新启用** —— 用户手动关掉的插件,不该被每次启动又打开
    if (host.isInstalled(parsed.id)) {
      try {
        await upgradeBundled(host, parsed)
      } catch (err) {
        // 升级失败**必须吞掉**:installFromEnvelope 内部已经回滚到旧版本了,
        // 一个起不来的新版插件不该拦着应用启动 —— 旧版本照常能用
        console.error(`[iMark] 插件 ${parsed.id} 升级失败,继续用旧版本:`, err)
      }
      continue
    }

    try {
      const outcome = await installFromEnvelope(host, JSON.parse(item.raw), {
        source: 'bundled',
        publisher: null,
        registryUrl: null,
        // 内置包没有安装确认环节,授权集合就是它自己声明的权限
        grantedPermissions: parsed.permissions
      })
      console.log(`[iMark] 已补装插件 ${outcome.name} ${outcome.version}`)

      // 必须走 save():它既置位又写进 settings.json。直接调私有的 enable()
      // 是不落盘的,下次启动又变回关闭。
      //
      // 注意由此带来的一个已知副作用:save() 里的 enable() 对同一个 entry
      // **不幂等**(host.enable 不看当前态直接跑生命周期),而 init() 结尾的启动循环
      // 还会对 state.enabled 为真的 entry 再跑一次 —— 所以默认启用的内置插件
      // 首次启动时 onEnable 会执行两遍。Advanced Table 的 onEnable 是空操作,无害;
      // 将来若有自带插件要默认启用、且 onEnable 有副作用,先给 enable() 加幂等守卫。
      if (item.enable) await host.save(outcome.id, { enabled: true })
    } catch (err) {
      console.error(`[iMark] 插件 ${parsed.id} 补装失败:`, err)
    }
  }
}

/** 设置界面用来区分「这是应用自带的」还是「从市场装的」 */
export function bundledIds(): string[] {
  return BUNDLED.map(item => peekId(item.raw))
    .filter((x): x is ParsedBundle => x !== null)
    .map(x => x.id)
}
