/**
 * 验收:市场页 / 已安装列表 / 扩展设置页在 v2 数据下的渲染。
 *
 * 不开真实市场服务端:这里只回答「重写后的市场界面能不能把 ExtensionView 画出来、
 * 离线时会不会崩」。安装/校验/发布路径由 market-v2 与 install-confirm 覆盖。
 *
 * 跑法:node verify/run.mjs market-ui
 */

import { app, BrowserWindow, dialog } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
  const service = await initExtensions({ appVersion: '0.1.0' })
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
  check('四款内置扩展出现在列表里', await waitFor(`document.querySelectorAll('.market-row').length === 4`))

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
  await waitFor(`document.querySelectorAll('.market-row').length === 4`)
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
  check(
    '设置页展示宿主分组与能力声明(v2)',
    detailText.includes('扩展宿主') && detailText.includes('能力声明'),
    detailText.slice(0, 200)
  )

  console.log('\n[E] 卸载确认是两段式')
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
  await waitFor(`document.querySelectorAll('.market-row').length === 4`)
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
