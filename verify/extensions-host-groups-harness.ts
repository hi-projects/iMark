/**
 * 验收:宿主分组。
 *
 * 这里只关心“扩展代码跑在哪个进程里”，不碰渲染层:
 *
 *   [1] shared(默认):所有扩展共用一个宿主
 *   [1b] isolated(显式选择):A/B/C 各自一个宿主；D 依赖 E，强制同组
 *   [2] shared:五个扩展共用一个宿主，每个扩展仍拿到自己的配置/密钥/命令
 *   [3] affinity:A、B 同宿主，C 独立，D/E 因依赖仍同组
 *   [4] 只改某个组的 affinity 编号且成员没变 → 不重启任何宿主
 *   [5] 把 A 并入 C 的组 → 只重启这两个组，D/E 宿主保持原 PID
 *   [6] 共享宿主里 A 崩溃 → 同组 C 一起重启，其他宿主不受影响
 *   [7] 禁用组内扩展 → 该组单独释放/换宿主，其他组 PID 不变
 *
 * 另外:E 的 activate() 返回导出对象,D(依赖 E,同宿主)通过
 * `imark.extensions.getExtension()` 读到它,覆盖 `Extension.exports` 的赋值路径。
 *
 * 每组里的扩展都用 `require('imark')` 注册**清单未声明**的命令；命令归属
 * (`command.registered` 的 extensionId)能直接证明注入的是调用方自己的 API。
 *
 * 跑法:
 *   node verify/run.mjs extensions-host-groups
 */

import { app } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from '../src/main/dataDir'
import { initExtensions, shutdownExtensions, type ExtensionService } from '../src/main/extensions/service'
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

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15000): Promise<boolean> {
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
  commands: { command: string; title: string }[],
  extra: Partial<ExtensionManifest> = {}
): ExtensionManifest {
  const id = `test.${name}`
  return {
    publisher: 'test',
    name,
    version: '1.0.0',
    displayName,
    engines: { imark: '^1.0.0' },
    main: './main.js',
    activationEvents: ['onStartupFinished'],
    contributes: {
      commands,
      configuration: {
        title: displayName,
        properties: {
          [`${id}.greeting`]: {
            type: 'string',
            default: `hello-${name}`,
            title: 'Greeting',
            imark: { kind: 'text' }
          },
          [`${id}.token`]: {
            type: 'string',
            default: '',
            title: 'Token',
            imark: { kind: 'password' }
          }
        }
      }
    },
    ...extra
  }
}

function codeFor(extra = '', exportValue = ''): string {
  return `
const imark = require('imark')

exports.activate = (context) => {
  const self = context.extension.id
  context.subscriptions.push(imark.commands.registerCommand(self + '.who', async () => {
    // 不传 section 时的 get 读的是**本扩展**的配置表。宿主若注入错了 API 对象,
    // 这里会读到别的扩展的配置。
    const greeting = imark.workspace.getConfiguration(self).get('greeting', 'missing')
    const token = (await context.secrets.get('token')) ?? 'none'
    return self + '|' + greeting + '|' + token
  }))
  // 清单里没声明:归属完全由注入的 API 对象决定
  context.subscriptions.push(imark.commands.registerCommand(self + '.runtime', () => self))
  ${extra}
  ${exportValue ? `return ${exportValue}` : ''}
}
`
}

const A_ID = 'test.aa'
const B_ID = 'test.bb'
const C_ID = 'test.cc'
const D_ID = 'test.dd'
const E_ID = 'test.ee'

const A = manifestOf('aa', 'A', [
  { command: `${A_ID}.who`, title: 'A Who' },
  { command: `${A_ID}.die`, title: 'A Die' }
])
const B = manifestOf('bb', 'B', [{ command: `${B_ID}.who`, title: 'B Who' }])
const C = manifestOf('cc', 'C', [{ command: `${C_ID}.who`, title: 'C Who' }])
const D = manifestOf('dd', 'D', [{ command: `${D_ID}.who`, title: 'D Who' }], {
  extensionDependencies: [E_ID]
})
const E = manifestOf('ee', 'E', [{ command: `${E_ID}.who`, title: 'E Who' }])

const EXTENSIONS = [A, B, C, D, E]
const IDS = [A_ID, B_ID, C_ID, D_ID, E_ID]

async function writeExtension(manifest: ExtensionManifest, code: string): Promise<void> {
  const dir = join(dataRoot(), 'plugins', `test.${manifest.name}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'main.js'), code, 'utf8')
}

const groupOf = (service: ExtensionService, id: string) =>
  service.hostGroupsView().find(group => group.extensionIds.includes(id))

const pidOf = (service: ExtensionService, id: string): number | null =>
  groupOf(service, id)?.pid ?? null

function pidsOf(service: ExtensionService): Record<string, number | null> {
  return Object.fromEntries(IDS.map(id => [id, pidOf(service, id)]))
}

function distinctLivePids(service: ExtensionService, ids: readonly string[]): number {
  return new Set(
    ids.map(id => pidOf(service, id)).filter((pid): pid is number => typeof pid === 'number')
  ).size
}

/** `require('imark')` 的归属:运行时命令应记在注册它的扩展名下 */
function ownsRuntimeCommand(service: ExtensionService, id: string): boolean {
  const item = service.getContributions().commands.find(c => c.command === `${id}.runtime`)
  return item?.extensionId === id && item.source === 'runtime'
}

function allOwnRuntimeCommands(service: ExtensionService): boolean {
  return IDS.every(id => ownsRuntimeCommand(service, id))
}

async function who(service: ExtensionService, id: string): Promise<string> {
  return String(await service.executeCommand(`${id}.who`))
}

/** D 在自己的宿主里读取 E 的 exports；跨宿主时读不到对象 */
async function readEExports(service: ExtensionService): Promise<string> {
  return String(await service.executeCommand(`${D_ID}.read-e`))
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }
  await app.whenReady()

  const dieCode =
    "context.subscriptions.push(imark.commands.registerCommand(self + '.die', () => { process.exit(9) }))"
  // D 依赖 E,两者同宿主;这里读的是宿主内的 exports 对象,不是命令返回值
  const readECode = `
  context.subscriptions.push(imark.commands.registerCommand(self + '.read-e', () => {
    const target = imark.extensions.getExtension('test.ee')
    return target ? String(target.exports?.marker ?? 'missing') : 'missing'
  }))`
  for (const manifest of EXTENSIONS) {
    const extra = manifest.name === 'aa' ? dieCode : manifest.name === 'dd' ? readECode : ''
    const exported = manifest.name === 'ee' ? "({ marker: 'export-e' })" : ''
    await writeExtension(manifest, codeFor(extra, exported))
  }

  const service = await initExtensions({ appVersion: APP_VERSION })
  try {
    console.log('\n[1] shared(默认):所有扩展共用一个宿主')
    check(
      '默认模式是 shared',
      service.getContributions().hostModeState === 'shared',
      service.getContributions().hostModeState
    )
    console.log('\n[1b] isolated(显式选择):每个扩展一个宿主，依赖强制同组')
    await service.setHostSettings({ mode: 'isolated' })
    await service.startup()
    check('五个扩展都已激活', IDS.every(id => service.isActivated(id)))
    const p1 = pidsOf(service)
    check(
      'A/B/C 三个宿主、三个 PID',
      distinctLivePids(service, [A_ID, B_ID, C_ID]) === 3 &&
        p1[A_ID] !== null &&
        p1[B_ID] !== null &&
        p1[C_ID] !== null,
      JSON.stringify(p1)
    )
    check(
      'D/E 因 extensionDependencies 同宿主',
      p1[D_ID] !== null && p1[D_ID] === p1[E_ID],
      JSON.stringify(p1)
    )
    check(
      '一共四个宿主',
      distinctLivePids(service, IDS) === 4,
      String(distinctLivePids(service, IDS))
    )
    check('运行时命令归属正确(isolated)', allOwnRuntimeCommands(service))
    check('D 能读到同宿主依赖 E 的 exports', (await readEExports(service)) === 'export-e')
    check(
      '每个扩展读到自己的配置默认值',
      (await who(service, A_ID)) === `${A_ID}|hello-aa|none` &&
        (await who(service, B_ID)) === `${B_ID}|hello-bb|none` &&
        (await who(service, C_ID)) === `${C_ID}|hello-cc|none` &&
        (await who(service, D_ID)) === `${D_ID}|hello-dd|none` &&
        (await who(service, E_ID)) === `${E_ID}|hello-ee|none`
    )

    for (const id of IDS) {
      await service.setExtensionSecret(id, 'token', `secret-${id.slice(5)}`)
    }
    check(
      '每个扩展只读到自己的密钥',
      (await who(service, A_ID)) === `${A_ID}|hello-aa|secret-aa` &&
        (await who(service, B_ID)) === `${B_ID}|hello-bb|secret-bb` &&
        (await who(service, C_ID)) === `${C_ID}|hello-cc|secret-cc` &&
        (await who(service, D_ID)) === `${D_ID}|hello-dd|secret-dd` &&
        (await who(service, E_ID)) === `${E_ID}|hello-ee|secret-ee`
    )

    console.log('\n[2] shared:一个宿主装下所有扩展')
    await service.setHostSettings({ mode: 'shared' })
    check(
      '五个扩展共用一个运行中的宿主',
      await waitFor('single shared host', () => {
        const pid = pidOf(service, A_ID)
        return typeof pid === 'number' && IDS.every(id => pidOf(service, id) === pid)
      }),
      JSON.stringify(pidsOf(service))
    )
    check(
      '切换后全部重新激活',
      await waitFor('all active in shared', () => IDS.every(id => service.isActivated(id)))
    )
    check('运行时命令归属正确(shared)', allOwnRuntimeCommands(service))
    check(
      '共享宿主里各扩展仍读自己的密钥',
      (await who(service, A_ID)) === `${A_ID}|hello-aa|secret-aa` &&
        (await who(service, C_ID)) === `${C_ID}|hello-cc|secret-cc`
    )

    await service.setExtensionConfig(A_ID, { [`${A_ID}.greeting`]: 'custom-a' })
    await sleep(150)
    check(
      '只改 A 的配置:同宿主的其他扩展不受影响',
      (await who(service, A_ID)) === `${A_ID}|custom-a|secret-aa` &&
        (await who(service, B_ID)) === `${B_ID}|hello-bb|secret-bb` &&
        (await who(service, C_ID)) === `${C_ID}|hello-cc|secret-cc`
    )

    console.log('\n[3] affinity:A/B 同宿主，C 独立，D/E 仍同组')
    await service.setHostSettings({
      affinity: { [A_ID]: 1, [B_ID]: 1, [C_ID]: 2, [D_ID]: 3, [E_ID]: 3 }
    })
    check(
      '分组符合 affinity + 依赖',
      await waitFor('affinity groups', () => {
        const pa = pidOf(service, A_ID)
        const pb = pidOf(service, B_ID)
        const pc = pidOf(service, C_ID)
        const pd = pidOf(service, D_ID)
        const pe = pidOf(service, E_ID)
        return (
          typeof pa === 'number' &&
          pa === pb &&
          typeof pc === 'number' &&
          pc !== pa &&
          typeof pd === 'number' &&
          pd === pe &&
          pd !== pa &&
          pd !== pc
        )
      }),
      JSON.stringify(pidsOf(service))
    )
    check(
      '三个宿主',
      distinctLivePids(service, IDS) === 3,
      String(distinctLivePids(service, IDS))
    )
    check(
      '重新激活后全部可用且归属正确',
      (await waitFor('all active after affinity', () => IDS.every(id => service.isActivated(id)))) &&
        allOwnRuntimeCommands(service)
    )
    check(
      '跨宿主调用返回各自的值',
      (await who(service, A_ID)) === `${A_ID}|custom-a|secret-aa` &&
        (await who(service, B_ID)) === `${B_ID}|hello-bb|secret-bb` &&
        (await who(service, D_ID)) === `${D_ID}|hello-dd|secret-dd` &&
        (await who(service, E_ID)) === `${E_ID}|hello-ee|secret-ee`
    )

    console.log('\n[4] 只改 affinity 编号、成员不变 → 不重启宿主')
    const p4 = pidsOf(service)
    await service.setHostSettings({
      affinity: { [A_ID]: 1, [B_ID]: 1, [C_ID]: 4, [D_ID]: 3, [E_ID]: 3 }
    })
    await sleep(800)
    check(
      '所有 PID 保持不变',
      IDS.every(id => pidOf(service, id) === p4[id]),
      `${JSON.stringify(p4)} → ${JSON.stringify(pidsOf(service))}`
    )
    check('扩展仍在运行', IDS.every(id => service.isActivated(id)))

    console.log('\n[5] 把 A 并入 C 的组:只重启受影响的宿主')
    const p5 = pidsOf(service)
    await service.setHostSettings({
      affinity: { [A_ID]: 2, [B_ID]: 1, [C_ID]: 2, [D_ID]: 3, [E_ID]: 3 }
    })
    check(
      'A/C 同宿主，B 独立，D/E 不变',
      await waitFor('merge groups', () => {
        const pa = pidOf(service, A_ID)
        const pb = pidOf(service, B_ID)
        const pc = pidOf(service, C_ID)
        return (
          typeof pa === 'number' &&
          pa === pc &&
          pa !== p5[A_ID] &&
          typeof pb === 'number' &&
          pb !== pa &&
          pb !== p5[B_ID] &&
          pidOf(service, D_ID) === p5[D_ID] &&
          pidOf(service, E_ID) === p5[E_ID]
        )
      }),
      `${JSON.stringify(p5)} → ${JSON.stringify(pidsOf(service))}`
    )
    check(
      'D/E 宿主 PID 没变(没被无关变更波及)',
      pidOf(service, D_ID) === p5[D_ID] && pidOf(service, E_ID) === p5[E_ID]
    )
    check(
      '重新激活后归属与配置仍正确',
      (await waitFor('active after merge', () => IDS.every(id => service.isActivated(id)))) &&
        allOwnRuntimeCommands(service) &&
        (await who(service, A_ID)) === `${A_ID}|custom-a|secret-aa` &&
        (await who(service, C_ID)) === `${C_ID}|hello-cc|secret-cc`
    )

    console.log('\n[6] 共享宿主崩溃:同组一起重启，其他组不动')
    const p6 = pidsOf(service)
    try {
      await service.executeCommand(`${A_ID}.die`)
      check('崩溃命令不应正常返回', false)
    } catch {
      check('崩溃命令以拒绝结束', true)
    }
    check(
      'A/C 所在宿主重启为新 PID',
      await waitFor(
        'a/c host restarted',
        () => {
          const pa = pidOf(service, A_ID)
          return typeof pa === 'number' && pa !== p6[A_ID] && pidOf(service, C_ID) === pa
        },
        8000
      ),
      `${JSON.stringify(p6)} → ${JSON.stringify(pidsOf(service))}`
    )
    check(
      'B 与 D/E 的宿主 PID 不受影响',
      pidOf(service, B_ID) === p6[B_ID] &&
        pidOf(service, D_ID) === p6[D_ID] &&
        pidOf(service, E_ID) === p6[E_ID]
    )
    check(
      'A/C 重启后都重新激活且命令可用',
      (await waitFor(
        'a/c active again',
        () => service.isActivated(A_ID) && service.isActivated(C_ID),
        8000
      )) && allOwnRuntimeCommands(service)
    )
    check(
      '重启后 A 的配置与密钥仍然生效',
      (await who(service, A_ID)) === `${A_ID}|custom-a|secret-aa`
    )

    console.log('\n[7] 禁用组内扩展:只释放/更换该组')
    const p7 = pidsOf(service)
    await service.setEnabled(D_ID, false)
    check(
      '禁用 D 后它不再有宿主',
      await waitFor('d group gone', () => groupOf(service, D_ID) === undefined)
    )
    check(
      '同组的 E 换到只有自己的宿主',
      await waitFor('e moved', () => {
        const pe = pidOf(service, E_ID)
        return typeof pe === 'number' && pe !== p7[E_ID]
      })
    )
    check(
      'A/C 与 B 的宿主 PID 没变',
      pidOf(service, A_ID) === p7[A_ID] && pidOf(service, B_ID) === p7[B_ID]
    )
    check('E 仍可执行命令', (await who(service, E_ID)) === `${E_ID}|hello-ee|secret-ee`)

    const p7b = pidsOf(service)
    await service.setEnabled(E_ID, false)
    check(
      '禁用 E 后该组消失',
      await waitFor('e group gone', () => groupOf(service, E_ID) === undefined)
    )
    check(
      '其他组的 PID 仍不变',
      pidOf(service, A_ID) === p7b[A_ID] && pidOf(service, B_ID) === p7b[B_ID]
    )
    check(
      '只剩两个宿主(A/C 一组、B 一组)',
      distinctLivePids(service, [A_ID, B_ID, C_ID]) === 2 &&
        service.hostGroupsView().length === 2,
      JSON.stringify(service.hostGroupsView())
    )
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
