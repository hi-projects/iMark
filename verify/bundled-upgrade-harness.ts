/**
 * 内置扩展的补装与「内置包为准」验收。
 *
 * 开发阶段四款官方扩展的版本号固定为 1.0.0,补装不能靠版本比较判断内容变化;
 * 这里按整包 integrity 对齐,同 ID 的本地/市场副本也会被内置包覆盖。
 *
 * 判据取「登记 + 目录」两处,而不是只读内存 —— 因为「下次启动还会不会这样」才是
 * 用户真正的体验,而那取决于磁盘。
 *
 * 覆盖:
 *   - 全新环境:四款都补装;quick-edit 默认启用,其余三款默认关闭;
 *   - 并发/重复调用幂等;
 *   - bundled 来源的旧版本 → 覆盖为内置版本,启用态不变;
 *   - market / local 来源 → 覆盖为 bundled;
 *   - 比内置版本还新的 bundled 记录 → 仍按内置包覆盖(版本固定,没有降级保护)。
 *
 * 跑法:node verify/run.mjs bundled-upgrade
 */

import { app } from 'electron'
import { APP_VERSION } from './appVersion'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionManifest, ExtensionPackageEnvelope } from '../src/shared/extensionPackage'
import { extensionIdOf } from '../src/shared/extensionPackage'
import type { ExtensionRecord, ExtensionSource } from '../src/shared/extensions'
import { initExtensions, shutdownExtensions, type ExtensionService } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import {
  invalidateInstalledCache,
  setRecord
} from '../src/main/extensions/installedStore'
import { extensionDir, installedPath } from '../src/main/extensions/paths'
import quickEditPackage from '../src/main/market/builtin/imark.quick-edit.imkpkg.json?raw'
import gitSyncPackage from '../src/main/market/builtin/imark.git-sync.imkpkg.json?raw'
import agentPackage from '../src/main/market/builtin/imark.agent.imkpkg.json?raw'
import claudeCodePackage from '../src/main/market/builtin/imark.claude-code.imkpkg.json?raw'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

interface Bundled {
  envelope: ExtensionPackageEnvelope
  manifest: ExtensionManifest
  id: string
  entry: string
}

function parse(raw: string): Bundled {
  const envelope = JSON.parse(raw) as ExtensionPackageEnvelope
  const manifest = envelope.manifest
  return {
    envelope,
    manifest,
    id: extensionIdOf(manifest),
    entry: (manifest.main ?? '').replace(/^\.\//, '')
  }
}

const QUICK = parse(quickEditPackage)
const GIT = parse(gitSyncPackage)
const AGENT = parse(agentPackage)
const CLAUDE = parse(claudeCodePackage)
const BUNDLED = [QUICK, GIT, AGENT, CLAUDE]

interface InstalledFile {
  version: number
  extensions: Record<string, ExtensionRecord>
}

async function readInstalled(): Promise<InstalledFile> {
  return JSON.parse(await readFile(installedPath(), 'utf8')) as InstalledFile
}

/** 把磁盘上的扩展伪装成一个更老的版本(文件与登记同时改,扫描才不会把它纠回来) */
/** 只改登记里的 integrity:模拟「版本号没变、包内容变了」的开发场景 */
async function fakeIntegrity(bundled: Bundled, integrity: string): Promise<void> {
  const file = await readInstalled()
  const previous = file.extensions[bundled.id]
  if (!previous) return
  await setRecord({ ...previous, integrity })
}

async function fakeOld(
  bundled: Bundled,
  version: string,
  source: ExtensionSource
): Promise<void> {
  const dir = extensionDir(bundled.id)
  await mkdir(dir, { recursive: true })
  const manifest: ExtensionManifest = { ...bundled.manifest, version }
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
  const mainBytes = Buffer.from(bundled.envelope.data[bundled.entry]!, 'base64')
  await writeFile(join(dir, bundled.entry), mainBytes)

  invalidateInstalledCache()
  const file = await readInstalled()
  const previous = file.extensions[bundled.id]
  const record: ExtensionRecord = {
    id: bundled.id,
    publisher: bundled.manifest.publisher,
    name: bundled.manifest.name,
    version,
    main: bundled.entry || null,
    activationEvents: bundled.manifest.activationEvents ?? [],
    capabilities: bundled.manifest.capabilities ?? {},
    integrity: previous?.integrity ?? sha256(JSON.stringify(manifest)),
    mainSha256: previous?.mainSha256 ?? sha256(mainBytes),
    installedAt: previous?.installedAt ?? Date.now(),
    source,
    registryUrl: source === 'market' ? 'https://example.com' : null
  }
  await setRecord(record)
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }
  await app.whenReady()
  const ud = app.getPath('userData')
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  const vault = join(ud, 'vault')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify({ skipVaultPicker: true, vaultPath: vault, vaults: [vault], marketUrl: '' }, null, 2),
    'utf8'
  )

  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })

  // ---------- [A] 全新环境:补装 ----------
  console.log('\n[A] 全新环境:补装')
  // 并发调用复用同一个 Promise —— 启动流程与「恢复自带扩展」按钮可能同时触发
  await Promise.all([
    ensureBundledProvisioned(service),
    ensureBundledProvisioned(service)
  ])

  // 开发阶段所有官方扩展版本固定为 1.0.0;内容变化由 integrity 判断。
  check(
    '四款内置包版本固定为 1.0.0',
    BUNDLED.every(bundled => bundled.manifest.version === '1.0.0'),
    BUNDLED.map(bundled => `${bundled.id}@${bundled.manifest.version}`).join(',')
  )
  check(
    '四款内置包都要求 iMark ^1.0.0',
    BUNDLED.every(bundled => bundled.manifest.engines.imark === '^1.0.0'),
    BUNDLED.map(bundled => bundled.manifest.engines.imark).join(',')
  )
  check(
    'Agent Core 的显示名已更新',
    AGENT.manifest.displayName === 'Agent Core',
    String(AGENT.manifest.displayName)
  )
  check(
    'Claude Code 依赖 Agent Core',
    JSON.stringify(CLAUDE.manifest.extensionDependencies) === JSON.stringify([AGENT.id]),
    JSON.stringify(CLAUDE.manifest.extensionDependencies)
  )
  check(
    'Claude Code 声明 imark.agentProviders',
    JSON.stringify(CLAUDE.manifest.contributes?.['imark.agentProviders']) ===
      JSON.stringify(['claude-code']),
    JSON.stringify(CLAUDE.manifest.contributes?.['imark.agentProviders'])
  )

  const installed = await readInstalled()
  check('登记表是当前形状', installed.version === 1)
  for (const bundled of BUNDLED) {
    const record = installed.extensions[bundled.id]
    check(`${bundled.id} 已补装`, Boolean(record), Object.keys(installed.extensions).join(','))
    check(
      `${bundled.id} 版本等于内置版本`,
      record?.version === bundled.manifest.version,
      String(record?.version)
    )
    check(`${bundled.id} 来源是 bundled`, record?.source === 'bundled', String(record?.source))
    const dir = extensionDir(bundled.id)
    check(`${bundled.id} 目录里有 package.json`, existsSync(join(dir, 'package.json')))
    const icon = bundled.manifest.icon?.replace(/^\.\//, '')
    check(`${bundled.id} 声明了图标`, icon === 'icon.svg', String(bundled.manifest.icon))
    check(
      `${bundled.id} 图标在包内`,
      Boolean(icon && bundled.envelope.files[icon] && bundled.envelope.data[icon]),
      String(icon)
    )
    if (bundled.entry) {
      const onDisk = sha256(await readFile(join(dir, bundled.entry)))
      check(
        `${bundled.id} 入口文件逐字节等于内置包`,
        onDisk === bundled.envelope.files[bundled.entry]?.sha256,
        onDisk.slice(0, 12)
      )
    }
  }

  const quickView = await service.getExtensionView(QUICK.id)
  const gitView = await service.getExtensionView(GIT.id)
  const agentView = await service.getExtensionView(AGENT.id)
  const claudeView = await service.getExtensionView(CLAUDE.id)
  check('quick-edit 默认启用', quickView?.enabled === true)
  check('git-sync 默认关闭', gitView?.enabled === false)
  check('Agent Core 默认关闭', agentView?.enabled === false)
  check('Claude Code 默认关闭', claudeView?.enabled === false)
  check('Agent Core 显示名是 Agent Core', agentView?.descriptor.displayName === 'Agent Core')

  // ---------- [B] 重复调用幂等 ----------
  console.log('\n[B] 重复调用幂等')
  const before = await readInstalled()
  await ensureBundledProvisioned(service)
  await ensureBundledProvisioned(service)
  const after = await readInstalled()
  const same = BUNDLED.every(
    bundled =>
      after.extensions[bundled.id]?.installedAt === before.extensions[bundled.id]?.installedAt &&
      after.extensions[bundled.id]?.version === before.extensions[bundled.id]?.version
  )
  check('重复调用不会重装任何扩展', same)
  check('重复调用没有改变默认启用态', (await service.getExtensionView(GIT.id))?.enabled === false)

  // ---------- [B2] 同版本但内容变化:按 integrity 重装 ----------
  console.log('\n[B2] 版本号固定，内容变化 → 按 integrity 重装')
  await fakeIntegrity(QUICK, '0'.repeat(64))
  await service.refreshInstalled()
  await ensureBundledProvisioned(service)
  const refreshed = (await readInstalled()).extensions[QUICK.id]
  check(
    '同版本也会被内置包覆盖',
    refreshed?.integrity === QUICK.envelope.integrity,
    String(refreshed?.integrity)
  )
  check('来源仍是 bundled', refreshed?.source === 'bundled', String(refreshed?.source))

  // ---------- [C] bundled 来源的旧版本:覆盖 ----------
  console.log('\n[C] bundled 来源的旧版本 → 覆盖')
  const oldVersion = '0.0.1'
  await fakeOld(QUICK, oldVersion, 'bundled')
  await service.refreshInstalled()
  check(
    '前提:服务看到的确实是旧版本',
    (await service.getExtensionView(QUICK.id))?.installed?.version === oldVersion,
    String((await service.getExtensionView(QUICK.id))?.installed?.version)
  )
  await ensureBundledProvisioned(service)
  const replaced = (await readInstalled()).extensions[QUICK.id]
  check('覆盖为内置版本', replaced?.version === QUICK.manifest.version, String(replaced?.version))
  check('来源仍是 bundled', replaced?.source === 'bundled', String(replaced?.source))
  check('登记 integrity 等于内置包', replaced?.integrity === QUICK.envelope.integrity)
  const replacedPkg = JSON.parse(
    await readFile(join(extensionDir(QUICK.id), 'package.json'), 'utf8')
  ) as { version: string }
  check('磁盘清单也是内置版本', replacedPkg.version === QUICK.manifest.version, replacedPkg.version)
  check('覆盖不改变用户开着的状态', (await service.getExtensionView(QUICK.id))?.enabled === true)

  // ---------- [D] market 来源:覆盖为内置包 ----------
  console.log('\n[D] market 来源的旧版本 → 覆盖为内置包')
  await fakeOld(GIT, oldVersion, 'market')
  await service.refreshInstalled()
  await ensureBundledProvisioned(service)
  const market = (await readInstalled()).extensions[GIT.id]
  check('覆盖为内置版本', market?.version === GIT.manifest.version, String(market?.version))
  check('来源变回 bundled', market?.source === 'bundled', String(market?.source))
  check('市场 registryUrl 已清掉', market?.registryUrl === null, String(market?.registryUrl))

  // ---------- [E] 比内置版本新:仍覆盖 ----------
  console.log('\n[E] 比内置版本还新 → 仍覆盖')
  await fakeOld(GIT, '9.9.9', 'bundled')
  await service.refreshInstalled()
  await ensureBundledProvisioned(service)
  check(
    '版本回到内置版本',
    (await readInstalled()).extensions[GIT.id]?.version === GIT.manifest.version,
    String((await readInstalled()).extensions[GIT.id]?.version)
  )

  // ---------- [F] local 来源:覆盖为内置包 ----------
  console.log('\n[F] local 来源的旧版本 → 覆盖为内置包')
  await fakeOld(AGENT, '2.0.0', 'local')
  await service.refreshInstalled()
  await ensureBundledProvisioned(service)
  const local = (await readInstalled()).extensions[AGENT.id]
  check('覆盖为内置版本', local?.version === AGENT.manifest.version, String(local?.version))
  check('来源变回 bundled', local?.source === 'bundled', String(local?.source))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  await shutdownExtensions()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
