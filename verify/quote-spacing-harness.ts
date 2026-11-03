/**
 * 引用的两件事:
 *
 *   1. 引用与正文之间要有留白(上 / 下各一档),并且可在
 *      「设置 → 外观 → 块间距」里调 —— 和代码块 / 列表同一组旋钮;
 *   2. 把引用与正文之间的空行删掉后,后面那段正文**不能**因此变成引用。
 *      CommonMark 的 lazy continuation 会把它算进 Blockquote 节点,旧实现
 *      按节点范围给整段上引用样式(竖线 + 缩进),看起来就是正文被"吞"了。
 *      现在的规则:只有真正带 `>` 的行才算引用;想留在引用里,每行补 `> `
 *      (在引用里回车本来就会自动续)。
 *
 * 断言:
 *   A 有空行:引用前后两条结构空行各按 1 档(16px)收紧,竖线只画在引用行
 *   B 紧贴正文(没有空行):间距落在相邻正文行的 padding 上,引用后那段
 *     懒续行按正文渲染(无竖线、无缩进),引用行本身照常有竖线
 *   C 设置里有「引用上方 / 引用下方」两根滑块,拖动即时生效、读数正确;
 *     值写进 settings.json,重载后按磁盘值还原
 *   D 「恢复默认设置」把引用间距也带回 1 档
 *
 * 跑法(先 `npm run build`,再在仓库根目录):
 *   xvfb-run -a node verify/run.mjs quote-spacing
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
/** 默认 1 档 */
const GAP = BODY

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

/** 引用前后都留空行 */
const BLANK = ['正文甲。', '', '> 引用第一行', '> 引用第二行', '', '正文乙。', ''].join('\n')

/** 引用紧贴正文:后面那段没写 `>` 的正文是 Parse 里的 lazy continuation */
const TIGHT = ['正文甲。', '> 引用第一行', '> 引用第二行', '正文乙。', ''].join('\n')

// 验收窗口一律不显示
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

interface LineInfo {
  text: string
  cls: string
  marginLeft: number
  isBody: boolean
  paddingTop: number
  paddingBottom: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs quote-spacing` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '引用.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, BLANK, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off',
        lineWrapping: true,
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
  win.setContentSize(1000, 800)
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

  const lines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const cs = getComputedStyle(el)
        return {
          text: el.textContent,
          cls: el.className,
          marginLeft: parseFloat(cs.marginLeft || '0'),
          isBody: parseFloat(cs.fontWeight) < 600,
          paddingTop: parseFloat(cs.paddingTop || '0'),
          paddingBottom: parseFloat(cs.paddingBottom || '0')
        }
      })`)

  const lineHeightOf = (cls: string): Promise<number[]> =>
    evalJs<number[]>(`
      [...document.querySelectorAll('.cm-line.${cls}')].map(el =>
        parseFloat(getComputedStyle(el).lineHeight))`)

  async function loadDoc(content: string): Promise<boolean> {
    const count = content.split('\n').length
    const ready = `document.querySelectorAll('.cm-content .cm-line').length === ${count}`
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(note, content, 'utf8')
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      if (await waitFor(ready, 6000)) return true
    }
    return false
  }

  const near = (a: number, b: number, tol = 0.6): boolean => Math.abs(a - b) <= tol
  const looks = (l: LineInfo): string => `${JSON.stringify(l.text)} [${l.cls}] margin=${l.marginLeft} pad=${l.paddingTop}/${l.paddingBottom}`

  // ---------- A ----------
  console.log('\n【A】引用前后有空行:结构空行按 1 档收紧')
  {
    const blankBefore = await lineHeightOf('cm-md-block-gap-quote-before')
    const blankAfter = await lineHeightOf('cm-md-block-gap-quote-after')
    console.log(`     [空行高] before=${JSON.stringify(blankBefore)} after=${JSON.stringify(blankAfter)}`)
    check('引用上方有空行,并按 1 档(16px)收紧', blankBefore.length === 1 && near(blankBefore[0], GAP), JSON.stringify(blankBefore))
    check('引用下方有空行,并按 1 档(16px)收紧', blankAfter.length === 1 && near(blankAfter[0], GAP), JSON.stringify(blankAfter))

    const ls = await lines()
    const quoted = ls.filter(l => /cm-md-quote/.test(l.cls))
    check('两条引用行都带引用样式', quoted.length === 2, JSON.stringify(ls.map(l => l.cls)))
    check('引用行有竖线的缩进(1em)', quoted.every(l => near(l.marginLeft, BODY)), JSON.stringify(quoted.map(l => l.marginLeft)))
    check('前后正文行没有被当成引用', !/cm-md-quote/.test(ls[0].cls) && !/cm-md-quote/.test(ls[5].cls), JSON.stringify(ls.map(l => l.cls)))
  }

  // ---------- B ----------
  console.log('\n【B】引用紧贴正文:间距落在相邻正文行上,懒续行按正文渲染')
  await loadDoc(TIGHT)
  {
    const ls = await lines()
    const [before, q1, q2, after] = ls
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    check('引用上方正文行有 1 档底部 padding', !!before && near(before.paddingBottom, GAP), before ? looks(before) : '缺行')
    check('引用下方正文行有 1 档顶部 padding', !!after && near(after.paddingTop, GAP), after ? looks(after) : '缺行')
    check('引用行本身带引用样式', !!q1 && /cm-md-quote/.test(q1.cls) && !!q2 && /cm-md-quote/.test(q2.cls), `${q1?.cls} | ${q2?.cls}`)
    check(
      '没写 `>` 的那行不再被画成引用(没有竖线缩进)',
      !!after && !/cm-md-quote/.test(after.cls) && near(after.marginLeft, 0),
      after ? looks(after) : '缺行'
    )
    check('没写 `>` 的那行按正文样式显示', !!after && after.isBody, after ? looks(after) : '缺行')
  }

  // ---------- C ----------
  console.log('\n【C】设置 → 外观 → 块间距:引用上下两根滑块即时生效、写盘、重载还原')
  await loadDoc(BLANK)
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  check(
    '「样式」区里有引用上下两根滑块',
    await waitFor(
      `document.querySelector('input[data-block-space="quoteBefore"]') && document.querySelector('input[data-block-space="quoteAfter"]')`
    ),
    '找不到 data-block-space="quoteBefore / quoteAfter"'
  )

  async function setSlider(side: string, value: number): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const input = document.querySelector('input[data-block-space="${side}"]')
        if (!input) return false
        input.value = '${value}'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
  }

  check('拖动引用上方 → 2 档', await setSlider('quoteBefore', 2))
  check('拖动引用下方 → 0.5 档', await setSlider('quoteAfter', 0.5))
  await sleep(400)

  const ui = await evalJs<{ vars: Record<string, string>; readouts: Record<string, string> }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      const readout = side => {
        const input = document.querySelector('input[data-block-space="' + side + '"]')
        return input?.closest('.settings-control')?.querySelector('.settings-readout')?.textContent ?? ''
      }
      return {
        vars: {
          before: root.getPropertyValue('--md-quote-space-before').trim(),
          after: root.getPropertyValue('--md-quote-space-after').trim()
        },
        readouts: { before: readout('quoteBefore'), after: readout('quoteAfter') }
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(ui)}`)
  check('根变量跟着滑块走', ui.vars.before === '2' && ui.vars.after === '0.5', JSON.stringify(ui.vars))
  check(
    '读数按「档 · px」显示',
    ui.readouts.before.includes('2.0 档') &&
      ui.readouts.before.includes('32 px') &&
      ui.readouts.after.includes('0.5 档') &&
      ui.readouts.after.includes('8 px'),
    JSON.stringify(ui.readouts)
  )

  const blankAfter = await lineHeightOf('cm-md-block-gap-quote-before')
  const blankAfter2 = await lineHeightOf('cm-md-block-gap-quote-after')
  check(
    '编辑器不等关闭面板就已跟着变(上方 32px / 下方 8px)',
    blankAfter.length === 1 && near(blankAfter[0], 32) && blankAfter2.length === 1 && near(blankAfter2[0], 8),
    `${JSON.stringify(blankAfter)} / ${JSON.stringify(blankAfter2)}`
  )

  await sleep(500)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '两个档位都写进了 settings.json',
    saved.quoteSpaceBefore === 2 && saved.quoteSpaceAfter === 0.5,
    JSON.stringify({ before: saved.quoteSpaceBefore, after: saved.quoteSpaceAfter })
  )

  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  await loadDoc(TIGHT)
  {
    const ls = await lines()
    const [before, , , after] = ls
    check(
      '重载后按磁盘值还原:上方 32px / 下方 8px',
      !!before && near(before.paddingBottom, 32) && !!after && near(after.paddingTop, 8),
      `${before?.paddingBottom} / ${after?.paddingTop}`
    )
  }

  // ---------- D ----------
  console.log('\n【D】「恢复默认设置」把引用间距也带回 1 档')
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  await waitFor(`document.querySelector('.settings-reset')`)
  await evalJs(`document.querySelector('.settings-reset')?.click()`)
  await sleep(700)
  const reset = await evalJs<{ before: string; after: string; sliders: number[] }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      return {
        before: root.getPropertyValue('--md-quote-space-before').trim(),
        after: root.getPropertyValue('--md-quote-space-after').trim(),
        sliders: [...document.querySelectorAll('input[data-block-space]')].map(i => Number(i.value))
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(reset)}`)
  check('根变量回到 1 档', reset.before === '1' && reset.after === '1', JSON.stringify(reset))
  check('七根块间距滑块都回到 1', reset.sliders.length === 7 && reset.sliders.every(v => v === 1), JSON.stringify(reset.sliders))
  await sleep(400)
  const resetSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '恢复默认也写回了 settings.json',
    resetSaved.quoteSpaceBefore === 1 && resetSaved.quoteSpaceAfter === 1,
    JSON.stringify({ before: resetSaved.quoteSpaceBefore, after: resetSaved.quoteSpaceAfter })
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
