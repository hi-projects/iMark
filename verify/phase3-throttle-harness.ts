/**
 * 阶段三验收(慢):**隐藏页面的定时器节流实测**。交接单 §3.10 点名的那一条,也是最容易被
 * 低估的一条 —— 它要跨过 Chromium 的两级节流台阶:
 *
 *   1. 页面不可见后,`setInterval` 先被降到 **1 秒一次**;
 *   2. 大约 5 分钟之后进入 **intensive throttling**,降到 **每 60 秒一次**。
 *
 * 所以"插件自己的 setInterval 能不能当计时器用"这件事,光看代码是看不出来的:
 * 前 5 分钟它一分不差,第 6 分钟开始每分钟才跑一次 —— 而那时作者已经在别处找原因了。
 * 宿主调度器(`imark.schedule.every`)走的是**主进程的 Node 定时器**,不受这套节流影响,
 * 这就是它存在的理由。
 *
 * 断言:同时注册 host 调度器与自己的 setInterval(都是 1000ms),窗口全程隐藏,
 * 跑满 DURATION 之后:
 *
 *   - **host tick 数 ≈ DURATION**(核心那条):宿主调度器跨过两个节流台阶仍然不丢点
 *   - 页面确实是隐藏的(`visibilityState === 'hidden'`)
 *   - 自己的 setInterval 跑得怎么样 —— **报告值,不当作通过条件**:
 *     插件窗口开了 `backgroundThrottling: false`(交接单 §3.5 的第 3 层,给作者
 *     自己写的定时器当止血带),所以它在一台正常机器上也会跑满。那是我们替作者
 *     买来的时间,不是 Chromium 的承诺 —— 文档里要如实写成"尽力而为"。
 *     这一条实测曾经把它当成"节流生效的证明"来断言,而那是**反着写的**:
 *     关掉节流之后它当然不会掉。
 *
 * 跑法:node verify/run.mjs phase3-throttle [--minutes=12]
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerPluginScheme, pluginWindowOf } from '../src/main/plugins/windows'
import { initPluginHost } from '../src/main/plugins/host'
import { pluginDir, setRecord } from '../src/main/plugins/installed'

registerPluginScheme()

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

/** 同时用两条路计时,把两个计数都报回来 */
const MAIN_JS = `
let hostTicks = 0
let selfTicks = 0
let lastLate = 0
window.imark.on('tick', payload => {
  hostTicks += 1
  if (payload && typeof payload.lateMs === 'number') lastLate = payload.lateMs
})
setInterval(() => { selfTicks += 1 }, 1000)
window.imark.plugin.handle({
  onEnable() {
    window.imark.schedule.every(1000, 'hb')
  },
  runAction(id) {
    if (id !== 'report') return { ok: false, message: 'unknown' }
    return {
      ok: true,
      message: JSON.stringify({ hostTicks, selfTicks, lastLate, hidden: document.visibilityState })
    }
  }
})
`

function argMinutes(): number {
  const hit = process.argv.find(a => a.startsWith('--minutes='))
  const n = hit ? Number(hit.slice('--minutes='.length)) : 12
  return Number.isFinite(n) && n > 0 ? n : 12
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await mkdir(vault, { recursive: true })

  const dir = pluginDir('sbx-throttle')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id: 'sbx-throttle',
        name: '节流实测',
        description: '验收用',
        version: '1.0.0',
        kind: 'sandboxed',
        main: 'main.js',
        permissions: [],
        fields: [],
        actions: [{ id: 'report', label: '报告' }]
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(join(dir, 'main.js'), MAIN_JS, 'utf8')
  await setRecord({
    id: 'sbx-throttle',
    version: '1.0.0',
    kind: 'sandboxed',
    integrity: 'x'.repeat(64),
    mainSha256: null,
    publisher: null,
    source: 'local',
    registryUrl: null,
    installedAt: Date.now(),
    grantedPermissions: []
  })

  const minutes = argMinutes()
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        autoSave: false,
        marketUrl: '',
        plugins: { 'sbx-throttle': { enabled: true, config: {} } }
      },
      null,
      2
    ),
    'utf8'
  )

  const host = await initPluginHost()
  const t0 = Date.now()
  console.log(`\n[节流实测] 窗口全程隐藏,跑 ${minutes} 分钟……`)

  // 每分钟报一次进度,免得看起来像是卡住了
  for (let i = 1; i <= minutes; i++) {
    await sleep(60_000)
    const r = await host.runAction('sbx-throttle', 'report')
    let counts = { hostTicks: 0, selfTicks: 0 }
    try {
      counts = JSON.parse(r.message) as typeof counts
    } catch {
      /* 报告失败的话下面会红 */
    }
    console.log(
      `  · ${String(i).padStart(2)} 分钟:宿主 tick ${counts.hostTicks} / 自己的 setInterval ${counts.selfTicks}`
    )
  }

  const elapsedMs = Date.now() - t0
  const win = pluginWindowOf('sbx-throttle')
  check('窗口全程是隐藏的', win ? win.isVisible() === false : false)

  const result = await host.runAction('sbx-throttle', 'report')
  const counts = JSON.parse(result.message) as { hostTicks: number; selfTicks: number; lastLate: number; hidden: string }
  const expected = Math.round(elapsedMs / 1000)
  const hostRatio = counts.hostTicks / expected
  const selfRatio = counts.selfTicks / expected

  console.log(
    `\n  期望 ≈${expected} 次;宿主 ${counts.hostTicks}(${(hostRatio * 100).toFixed(1)}%),` +
      `自己 ${counts.selfTicks}(${(selfRatio * 100).toFixed(1)}%),页面 visibilityState=${counts.hidden}`
  )

  check(
    `宿主调度器跨过节流台阶仍然不丢点(≥90% 的期望次数)`,
    hostRatio >= 0.9,
    `${(hostRatio * 100).toFixed(1)}%`
  )
  /**
   * 这里**不是** `hidden`,而是 `visible` —— 窗口明明没显示过。
   *
   * 原因是插件窗口开着 `backgroundThrottling: false`:Chromium 一旦不再节流这个
   * renderer,就把它当作"可见"页面。这条断言是一根**探针**:哪天有人把节流改回默认,
   * 这里会变回 `hidden`,而下面那条"作者自己的定时器也在跑"会跟着掉下去 ——
   * 两个现象一起变,才是"节流回来了"的样子。
   */
  check(
    "关掉后台节流之后页面自报 visible(窗口其实没显示)",
    counts.hidden === 'visible',
    counts.hidden
  )
  // 报告值:插件窗口关了后台节流,所以作者自己的 setInterval 也会跑满。
  // 只断言"它没停"(>50%),别拿它当节流生效的证据 —— 见文件头的说明。
  check(
    '作者自己的 setInterval 也在跑(窗口关掉了后台节流,这是尽力而为的止血带)',
    selfRatio > 0.5,
    `${(selfRatio * 100).toFixed(1)}%`
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
