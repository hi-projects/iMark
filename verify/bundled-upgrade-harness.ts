/**
 * 内置扩展的补装与「跟着应用一起升级」验收(v2)。
 *
 * 为什么需要这一段:应用自带的扩展包在补装时是「有同 id 就不碰」的,而扩展的新
 * 能力是随应用版本一起发出去的。没有升级这条路,用户升了应用却拿不到新能力。
 *
 * 判据取「登记 + 目录」两处,而不是只读内存 —— 因为「下次启动还会不会这样」才是
 * 用户真正的体验,而那取决于磁盘。
 *
 * 覆盖:
 *   - 全新环境:四款都补装;quick-edit 默认启用,git-sync / ai-for-edit / agent 默认关闭;
 *   - 并发/重复调用幂等;
 *   - bundled 来源的旧版本 → 升到应用自带版本,启用态不变;
 *   - market 来源的旧版本 → 不被内置包覆盖;
 *   - 比内置包还新的 bundled 记录 → 不降级。
 *
 * 跑法:node verify/run.mjs bundled-upgrade
 */

import { app } from 'electron'
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
import aiForEditPackage from '../src/main/market/builtin/imark.ai-for-edit.imkpkg.json?raw'
import agentPackage from '../src/main/market/builtin/imark.agent.imkpkg.json?raw'

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
const AI = parse(aiForEditPackage)
const AGENT = parse(agentPackage)

interface InstalledFile {
  version: number
  extensions: Record<string, ExtensionRecord>
}

async function readInstalled(): Promise<InstalledFile> {
  return JSON.parse(await readFile(installedPath(), 'utf8')) as InstalledFile
}

/** 把磁盘上的扩展伪装成一个更老的版本(文件与登记同时改,扫描才不会把它纠回来) */
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
    source: source === 'dev' ? 'local' : source,
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

  const service: ExtensionService = await initExtensions({ appVersion: '0.1.0' })

  // ---------- [A] 全新环境:补装 ----------
  console.log('\n[A] 全新环境:补装')
  // 并发调用复用同一个 Promise —— 启动流程与「恢复自带扩展」按钮可能同时触发
  await Promise.all([
    ensureBundledProvisioned(service),
    ensureBundledProvisioned(service)
  ])

  const installed = await readInstalled()
  check('登记表是 v2 形状', installed.version === 2)
  for (const bundled of [QUICK, GIT, AI, AGENT]) {
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
  const aiView = await service.getExtensionView(AI.id)
  const agentView = await service.getExtensionView(AGENT.id)
  check('quick-edit 默认启用', quickView?.enabled === true)
  check('git-sync 默认关闭', gitView?.enabled === false)
  check('ai-for-edit 默认关闭', aiView?.enabled === false)
  check('agent 默认关闭', agentView?.enabled === false)

  // ---------- [B] 重复调用幂等 ----------
  console.log('\n[B] 重复调用幂等')
  const before = await readInstalled()
  await ensureBundledProvisioned(service)
  await ensureBundledProvisioned(service)
  const after = await readInstalled()
  const same = [QUICK, GIT, AI, AGENT].every(
    bundled =>
      after.extensions[bundled.id]?.installedAt === before.extensions[bundled.id]?.installedAt &&
      after.extensions[bundled.id]?.version === before.extensions[bundled.id]?.version
  )
  check('重复调用不会重装任何扩展', same)
  check('重复调用没有改变默认启用态', (await service.getExtensionView(GIT.id))?.enabled === false)

  // ---------- [C] bundled 来源的旧版本:升级 ----------
  console.log('\n[C] bundled 来源的旧版本 → 升级')
  const oldVersion = '0.0.1'
  await fakeOld(QUICK, oldVersion, 'bundled')
  await service.refreshInstalled()
  check(
    '前提:服务看到的确实是旧版本',
    (await service.getExtensionView(QUICK.id))?.installed?.version === oldVersion,
    String((await service.getExtensionView(QUICK.id))?.installed?.version)
  )
  await ensureBundledProvisioned(service)
  const upgraded = (await readInstalled()).extensions[QUICK.id]
  check('升到内置版本', upgraded?.version === QUICK.manifest.version, String(upgraded?.version))
  check('来源仍是 bundled', upgraded?.source === 'bundled', String(upgraded?.source))
  check('登记 integrity 等于内置包', upgraded?.integrity === QUICK.envelope.integrity)
  const upgradedPkg = JSON.parse(
    await readFile(join(extensionDir(QUICK.id), 'package.json'), 'utf8')
  ) as { version: string }
  check('磁盘清单也升到了内置版本', upgradedPkg.version === QUICK.manifest.version, upgradedPkg.version)
  check('升级不改变用户开着的状态', (await service.getExtensionView(QUICK.id))?.enabled === true)

  // ---------- [D] market 来源:不碰 ----------
  console.log('\n[D] market 来源的旧版本 → 不碰')
  await fakeOld(GIT, oldVersion, 'market')
  await service.refreshInstalled()
  await ensureBundledProvisioned(service)
  const market = (await readInstalled()).extensions[GIT.id]
  check('版本保持旧版', market?.version === oldVersion, String(market?.version))
  check('来源仍是 market', market?.source === 'market', String(market?.source))
  check(
    '市场来源的 registryUrl 没被抹掉',
    market?.registryUrl === 'https://example.com',
    String(market?.registryUrl)
  )

  // ---------- [E] 比内置包新:不降级 ----------
  console.log('\n[E] 比内置包还新 → 不降级')
  await fakeOld(GIT, '9.9.9', 'bundled')
  await service.refreshInstalled()
  await ensureBundledProvisioned(service)
  check(
    '版本保持 9.9.9',
    (await readInstalled()).extensions[GIT.id]?.version === '9.9.9',
    String((await readInstalled()).extensions[GIT.id]?.version)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  await shutdownExtensions()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
