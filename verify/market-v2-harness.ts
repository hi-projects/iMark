/**
 * 验收:市场 v2 的打包 / 预览 / 安装 / 拒绝 v1。
 *
 * 不开窗口,全部在主进程里完成 —— 市场模块的正确性判据是**磁盘上的信封与登记**,
 * 界面只是它的投影。
 *
 * 覆盖:
 *   1. 目录 → 信封:package.json 清单、stable integrity、贡献摘要;
 *   2. 含代码包:hasMain / main / activationEvents / capabilities / mainSha256;
 *   3. 纯声明包:hasMain=false、没有入口哈希、没有「以用户权限运行」确认项;
 *   4. 安装:installed.json 的 v2 记录、目录里的 package.json 与 main.js;
 *   5. v1 信封被明确拒绝;
 *   6. 篡改文件字节 / 清单 / integrity 后校验必须失败。
 *
 * 跑法:node verify/run.mjs market-v2
 */

import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initExtensions, shutdownExtensions, type ExtensionService } from '../src/main/extensions/service'
import { installFromEnvelope, previewEnvelope, type InstallOutcome } from '../src/main/market/installer'
import { packDirectory } from '../src/main/market/pack'
import { sha256, verifyEnvelope } from '../src/main/market/verify'
import { stableIntegrityInput, type ExtensionPackageEnvelope } from '../src/shared/extensionPackage'

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
  const service: ExtensionService = await initExtensions({ appVersion: '0.1.0' })
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
      engines: { imark: '^0.1.0' },
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
  check('打出了 v2 信封', packed.envelope.formatVersion === 2, String(packed.envelope.formatVersion))
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
    check('没有权限数组', !('permissions' in p))
    check('新安装没有已装版本', p.installed === null && p.installedVersion === null)
  }

  // ---------- [C] 安装与登记 ----------
  console.log('\n[C] 安装:磁盘上的 v2 登记')
  const entrySha = codePreview.ok ? codePreview.value.mainSha256 : null
  const outcome: InstallOutcome = await installFromEnvelope(service, packed.envelope, {
    source: 'local',
    registryUrl: null,
    appVersion: '0.1.0'
  })
  check('安装返回正确的 id 与版本', outcome.id === CODE_ID && outcome.version === '1.0.0', JSON.stringify(outcome))
  check('新装不是升级', outcome.upgraded === false && outcome.downgraded === false)

  const installedRaw = JSON.parse(await readFile(join(ud, 'plugins', 'installed.json'), 'utf8')) as {
    version: number
    extensions: Record<string, { version: string; source: string; main: string | null; integrity: string; mainSha256: string | null }>
  }
  check('登记表是 v2 形状', installedRaw.version === 2)
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
      engines: { imark: '^0.1.0' },
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
    check('没有权限数组', !('permissions' in declPreview.value))
  }
  const declOutcome = await installFromEnvelope(service, declPacked.envelope, {
    source: 'local',
    registryUrl: null,
    appVersion: '0.1.0'
  })
  check('纯声明扩展能安装', declOutcome.id === DECL_ID)
  const declRecord = (JSON.parse(
    await readFile(join(ud, 'plugins', 'installed.json'), 'utf8')
  ) as { extensions: Record<string, { main: string | null; mainSha256: string | null }> }).extensions[DECL_ID]
  check('纯声明记录 main 为 null', declRecord?.main === null && declRecord?.mainSha256 === null)

  // ---------- [E] v1 信封被拒绝 ----------
  console.log('\n[E] v1 信封必须被拒绝')
  const v1 = {
    format: 'imk-plugin',
    formatVersion: 1,
    manifest: {
      id: 'harness.legacy',
      name: '旧包',
      version: '1.0.0',
      main: { mode: 'node', entry: 'main.js' },
      permissions: ['network']
    },
    files: { 'main.js': { encoding: 'base64', size: 1, sha256: '0'.repeat(64) } },
    data: { 'main.js': 'YQ==' },
    integrity: '0'.repeat(64)
  }
  const v1Check = verifyEnvelope(v1)
  check(
    'v1 信封校验失败且指出 formatVersion',
    !v1Check.ok && v1Check.errors.some(e => e.includes('formatVersion')),
    v1Check.ok ? '(意外通过)' : v1Check.errors.join(';')
  )
  let v1Threw = false
  try {
    await installFromEnvelope(service, v1, {
      source: 'local',
      registryUrl: null,
      appVersion: '0.1.0'
    })
  } catch (err) {
    v1Threw = (err as Error).message.includes('formatVersion')
  }
  check('v1 信封装不进去', v1Threw)

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

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  await shutdownExtensions()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
