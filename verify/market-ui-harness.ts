/**
 * 验收:市场页 / 已安装列表 / 扩展设置页的渲染。
 *
 * 不开真实市场服务端:这里只回答「市场界面能不能把 ExtensionView 画出来、
 * 离线时会不会崩」。安装/校验/发布路径由 market-package 与 install-confirm 覆盖。
 *
 * 跑法:node verify/run.mjs market-ui
 */

import { app, BrowserWindow, dialog } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }
  await app.whenReady()
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await rm(vault, { recursive: true, force: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  const note = join(vault, '笔记.md')
  await writeFile(note, '# 市场 UI\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        // 空地址:浏览页会立刻给出「没有设置市场地址」,不会真的打网络
        marketUrl: ''
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)

  const win: BrowserWindow = createMainWindow(settings)
  service.setRendererSender(message => {
    if (!win.isDestroyed()) win.webContents.send(IPC.ExtensionToRenderer, message)
  })
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  console.log('\n[A] 打开设置 → 浏览市场 → 已安装')
  const opened = await evalJs<boolean>(`(() => {
    const b = document.querySelector('button[title^="设置"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('设置面板打开了', opened && (await waitFor(`document.querySelector('.settings-nav')`)))

  const onMarket = await evalJs<boolean>(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('市场页入口可点', onMarket && (await waitFor(`document.querySelector('.market-page')`)))

  const installedTab = await evalJs<boolean>(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '已安装')
    if (!t) return false
    t.click()
    return true
  })()`)
  check('已安装页签可点', installedTab)
  check('五款内置扩展出现在列表里', await waitFor(`document.querySelectorAll('.market-row').length === 5`))

  const rows = await evalJs<{ name: string; badges: string[]; hasSha: boolean }[]>(`
    [...document.querySelectorAll('.market-row')].map(row => ({
      name: row.querySelector('.market-row-name b')?.textContent?.trim() ?? '',
      badges: [...row.querySelectorAll('.market-badge')].map(b => b.textContent.trim()),
      hasSha: !!row.querySelector('.market-hash-chip')
    }))`)
  check('每行都有含代码/纯声明徽标与来源', rows.every(r => r.badges.some(b => b === '含代码' || b === '纯声明') && r.badges.some(b => b.includes('内置'))), JSON.stringify(rows))
  check('每行都有安装 sha256', rows.every(r => r.hasSha), JSON.stringify(rows))
  check(
    'quick-edit 默认启用、git-sync 默认停用',
    rows.some(r => r.name.includes('快速编辑') && !r.badges.includes('已停用')) &&
      rows.some(r => r.name.includes('Git') && r.badges.includes('已停用')),
    JSON.stringify(rows)
  )
  check(
    'Agent Core 与 Claude Code 都已装上且默认停用',
    rows.some(r => r.name.includes('Agent Core') && r.badges.includes('已停用')) &&
      rows.some(r => r.name === 'Claude Code' && r.badges.includes('已停用')),
    JSON.stringify(rows)
  )

  console.log('\n[B] 浏览市场:离线提示,不崩')
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '浏览市场')
    if (t) t.click()
  })()`)
  check('浏览页出现错误条而不是白屏', await waitFor(`document.querySelector('.market-banner-error')?.textContent?.includes('市场地址')`), await evalJs<string>(`document.querySelector('.market-banner-error')?.textContent ?? ''`))

  console.log('\n[C] 发布页:三个区块都渲染')
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '发布插件')
    if (t) t.click()
  })()`)
  const publishText = await waitFor(`document.querySelectorAll('.market-block-title').length >= 3`)
  const titles = await evalJs<string[]>(`[...document.querySelectorAll('.market-block-title')].map(h => h.textContent.trim())`)
  check('发布页三个区块齐全', publishText && titles.some(t => t.includes('市场地址')) && titles.some(t => t.includes('账号')) && titles.some(t => t.includes('打包与发布')), JSON.stringify(titles))

  console.log('\n[D] 扩展设置页')
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '已安装')
    if (t) t.click()
  })()`)
  await waitFor(`document.querySelectorAll('.market-row').length === 5`)
  const toSettings = await evalJs<boolean>(`(() => {
    const row = [...document.querySelectorAll('.market-row')].find(r => r.textContent.includes('快速编辑'))
    const b = row ? [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '设置') : null
    if (!b) return false
    b.click()
    return true
  })()`)
  check('从已安装行进入扩展设置', toSettings)
  check('设置页显示扩展名与启用开关', await waitFor(`document.querySelector('.plugin-detail-version') && document.querySelector('.plugin-switch')`))
  const detailText = await evalJs<string>(`document.querySelector('.settings-main')?.innerText ?? ''`)
  const detailSections = await evalJs<string[]>(
    `[...document.querySelectorAll('.plugin-group-title')].map(h => h.textContent.trim())`
  )
  check(
    '设置页保留能力声明，宿主区已移出',
    detailText.includes('能力声明') && !detailSections.includes('扩展宿主'),
    JSON.stringify(detailSections)
  )

  console.log('\n[E] 扩展宿主页签:集中管理全部插件')
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (b) b.click()
  })()`)
  await waitFor(`document.querySelector('.market-page')`)
  const hostsTab = await evalJs<boolean>(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '扩展宿主')
    if (!t) return false
    t.click()
    return true
  })()`)
  check('扩展宿主页签可点', hostsTab)
  check(
    '宿主面板渲染出来',
    await waitFor(
      `document.querySelector('.market-hosts') &&
       document.querySelector('.market-host-mode') &&
       document.querySelector('.market-host-groups .market-host-card')`
    )
  )
  check(
    '右侧标题为「扩展宿主」',
    await waitFor(`document.querySelector('.settings-main-header h1')?.textContent?.trim() === '扩展宿主'`)
  )
  const hostPanel = await evalJs<{
    modeButtons: string[]
    text: string
    quickEditInHost: boolean
    quickEditReload: boolean
    hostCardsWithoutReload: number
    pausedText: string
    pausedAffinity: number
  }>(`(() => {
    const cards = [...document.querySelectorAll('.market-host-groups .market-host-card')]
    const card = cards.find(c => c.textContent.includes('快速编辑'))
    const paused = document.querySelector('.market-host-paused')
    return {
      modeButtons: [...document.querySelectorAll('.market-host-mode .settings-preset')]
        .map(b => b.textContent.trim()),
      text: document.querySelector('.market-hosts')?.innerText ?? '',
      quickEditInHost: !!card,
      quickEditReload: card
        ? !!card.querySelector('.plugin-icon-btn[title^="重新加载这个宿主"]')
        : false,
      hostCardsWithoutReload: cards.filter(c => !c.querySelector('.plugin-icon-btn[title^="重新加载这个宿主"]')).length,
      pausedText: paused?.textContent ?? '',
      pausedAffinity: paused ? paused.querySelectorAll('input.settings-number').length : -1
    }
  })()`)
  check(
    '模式切换按钮齐全',
    hostPanel.modeButtons.includes('每扩展独立进程') && hostPanel.modeButtons.includes('共享宿主'),
    JSON.stringify(hostPanel.modeButtons)
  )
  check('面板说明分组编号规则', hostPanel.text.includes('分组编号'))
  check(
    '快速编辑出现在宿主卡里，每张宿主卡都有重载按钮',
    hostPanel.quickEditInHost && hostPanel.quickEditReload && hostPanel.hostCardsWithoutReload === 0
  )
  check(
    '未分配宿主区列出已停用的内置插件',
    hostPanel.pausedText.includes('定时上传（Git）') && hostPanel.pausedText.includes('已停用'),
    hostPanel.pausedText.slice(0, 120)
  )
  check(
    '已停用的含代码插件仍可预设分组编号',
    hostPanel.pausedAffinity >= 3,
    String(hostPanel.pausedAffinity)
  )

  // 只动**已停用**插件的编号:它不在宿主计划的候选集里,不会拉起或重启任何进程。
  // 这一段验证的是「输入 → 设置写盘 → 输入框按规范值回写」的完整回路。
  const setPausedAffinity = (value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const paused = document.querySelector('.market-host-paused')
      const row = paused
        ? [...paused.querySelectorAll('.market-host-row')].find(r => r.textContent.includes('定时上传（Git）'))
        : null
      const input = row?.querySelector('input.settings-number')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)

  interface HostSettingsFile {
    mode?: string
    affinity?: Record<string, number>
  }
  const readHostSettings = async (): Promise<HostSettingsFile> => {
    const json = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as {
      extensionHost?: HostSettingsFile
    }
    return json.extensionHost ?? {}
  }

  check('能给停用的代码插件填编号', await setPausedAffinity('7'))
  await sleep(500)
  check(
    '编号写进 settings.extensionHost.affinity',
    (await readHostSettings()).affinity?.['imark.git-sync'] === 7,
    JSON.stringify(await readHostSettings())
  )
  check('清空编号', await setPausedAffinity(''))
  await sleep(500)
  check(
    '清空 = 删除编号（按模式自动分组）',
    !('imark.git-sync' in ((await readHostSettings()).affinity ?? {})),
    JSON.stringify(await readHostSettings())
  )

  // quick-edit 是懒激活(onCommand),此刻宿主没启动,切换模式不会真的拉起进程;
  // 这里只验证按钮 → 设置写盘 → 再切回来的回路。
  const setMode = (label: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const b = [...document.querySelectorAll('.market-host-mode .settings-preset')]
        .find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return false
      b.click()
      return true
    })()`)
  check('能切换为共享宿主', await setMode('共享宿主'))
  await sleep(500)
  check('模式写进设置', (await readHostSettings()).mode === 'shared', JSON.stringify(await readHostSettings()))
  check('能切回每扩展独立进程', await setMode('每扩展独立进程'))
  await sleep(500)
  check('模式切回 isolated', (await readHostSettings()).mode === 'isolated', JSON.stringify(await readHostSettings()))

  console.log('\n[F] 卸载确认是两段式')
  // 先回市场页(刚才在某个扩展的设置页里)
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (b) b.click()
  })()`)
  await waitFor(`document.querySelector('.market-page')`)
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '已安装')
    if (t) t.click()
  })()`)
  await waitFor(`document.querySelectorAll('.market-row').length === 5`)
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('.market-row')].find(r => r.textContent.includes('快速编辑'))
    const b = row ? row.querySelector('button[title="卸载"]') : null
    if (b) b.click()
  })()`)
  check(
    '卸载要先展开确认,并说清会删配置与密钥',
    await waitFor(`document.querySelector('.market-row-confirm')?.textContent?.includes('配置、密钥')`),
    await evalJs<string>(`document.querySelector('.market-row-confirm')?.textContent ?? ''`)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
