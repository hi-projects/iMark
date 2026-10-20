/**
 * 验收:市场搜索的两个回归。
 *
 *   1. 按作者搜 —— 清单里的 `author`(iMark)也算搜索范围,不是只搜 id/名称/描述;
 *   2. 清空搜索框立即回到全量列表,不需要再按一次回车。
 *
 * 依赖本机 market server(`node server/index.mjs`,默认 127.0.0.1:8787),且里面
 * 至少有一个名称含「advanced」、作者为 iMark 的包,总数 ≥2。
 *
 * 跑法:node verify/run.mjs market-search
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

  const cardCount = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.market-card').length`)

  const cardNames = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('.market-card .market-card-name b')].map(b => b.textContent.trim())`
    )

  /** 往搜索框里写值并触发 v-model;不按回车 */
  async function setQuery(value: string): Promise<void> {
    await evalJs(`(() => {
      const input = document.querySelector('.market-search input')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(50)
  }

  async function pressEnter(): Promise<void> {
    await evalJs(`(() => {
      const input = document.querySelector('.market-search input')
      if (!input) return false
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
      return true
    })()`)
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

  // 从详情/已安装切回来时页签可能停在别处,显式点一次「浏览市场」
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')]
      .find(b => b.textContent.trim() === '浏览市场')
    if (t && !t.classList.contains('market-tab-active')) t.click()
  })()`)

  const initial = await waitFor(`document.querySelectorAll('.market-card').length >= 2`, 10_000)
  const initialCount = await cardCount()
  check(
    '市场连上了,并且列出了全量插件',
    initial && initialCount >= 2,
    `卡片数 ${initialCount}(市场地址 ${MARKET_URL})`
  )
  if (!initial) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }

  // ---------- 1. 按名称搜索(回归:别把原有能力弄坏) ----------
  console.log('\n[一] 按名称搜索')
  await setQuery('advanced')
  await pressEnter()
  const byName = await waitFor(`document.querySelectorAll('.market-card').length === 1`, 6000)
  const nameHits = await cardNames()
  check(
    '搜索 advanced 只返回 Advanced Table',
    byName && nameHits.length === 1 && nameHits[0].includes('Advanced Table'),
    JSON.stringify(nameHits)
  )

  // ---------- 2. 按作者搜索 ----------
  console.log('\n[二] 按作者搜索')
  await setQuery('iMark')
  await pressEnter()
  // 搜索前是 1 张,变成全量才说明这一轮真的按作者命中了
  const byAuthor = await waitFor(`document.querySelectorAll('.market-card').length >= 2`, 6000)
  const authorHits = await cardNames()
  check(
    '搜索 iMark(作者)能返回其名下的插件',
    byAuthor && authorHits.length >= 2,
    JSON.stringify(authorHits)
  )

  // ---------- 3. 清空立即回到全量 ----------
  console.log('\n[三] 清空搜索框')
  await setQuery('advanced')
  await pressEnter()
  const narrowed = await waitFor(`document.querySelectorAll('.market-card').length === 1`, 6000)
  check('前提:先收窄到 1 张卡片', narrowed)

  // 只触发 input(v-model),不按回车
  await setQuery('')
  const cleared = await waitFor(`document.querySelectorAll('.market-card').length >= 2`, 6000)
  const clearedCount = await cardCount()
  check(
    '清空后无需回车即回到全量列表',
    cleared && clearedCount >= 2,
    `卡片数 ${clearedCount}`
  )

  await evalJs(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  await mkdir(join(__dirname, '..', '..', '.verify-ud', 'shots'), { recursive: true })
  await writeFile(
    join(__dirname, '..', '..', '.verify-ud', 'shots', 'market-search.png'),
    (await wc.capturePage()).toPNG()
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
