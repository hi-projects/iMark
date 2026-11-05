/**
 * 验收:占位列表标记(还没补内容)也要有列表上下的间距。
 *
 * CommonMark 里空的列表项不能打断段落:`正文\n1. ` 仍是同一段正文,没有
 * OrderedList 节点;`正文\n- ` 则被解析成 SetextHeading2。渲染层已经把这两种
 * 「占位」标记提前画成列表符号(见 list-marker 验收),但间距原来要等补上
 * 第一个字、真解析成列表才出现 —— 列表会在输入瞬间上下跳一下。
 *
 * 断言:
 *   A 真有序列表紧贴正文:`正文甲` 下 / `正文乙` 上各有 1 档留白(对照);
 *   B `正文甲` 下直接敲 `1. `:标记已画上,列表上方留白与 A 相同(16px);
 *   C 补上内容(`1. x`):留白仍是 16px,与 B 完全一致,没有跳一下;
 *   D 两段正文中间插入 `1. `(占位行后面还跟着同一段正文):上下留白都立刻生效,
 *     补字前后一致;
 *   E `- ` 与 `* ` 占位行同样带列表上方留白;
 *   F 空行之后的空列表项仍按结构空行收紧(回归,不受占位逻辑影响);
 *   G / H 真输入流程(文末、两段正文之间):回车 + `1. ` 立刻有留白,补字不来回跳。
 *
 * 跑法(仓库根目录,改了渲染层先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs list-spacing
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const BODY = 16
/** 默认 1 档:一个正文字号 */
const DEFAULT_GAP = BODY
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

interface Metrics {
  texts: string[]
  classes: string[]
  /** 正文甲行的 padding-bottom(列表上方留白) */
  beforePad: number
  /** 正文乙行的 padding-top(列表下方留白) */
  afterPad: number
  /** 结构空行的 line-height(按类名取) */
  gapLineHeight: number
  /** 占位标记 / 真标记的文本 */
  mark: string
  /** 圆点伪元素 content */
  bullet: string
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs list-spacing` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({ canceled: true })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '列表间距.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false,
        autoSaveMode: 'off',
        editorFontSize: BODY,
        editorFontSizeVersion: 2
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 6000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(900)
  }

  const metrics = (): Promise<Metrics> =>
    evalJs<Metrics>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const round = n => Math.round(n * 100) / 100
        const find = text => lines.find(el => el.textContent.includes(text)) || null
        const pad = (el, side) =>
          el ? round(parseFloat(getComputedStyle(el)['padding' + side])) : -1
        const markLine = lines.find(el => el.querySelector('.cm-md-listmark')) || null
        const mark = markLine ? markLine.querySelector('.cm-md-listmark') : null
        const bullet = markLine ? markLine.querySelector('.cm-md-listmark-bullet') : null
        const gapLine = lines.find(el => /cm-md-block-gap-list-before/.test(el.className)) || null
        return {
          texts: lines.map(el => el.textContent),
          classes: lines.map(el => el.className),
          beforePad: pad(find('正文甲'), 'Bottom'),
          afterPad: pad(find('正文乙'), 'Top'),
          gapLineHeight: gapLine ? round(parseFloat(getComputedStyle(gapLine).lineHeight)) : -1,
          mark: mark ? mark.textContent : '',
          bullet: bullet ? getComputedStyle(bullet, '::after').content : ''
        }
      })()`)

  const near = (a: number, b: number, tol = 0.6): boolean => Math.abs(a - b) <= tol

  /** sendInputEvent 只认 W3C 旧键名 */
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(160)
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  /** 合成输入会偶发丢字,没落进去就重新聚焦再打一次 */
  async function type(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(240)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)} —— 重新聚焦再打)`)
    }
  }

  // ---------- A ----------
  console.log('\n【A】真有序列表紧贴正文:上下各 1 档留白(对照)')
  await loadDoc('正文甲。\n1. 第一项\n2. 第二项\n正文乙。')
  await waitFor(`document.querySelector('.cm-md-gap-list-after')`)
  const real = await metrics()
  console.log(`     [实测] ${JSON.stringify(real)}`)
  check('列表上方留白 = 16px', near(real.beforePad, DEFAULT_GAP), String(real.beforePad))
  check('列表下方留白 = 16px', near(real.afterPad, DEFAULT_GAP), String(real.afterPad))
  check('有序标记 `1.` 正常显示', real.mark === '1.', JSON.stringify(real.mark))

  // ---------- B ----------
  console.log('\n【B】正文正下方敲 `1. `(还没内容):列表上方留白立刻就有')
  await loadDoc('正文甲。\n1. ')
  await waitFor(`document.querySelector('.cm-md-listmark')`)
  const pending = await metrics()
  console.log(`     [实测] ${JSON.stringify(pending)}`)
  check('占位有序标记已经画上', pending.mark === '1.', JSON.stringify(pending.mark))
  check(
    '占位状态下列表上方留白 = 16px(不再等补字)',
    near(pending.beforePad, DEFAULT_GAP),
    JSON.stringify({ beforePad: pending.beforePad, classes: pending.classes })
  )

  // ---------- C ----------
  console.log('\n【C】补上内容(`1. x`):留白与占位时完全一致,不跳一下')
  await loadDoc('正文甲。\n1. x')
  await waitFor(`document.querySelector('.cm-md-gap-list-before')`)
  const typed = await metrics()
  console.log(`     [实测] ${JSON.stringify(typed)}`)
  check('补字后列表上方留白仍是 16px', near(typed.beforePad, DEFAULT_GAP), String(typed.beforePad))
  check('补字前后行盒位置没有变化(留白数值相同)', near(typed.beforePad, pending.beforePad), JSON.stringify({ pending: pending.beforePad, typed: typed.beforePad }))
  check('补字后仍是有序标记', typed.mark === '1.', JSON.stringify(typed.mark))

  // ---------- D ----------
  console.log('\n【D】正文中间插入 `1. `(后面的行仍属同一段):上下留白都已生效')
  await loadDoc('正文甲。\n1. \n正文乙。')
  await waitFor(`document.querySelector('.cm-md-listmark')`)
  const middle = await metrics()
  console.log(`     [实测] ${JSON.stringify(middle)}`)
  check('段落中间的占位标记已画上', middle.mark === '1.', JSON.stringify(middle.mark))
  check('上方留白 = 16px', near(middle.beforePad, DEFAULT_GAP), String(middle.beforePad))
  check('下方留白 = 16px', near(middle.afterPad, DEFAULT_GAP), String(middle.afterPad))

  await loadDoc('正文甲。\n1. x\n正文乙。')
  await waitFor(`document.querySelector('.cm-md-gap-list-after')`)
  const middleTyped = await metrics()
  console.log(`     [实测] ${JSON.stringify(middleTyped)}`)
  check('补字后上方留白仍是 16px', near(middleTyped.beforePad, DEFAULT_GAP), String(middleTyped.beforePad))
  check('补字后下方留白仍是 16px', near(middleTyped.afterPad, DEFAULT_GAP), String(middleTyped.afterPad))
  check(
    '补字前后上下留白一致(不跳)',
    near(middleTyped.beforePad, middle.beforePad) && near(middleTyped.afterPad, middle.afterPad),
    JSON.stringify({ pending: [middle.beforePad, middle.afterPad], typed: [middleTyped.beforePad, middleTyped.afterPad] })
  )

  // ---------- E ----------
  console.log('\n【E】`- ` / `* ` 占位行同样带列表上方留白')
  await loadDoc('正文甲。\n- ')
  await waitFor(`document.querySelector('.cm-md-listmark-bullet')`)
  const dash = await metrics()
  console.log(`     [实测] ${JSON.stringify(dash)}`)
  check('`- ` 画成圆点', dash.bullet === '"•"', JSON.stringify(dash.bullet))
  check('`- ` 占位时上方留白 = 16px', near(dash.beforePad, DEFAULT_GAP), String(dash.beforePad))

  await loadDoc('正文甲。\n* ')
  await waitFor(`document.querySelector('.cm-md-listmark-bullet')`)
  const star = await metrics()
  console.log(`     [实测] ${JSON.stringify(star)}`)
  check('`* ` 画成圆点', star.bullet === '"•"', JSON.stringify(star.bullet))
  check('`* ` 占位时上方留白 = 16px', near(star.beforePad, DEFAULT_GAP), String(star.beforePad))

  // ---------- F ----------
  console.log('\n【F】回归:空行之后的空列表项按结构空行收紧')
  await loadDoc('正文甲。\n\n1. ')
  await waitFor(`document.querySelector('.cm-md-block-gap-list-before')`)
  const blank = await metrics()
  console.log(`     [实测] ${JSON.stringify(blank)}`)
  check('上一行不额外加 padding', near(blank.beforePad, 0), JSON.stringify(blank))
  check('结构空行按 1 档收紧(16px)', near(blank.gapLineHeight, DEFAULT_GAP), String(blank.gapLineHeight))

  // ---------- G ----------
  console.log('\n【G】真输入流程(文末):回车 + `1. `,再补字,间距不来回跳')
  await loadDoc('正文甲。')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
    return true
  })()`)
  await key('Enter')
  await type('1. ')
  await sleep(350)
  const beforeTyping = await metrics()
  console.log(`     [输入第一项文字前] ${JSON.stringify(beforeTyping)}`)
  check('输入第一项文字前标记已画上', beforeTyping.mark === '1.', JSON.stringify(beforeTyping.mark))
  // 回车 = 新段,列表和新段落之间隔着一条结构空行:留白落在空行上(和 F 一样),
  // 上一行不再额外加 padding。
  check('上一行不额外加 padding', near(beforeTyping.beforePad, 0), String(beforeTyping.beforePad))
  check(
    '输入第一项文字前上方留白已生效(16px)',
    near(beforeTyping.gapLineHeight, DEFAULT_GAP),
    String(beforeTyping.gapLineHeight)
  )
  await type('x')
  await sleep(350)
  const afterTyping = await metrics()
  console.log(`     [补上 x 之后] ${JSON.stringify(afterTyping)}`)
  check('补字后上方留白不变(16px)', near(afterTyping.gapLineHeight, DEFAULT_GAP), String(afterTyping.gapLineHeight))

  // ---------- H ----------
  console.log('\n【H】真输入流程(两段正文之间):光标落在空行上敲 `1. ` 立刻有上下留白')
  // 回车现在按「新段」补空行,这条要验的是「空行上直接输入列表标记」的瞬时观感,
  // 所以把光标直接放到两段之间的空行上,别让回车再插一条空行。
  await loadDoc('正文甲。\n\n正文乙。')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
    view.focus()
    return true
  })()`)
  await type('1. ')
  await sleep(350)
  const inserted = await metrics()
  console.log(`     [输入第一项文字前] ${JSON.stringify(inserted)}`)
  check(
    '两段之间是「正文甲 / `1. ` / 正文乙」三行',
    inserted.texts.join('|') === '正文甲。|1. |正文乙。',
    JSON.stringify(inserted.texts)
  )
  check('占位标记已画上', inserted.mark === '1.', JSON.stringify(inserted.mark))
  check('列表上方留白已生效(16px)', near(inserted.beforePad, DEFAULT_GAP), String(inserted.beforePad))
  check('列表下方留白已生效(16px)', near(inserted.afterPad, DEFAULT_GAP), String(inserted.afterPad))

  await type('x')
  await sleep(350)
  const insertedTyped = await metrics()
  console.log(`     [补上 x 之后] ${JSON.stringify(insertedTyped)}`)
  check('补字后上方留白不变(16px)', near(insertedTyped.beforePad, DEFAULT_GAP), String(insertedTyped.beforePad))
  check('补字后下方留白不变(16px)', near(insertedTyped.afterPad, DEFAULT_GAP), String(insertedTyped.afterPad))

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
