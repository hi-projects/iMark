/**
 * 验收:插件详情页去掉了「下载前请核对」整块。
 *
 * 用户的原话:「去掉插件详情,图中所示部分内容」—— 指的是详情页底部那块
 * 「版本号 · 完整 sha256」+「复制」按钮 + 一段说明。整包摘要仍在「版本」
 * 列表的 sha256 小按钮与安装确认框里可查,详情页不再重复一遍。
 *
 * 这个 harness 只断言「该走的走了、该留的还在」:如果哪天有人把整块加回来,
 * 或者顺手把版本列表里的 sha256 也删了,这里会红。
 *
 * 依赖本机 market server(`node server/index.mjs`,默认 127.0.0.1:8787)且至少
 * 有一个已发布的包。
 *
 * 跑法:node verify/run.mjs market-detail
 *
 * ⚠️ 改了 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层页面走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'

registerPluginScheme()

const MARKET_URL = 'http://127.0.0.1:8787'

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
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, '笔记.md'), 'hello world\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '笔记.md'),
        autoSave: false,
        marketUrl: MARKET_URL
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned)

  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 6000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  console.log('\n[准备] 打开设置 → 浏览市场')
  const settingsBtn = await evalJs<boolean>(`(() => {
    const b = document.querySelector('button[title^="设置"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  const opened = settingsBtn && (await waitFor(`document.querySelector('.settings-nav')`))
  check('设置面板打开了', opened)
  if (!opened) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }

  const onMarket = await evalJs<boolean>(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('打开了市场页', onMarket)

  const listed = await waitFor(`document.querySelectorAll('.market-card').length >= 1`, 10_000)
  check('市场列出了插件', listed)
  if (!listed) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }

  // ---------- 进入第一张卡片的详情 ----------
  console.log('\n[一] 打开插件详情')
  await evalJs(`(() => {
    const card = document.querySelector('.market-card')
    if (card) card.click()
    return !!card
  })()`)
  const inDetail = await waitFor(`document.querySelector('.market-detail-head')`, 6000)
  check('详情页打开了', inDetail)
  if (!inDetail) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }

  const blocks = await evalJs<string[]>(
    `[...document.querySelectorAll('.market-block-title')].map(h => h.textContent.trim())`
  )

  // ---------- 1. 被删掉的那块确实不在了 ----------
  console.log('\n[二] 「下载前请核对」整块已移除')
  check(
    '详情页没有「下载前请核对」小节',
    !blocks.some(t => t.includes('下载前请核对')),
    JSON.stringify(blocks)
  )
  check(
    '详情页没有整包摘要框(版本号 · 完整 sha256 + 复制)',
    await evalJs<boolean>(`document.querySelectorAll('.market-tab-body .market-hash').length === 0`)
  )

  // ---------- 2. 详情页该有的部分都还在 ----------
  console.log('\n[三] 其余内容未受影响')
  check('「权限」小节还在', blocks.some(t => t.includes('权限')), JSON.stringify(blocks))
  check(
    '「版本」小节还在',
    blocks.some(t => t.includes('版本')),
    JSON.stringify(blocks)
  )
  // 整包摘要没有真的消失:它仍挂在版本列表的 sha256 小按钮上
  const chips = await evalJs<number>(`document.querySelectorAll('.market-hash-chip').length`)
  check('版本列表里仍可查 sha256', chips >= 1, `按钮数 ${chips}`)

  await evalJs(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  await mkdir(join(__dirname, '..', '..', '.verify-ud', 'shots'), { recursive: true })
  await writeFile(
    join(__dirname, '..', '..', '.verify-ud', 'shots', 'market-detail.png'),
    (await wc.capturePage()).toPNG()
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
