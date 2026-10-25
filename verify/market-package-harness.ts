/**
 * 验收:扩展包的打包 / 预览 / 安装 / 校验。
 *
 * 不开窗口,全部在主进程里完成 —— 市场模块的正确性判据是**磁盘上的信封与登记**,
 * 界面只是它的投影。
 *
 * 覆盖:
 *   1. 目录 → 信封:package.json 清单、stable integrity、贡献摘要;
 *   2. 含代码包:hasMain / main / activationEvents / capabilities / mainSha256;
 *   3. 纯声明包:hasMain=false、没有入口哈希;
 *   4. 安装:installed.json 记录、目录里的 package.json 与 main.js;
 *   5. 未知 formatVersion 被拒绝;
 *   6. 篡改文件字节 / 清单 / integrity 后校验必须失败;
 *   7. Agent provider 包:贡献点随包保留、依赖未装时拒绝安装、清单必填项校验。
 *
 * 跑法:node verify/run.mjs market-package
 */

import { app } from 'electron'
import { APP_VERSION } from './appVersion'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initExtensions, shutdownExtensions, type ExtensionService } from '../src/main/extensions/service'
import { installFromEnvelope, previewEnvelope, type InstallOutcome } from '../src/main/market/installer'
import { packDirectory } from '../src/main/market/pack'
import { sha256 } from '../src/main/extensions/paths'
import { verifyEnvelope } from '../src/main/market/verify'
import {
  stableIntegrityInput,
  validateManifest,
  type ExtensionPackageEnvelope
} from '../src/shared/extensionPackage'
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

const CODE_ID = 'harness.code-demo'
const DECL_ID = 'harness.declarative-demo'

async function fixture(root: string, name: string, packageJson: unknown, files: Record<string, string>): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8')
  for (const [rel, text] of Object.entries(files)) {
    await writeFile(join(dir, rel), text, 'utf8')
  }
  return dir
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }
  await app.whenReady()
  const ud = app.getPath('userData')
  const fixtures = join(ud, 'fixtures')

  // harness 里 Electron 自己的 app.getVersion() 是运行时版本;固定成应用版本
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  const origin = { kind: 'local-dir' as const, label: 'harness' }

  // ---------- [A] 含代码扩展:打包 ----------
  console.log('\n[A] 含代码扩展:目录 → 信封')
  const codeDir = await fixture(
    fixtures,
    'code',
    {
      publisher: 'harness',
      name: 'code-demo',
      version: '1.0.0',
      displayName: '含代码示例',
      description: 'harness 用的含代码扩展',
      engines: { imark: '^1.0.0' },
      main: './main.js',
      activationEvents: ['onCommand:harness.code-demo.hello'],
      capabilities: { filesystem: 'workspace', network: true },
      contributes: {
        commands: [{ command: 'harness.code-demo.hello', title: '打招呼' }],
        keybindings: [{ command: 'harness.code-demo.hello', key: 'ctrl+alt+h' }],
        configuration: {
          properties: {
            'harness.code-demo.greeting': {
              type: 'string',
              default: '你好',
              title: '问候语'
            }
          }
        },
        'imark.lineMenu': [
          { id: 'hello', label: '打招呼', command: 'harness.code-demo.hello' }
        ],
        'imark.actions': [{ command: 'harness.code-demo.hello', label: '打招呼' }]
      }
    },
    {
      'main.js': 'exports.activate = function () {}\nexports.deactivate = function () {}\n',
      'README.md': '# code-demo\n'
    }
  )

  const packed = await packDirectory(codeDir)
  check('打出了当前格式的信封', packed.envelope.formatVersion === 1, String(packed.envelope.formatVersion))
  check('清单有 main 入口', packed.manifest.main === './main.js', String(packed.manifest.main))
  check(
    'package.json 没有被当成包内文件',
    !('package.json' in packed.envelope.files),
    Object.keys(packed.envelope.files).join(',')
  )
  check(
    'stable integrity 可独立复算',
    packed.envelope.integrity === sha256(stableIntegrityInput(packed.manifest, packed.envelope.files)),
    packed.envelope.integrity.slice(0, 12)
  )

  // ---------- [B] 含代码扩展:预览 ----------
  console.log('\n[B] 含代码扩展:预览字段')
  const codePreview = previewEnvelope(packed.envelope, origin, null)
  check('预览成功', codePreview.ok, codePreview.ok ? '' : codePreview.errors.join(';'))
  if (codePreview.ok) {
    const p = codePreview.value
    check('hasMain = true', p.hasMain === true)
    check('main 带 ./ 前缀', p.main === './main.js', String(p.main))
    check('激活事件带出', p.activationEvents.includes('onCommand:harness.code-demo.hello'))
    check('capabilities 带出', p.capabilities.filesystem === 'workspace' && p.capabilities.network === true)
    check(
      '贡献摘要计数正确',
      p.contributesSummary.commands === 1 &&
        p.contributesSummary.keybindings === 1 &&
        p.contributesSummary.configuration === 1 &&
        p.contributesSummary.lineMenu === 1 &&
        p.contributesSummary.actions === 1,
      JSON.stringify(p.contributesSummary)
    )
    check('入口 sha256 非空', Boolean(p.mainSha256) && p.mainSha256!.length === 64)
    check('整包 sha256 与信封一致', p.integrity === packed.envelope.integrity)
    check('新安装没有已装版本', p.installed === null)
  }

  // ---------- [C] 安装与登记 ----------
  console.log('\n[C] 安装:磁盘上的登记')
  const entrySha = codePreview.ok ? codePreview.value.mainSha256 : null
  const outcome: InstallOutcome = await installFromEnvelope(service, packed.envelope, {
    source: 'local',
    registryUrl: null,
    appVersion: APP_VERSION
  })
  check('安装返回正确的 id 与版本', outcome.id === CODE_ID && outcome.version === '1.0.0', JSON.stringify(outcome))
  check('新装不是升级', outcome.upgraded === false && outcome.downgraded === false)

  const installedRaw = JSON.parse(await readFile(join(ud, 'plugins', 'installed.json'), 'utf8')) as {
    version: number
    extensions: Record<string, { version: string; source: string; main: string | null; integrity: string; mainSha256: string | null }>
  }
  check('登记表是当前形状', installedRaw.version === 1)
  const record = installedRaw.extensions[CODE_ID]
  check('登记了扩展', Boolean(record))
  check('记录版本 / 来源 / main', record?.version === '1.0.0' && record?.source === 'local' && record?.main === 'main.js')
  check('记录 integrity', record?.integrity === packed.envelope.integrity)
  check('记录入口哈希', Boolean(entrySha) && record?.mainSha256 === entrySha, String(record?.mainSha256))

  const installedPkg = JSON.parse(
    await readFile(join(ud, 'plugins', CODE_ID, 'package.json'), 'utf8')
  ) as { publisher: string; name: string; main: string }
  check('磁盘清单是 package.json 且内容正确', installedPkg.publisher === 'harness' && installedPkg.main === './main.js')
  const installedMain = await readFile(join(ud, 'plugins', CODE_ID, 'main.js'), 'utf8')
  check('入口文件逐字节落盘', installedMain.includes('exports.activate'))

  const view = await service.getExtensionView(CODE_ID)
  check('扩展服务能看到它', view?.descriptor.id === CODE_ID && view?.installed?.version === '1.0.0')
  check('扩展服务记录来源', view?.source === 'local')

  // ---------- [D] 纯声明扩展 ----------
  console.log('\n[D] 纯声明扩展')
  const declDir = await fixture(
    fixtures,
    'declarative',
    {
      publisher: 'harness',
      name: 'declarative-demo',
      version: '1.0.0',
      displayName: '纯声明示例',
      engines: { imark: '^1.0.0' },
      contributes: {
        commands: [{ command: 'harness.declarative-demo.run', title: '运行' }]
      }
    },
    { 'README.md': '# declarative\n' }
  )
  const declPacked = await packDirectory(declDir)
  const declPreview = previewEnvelope(declPacked.envelope, origin, null)
  check('纯声明预览成功', declPreview.ok, declPreview.ok ? '' : declPreview.errors.join(';'))
  if (declPreview.ok) {
    check('hasMain = false', declPreview.value.hasMain === false)
    check('没有 main', declPreview.value.main === null)
    check('没有入口哈希', declPreview.value.mainSha256 === null)
    check('仍然有贡献摘要', declPreview.value.contributesSummary.commands === 1)
  }
  const declOutcome = await installFromEnvelope(service, declPacked.envelope, {
    source: 'local',
    registryUrl: null,
    appVersion: APP_VERSION
  })
  check('纯声明扩展能安装', declOutcome.id === DECL_ID)
  const declRecord = (JSON.parse(
    await readFile(join(ud, 'plugins', 'installed.json'), 'utf8')
  ) as { extensions: Record<string, { main: string | null; mainSha256: string | null }> }).extensions[DECL_ID]
  check('纯声明记录 main 为 null', declRecord?.main === null && declRecord?.mainSha256 === null)

  // ---------- [E] 未知格式被拒绝 ----------
  console.log('\n[E] 未知 formatVersion 必须被拒绝')
  const unknown = {
    format: 'imk-plugin',
    formatVersion: 999,
    manifest: {
      publisher: 'harness',
      name: 'unknown-format',
      version: '1.0.0',
      engines: { imark: '^1.0.0' }
    },
    files: {},
    data: {},
    integrity: '0'.repeat(64)
  }
  const unknownCheck = verifyEnvelope(unknown)
  check(
    '未知 formatVersion 校验失败',
    !unknownCheck.ok && unknownCheck.errors.some(e => e.includes('formatVersion')),
    unknownCheck.ok ? '(意外通过)' : unknownCheck.errors.join(';')
  )
  let unknownThrew = false
  try {
    await installFromEnvelope(service, unknown, {
      source: 'local',
      registryUrl: null,
      appVersion: APP_VERSION
    })
  } catch (err) {
    unknownThrew = (err as Error).message.includes('formatVersion')
  }
  check('未知格式装不进去', unknownThrew)

  // ---------- [F] 篡改 ----------
  console.log('\n[F] 篡改必须被拒绝')
  const clone = (): ExtensionPackageEnvelope =>
    JSON.parse(JSON.stringify(packed.envelope)) as ExtensionPackageEnvelope

  const bytesTampered = clone()
  const b64 = bytesTampered.data['main.js']!
  const flipped = `${b64[0] === 'A' ? 'B' : 'A'}${b64.slice(1)}`
  bytesTampered.data['main.js'] = flipped
  const bytesCheck = verifyEnvelope(bytesTampered)
  check(
    '改一个字节 → 逐文件 sha256 失败',
    !bytesCheck.ok && bytesCheck.errors.some(e => e.includes('内容校验失败')),
    bytesCheck.ok ? '(意外通过)' : bytesCheck.errors.join(';')
  )

  const manifestTampered = clone()
  ;(manifestTampered.manifest as unknown as Record<string, unknown>).surprise = true
  const manifestCheck = verifyEnvelope(manifestTampered)
  check(
    '清单多一个字段 → 拒绝',
    !manifestCheck.ok && manifestCheck.errors.some(e => e.includes('不认识的清单字段')),
    manifestCheck.ok ? '(意外通过)' : manifestCheck.errors.join(';')
  )

  const integrityTampered = clone()
  integrityTampered.integrity = '0'.repeat(64)
  const integrityCheck = verifyEnvelope(integrityTampered)
  check(
    '改 integrity → 失败',
    !integrityCheck.ok && integrityCheck.errors.some(e => e.includes('integrity')),
    integrityCheck.ok ? '(意外通过)' : integrityCheck.errors.join(';')
  )

  const expectedMismatch = verifyEnvelope(clone(), '1'.repeat(64))
  check(
    '外部期望 integrity 不符 → 失败',
    !expectedMismatch.ok && expectedMismatch.errors.some(e => e.includes('市场登记')),
    expectedMismatch.ok ? '(意外通过)' : expectedMismatch.errors.join(';')
  )

  // ---------- [G] Agent provider 包 ----------
  console.log('\n[G] Agent provider 包:贡献点、依赖与安装顺序')
  const providerManifest = {
    publisher: 'harness',
    name: 'provider-demo',
    version: '1.0.0',
    displayName: 'Provider 示例',
    engines: { imark: '^1.0.0' },
    main: './main.js',
    extensionDependencies: ['imark.agent'],
    capabilities: { process: true },
    contributes: {
      'imark.agentProviders': ['demo']
    }
  }
  const providerDir = await fixture(fixtures, 'provider', providerManifest, {
    'main.js': 'exports.activate = () => ({ apiVersion: 2, providers: [] })\n'
  })
  const providerPacked = await packDirectory(providerDir)
  check(
    '打包后清单仍保留 imark.agentProviders',
    JSON.stringify(providerPacked.manifest.contributes?.['imark.agentProviders']) ===
      JSON.stringify(['demo']),
    JSON.stringify(providerPacked.manifest.contributes)
  )
  const providerPreview = previewEnvelope(providerPacked.envelope, origin, null)
  check('provider 预览成功', providerPreview.ok, providerPreview.ok ? '' : providerPreview.errors.join(';'))
  if (providerPreview.ok) {
    check(
      '预览带出依赖与 provider 贡献',
      providerPreview.value.descriptor.extensionDependencies.includes('imark.agent') &&
        JSON.stringify(
          providerPreview.value.descriptor.contributes['imark.agentProviders']
        ) === JSON.stringify(['demo']),
      JSON.stringify(providerPreview.value.descriptor)
    )
  }

  let dependencyError = ''
  try {
    await installFromEnvelope(service, providerPacked.envelope, {
      source: 'local',
      registryUrl: null,
      appVersion: APP_VERSION
    })
  } catch (err) {
    dependencyError = err instanceof Error ? err.message : String(err)
  }
  check(
    '依赖未安装时拒绝安装 provider',
    dependencyError.includes('imark.agent') && dependencyError.includes('未安装'),
    dependencyError
  )
  check(
    '拒绝安装后没有留下半份目录',
    !existsSync(join(ud, 'plugins', 'harness.provider-demo'))
  )

  const coreOutcome = await installFromEnvelope(service, JSON.parse(agentPackage), {
    source: 'bundled',
    registryUrl: null,
    appVersion: APP_VERSION
  })
  check('先装 Agent Core 成功', coreOutcome.id === 'imark.agent', JSON.stringify(coreOutcome))
  const providerOutcome = await installFromEnvelope(service, providerPacked.envelope, {
    source: 'local',
    registryUrl: null,
    appVersion: APP_VERSION
  })
  check(
    '装了依赖后 provider 可安装',
    providerOutcome.id === 'harness.provider-demo',
    JSON.stringify(providerOutcome)
  )
  const providerView = await service.getExtensionView('harness.provider-demo')
  check(
    '扩展服务能看到依赖关系',
    providerView?.descriptor.extensionDependencies.includes('imark.agent') === true,
    JSON.stringify(providerView?.descriptor.extensionDependencies)
  )

  // 直接校验清单的负例:打包会先拒绝,这里确认错误信息说得清楚
  const noMain = validateManifest({
    ...providerManifest,
    main: undefined,
    contributes: { 'imark.agentProviders': ['demo'] }
  })
  check(
    'provider 清单缺 main 被拒绝',
    !noMain.ok && noMain.errors.some(e => e.includes('必须提供 main 入口')),
    noMain.ok ? '(意外通过)' : noMain.errors.join(';')
  )
  const noDependency = validateManifest({
    ...providerManifest,
    extensionDependencies: undefined
  })
  check(
    'provider 清单缺依赖被拒绝',
    !noDependency.ok &&
      noDependency.errors.some(e => e.includes('必须通过 extensionDependencies 依赖 imark.agent')),
    noDependency.ok ? '(意外通过)' : noDependency.errors.join(';')
  )
  const badId = validateManifest({
    ...providerManifest,
    contributes: { 'imark.agentProviders': ['Demo'] }
  })
  check(
    'provider id 非法被拒绝',
    !badId.ok && badId.errors.some(e => e.includes('非法')),
    badId.ok ? '(意外通过)' : badId.errors.join(';')
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  await shutdownExtensions()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
