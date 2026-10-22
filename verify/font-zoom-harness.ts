/**
 * 验收:Ctrl + 滚轮调正文字号。
 *
 * 断言四件事:
 *   1. 按住 Ctrl 滚轮会改变 `--editor-font-size`,编辑器的计算字号跟着变;
 *   2. 不按 Ctrl 的滚轮完全放行,不动字号;
 *   3. 触控板式的小增量会先累计,攒够一格才走 1px;
 *   4. 调完的字号落盘,并且设置面板「编辑器 → 显示 → 正文字号」的滑块
 *      实时显示同一个值 —— 两处走的是同一份设置。
 *
 * 用合成的 WheelEvent 而不是 sendInputEvent:滚轮在这种无头环境里没有可用的
 * 坐标系,而这里要测的是「谁处理了这个事件」,合成事件能直接拿到 preventDefault
 * 的结果。事件里带 ctrlKey:true,正是 Chromium 用来表示「Ctrl + 滚轮」的字段。
 *
 * 跑法:node verify/run.mjs font-zoom
 *
 * ⚠️ 改了 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层页面走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'

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

interface FontState {
  /** 根元素上的 CSS 变量,如 "14px" */
  cssVar: string
  /** 编辑器正文实际算出来的字号(px) */
  computed: number
  /** 设置面板打开时滑块的当前值;没打开是 null */
  slider: number | null
  /** 设置面板打开时的字号读数文本;没打开是 null */
  readout: string | null
}

const STATE = `
(() => {
  const root = getComputedStyle(document.documentElement)
  const content = document.querySelector('.cm-content')
  const slider = document.querySelector('.settings-range[type="range"]')
  const readout = document.querySelector('.settings-readout')
  return {
    cssVar: root.getPropertyValue('--editor-font-size').trim(),
    computed: content ? parseFloat(getComputedStyle(content).fontSize) : -1,
    slider: slider ? Number(slider.value) : null,
    readout: readout ? readout.textContent.trim() : null
  }
})()
`

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
  const note = join(vault, '笔记.md')
  await writeFile(note, '# 标题\n\n正文\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: note,
        marketUrl: '',
        autoSave: false,
        editorFontSize: 13
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  await initExtensions({ appVersion: '0.1.0' })
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(2200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const state = (): Promise<FontState> => evalJs<FontState>(STATE)

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  /**
   * 在 window 上派发一个滚轮事件,返回它是否被处理方 preventDefault 了。
   * ctrlKey 就是浏览器/Electron 判断「Ctrl + 滚轮」的依据。
   */
  const wheel = (deltaY: number, ctrl = true): Promise<boolean> =>
    evalJs<boolean>(`
      (() => {
        const e = new WheelEvent('wheel', {
          deltaY: ${deltaY},
          ctrlKey: ${ctrl},
          bubbles: true,
          cancelable: true
        })
        window.dispatchEvent(e)
        return e.defaultPrevented
      })()`)

  const openEditorSettings = async (): Promise<boolean> => {
    await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
    if (!(await waitFor(`document.querySelector('.settings-nav-item')`))) return false
    await evalJs(`
      [...document.querySelectorAll('.settings-nav-item')]
        .find(b => b.textContent.trim() === '编辑器')
        ?.click()`)
    return waitFor(`document.querySelector('.settings-range[type="range"]')`)
  }

  console.log('\n[Ctrl + 滚轮:正文字号]')
  if (!(await waitFor(`document.querySelector('.cm-content')`))) {
    check('编辑器已就绪', false)
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }

  const initial = await state()
  check('初始字号 13px(来自 settings.json)', initial.cssVar === '13px' && initial.computed === 13, JSON.stringify(initial))

  // 1) Ctrl + 向上滚:放大 1px,并且拦下默认行为(页面缩放)
  const handledUp = await wheel(-100)
  await sleep(60)
  const afterUp = await state()
  check('Ctrl + 滚轮向上:字号 +1', afterUp.cssVar === '14px' && afterUp.computed === 14, JSON.stringify(afterUp))
  check('Ctrl + 滚轮事件被 preventDefault(不会触发页面缩放/滚动)', handledUp)

  // 2) 不按 Ctrl:完全不接管
  const handledPlain = await wheel(-100, false)
  await sleep(60)
  const afterPlain = await state()
  check('不按 Ctrl 的滚轮不动字号', afterPlain.cssVar === '14px', JSON.stringify(afterPlain))
  check('不按 Ctrl 的滚轮不 preventDefault', handledPlain === false)

  // 3) 触控板式小增量:4 × 10px 攒够一格才走 1px
  for (let i = 0; i < 4; i += 1) {
    await wheel(-10)
    await sleep(20)
  }
  await sleep(60)
  const afterAccum = await state()
  check('4 次 10px 的小增量累计成 1px(触控板不会一划跳到底)', afterAccum.cssVar === '15px', JSON.stringify(afterAccum))

  // 4) 一直放大:夹在上限 24px
  for (let i = 0; i < 30; i += 1) await wheel(-100)
  await sleep(80)
  const atMax = await state()
  check('放大到上限 24px 后不再增加', atMax.cssVar === '24px' && atMax.computed === 24, JSON.stringify(atMax))

  // 5) 设置面板显示的是同一个值(两处共用一份设置)
  const opened = await openEditorSettings()
  check('设置面板打开到「编辑器」页', opened)
  if (opened) {
    await sleep(200)
    const inPanel = await state()
    check(
      '面板滑块与读数显示 24px',
      inPanel.slider === 24 && inPanel.readout === '24 px',
      JSON.stringify(inPanel)
    )

    // 6) 面板打开时滚轮继续生效,滑块实时跟上
    await wheel(100)
    await sleep(80)
    const afterDownInPanel = await state()
    check(
      '面板打开时 Ctrl + 向下滚:字号 23,滑块同步',
      afterDownInPanel.cssVar === '23px' && afterDownInPanel.slider === 23,
      JSON.stringify(afterDownInPanel)
    )
  }

  // 7) 一直缩小:夹在下限 12px
  for (let i = 0; i < 30; i += 1) await wheel(100)
  await sleep(80)
  const atMin = await state()
  check('缩小到下限 12px 后不再减小', atMin.cssVar === '12px' && atMin.computed === 12, JSON.stringify(atMin))

  // 8) 停止滚动后落盘(250ms 防抖 + IPC),重读 settings.json
  await sleep(700)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as { editorFontSize?: number }
  check('停止滚动后字号写进 settings.json', saved.editorFontSize === 12, JSON.stringify(saved))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
