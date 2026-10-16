/**
 * 内置插件的「跟着应用一起升级」验收。
 *
 * 为什么需要这一段:应用自带的插件包在补装时是「有同 id 就完全不碰」的,而插件的新
 * 能力(比如 git-sync 0.3.0 才有的状态栏条目与命令)是随应用版本一起发出去的。
 * 没有升级这条路,用户升了应用却拿不到新能力 —— 而且这次的表现不是"少个新功能",
 * 是**状态栏上那个按钮直接不见了**(应用这边已经改成插件声明,插件那边还停在没声明的版本)。
 *
 * 这一段不用开窗口:补装与升级是纯主进程的事,判据全在**磁盘上的登记**与**目录里的文件**上。
 * 判据取"登记 + 目录"两处,而不是只读内存里的 entry —— 因为「下次启动还会不会这样」才是
 * 用户真正的体验,而那取决于磁盘。
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs bundled-upgrade
 */

import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { loadSettings } from '../src/main/settings'
import {
  getPluginHost,
  initPluginHost,
  type PluginHost
} from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import {
  getRecord,
  pluginDir,
  setRecord,
  removeRecord
} from '../src/main/plugins/installed'
import gitSyncPackage from '../src/main/market/builtin/git-sync.imkpkg.json?raw'

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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 应用里自带的那份 git-sync 包的清单信息(判据的真值来源) */
const bundled = JSON.parse(gitSyncPackage) as {
  manifest: { id: string; version: string; permissions: string[]; main: string }
  /** 包内路径 → 该文件的 sha256(内容是另一个字段里的 base64 大块) */
  files: Record<string, { encoding: string; size: number; sha256: string }>
  integrity: string
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** 这一份装上去的文件,是不是就是应用自带的那份(逐字节) */
async function installedMatchesBundled(): Promise<boolean> {
  const dir = pluginDir(bundled.manifest.id)
  for (const [rel, meta] of Object.entries(bundled.files)) {
    const p = join(dir, rel)
    if (!existsSync(p)) return false
    if ((await sha256File(p)) !== meta.sha256) return false
  }
  return true
}

/** 把已装的登记改成「一个更旧的版本」,模拟老用户升级应用之后的那台机器 */
async function fakeOldVersion(
  id: string,
  version: string,
  patch: Partial<{ source: string; registryUrl: string | null }> = {}
): Promise<void> {
  const rec = await getRecord(id)
  if (!rec) throw new Error(`没有 ${id} 的登记,装不上这一步`)
  await setRecord({
    ...rec,
    version,
    ...(patch.source ? { source: patch.source as typeof rec.source } : {}),
    ...(patch.registryUrl !== undefined ? { registryUrl: patch.registryUrl } : {})
  })
}

const existing = (p: string): boolean => existsSync(p)

async function main(): Promise<void> {
  if (!process.argv.some(a => a.startsWith('--user-data-dir'))) {
    console.error('必须显式指定 --user-data-dir(否则会写进真实用户目录)')
    app.exit(2)
    return
  }
  await app.whenReady()
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

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

  registerIpc()
  await loadSettings()
  // 这就是应用启动时的那一步:补装缺失的内置包
  await initPluginHost(ensureBundledProvisioned)
  const host = getPluginHost() as PluginHost
  await sleep(300)

  // ---- 1. 全新环境:该装的都装了 ----
  console.log('\n[A] 全新环境:补装')
  const fresh = await getRecord('git-sync')
  check('内置包被补装上了', fresh !== null && fresh.version === bundled.manifest.version,
    JSON.stringify(fresh?.version))
  check('装上去的文件就是应用自带的那份(逐字节)', await installedMatchesBundled())
  check(
    '补装时是「装上但关着」(git-sync 要填仓库地址才有意义)',
    (await host.list()).find(v => v.descriptor.id === 'git-sync')?.state.enabled === false
  )

  // 默认启用的那个兜底包(quick-edit)在启动时只能被启用一次 ——
  // 「补装时 save() 启用一次」和「启动循环对已启用项再启用一次」本来会撞在一起,
  // 一个在 onEnable 里 setInterval 的插件会因此拿到两个定时器
  const qeStartup = ((await host.list()).find(v => v.descriptor.id === 'quick-edit')?.logs ?? [])
    .filter(l => l.includes('Quick Edit 已就绪')).length
  check('启动时插件只被启用一次(onEnable 不跑两遍)', qeStartup === 1, String(qeStartup))

  // ---- 2. 老用户:装的是旧版,应用是新的 ----
  console.log('\n[B] 老用户升级应用:内置插件跟着升')
  await fakeOldVersion('git-sync', '0.1.0')
  await ensureBundledProvisioned(host)
  const upgraded = await getRecord('git-sync')
  check('内置来源 + 版本更旧 → 升到应用自带的那一版',
    upgraded?.version === bundled.manifest.version, String(upgraded?.version))
  check('升完目录里就是新版的文件(逐字节)', await installedMatchesBundled())
  check(
    '登记里记的 integrity 就是应用自带那份包的 integrity(下次启动不会再想升一遍)',
    upgraded?.integrity === bundled.integrity,
    `${String(upgraded?.integrity?.slice(0, 12))} vs ${bundled.integrity.slice(0, 12)}`
  )
  check('来源仍是「应用自带」', upgraded?.source === 'bundled', String(upgraded?.source))
  check(
    '授权集合一个都没变(升个版本不该顺手把权限变大)',
    JSON.stringify(upgraded?.grantedPermissions) ===
      JSON.stringify(bundled.manifest.permissions),
    JSON.stringify(upgraded?.grantedPermissions)
  )
  check('升级后依然是关着的(用户没让它碰过他的仓库)',
    (await host.list()).find(v => v.descriptor.id === 'git-sync')?.state.enabled === false)

  // ---- 3. 用户开着这个插件时升级 ----
  console.log('\n[C] 插件正开着的时候升级')
  // 关掉自动同步:harness 的仓库不是 git 仓库,别在这里真的跑 git
  await host.save('git-sync', {
    enabled: true,
    config: { intervalMinutes: 0, syncOnStart: false }
  })
  await sleep(200)
  // 「插件真的有反应」得问插件自己:没配远端时它会**带着原因**拒绝这次同步,
  // 这声应答就是活着的证据(宿主自己的 state 不区分"跑过"和"没跑过")
  const statusItem = { pluginId: 'git-sync', itemId: 'sync-now-status', from: 'status' as const }
  const before = await host.invokeContrib(statusItem)
  await sleep(20) // 让时间戳能区分开(不然同一毫秒看不出先后)
  await fakeOldVersion('git-sync', '0.1.0')
  await ensureBundledProvisioned(host)
  const rightAfterUpgrade = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  const after = await host.invokeContrib(statusItem)
  check('升级不会把用户开着的插件关掉', rightAfterUpgrade?.state.enabled === true,
    JSON.stringify(rightAfterUpgrade?.state))
  check('升级后没有加载错误', rightAfterUpgrade?.loadError === undefined,
    String(rightAfterUpgrade?.loadError))
  check(
    '升级之后插件答得上话(新的那份代码活着,能跑到它自己的判断逻辑)',
    after.message === before.message && after.message === '尚未配置远端仓库',
    `${JSON.stringify(before.message)} → ${JSON.stringify(after.message)}`
  )
  // 升级会重造 runtime(状态清成 idle、lastRunAt 清零),所以这个时间戳**只能是**
  // 升级之后那一次跑出来的 —— 它是"新代码真的在跑"的第二个证据
  check(
    '升级重置了运行状态(证明换的是真的一个新的运行实例)',
    rightAfterUpgrade?.state.lastRunAt === null,
    String(rightAfterUpgrade?.state.lastRunAt)
  )
  const afterState = (await host.list()).find(v => v.descriptor.id === 'git-sync')?.state
  check(
    '升级之后插件自己的状态又动了起来(不是一份躺着的旧登记)',
    typeof afterState?.lastRunAt === 'number' && afterState.lastRunAt > 0,
    JSON.stringify(afterState)
  )

  // ---- 4. 不该被碰的三种情况 ----
  console.log('\n[D] 三种「不归它管」的情况')
  await fakeOldVersion('git-sync', '0.1.0', { source: 'market', registryUrl: 'https://example.com' })
  await ensureBundledProvisioned(host)
  const market = await getRecord('git-sync')
  check(
    '从市场装的那份不归内置包管(拿自带的去盖,可能盖成一个比市场还旧的版本)',
    market?.version === '0.1.0' && market?.source === 'market',
    JSON.stringify({ v: market?.version, s: market?.source })
  )

  await fakeOldVersion('git-sync', '9.9.9', { source: 'bundled' })
  await ensureBundledProvisioned(host)
  check('装着的比自带的还新 → 不降级', (await getRecord('git-sync'))?.version === '9.9.9',
    String((await getRecord('git-sync'))?.version))

  // 没有登记 = 不是"装"进来的(开发模式挂的目录、手工放的文件夹)
  await removeRecord('git-sync')
  await ensureBundledProvisioned(host)
  check(
    '没有登记的那份不碰它(不新装、也不覆盖),它还得留在原地',
    (await getRecord('git-sync')) === null && existing(join(pluginDir('git-sync'), 'manifest.json'))
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

// 断言里抛了异常要**当场退出**,不能悬在那儿等外部超时 ——
// 那样看到的是一份没写完的日志,还得先排除"是不是卡住了"
void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
