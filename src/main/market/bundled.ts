/**
 * 应用内置的官方扩展包。
 *
 * 官方扩展都随应用带一份包(由 `npm run plugins:build` 生成):
 *   - quick-edit:开箱即用(行首「+」菜单);
 *   - git-sync:要填仓库地址才有意义,装上但默认关着;
 *   - agent(Agent Core)与 claude-code(Claude Code):要配置本机 CLI,装上但默认关着。
 *     Claude Code 依赖 Agent Core,所以 Core 必须排在前面,安装依赖检查才能通过。
 *
 * 官方扩展**只认内置包**。开发阶段版本号统一固定为 1.0.0,不能靠版本比较判断
 * 内容是否变化;这里按整包 integrity 对齐:内容一致就跳过,不一致就整包替换。
 * 同 ID 的本地/市场安装也会被内置包覆盖 —— 否则旧副本会一直遮住新代码。
 *
 * 内置包走的是与市场下载**完全相同**的校验与安装路径
 * (`ExtensionService.installPackage`)。这里没有任何「因为是内置的所以跳过校验」
 * 的近道 —— 内置包坏了,用户看到的现象与下载到的包坏掉一模一样。
 */

import type { ExtensionService } from '../extensions/service'
import { peekIdentity } from './verify'
import agentPackage from './builtin/imark.agent.imkpkg.json?raw'
import claudeCodePackage from './builtin/imark.claude-code.imkpkg.json?raw'
import gitSyncPackage from './builtin/imark.git-sync.imkpkg.json?raw'
import quickEditPackage from './builtin/imark.quick-edit.imkpkg.json?raw'

interface BundledPackage {
  raw: string
  /**
   * 全新安装后是否直接启用。
   *
   * 这是**宿主自己的策略**,不写进包 —— 「哪个自带扩展默认开着」是应用的取舍,
   * 不该由包自己声明。
   */
  enable: boolean
}

/**
 * 内置包清单。加新包 = 跑一次 `npm run plugins:build` 再把生成的
 * `builtin/<id>.imkpkg.json` 加进来。
 */
const BUNDLED: BundledPackage[] = [
  // 全新用户也开箱就有「+」:它不配置也能用
  { raw: quickEditPackage, enable: true },
  // git-sync 要填仓库地址与令牌,装上但默认关着
  { raw: gitSyncPackage, enable: false },
  // Agent Core 与 Claude Code 需要本机 CLI,装上但默认关着;
  // Core 在前,保证 provider 安装时的依赖检查能通过
  { raw: agentPackage, enable: false },
  { raw: claudeCodePackage, enable: false }
]

interface ParsedBundle {
  /** 包本身的原文(安装时要原样交给安装路径,不能是重新序列化过的一份) */
  raw: string
  id: string
  version: string
  /** 整包 integrity;与已安装记录比对,判断内容是否变化 */
  integrity: string
}

function peek(raw: string): ParsedBundle | null {
  try {
    const envelope = JSON.parse(raw) as { integrity?: unknown }
    const identity = peekIdentity(envelope)
    if (!identity || typeof envelope.integrity !== 'string') return null
    return { raw, ...identity, integrity: envelope.integrity }
  } catch {
    // 包本身坏了:交给下面安装时的校验去报错,这里只是读不了 id 而已
    return null
  }
}

async function provisionOne(service: ExtensionService, item: BundledPackage): Promise<void> {
  const parsed = peek(item.raw)
  if (!parsed) {
    console.error('[iMark] 内置扩展包无法解析,已跳过')
    return
  }

  const existing = await service.getExtensionView(parsed.id)
  if (existing) {
    // 版本号在开发阶段固定,只能比内容。来源是 bundled 且 integrity 一致 = 已是最新。
    if (
      existing.source === 'bundled' &&
      existing.installed?.version === parsed.version &&
      existing.installed.integrity === parsed.integrity
    ) {
      return
    }
    await service.installPackage(JSON.parse(parsed.raw), { source: 'bundled' })
    console.log(
      `[iMark] 已用内置包覆盖 ${parsed.id} ` +
        `${existing.installed?.version ?? existing.source} → ${parsed.version}`
    )
    return
  }

  await service.installPackage(JSON.parse(parsed.raw), { source: 'bundled' })
  // 默认偏好是 enabled=true,所以只有「默认关闭」的包需要显式落一次设置
  if (!item.enable) await service.setEnabled(parsed.id, false)
  console.log(`[iMark] 已补装内置扩展 ${parsed.id} ${parsed.version}`)
}

/**
 * 补装缺失的内置包 / 用内置包覆盖同 ID 的旧副本。
 *
 * 由启动流程与「恢复自带扩展」按钮共同调用,所以要有并发保护:
 * 两次调用复用同一个 Promise,不会把同一个包装两遍。
 */
let provisioning: Promise<void> | null = null

export function ensureBundledProvisioned(service: ExtensionService): Promise<void> {
  if (provisioning) return provisioning
  provisioning = (async () => {
    for (const item of BUNDLED) {
      try {
        await provisionOne(service, item)
      } catch (err) {
        // 单个包失败不该拦着应用启动,也不该影响其它内置包
        console.error('[iMark] 内置扩展补装失败:', err)
      }
    }
  })().finally(() => {
    provisioning = null
  })
  return provisioning
}

/** 设置界面用来区分「这是应用自带的」还是「从市场装的」 */
export function bundledIds(): string[] {
  return BUNDLED.map(item => peek(item.raw))
    .filter((x): x is ParsedBundle => x !== null)
    .map(x => x.id)
}
