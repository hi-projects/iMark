/**
 * 阶段三冒烟:一个**真装进来的**沙箱插件能不能起来、能不能通过窗口调宿主能力。
 *
 * 这是 phase3-harness 的探路版本:先把"协议、会话、窗口、preload、RPC、闸门"
 * 这条链子跑通,再往上堆权限/路径/网络的细粒度断言。
 *
 * 跑法:node verify/run.mjs phase3-smoke
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerPluginScheme } from '../src/main/plugins/windows'
import { initPluginHost } from '../src/main/plugins/host'
import { pluginDir, setRecord } from '../src/main/plugins/installed'

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

// **必须在这里调,不能在 main() 里**:registerSchemesAsPrivileged 只在 app ready
// 之前有效,晚了就永远拿不到 standard/secure 那些特权 —— 表现是插件页里
// 同源的 `<script src>` 被 `script-src 'self'` 拦掉(因为那个 origin 根本不存在)
registerPluginScheme()

/** 一个纯后台的沙箱插件:不开自己的窗口,但要把能力调一遍 */
const MAIN_JS = `
const results = {}
window.imark.plugin.handle({
  async onEnable() {
    results.hello = true
    // ① 身份
    results.id = window.imark.plugin.id
    // ② 不要权限的能力(应该都能用)
    try {
      await window.imark.document.flush()
      results.flush = 'ok'
    } catch (e) { results.flush = 'err:' + e.message }
    // ③ vault:read —— 清单里声明了,应该能读
    try {
      results.vaultPath = await window.imark.vault.path()
      results.vaultRead = (await window.imark.vault.read('笔记.md')).text.trim()
    } catch (e) { results.vaultRead = 'err:' + e.message }
    // ④ 没声明的能力:命名空间压根不该存在
    results.hasGit = typeof window.imark.git
    results.hasSecrets = typeof window.imark.secrets
    results.hasWindowApi = typeof window.imark.window
    // ⑤ 沙箱事实:没有 node、没有 require、CSP 拦网络
    results.typeofRequire = typeof require
    results.typeofProcess = typeof process
    try {
      await fetch('https://example.com/')
      results.netRaw = 'ok'
    } catch (e) { results.netRaw = 'blocked' }
    // ⑥ 界面槽位(不要权限)
    window.imark.ui.statusItem({ id: 'smoke', label: '冒烟' })
    window.imark.setState({ status: 'ok', lastMessage: 'ready' })
  },
  runAction(actionId) {
    if (actionId === 'report') return { ok: true, message: JSON.stringify(results) }
    return { ok: false, message: 'unknown action: ' + actionId }
  }
})
`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs phase3-smoke` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, '笔记.md'), '# 笔记\n', 'utf8')

  // 造一个沙箱插件并按"已安装"落盘(磁盘是权威:有目录 + 合法清单就算装上了)
  const dir = pluginDir('sbx-smoke')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id: 'sbx-smoke',
        name: '冒烟沙箱插件',
        description: '验收用',
        version: '1.0.0',
        kind: 'sandboxed',
        main: 'main.js',
        permissions: ['vault:read'],
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
    id: 'sbx-smoke',
    version: '1.0.0',
    kind: 'sandboxed',
    integrity: 'x'.repeat(64),
    mainSha256: null,
    publisher: null,
    source: 'local',
    registryUrl: null,
    installedAt: Date.now(),
    grantedPermissions: ['vault:read']
  })

  // 启用态与仓库路径写进 settings.json(与真实用户的形状一致)
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        autoSave: false,
        marketUrl: '',
        plugins: { 'sbx-smoke': { enabled: true, config: {} } }
      },
      null,
      2
    ),
    'utf8'
  )

  const host = await initPluginHost()

  console.log('\n[A] 窗口与运行时')
  const { pluginWindowOf } = await import('../src/main/plugins/windows')
  await sleep(2500)
  const win = pluginWindowOf('sbx-smoke')
  check('沙箱插件建出了自己的窗口', win !== null)
  if (win) {
    check('窗口是隐藏的(纯后台插件)', win.isVisible() === false)
    check('窗口不进任务栏', win.isVisible() === false)
    const wc = win.webContents
    check('页面就是宿主的执行器页面', wc.getURL().includes('__imark/exec.html'), wc.getURL())
  }

  console.log('\n[B] 页面里的探针')
  const result = await host.runAction('sbx-smoke', 'report')
  check('runAction 走通了(宿主 → 页面 → 宿主)', result.ok, result.message)
  let probes: Record<string, string> = {}
  try {
    probes = JSON.parse(result.message) as Record<string, string>
  } catch {
    /* 下面每条都会红,足够说明问题 */
  }
  check('页面收到了 hello 之外的东西:onEnable 跑过', probes.hello === true)
  check('页面知道自己的 id', probes.id === 'sbx-smoke', String(probes.id))
  check('document.flush 可用(不要权限)', probes.flush === 'ok', String(probes.flush))
  check('vault:read 声明了就能读仓库文件', probes.vaultRead === '# 笔记', String(probes.vaultRead))
  check('未声明的 git 命名空间不存在', probes.hasGit === 'undefined', String(probes.hasGit))
  check('未声明的 secrets 命名空间不存在', probes.hasSecrets === 'undefined', String(probes.hasSecrets))
  check('未声明的 window 命名空间不存在', probes.hasWindowApi === 'undefined', String(probes.hasWindowApi))
  check('页面里没有 require(不是 Node 环境)', probes.typeofRequire === 'undefined', String(probes.typeofRequire))
  check('页面里没有 process', probes.typeofProcess === 'undefined', String(probes.typeofProcess))
  check('CSP 掐死了裸 fetch', probes.netRaw === 'blocked', String(probes.netRaw))

  console.log('\n[C] 停用与窗口')
  await host.save('sbx-smoke', { enabled: false })
  const t0 = Date.now()
  while (pluginWindowOf('sbx-smoke') && Date.now() - t0 < 3000) await sleep(50)
  check('停用后窗口在 2 秒内消失', pluginWindowOf('sbx-smoke') === null, `${Date.now() - t0}ms`)

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
