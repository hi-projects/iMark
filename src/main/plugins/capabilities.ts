/**
 * 内置能力注册表 —— 声明式插件(包里没有代码)的落点。
 *
 * 声明式插件把「我要用哪个能力」写在清单的 `capability` 里,再自带一份字段表描述
 * 自己要让用户填什么。能力实现由应用提供,所以这类插件**永远不会执行第三方代码**,
 * 安全性与内置功能完全一致 —— 这也是它存在的意义:绝大多数「配置一下就能用」的需求
 * (推送通知、导出到某处、连接某个服务)本就不该要求用户信任一段任意代码。
 *
 * 能力与清单的契约:`Capability` 声明自己需要哪些字段 key 与动作 id,
 * 安装/加载时校验清单是否配齐,缺了就报出**具体缺什么**,而不是运行时静默失效。
 */

import type { ImkApi, PluginRuntime } from '@shared/pluginApi'
import type { PluginManifest, PluginPermission } from '@shared/pluginPackage'
import { webhookCapability } from './capabilities/webhook'

export interface CapabilityContext {
  manifest: PluginManifest
  /** 当前生效配置(已按清单字段表归一化) */
  api: ImkApi
}

export interface Capability {
  id: string
  name: string
  description: string
  /**
   * 该能力会用到的权限。**清单必须声明它们,否则加载期直接报错** ——
   * 这类权限是给安装确认框看的:能力用了 `network` 而清单没写,用户按下「安装」时
   * 看到的那份清单就是残缺的,而那是他唯一的知情机会。
   *
   * 之所以是「报错」而不是「宿主偷偷补上」:确认框展示的是清单里的权限,补上就得
   * 让这份数据穿过主进程→渲染层再到落盘的 grantedPermissions 一路,而报表却只有一行字。
   * 作者少写一项是明确的、可修的失误,不是需要运行时兜底的正常状态。
   */
  permissions: PluginPermission[]
  /** 清单字段表里必须出现的字段 key */
  requiredFields: string[]
  /** 清单里必须声明的动作(宿主会据此校验,避免用户装了却点不动) */
  actions: { id: string; label: string }[]
  /** 清单里必须声明的目标级动作 */
  targetActions?: { id: string; label: string }[]
  /** 若声明了 targetActions,清单必须把 targetFieldKey 指到这个字段 */
  targetFieldKey?: string
  create(ctx: CapabilityContext): PluginRuntime
}

const registry = new Map<string, Capability>()

export function registerCapability(capability: Capability): void {
  registry.set(capability.id, capability)
}

export function getCapability(id: string): Capability | null {
  return registry.get(id) ?? null
}

export function listCapabilities(): Capability[] {
  return [...registry.values()]
}

/**
 * 校验清单是否配齐了它声称要用的能力。
 * 返回人类可读的问题列表(空数组 = 通过)。安装前与加载前都会调用。
 */
export function checkAgainstCapability(manifest: PluginManifest): string[] {
  if (manifest.kind !== 'declarative') return []
  const problems: string[] = []
  const capability = manifest.capability ? getCapability(manifest.capability) : null
  if (!capability) {
    return [`声明式插件引用了本应用不认识的能力:${manifest.capability ?? '(未声明)'}`]
  }
  const declared = new Set(manifest.permissions ?? [])
  for (const permission of capability.permissions) {
    if (!declared.has(permission)) {
      problems.push(`能力「${capability.name}」需要权限 ${permission},但清单的 permissions 里没有`)
    }
  }
  // 用 ?? [] 而不是直接 .map:这个函数也会被装到磁盘上的清单调一次,而磁盘上的
  // 东西是可以被手改的 —— 缺字段表的插件应当得到一句「缺少字段」,而不是 TypeError
  const keys = new Set((manifest.fields ?? []).map(f => f.key))
  for (const key of capability.requiredFields) {
    if (!keys.has(key)) problems.push(`缺少能力「${capability.name}」需要的字段:${key}`)
  }
  const ids = new Set((manifest.actions ?? []).map(a => a.id))
  for (const action of capability.actions) {
    if (!ids.has(action.id)) problems.push(`缺少能力「${capability.name}」需要的动作:${action.id}`)
  }
  const targetIds = new Set((manifest.targetActions ?? []).map(a => a.id))
  for (const action of capability.targetActions ?? []) {
    if (!targetIds.has(action.id)) {
      problems.push(`缺少能力「${capability.name}」需要的目标级动作:${action.id}`)
    }
  }
  if (capability.targetFieldKey && manifest.targetFieldKey !== capability.targetFieldKey) {
    problems.push(`targetFieldKey 必须是「${capability.targetFieldKey}」`)
  }
  return problems
}

/** 造出声明式插件的运行时;清单没配齐时抛异常(由宿主包成加载期错误) */
export function createCapabilityRuntime(manifest: PluginManifest, api: ImkApi): PluginRuntime {
  const problems = checkAgainstCapability(manifest)
  if (problems.length > 0) throw new Error(problems.join(';'))
  const capability = getCapability(manifest.capability as string) as Capability
  return capability.create({ manifest, api })
}

// 内置能力在此登记(新增能力只需实现 Capability 后加进这里)
registerCapability(webhookCapability)
