/**
 * 验收:扩展模型核心。
 *
 * 不碰渲染层、不开窗口:这里直接驱动 `ExtensionService`，盯的是模型本身:
 *
 *   [1] 磁盘扫描 + `package.json` 清单 + 贡献点快照
 *   [2] `onStartupFinished` / `onCommand` 懒激活(未命中的扩展不 fork 宿主)
 *   [3] 状态栏、配置默认值、配置写入、密钥只在宿主里可读、globalState 落盘
 *   [4] `onCommand` 懒激活
 *   [5] 禁用 → 宿主释放、命令/状态栏消失；重新启用 → 命令可再执行
 *   [6] isolated 模式下扩展里的 process.exit 只重启自己的宿主
 *   [7] 卸载清理
 *
 * 跑法:
 *   node verify/run.mjs extensions-model
 */

import { app } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from '../src/main/dataDir'
import { initExtensions, shutdownExtensions, type ExtensionService } from '../src/main/extensions/service'
import { saveSettings } from '../src/main/settings'
import type { ExtensionManifest } from '../src/shared/extensionPackage'

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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(50)
  }
  console.log(`  (超时:${label})`)
  return false
}

function manifestOf(
  name: string,
  displayName: string,
  activationEvents: string[],
  commands: { command: string; title: string }[],
  properties: Record<string, unknown> = {}
): ExtensionManifest {
  return {
    publisher: 'test',
    name,
    version: '1.0.0',
    displayName,
    description: `${displayName} fixture`,
    engines: { imark: '^1.0.0' },
    main: './main.js',
    activationEvents,
    contributes: {
      commands,
      ...(Object.keys(properties).length > 0
        ? { configuration: { title: displayName, properties } }
        : {})
    }
  }
}

async function writeExtension(manifest: ExtensionManifest, code: string): Promise<void> {
  const id = `${manifest.publisher}.${manifest.name}`
  const dir = join(dataRoot(), 'plugins', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'main.js'), code, 'utf8')
}

const ALPHA = manifestOf(
  'alpha',
  'Alpha',
  ['onStartupFinished'],
  [
    { command: 'test.alpha.hello', title: 'Alpha Hello' },
    { command: 'test.alpha.secret', title: 'Alpha Secret' },
    { command: 'test.alpha.count', title: 'Alpha Count' },
    { command: 'test.alpha.remote', title: 'Alpha Remote' },
    { command: 'test.alpha.setRemote', title: 'Alpha Set Remote' },
    { command: 'test.alpha.setRemoteGlobal', title: 'Alpha Set Remote Global' },
    { command: 'test.alpha.inspectRemote', title: 'Alpha Inspect Remote' }
  ],
  {
    'test.alpha.greeting': {
      type: 'string',
      default: 'hello',
      title: 'Greeting',
      imark: { kind: 'text', section: '基础' }
    },
    'test.alpha.apiKey': {
      type: 'string',
      default: '',
      title: 'API Key',
      imark: { kind: 'password', section: '基础' }
    },
    'test.alpha.remote': {
      type: 'string',
      default: '',
      title: 'Remote',
      imark: { kind: 'text', section: '按仓库', scope: 'workspace' }
    }
  }
)

const LAZY = manifestOf(
  'lazy',
  'Lazy',
  ['onCommand:test.lazy.ping'],
  [{ command: 'test.lazy.ping', title: 'Lazy Ping' }]
)

const BAD = manifestOf('bad', 'Bad', ['onStartupFinished'], [])

const CRASHY = manifestOf(
  'crashy',
  'Crashy',
  ['onCommand:test.crashy.ping', 'onCommand:test.crashy.die'],
  [
    { command: 'test.crashy.ping', title: 'Crashy Ping' },
    { command: 'test.crashy.die', title: 'Crashy Die' }
  ]
)

const ALPHA_CODE = `
const imark = require('imark')

exports.activate = async (context) => {
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.hello', (name) => {
    const greeting = imark.workspace.getConfiguration('test.alpha').get('greeting', 'default')
    return 'alpha:' + greeting + ':' + String(name)
  }))
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.secret', async (key) => {
    const value = await context.secrets.get(key)
    return value === undefined ? 'missing' : value
  }))
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.count', async () => {
    const next = (context.globalState.get('calls', 0)) + 1
    await context.globalState.update('calls', next)
    return next
  }))
  // 按仓库配置:读生效值、自己写回、读分层值(globalValue / workspaceValue)
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.remote', () => {
    return imark.workspace.getConfiguration('test.alpha').get('remote', 'none')
  }))
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.setRemote', async (value) => {
    await imark.workspace.getConfiguration('test.alpha').update('remote', value)
    return 'set'
  }))
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.setRemoteGlobal', async (value) => {
    await imark.workspace.getConfiguration('test.alpha').update('remote', value, imark.ConfigurationTarget.Global)
    return 'set-global'
  }))
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.inspectRemote', () => {
    const info = imark.workspace.getConfiguration('test.alpha').inspect('remote') || {}
    return {
      global: info.globalValue === undefined ? null : info.globalValue,
      workspace: info.workspaceValue === undefined ? null : info.workspaceValue,
      defaultValue: info.defaultValue === undefined ? null : info.defaultValue
    }
  }))
  // 清单里没声明的命令：贡献快照里应以 source === 'runtime' 出现
  context.subscriptions.push(imark.commands.registerCommand('test.alpha.runtimeOnly', () => 'runtime'))
  const item = imark.window.createStatusBarItem(imark.StatusBarAlignment.Left, 5)
  item.text = 'Alpha'
  item.command = 'test.alpha.hello'
  item.show()
  context.subscriptions.push(item)
  imark.imark.reportStatus({ status: 'ok', message: 'alpha ready' })
}

exports.deactivate = () => {
  globalThis.__alphaDeactivated = true
}
`

const LAZY_CODE = `
const imark = require('imark')
exports.activate = (context) => {
  context.subscriptions.push(imark.commands.registerCommand('test.lazy.ping', () => 'pong'))
}
`

const BAD_CODE = `
exports.activate = () => {
  throw new Error('boom from bad')
}
`

const CRASHY_CODE = `
const imark = require('imark')
exports.activate = (context) => {
  context.subscriptions.push(imark.commands.registerCommand('test.crashy.ping', () => 'pong'))
  context.subscriptions.push(imark.commands.registerCommand('test.crashy.die', () => {
    process.exit(7)
  }))
}
`

const groupOf = (service: ExtensionService, id: string) =>
  service.hostGroupsView().find(group => group.extensionIds.includes(id))

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }
  await app.whenReady()

  await writeExtension(ALPHA, ALPHA_CODE)
  await writeExtension(LAZY, LAZY_CODE)
  await writeExtension(BAD, BAD_CODE)
  await writeExtension(CRASHY, CRASHY_CODE)
  // 这一组用例验证的是「一个扩展崩溃不波及别的扩展」,必须在显式 isolated
  // 下跑;应用默认已改成 shared。
  await saveSettings({ extensionHost: { mode: 'isolated', affinity: {} } })

  const service = await initExtensions({ appVersion: APP_VERSION })
  try {
    /** 配置推送是异步的:轮询宿主读到的生效值,别用固定 sleep 赌时序 */
    const waitRemote = async (expected: string): Promise<boolean> => {
      const started = Date.now()
      while (Date.now() - started < 5000) {
        try {
          if ((await service.executeCommand('test.alpha.remote')) === expected) return true
        } catch {
          /* 宿主可能还没起来 */
        }
        await sleep(50)
      }
      return false
    }

    console.log('\n[1] 扫描与初始状态')
    const views = await service.getExtensionViewsWithSecrets()
    check('四份清单都被扫描到', views.length === 4, views.map(v => v.descriptor.id).join(','))
    const alphaView = views.find(v => v.descriptor.id === 'test.alpha')!
    check(
      '清单配置被翻译成设置字段(含 password 与按仓库范围)',
      alphaView.descriptor.settingsFields.length === 3 &&
        alphaView.descriptor.settingsFields.some(field => field.kind === 'password') &&
        alphaView.descriptor.settingsFields.some(field => field.scope === 'workspace')
    )
    check('启动前没有宿主进程', service.hostGroupsView().every(group => group.pid === null))

    console.log('\n[2] onStartupFinished 激活与失败隔离')
    await service.startup()
    check('Alpha 已激活', service.isActivated('test.alpha'))
    check('Lazy 仍未激活(只有 onCommand)', !service.isActivated('test.lazy'))
    check('Lazy 没占宿主', groupOf(service, 'test.lazy')?.pid === null)
    check(
      'Bad 激活失败但没有拖垮 Alpha',
      (await service.getExtensionViewWithSecrets('test.bad'))!.runtime.status === 'failed' &&
        service.isActivated('test.alpha')
    )
    const alphaHost = groupOf(service, 'test.alpha')!
    check('Alpha 宿主在运行且有 PID', alphaHost.state === 'running' && typeof alphaHost.pid === 'number')

    console.log('\n[3] 状态栏 / 状态 / 配置 / 密钥 / globalState')
    const contribs = service.getContributions()
    check(
      '状态栏条目来自运行时注册',
      contribs.statusItems.some(item => item.extensionId === 'test.alpha' && item.text === 'Alpha')
    )
    check(
      '命令面板包含清单声明与运行时注册',
      contribs.commands.some(item => item.command === 'test.lazy.ping' && item.source === 'manifest') &&
        contribs.commands.some(
          item => item.command === 'test.alpha.runtimeOnly' && item.source === 'runtime'
        )
    )
    const liveAlpha = (await service.getExtensionViewWithSecrets('test.alpha'))!
    check(
      'reportStatus 进入状态快照',
      liveAlpha.status.status === 'ok' && liveAlpha.status.lastMessage === 'alpha ready',
      JSON.stringify(liveAlpha.status)
    )

    check('配置默认值生效', (await service.executeCommand('test.alpha.hello', ['x'])) === 'alpha:hello:x')
    await service.setExtensionConfig('test.alpha', { 'test.alpha.greeting': '你好' })
    await sleep(100)
    check(
      '设置页写入的配置立刻推给宿主',
      (await service.executeCommand('test.alpha.hello', ['x'])) === 'alpha:你好:x'
    )

    console.log('\n[3b] 按仓库配置')
    const vaultA = join(dataRoot(), 'vaults', 'alpha-a')
    const vaultB = join(dataRoot(), 'vaults', 'alpha-b')
    await saveSettings({ vaultPath: vaultA })
    await service.setExtensionField('test.alpha', 'test.alpha.remote', 'https://a.example/repo.git')
    check(
      '按仓库字段写入当前仓库',
      (await service.getExtensionView('test.alpha'))!.config['test.alpha.remote'] ===
        'https://a.example/repo.git'
    )
    check('宿主读到仓库 A 的值', await waitRemote('https://a.example/repo.git'))
    const inspectA = (await service.executeCommand('test.alpha.inspectRemote')) as {
      global: unknown
      workspace: unknown
      defaultValue: unknown
    }
    check(
      'inspect 区分全局值与仓库值',
      inspectA.global === null &&
        inspectA.workspace === 'https://a.example/repo.git' &&
        inspectA.defaultValue === '',
      JSON.stringify(inspectA)
    )

    await saveSettings({ vaultPath: vaultB })
    check(
      '切换仓库后回落到默认值',
      (await service.getExtensionView('test.alpha'))!.config['test.alpha.remote'] === ''
    )
    check('宿主收到仓库切换后的值', await waitRemote(''))
    await service.setExtensionField('test.alpha', 'test.alpha.remote', 'https://b.example/repo.git')
    check('仓库 B 有自己的值', await waitRemote('https://b.example/repo.git'))

    await saveSettings({ vaultPath: vaultA })
    check('切回仓库 A 仍保留各自的值', await waitRemote('https://a.example/repo.git'))
    const settingsFile = JSON.parse(
      await readFile(join(dataRoot(), 'settings.json'), 'utf8')
    ) as {
      extensions: Record<string, { workspaceConfig?: Record<string, Record<string, unknown>> }>
    }
    const scoped = settingsFile.extensions['test.alpha']?.workspaceConfig ?? {}
    check(
      '两个仓库的覆盖值分别落盘',
      Object.keys(scoped).length === 2 &&
        Object.values(scoped).every(
          bucket => typeof bucket['test.alpha.remote'] === 'string'
        ),
      JSON.stringify(scoped)
    )

    // 插件自己 update():清单声明 workspace 时默认写当前仓库,不必显式传 target
    check('插件可写回按仓库配置', (await service.executeCommand('test.alpha.setRemote', ['from-plugin'])) === 'set')
    check('插件写入后生效', await waitRemote('from-plugin'))
    const afterWrite = JSON.parse(
      await readFile(join(dataRoot(), 'settings.json'), 'utf8')
    ) as {
      extensions: Record<string, { workspaceConfig?: Record<string, Record<string, unknown>> }>
    }
    const buckets = Object.values(afterWrite.extensions['test.alpha']?.workspaceConfig ?? {})
    check(
      '插件写入只更新当前仓库',
      buckets.filter(bucket => bucket['test.alpha.remote'] === 'from-plugin').length === 1 &&
        buckets.some(bucket => bucket['test.alpha.remote'] === 'https://b.example/repo.git'),
      JSON.stringify(buckets)
    )

    // 显式写全局层:当前仓库已有覆盖,生效值不变,但分层值仍要同步给宿主,
    // 否则 inspect() 会在下一次推送前一直看到旧的全局值。
    check(
      '插件可显式写全局层',
      (await service.executeCommand('test.alpha.setRemoteGlobal', ['https://global.example/repo.git'])) ===
        'set-global'
    )
    check('全局层不越过仓库覆盖', await waitRemote('from-plugin'))
    const inspectGlobal = (await service.executeCommand('test.alpha.inspectRemote')) as {
      global: unknown
      workspace: unknown
      defaultValue: unknown
    }
    check(
      'inspect 同时反映全局层与仓库层',
      inspectGlobal.global === 'https://global.example/repo.git' &&
        inspectGlobal.workspace === 'from-plugin' &&
        inspectGlobal.defaultValue === '',
      JSON.stringify(inspectGlobal)
    )

    const vaultC = join(dataRoot(), 'vaults', 'alpha-c')
    await saveSettings({ vaultPath: vaultC })
    check('没有覆盖的仓库继承全局值', await waitRemote('https://global.example/repo.git'))
    const inspectC = (await service.executeCommand('test.alpha.inspectRemote')) as {
      global: unknown
      workspace: unknown
    }
    check(
      '仓库 C 没有自己的覆盖值',
      inspectC.global === 'https://global.example/repo.git' && inspectC.workspace === null,
      JSON.stringify(inspectC)
    )

    await service.setExtensionSecret('test.alpha', 'apiKey', 's3cret-value')
    check(
      '密钥只在宿主里读到明文',
      (await service.executeCommand('test.alpha.secret', ['apiKey'])) === 's3cret-value'
    )
    const withSecrets = (await service.getExtensionViewWithSecrets('test.alpha'))!
    check(
      '视图里只有掩码',
      withSecrets.secrets['test.alpha:apiKey'] === 's3****ue' &&
        !JSON.stringify(withSecrets).includes('s3cret-value'),
      JSON.stringify(withSecrets.secrets)
    )

    check('globalState 第一次计数为 1', (await service.executeCommand('test.alpha.count')) === 1)
    check('globalState 第二次计数为 2', (await service.executeCommand('test.alpha.count')) === 2)
    await sleep(300)
    const stateFile = JSON.parse(
      await readFile(join(dataRoot(), 'extensions-data', 'test.alpha', 'state.json'), 'utf8')
    ) as { global: Record<string, unknown> }
    check('globalState 已落盘', stateFile.global.calls === 2, JSON.stringify(stateFile.global))

    console.log('\n[4] onCommand 懒激活')
    check('Lazy 命令返回 pong', (await service.executeCommand('test.lazy.ping')) === 'pong')
    check('Lazy 已激活', service.isActivated('test.lazy'))
    check('Lazy 现在占了自己的宿主', typeof groupOf(service, 'test.lazy')?.pid === 'number')

    console.log('\n[5] 禁用 / 重新启用')
    const alphaPid = groupOf(service, 'test.alpha')!.pid
    await service.setEnabled('test.alpha', false)
    check(
      '禁用后命令从贡献快照消失',
      await waitFor('alpha commands gone', () =>
        service
          .getContributions()
          .commands.every(item => item.extensionId !== 'test.alpha')
      )
    )
    check(
      '禁用后 Alpha 宿主 PID 释放',
      await waitFor('alpha pid released', () => {
        // 禁用后规划里已经不再有它的组,`undefined` 与 `null` 都算释放
        const pid = groupOf(service, 'test.alpha')?.pid
        return pid === undefined || pid === null
      }),
      String(alphaPid)
    )
    check(
      '禁用后状态栏条目消失',
      service.getContributions().statusItems.every(item => item.extensionId !== 'test.alpha')
    )

    await service.setEnabled('test.alpha', true)
    check(
      '重新启用后命令重新出现(清单声明)',
      service.getContributions().commands.some(item => item.command === 'test.alpha.hello')
    )
    // 关键回归:启动之后再启用，onStartupFinished 已经过去；扩展仍应被立即激活，
    // 否则「激活里创建状态栏」的扩展在启用后什么都不出现
    check(
      '重新启用后 onStartupFinished 扩展自动激活(不必等命令)',
      await waitFor('alpha auto activated', () => service.isActivated('test.alpha'))
    )
    check('重新启用后命令可执行', (await service.executeCommand('test.alpha.hello', ['y'])) === 'alpha:你好:y')
    check('重新启用后扩展状态为 active', service.isActivated('test.alpha'))
    check('配置与 globalState 跨停用保留', (await service.executeCommand('test.alpha.count')) === 3)

    console.log('\n[6] isolated 模式的崩溃隔离')
    check('Crashy 首次激活', (await service.executeCommand('test.crashy.ping')) === 'pong')
    const alphaBefore = groupOf(service, 'test.alpha')!.pid
    const crashyBefore = groupOf(service, 'test.crashy')!.pid
    try {
      await service.executeCommand('test.crashy.die')
      check('崩溃命令不应正常返回', false)
    } catch {
      check('崩溃命令以拒绝结束(进程已被带走)', true)
    }
    check(
      'Crashy 的宿主重启为新 PID',
      await waitFor('crashy new pid', () => {
        const pid = groupOf(service, 'test.crashy')?.pid
        return typeof pid === 'number' && pid !== crashyBefore
      }, 8000),
      `${String(crashyBefore)} → ${String(groupOf(service, 'test.crashy')?.pid)}`
    )
    check(
      'Alpha 的宿主 PID 没变(崩溃没有波及别的扩展)',
      groupOf(service, 'test.alpha')?.pid === alphaBefore
    )
    check(
      'Crashy 重启后重新激活',
      await waitFor('crashy active again', () => service.isActivated('test.crashy'), 8000)
    )
    check('重启后命令重新注册', (await service.executeCommand('test.crashy.ping')) === 'pong')

    console.log('\n[7] 卸载清理')
    await service.uninstallExtension('test.lazy')
    check(
      '卸载后清单消失',
      !(await service.getExtensionViewsWithSecrets()).some(v => v.descriptor.id === 'test.lazy')
    )
    let unknown = false
    try {
      await service.executeCommand('test.lazy.ping')
    } catch {
      unknown = true
    }
    check('卸载后命令不再可执行', unknown)
  } finally {
    await shutdownExtensions()
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
