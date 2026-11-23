/**
 * 验收:调「行间距」不再改变段与段之间的距离。
 *
 * 用户报告:在设置 → 外观里把行间距从 0.6 档调到 1.4 档,两段正文之间的
 * 距离也跟着变大 —— 行间距本该只管「同一段里行与行之间」。
 *
 * 行高的模型是 行盒 = (1 + 行间距档) × 字号,多出来的那一份在文字上下各分
 * 一半。段落首行 / 末行也会分到这两半,于是调行间距就把段间距一起推大。
 * 现在从段间距空行的高度里扣掉这一份,断言:
 *   · 0.6 / 1.0 / 1.4 档下,两段正文的文字距离保持不变;
 *   · 段间距空行的高度随之反向变化(行间距大 → 空行矮);
 *   · 默认 1 档时空行高度仍是「段间距」那一档(不改变现有观感);
 *   · 同一段内行与行之间的距离仍然随行间距变大(功能没丢);
 *   · 「段间距」滑块照常改变段与段的距离。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs line-space-gap
 */

import { app, dialog, protocol } from 'electron'
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

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 两段正文 + 一条段间距空行 */
const PARAS = '第一段正文。\n\n第二段正文。\n\n第三段正文。\n'
/** 同一个段落里的三行(源码行首尾相接,没有空行) */
const LINES = '同一段第一行\n同一段第二行\n同一段第三行\n'

interface Metrics {
  /** 相邻依次两段文字之间的空白:上一段文字底 → 下一段文字顶 */
  gaps: number[]
  /** 每条段间距空行的实际高度 */
  gapHeights: number[]
  /** 同一段内相邻两行文字的行距(上一行文字顶 → 下一行文字顶) */
  advances: number[]
  /** 文字字形盒的高度(随字体固定,不随行高变) */
  lineHeights: number[]
  /** 每一行行盒的高度(= (1+行间距档)×字号) */
  boxHeights: number[]
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs line-space-gap` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '测试.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, PARAS, 'utf8')
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
        lineWrapping: false,
        editorFontSize: 16,
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

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1100)
    await focusEditor()
  }

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} } })
      view.focus()
      return true
    })()`)
    await sleep(120)
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(250)
  }

  /** 改根元素上的档位变量(与设置面板写的是同一组变量) */
  async function setVars(lineSpace: number, bodyBetween: number): Promise<void> {
    await evalJs(`(() => {
      const root = document.documentElement
      root.style.setProperty('--editor-line-space', '${lineSpace}')
      root.style.setProperty('--md-body-space-between', '${bodyBetween}')
      return true
    })()`)
    await sleep(250)
  }

  const metrics = (): Promise<Metrics> =>
    evalJs<Metrics>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const textLines = []
        for (const el of lines) {
          const range = document.createRange()
          range.selectNodeContents(el)
          const r = range.getBoundingClientRect()
          if ((el.textContent || '').trim() && r.height > 0) textLines.push({ el, r })
        }
        const gaps = []
        for (let i = 1; i < textLines.length; i++) {
          gaps.push(Math.round((textLines[i].r.top - textLines[i - 1].r.bottom) * 100) / 100)
        }
        const advances = []
        for (let i = 1; i < textLines.length; i++) {
          advances.push(Math.round((textLines[i].r.top - textLines[i - 1].r.top) * 100) / 100)
        }
        const gapHeights = lines
          .filter(el => el.classList.contains('cm-md-block-gap-body'))
          .map(el => Math.round(el.getBoundingClientRect().height * 100) / 100)
        const lineHeights = textLines.map(t => Math.round(t.r.height * 100) / 100)
        const boxHeights = textLines.map(t => Math.round(t.el.getBoundingClientRect().height * 100) / 100)
        return { gaps, gapHeights, advances, lineHeights, boxHeights }
      })()`)

  const near = (a: number, b: number, tol = 1.5): boolean => Math.abs(a - b) <= tol
  const fmt = (m: Metrics): string => JSON.stringify(m)

  // ---------- 1. 两段正文之间:行间距变了,段距离不变 ----------

  console.log('\n【1】调行间距:两段正文之间的文字距离保持不变')
  await loadDoc(PARAS)
  await setVars(1, 1)
  const base = await metrics()
  console.log(`     [1.0 档] ${fmt(base)}`)
  check(
    '默认 1 档:段间距空行 = 1 档(16px)',
    base.gapHeights.every(h => near(h, 16)),
    fmt(base)
  )
  check('默认 1 档:两段文字之间有留白', base.gaps.length === 2 && base.gaps.every(g => g > 0), fmt(base))

  await setVars(0.6, 1)
  const small = await metrics()
  console.log(`     [0.6 档] ${fmt(small)}`)
  check(
    '0.6 档:段与段的文字距离与 1 档相同',
    small.gaps.length === base.gaps.length && small.gaps.every((g, i) => near(g, base.gaps[i])),
    fmt({ base: base.gaps, small: small.gaps })
  )
  check(
    '0.6 档:段间距空行高度不变(行间距不再参与段距)',
    small.gapHeights.every((h, i) => near(h, base.gapHeights[i])),
    fmt({ base: base.gapHeights, small: small.gapHeights })
  )

  await setVars(1.4, 1)
  const large = await metrics()
  console.log(`     [1.4 档] ${fmt(large)}`)
  check(
    '1.4 档:段与段的文字距离仍与 1 档相同',
    large.gaps.length === base.gaps.length && large.gaps.every((g, i) => near(g, base.gaps[i])),
    fmt({ base: base.gaps, large: large.gaps })
  )
  check(
    '1.4 档:段间距空行高度不变',
    large.gapHeights.every((h, i) => near(h, base.gapHeights[i])),
    fmt({ base: base.gapHeights, large: large.gapHeights })
  )

  // ---------- 2. 段间距滑块仍能拉开两段 ----------

  console.log('\n【2】「段间距」滑块照常改变段与段的距离')
  await setVars(1, 2)
  const body2 = await metrics()
  console.log(`     [段间距 2 档] ${fmt(body2)}`)
  check(
    '段间距 2 档:空行高度翻倍(32px)',
    body2.gapHeights.every(h => near(h, 32)),
    fmt(body2.gapHeights)
  )
  check(
    '段间距 2 档:两段文字之间的距离相应变大',
    body2.gaps.every((g, i) => near(g, base.gaps[i] + 16)),
    fmt({ base: base.gaps, body2: body2.gaps })
  )

  // ---------- 3. 同一段内的行距仍随行间距变化 ----------

  console.log('\n【3】同一段内行与行之间:行间距照常生效')
  await loadDoc(LINES)
  await setVars(0.6, 1)
  const tight = await metrics()
  console.log(`     [段内 0.6 档] ${fmt(tight)}`)
  await setVars(1.4, 1)
  const loose = await metrics()
  console.log(`     [段内 1.4 档] ${fmt(loose)}`)
  check(
    '段内行距随行间距变大(0.6 → 1.4)',
    tight.advances.length > 0 &&
      loose.advances.length === tight.advances.length &&
      loose.advances.every((a, i) => a > tight.advances[i] + 4),
    fmt({ tight: tight.advances, loose: loose.advances })
  )
  check(
    '段内行盒高度按 (1+档)×字号 变化(段落首尾行按边裁切)',
    near(tight.boxHeights[1], 25.6, 2) && near(loose.boxHeights[1], 38.4, 2),
    fmt({ tight: tight.boxHeights, loose: loose.boxHeights })
  )

  // ---------- 4. 连排空行 / 回车建出的空段落:同样不随行间距移动 ----------

  console.log('\n【4】连排空行:两段文字的距离不随行间距变化')
  await loadDoc('阿\n\n\n\n阿\n')
  await setVars(0.6, 1)
  const blanksTight = await metrics()
  await setVars(1.4, 1)
  const blanksLoose = await metrics()
  console.log(`     [连排 0.6] ${fmt(blanksTight)}\n     [连排 1.4] ${fmt(blanksLoose)}`)
  check(
    '三条空行连排:行间距变化时两段文字距离不变',
    blanksTight.gaps.length === 1 &&
      blanksLoose.gaps.length === 1 &&
      near(blanksTight.gaps[0], blanksLoose.gaps[0]),
    fmt({ tight: blanksTight.gaps, loose: blanksLoose.gaps })
  )
  check(
    '三条空行仍是三条间距(条数没有被合并掉)',
    blanksTight.gapHeights.length === 3 && blanksTight.gapHeights.every(h => h > 0),
    fmt(blanksTight.gapHeights)
  )

  console.log('\n【5】回车建出的空段落:两段文字的距离不随行间距变化')
  await loadDoc('阿\n\n阿\n')
  await setCaret(1)
  await key('Enter')
  await setVars(0.6, 1)
  const keptTight = await metrics()
  await setVars(1.4, 1)
  const keptLoose = await metrics()
  console.log(`     [空段落 0.6] ${fmt(keptTight)}\n     [空段落 1.4] ${fmt(keptLoose)}`)
  check(
    '回车空段落夹在中间时,行间距变化不移动两段文字',
    keptTight.gaps.length === 1 &&
      keptLoose.gaps.length === 1 &&
      near(keptTight.gaps[0], keptLoose.gaps[0]),
    fmt({ tight: keptTight.gaps, loose: keptLoose.gaps })
  )

  // ---------- 6. 设置面板:拖行间距时,正文与预览都不移动 ----------

  console.log('\n【6】设置面板里拖「行间距」:正文位置与预览里的两段距离都不动')
  await loadDoc(PARAS)
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('[data-spacing-preview]')`)
  await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="body"]')?.click()`)
  await sleep(150)
  await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="body"]')?.click()`)
  await waitFor(`document.querySelector('[data-pair-mode="self"]')`)

  /** 用面板上的滑块改行间距(同时更新 store 与根变量) */
  async function setLineSpaceBySlider(value: number): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const input = document.querySelector('input[data-line-space="lineSpace"]')
      if (!input) return false
      input.value = '${value}'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(350)
    return ok
  }

  interface PanelMetrics {
    /** 编辑器里第一段正文的文字上沿 */
    firstTextTop: number
    /** 预览里两个样本盒之间的距离(样本已裁到文字边,就是两段之间的距离) */
    previewBetween: number
    /** 预览里那条缝的实际高度 */
    previewGap: number
    /** 上样本里的行数(段内换行预览) */
    previewLines: number
    /** 上样本里第一行到第二行的行距 */
    previewAdvance: number
  }

  const panelMetrics = (): Promise<PanelMetrics | null> =>
    evalJs<PanelMetrics | null>(`
      (() => {
        const first = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => (el.textContent || '').trim())
        const samples = [...document.querySelectorAll('.spacing-doc-sample')]
        const gap = document.querySelector('[data-preview-gap]')
        if (!first || samples.length < 2 || !gap) return null
        const textTop = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect().top
        }
        const lines = [...samples[0].querySelectorAll('.spacing-doc-body > div')]
        const s0 = samples[0].getBoundingClientRect()
        const s1 = samples[1].getBoundingClientRect()
        return {
          firstTextTop: Math.round(textTop(first) * 10) / 10,
          previewBetween: Math.round((s1.top - s0.bottom) * 10) / 10,
          previewGap: Math.round(parseFloat(getComputedStyle(gap).height) * 10) / 10,
          previewLines: lines.length,
          previewAdvance:
            lines.length > 1 ? Math.round((textTop(lines[1]) - textTop(lines[0])) * 10) / 10 : 0
        }
      })()`)

  check('行间距滑块可用', await setLineSpaceBySlider(1))
  const pm1 = await panelMetrics()
  console.log(`     [1.0 档] ${JSON.stringify(pm1)}`)
  check('设置面板里能同时量到正文与预览', !!pm1, JSON.stringify(pm1))
  const pm0 = await (async () => {
    check('拖到 0 档', await setLineSpaceBySlider(0))
    return panelMetrics()
  })()
  console.log(`     [0.0 档] ${JSON.stringify(pm0)}`)
  const pm14 = await (async () => {
    check('拖到 1.4 档', await setLineSpaceBySlider(1.4))
    return panelMetrics()
  })()
  console.log(`     [1.4 档] ${JSON.stringify(pm14)}`)
  if (pm1 && pm0 && pm14) {
    check(
      '编辑器正文没有上下移动(首行文字位置不变)',
      near(pm0.firstTextTop, pm1.firstTextTop, 2) && near(pm14.firstTextTop, pm1.firstTextTop, 2),
      JSON.stringify({ pm0: pm0.firstTextTop, pm1: pm1.firstTextTop, pm14: pm14.firstTextTop })
    )
    check(
      '预览里两段正文的距离不变',
      near(pm0.previewBetween, pm1.previewBetween, 2) &&
        near(pm14.previewBetween, pm1.previewBetween, 2),
      JSON.stringify({
        pm0: pm0.previewBetween,
        pm1: pm1.previewBetween,
        pm14: pm14.previewBetween
      })
    )
    check(
      '预览里那条缝的高度不随行间距变化',
      near(pm0.previewGap, pm1.previewGap, 1) && near(pm14.previewGap, pm1.previewGap, 1),
      JSON.stringify({ pm0: pm0.previewGap, pm1: pm1.previewGap, pm14: pm14.previewGap })
    )
    check(
      '预览上样本画了两行(段内换行可见)',
      pm1.previewLines === 2,
      JSON.stringify({ lines: pm1.previewLines })
    )
    check(
      '预览里段内两行的行距随行间距变大',
      pm14.previewAdvance > pm0.previewAdvance + 10,
      JSON.stringify({ pm0: pm0.previewAdvance, pm14: pm14.previewAdvance })
    )
  } else {
    check('设置面板里的量测齐全', false, JSON.stringify({ pm1, pm0, pm14 }))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
