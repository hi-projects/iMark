/**
 * 验收:正文与 H4/H5/H6 字号统一(H1–H3 保持标题梯度)。
 *
 * 规则(以正文字号 S 计):
 *   - 正文 = H4 = H5 = H6 = S(设置值就是实际 px);
 *   - H1 / H2 / H3 = 1.4545S / 1.2727S / 1.0909S(H1 : H4 = 2 : 1.375);
 *   - 设置面板「正文字号」显示的读数就是滑块值 S。
 *
 * 两个场景:正文字号 13px、改到 20px —— 验证比例关系而不是某一档硬编码。
 * 窗口全程不可见(show 替换 + run.mjs 的 IMARK_VERIFY_HIDDEN)。
 *
 * 跑法(仓库根目录,先 npm run build,改了 CSS/渲染层时必须重新 build):
 *   IMARK_VERIFY_HIDDEN=1 node verify/run.mjs heading-sizes
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'
import { IPC } from '../src/shared/ipc-channels'

// 特权 scheme 必须在 app ready 之前注册(与 src/main/index.ts 一致)
protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

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
const near = (a: number, b: number): boolean => Number.isFinite(a) && Math.abs(a - b) < 0.05

/** 验收窗口一律不显示:窗口照常创建与渲染,只是不出现在屏幕上 */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

type Sizes = {
  h1: number
  h2: number
  h3: number
  h4: number
  h5: number
  h6: number
  body: number
  bodyVar: string
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs heading-sizes` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'sizes.md')
  const source = [
    '# 一级标题',
    '',
    '## 二级标题',
    '',
    '### 三级标题',
    '',
    '#### 四级标题',
    '',
    '##### 五级标题',
    '',
    '###### 六级标题',
    '',
    '正文段落',
    ''
  ].join('\n')

  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, source, 'utf8')

  await loadSettings()
  await saveSettings({
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: note,
    openFiles: [note],
    editorFontSize: 13,
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false
  })

  await initExtensions({ appVersion: APP_VERSION })

  function evalJs<T>(win: BrowserWindow, code: string): Promise<T> {
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async function waitFor(win: BrowserWindow, code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(win, `(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(60)
    }
    return false
  }

  function measure(win: BrowserWindow): Promise<Sizes> {
    return evalJs<Sizes>(
      win,
      `(() => {
        const one = cls => document.querySelector('.' + cls)
        const bodyLine = [...document.querySelectorAll('.cm-line')]
          .find(el => el.textContent.includes('正文段落'))
        const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : NaN
        return {
          h1: px(one('cm-md-h1')),
          h2: px(one('cm-md-h2')),
          h3: px(one('cm-md-h3')),
          h4: px(one('cm-md-h4')),
          h5: px(one('cm-md-h5')),
          h6: px(one('cm-md-h6')),
          body: px(bodyLine),
          bodyVar: getComputedStyle(document.documentElement)
            .getPropertyValue('--editor-body-size').trim()
        }
      })()`
    )
  }

  async function openWindow(): Promise<BrowserWindow> {
    const win = createMainWindow(await loadSettings())
    win.webContents.setBackgroundThrottling(false)
    win.webContents.on('console-message', details => {
      if (details.level === 'error' || details.level === 'warning') {
        console.log(`     [渲染层 ${details.level}] ${details.message}`)
      }
    })
    await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()))
    await waitFor(win, `document.querySelector('.cm-md-h1') && document.querySelector('.cm-md-h6')`)
    return win
  }

  console.log('\n【A】正文字号 13px:正文 = H4–H6 = 13px,H1–H3 按标题梯度放大')
  {
    const win = await openWindow()
    const s = await measure(win)
    console.log(`     [实测] ${JSON.stringify(s)}`)
    const S = 13
    check(
      'H1 / H2 / H3 = 1.4545S / 1.2727S / 1.0909S',
      near(s.h1, S * 1.4545) && near(s.h2, S * 1.2727) && near(s.h3, S * 1.0909),
      JSON.stringify(s)
    )
    check('H4/H5/H6 与正文同为 13 px', near(s.h4, S) && near(s.h5, S) && near(s.h6, S) && near(s.body, S), JSON.stringify(s))

    win.webContents.send(IPC.MenuCommand, 'view:settings')
    await waitFor(win, `document.querySelector('.settings-nav-item')`)
    // 默认停在外观页,字号在「编辑器」页
    const switched = await evalJs<boolean>(
      win,
      `(() => {
        const nav = [...document.querySelectorAll('.settings-nav-item')]
          .find(el => el.textContent.trim() === '外观')
        if (!nav) return false
        nav.click()
        return true
      })()`
    )
    const readoutReady =
      switched &&
      (await waitFor(win, `document.querySelector('.settings-row-title')`)) &&
      (await waitFor(win, `document.querySelector('.settings-readout')`))
    const readout = readoutReady
      ? await evalJs<string | null>(
          win,
          `(() => {
            const row = [...document.querySelectorAll('.settings-row')]
              .find(r => r.textContent.includes('正文字号'))
            return row?.querySelector('.settings-readout')?.textContent?.trim() ?? null
          })()`
        )
      : null
    check('设置面板读数就是正文字号 13 px', readout === '13 px', String(readout))
    win.destroy()
    await sleep(250)
  }

  console.log('\n【B】把正文字号改到 20px:比例关系跟着走,H4–H6 仍与正文同大')
  {
    await saveSettings({ editorFontSize: 20 })
    const win = await openWindow()
    const s = await measure(win)
    console.log(`     [实测] ${JSON.stringify(s)}`)
    const S = 20
    check(
      'H1 / H2 / H3 = 1.4545S / 1.2727S / 1.0909S',
      near(s.h1, S * 1.4545) && near(s.h2, S * 1.2727) && near(s.h3, S * 1.0909),
      JSON.stringify(s)
    )
    check('H4/H5/H6 与正文同为 20 px', near(s.h4, S) && near(s.h5, S) && near(s.h6, S) && near(s.body, S), JSON.stringify(s))
    win.destroy()
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[heading-sizes] 未捕获异常:', err)
  app.exit(1)
})
