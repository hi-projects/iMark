/**
 * 验收:图片(独占一行时)与相邻标题 / 正文的四组留白(设置「外观 → 块间距」)。
 *
 *   图片上方与标题 / 图片上方与正文 / 图片下方与标题 / 图片下方与正文 ——
 *   同一个缝隙从两边说都是同一件事(图片上方与标题 = 标题下方与图片),
 *   所以每根滑块管一个「方向 × 邻居类型」。
 *
 * 断言:
 *   A 紧贴标题:留白做在图片行的 padding 上,标题那一侧的留白清零 ——
 *     图片档是权威值,不与标题间距叠加;
 *   B 紧贴正文:留白做在图片行上,空行变体也不算段间距;
 *   C 中间有空行:那条结构空行压到图片档高度,标题一侧照样清零;
 *   D 「标题在上/图片在下」「正文在上/图片在下」两个配对各给一根滑块,互换
 *     后调另一侧;即时生效、读数正确,画面上的实际间距跟着走;
 *     值写进 settings.json,重载后还原;
 *   E 「恢复默认设置」把图片间距也带回 1 档(表格回到 1.7 / 0.7 档)。
 *
 * 跑法(先 `npm run build`,再在仓库根目录):
 *   xvfb-run -a node verify/run.mjs image-spacing
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
/** 默认 1 档 = 一个正文字号 */
const GAP = BODY
/** `.cm-md-image img` 自带的上下 margin(见 editor.css) */
const IMG_MARGIN = 4

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

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90">
  <rect width="160" height="90" fill="#eef" stroke="#334" stroke-width="2"/>
</svg>
`

/** 标题紧挨图片上方(图片上方与标题) */
const TIGHT_HEADING_ABOVE = ['## 小标题', '![](shot.svg)', ''].join('\n')
/** 标题紧挨图片下方(图片下方与标题) */
const TIGHT_HEADING_BELOW = ['![](shot.svg)', '## 小标题', ''].join('\n')
/** 正文紧挨图片上方,同一段(图片上方与正文) */
const TIGHT_BODY_ABOVE = ['正文甲', '![](shot.svg)', ''].join('\n')
/** 正文紧挨图片下方,同一段(图片下方与正文) */
const TIGHT_BODY_BELOW = ['![](shot.svg)', '正文乙', ''].join('\n')
/** 空行变体:标题 / 空行 / 图片 */
const BLANK_HEADING_ABOVE = ['## 小标题', '', '![](shot.svg)', ''].join('\n')
/** 空行变体:图片 / 空行 / 标题 */
const BLANK_HEADING_BELOW = ['![](shot.svg)', '', '## 小标题', ''].join('\n')
/** 空行变体:正文 / 空行 / 图片 */
const BLANK_BODY_ABOVE = ['正文甲', '', '![](shot.svg)', ''].join('\n')
/** 空行变体:图片 / 空行 / 正文 */
const BLANK_BODY_BELOW = ['![](shot.svg)', '', '正文乙', ''].join('\n')

/** 四根滑块各自有活干的一段:两个图片夹在标题和正文之间 */
const SLIDER_DOC = ['## 头A', '![](shot.svg)', '正文甲', '![](shot.svg)', '## 头B', ''].join('\n')

// 验收窗口一律不显示
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

interface LineInfo {
  text: string
  cls: string
  paddingTop: number
  paddingBottom: number
  lineHeight: number
  headingPad: string
  top: number
  bottom: number
}

interface ImageInfo {
  top: number
  bottom: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs image-spacing` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '图片间距.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, TIGHT_HEADING_ABOVE, 'utf8')
  await writeFile(join(vault, 'shot.svg'), SVG, 'utf8')
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
        const r = el.getBoundingClientRect()
        return {
          text: el.textContent,
          cls: el.className,
          paddingTop: parseFloat(cs.paddingTop || '0'),
          paddingBottom: parseFloat(cs.paddingBottom || '0'),
          lineHeight: parseFloat(cs.lineHeight),
          headingPad: cs.getPropertyValue('--md-heading-pad').trim(),
          top: r.top,
          bottom: r.bottom
        }
      })`)

  const images = (): Promise<ImageInfo[]> =>
    evalJs<ImageInfo[]>(`
      [...document.querySelectorAll('.cm-md-image img')].map(el => {
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom }
      })`)

  async function loadDoc(content: string): Promise<boolean> {
    const count = content.split('\n').length
    const ready = `document.querySelectorAll('.cm-content .cm-line').length === ${count}`
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(note, content, 'utf8')
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      if (await waitFor(ready, 6000)) {
        // 光标默认停在文档开头。文档以图片开头时,光标就"碰到"图片 ——
        // 渲染层会显形为源码而不是图片,量出来的行高就不是成品的样子。
        // 统一把光标挪到文末(这一组文档末尾都是一条空行),图片全部落回渲染态。
        await evalJs(`document.querySelector('.cm-content')?.focus()`)
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] })
        // 图片 onload 之后行高才是最终值
        await waitFor(`document.querySelector('.cm-md-image-loaded img')`, 4000)
        await sleep(120)
        return true
      }
    }
    return false
  }

  /** 调色板:点已选中的上块,直到回到空状态 */
  async function resetRing(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      const state = await evalJs<string>(
        `document.querySelector('[data-spacing-ring]')?.getAttribute('data-ring-state') ?? ''`
      )
      if (state === 'empty') return
      await evalJs(
        `document.querySelector('[data-spacing-ring] [data-block-role="top"]')?.click()`
      )
      await sleep(80)
    }
  }

  async function clickNode(kind: string): Promise<void> {
    await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="${kind}"]')?.click()`)
    await sleep(100)
  }

  /** 先点 top(上面),再点 bottom(下面) */
  async function selectPair(top: string, bottom: string): Promise<boolean> {
    await resetRing()
    await clickNode(top)
    await clickNode(bottom)
    return waitFor(`document.querySelector('[data-pair-panel]')`, 3000)
  }

  /** 互换上下 */
  async function swapSides(): Promise<boolean> {
    await evalJs(`document.querySelector('[data-ring-swap]')?.click()`)
    await sleep(150)
    return waitFor(`document.querySelector('[data-pair-panel]')`, 2000)
  }

  const near = (a: number, b: number, tol = 0.6): boolean => Math.abs(a - b) <= tol
  const looks = (l: LineInfo | undefined): string =>
    l ? `${JSON.stringify(l.text)} [${l.cls}] pad=${l.paddingTop}/${l.paddingBottom} lh=${l.lineHeight}` : '缺行'

  // ---------- A ----------
  console.log('\n【A】紧贴标题:留白做在图片行上,标题那一侧清零')
  {
    check('载入「标题在上」的文档', await loadDoc(TIGHT_HEADING_ABOVE))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const [head, image] = ls
    check(
      '图片行带「图片上方与标题」类',
      !!image && /\bcm-md-image-gap-before-heading\b/.test(image.cls),
      looks(image)
    )
    check('图片行上留白 = 1 档(16px)', !!image && near(image.paddingTop, GAP), looks(image))
    check('标题下方留白清零(不与图片档叠加)', !!head && near(head.paddingBottom, 0), looks(head))
  }
  {
    check('载入「标题在下」的文档', await loadDoc(TIGHT_HEADING_BELOW))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const [image, head] = ls
    check(
      '图片行带「图片下方与标题」类',
      !!image && /\bcm-md-image-gap-after-heading\b/.test(image.cls),
      looks(image)
    )
    check('图片行下留白 = 1 档(16px)', !!image && near(image.paddingBottom, GAP), looks(image))
    check(
      '标题上方留白清零(+ 按钮定位变量一起归零)',
      !!head && near(head.paddingTop, 0) && head.headingPad === '0px',
      looks(head)
    )
  }

  // ---------- B ----------
  console.log('\n【B】紧贴正文:留白做在图片行上')
  {
    check('载入「正文在上」的文档', await loadDoc(TIGHT_BODY_ABOVE))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const image = ls[1]
    check(
      '图片行带「图片上方与正文」类',
      !!image && /\bcm-md-image-gap-before-body\b/.test(image.cls),
      looks(image)
    )
    check('图片行上留白 = 1 档(16px)', !!image && near(image.paddingTop, GAP), looks(image))
  }
  {
    check('载入「正文在下」的文档', await loadDoc(TIGHT_BODY_BELOW))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const image = ls[0]
    check(
      '图片行带「图片下方与正文」类',
      !!image && /\bcm-md-image-gap-after-body\b/.test(image.cls),
      looks(image)
    )
    check('图片行下留白 = 1 档(16px)', !!image && near(image.paddingBottom, GAP), looks(image))
  }

  // ---------- C ----------
  console.log('\n【C】中间有空行:结构空行压到图片档')
  const blankOf = (ls: LineInfo[], cls: string): LineInfo | undefined =>
    ls.find(l => new RegExp(`\\b${cls}\\b`).test(l.cls))

  {
    check('载入「标题 / 空行 / 图片」', await loadDoc(BLANK_HEADING_ABOVE))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const blank = blankOf(ls, 'cm-md-image-gap-blank-before-heading')
    const head = ls[0]
    check('空行带「图片上方与标题」的结构空行类', !!blank, JSON.stringify(ls.map(l => l.cls)))
    check('空行高度 = 1 档(16px)', !!blank && near(blank.lineHeight, GAP), looks(blank))
    check('标题下方留白清零', !!head && near(head.paddingBottom, 0), looks(head))
  }
  {
    check('载入「图片 / 空行 / 标题」', await loadDoc(BLANK_HEADING_BELOW))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const blank = blankOf(ls, 'cm-md-image-gap-blank-after-heading')
    const head = ls[2]
    check('空行带「图片下方与标题」的结构空行类', !!blank, JSON.stringify(ls.map(l => l.cls)))
    check(
      '空行高度 = 1 档(16px),不再按「标题前整行」展开',
      !!blank && near(blank.lineHeight, GAP),
      looks(blank)
    )
    check(
      '标题上方留白清零',
      !!head && near(head.paddingTop, 0) && head.headingPad === '0px',
      looks(head)
    )
  }
  {
    check('载入「正文 / 空行 / 图片」', await loadDoc(BLANK_BODY_ABOVE))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const blank = blankOf(ls, 'cm-md-image-gap-blank-before-body')
    check('空行带「图片上方与正文」的结构空行类', !!blank, JSON.stringify(ls.map(l => l.cls)))
    check(
      '空行高度 = 1 档,且没有再叠一份段间距',
      !!blank && near(blank.lineHeight, GAP) && !/\bcm-md-block-gap-body\b/.test(blank.cls),
      looks(blank)
    )
  }
  {
    check('载入「图片 / 空行 / 正文」', await loadDoc(BLANK_BODY_BELOW))
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const blank = blankOf(ls, 'cm-md-image-gap-blank-after-body')
    check('空行带「图片下方与正文」的结构空行类', !!blank, JSON.stringify(ls.map(l => l.cls)))
    check(
      '空行高度 = 1 档,且没有再叠一份段间距',
      !!blank && near(blank.lineHeight, GAP) && !/\bcm-md-block-gap-body\b/.test(blank.cls),
      looks(blank)
    )
  }

  // ---------- D ----------
  console.log('\n【D】四根滑块即时生效、写盘、重载还原')
  check('载入四根滑块各管一段的文档', await loadDoc(SLIDER_DOC))
  const baseLines = await lines()
  const baseImages = await images()
  console.log(`     ${baseLines.map(looks).join('\n     ')}`)
  const baseGap = (baseImages[0]?.top ?? 0) - (baseLines[0]?.bottom ?? 0)
  console.log(`     [实测] 标题→第一张图片的间距 ${baseGap.toFixed(1)}px(含图片自身 margin ${IMG_MARGIN}px)`)

  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  await waitFor(`document.querySelector('[data-spacing-ring]')`)

  async function setSlider(side: string, value: number): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const input = document.querySelector('input[data-image-space="${side}"]')
        if (!input) return false
        input.value = '${value}'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
  }

  /** 当前配对面板里可见的滑块读数 */
  const imageReadouts = (): Promise<Record<string, string>> =>
    evalJs<Record<string, string>>(`
      (() => {
        const out = {}
        for (const input of document.querySelectorAll('input[data-image-space]')) {
          const side = input.getAttribute('data-image-space')
          out[side] = input.closest('.settings-control')?.querySelector('.settings-readout')?.textContent ?? ''
        }
        return out
      })()`)

  const headingPair = await selectPair('heading', 'image')
  check(
    '标题在上、图片在下:面板只列「图片上方与标题」一根滑块',
    headingPair && (await waitFor(`document.querySelector('input[data-image-space="beforeHeading"]')`)),
    '标题 ↔ 图片配对没有出现 beforeHeading 滑块'
  )
  check('拖动「图片上方与标题」→ 2 档', await setSlider('beforeHeading', 2))
  await sleep(150)
  const beforeHeadingReadout = await imageReadouts()
  check(
    '互换后图片在上:面板只列「图片下方与标题」一根滑块',
    (await swapSides()) &&
      (await waitFor(`document.querySelector('input[data-image-space="afterHeading"]')`)),
    '互换后没有出现 afterHeading 滑块'
  )
  check('拖动「图片下方与标题」→ 0 档', await setSlider('afterHeading', 0))
  await sleep(200)
  const afterHeadingReadout = await imageReadouts()

  const bodyPair = await selectPair('body', 'image')
  check(
    '正文在上、图片在下:面板只列「图片上方与正文」一根滑块',
    bodyPair && (await waitFor(`document.querySelector('input[data-image-space="beforeBody"]')`)),
    '正文 ↔ 图片配对没有出现 beforeBody 滑块'
  )
  check('拖动「图片上方与正文」→ 0.5 档', await setSlider('beforeBody', 0.5))
  await sleep(150)
  const beforeBodyReadout = await imageReadouts()
  check(
    '互换后图片在上:面板只列「图片下方与正文」一根滑块',
    (await swapSides()) &&
      (await waitFor(`document.querySelector('input[data-image-space="afterBody"]')`)),
    '互换后没有出现 afterBody 滑块'
  )
  check('拖动「图片下方与正文」→ 2 档', await setSlider('afterBody', 2))
  await sleep(400)
  const afterBodyReadout = await imageReadouts()

  const ui = await evalJs<{ vars: Record<string, string>; readouts: Record<string, string> }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      return {
        vars: {
          beforeHeading: root.getPropertyValue('--md-image-space-before-heading').trim(),
          beforeBody: root.getPropertyValue('--md-image-space-before-body').trim(),
          afterHeading: root.getPropertyValue('--md-image-space-after-heading').trim(),
          afterBody: root.getPropertyValue('--md-image-space-after-body').trim()
        },
        readouts: {}
      }
    })()`)
  ui.readouts = {
    ...beforeHeadingReadout,
    ...afterHeadingReadout,
    ...beforeBodyReadout,
    ...afterBodyReadout
  }
  console.log(`     [实测] ${JSON.stringify(ui)}`)
  check(
    '根变量跟着滑块走',
    ui.vars.beforeHeading === '2' &&
      ui.vars.beforeBody === '0.5' &&
      ui.vars.afterHeading === '0' &&
      ui.vars.afterBody === '2',
    JSON.stringify(ui.vars)
  )
  check(
    '读数按「档 · px」显示',
    ui.readouts.beforeHeading.includes('2.0 档') &&
      ui.readouts.beforeHeading.includes('32 px') &&
      ui.readouts.beforeBody.includes('0.5 档') &&
      ui.readouts.beforeBody.includes('8 px') &&
      ui.readouts.afterHeading.includes('0.0 档') &&
      ui.readouts.afterHeading.includes('0 px'),
    JSON.stringify(ui.readouts)
  )

  const changedLines = await lines()
  const changedImages = await images()
  console.log(`     ${changedLines.map(looks).join('\n     ')}`)
  const image1 = changedLines[1]
  const image2 = changedLines[3]
  check(
    '上方的图片:上 32px(与标题)/ 下 32px(与正文)',
    !!image1 && near(image1.paddingTop, 32) && near(image1.paddingBottom, 32),
    looks(image1)
  )
  check(
    '下方的图片:上 8px(与正文)/ 下 0px(与标题)',
    !!image2 && near(image2.paddingTop, 8) && near(image2.paddingBottom, 0),
    looks(image2)
  )
  const changedGap = (changedImages[0]?.top ?? 0) - (changedLines[0]?.bottom ?? 0)
  check(
    '画面上的实际间距跟着档位走(1 档 → 2 档,+16px)',
    near(changedGap - baseGap, 16, 2),
    `默认 ${baseGap.toFixed(1)}px → 2 档 ${changedGap.toFixed(1)}px`
  )

  await sleep(500)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '四个档位都写进了 settings.json',
    saved.imageSpaceBeforeHeading === 2 &&
      saved.imageSpaceBeforeBody === 0.5 &&
      saved.imageSpaceAfterHeading === 0 &&
      saved.imageSpaceAfterBody === 2,
    JSON.stringify({
      beforeHeading: saved.imageSpaceBeforeHeading,
      beforeBody: saved.imageSpaceBeforeBody,
      afterHeading: saved.imageSpaceAfterHeading,
      afterBody: saved.imageSpaceAfterBody
    })
  )

  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  check('重载文档', await loadDoc(SLIDER_DOC))
  {
    const ls = await lines()
    console.log(`     ${ls.map(looks).join('\n     ')}`)
    const [headA, above, , below] = ls
    check(
      '重载后按磁盘值还原(上 32 / 32,下 8 / 0)',
      !!above && near(above.paddingTop, 32) && near(above.paddingBottom, 32) &&
        !!below && near(below.paddingTop, 8) && near(below.paddingBottom, 0),
      `${looks(above)} | ${looks(below)}`
    )
    check('标题一侧依旧清零', !!headA && near(headA.paddingBottom, 0), looks(headA))
  }

  // ---------- E ----------
  console.log('\n【E】「恢复默认设置」把图片间距也带回 1 档')
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  await waitFor(`document.querySelector('.settings-reset')`)
  await evalJs(`document.querySelector('.settings-reset')?.click()`)
  await sleep(700)
  const reset = await evalJs<{ vars: Record<string, string>; nodes: number }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      return {
        vars: {
          beforeHeading: root.getPropertyValue('--md-image-space-before-heading').trim(),
          beforeBody: root.getPropertyValue('--md-image-space-before-body').trim(),
          afterHeading: root.getPropertyValue('--md-image-space-after-heading').trim(),
          afterBody: root.getPropertyValue('--md-image-space-after-body').trim(),
          bodyBetween: root.getPropertyValue('--md-body-space-between').trim(),
          tableBefore: root.getPropertyValue('--md-table-space-before').trim(),
          tableAfter: root.getPropertyValue('--md-table-space-after').trim()
        },
        nodes: document.querySelectorAll('[data-block-node]').length
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(reset)}`)
  check(
    '图片四根根变量回到 1 档',
    reset.vars.beforeHeading === '1' &&
      reset.vars.beforeBody === '1' &&
      reset.vars.afterHeading === '1' &&
      reset.vars.afterBody === '1',
    JSON.stringify(reset.vars)
  )
  check(
    '段间距回到 1 档,表格回到 1.7 / 0.7 档',
    reset.vars.bodyBetween === '1' && reset.vars.tableBefore === '1.7' && reset.vars.tableAfter === '0.7',
    JSON.stringify(reset.vars)
  )
  check('重置后圆环仍在,七个块都在', reset.nodes === 7, JSON.stringify(reset.nodes))
  await sleep(400)
  const resetSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '恢复默认也写回了 settings.json(含表格默认)',
    resetSaved.imageSpaceBeforeHeading === 1 &&
      resetSaved.imageSpaceBeforeBody === 1 &&
      resetSaved.imageSpaceAfterHeading === 1 &&
      resetSaved.imageSpaceAfterBody === 1 &&
      resetSaved.tableSpaceBefore === 1.7 &&
      resetSaved.tableSpaceAfter === 0.7,
    JSON.stringify({
      beforeHeading: resetSaved.imageSpaceBeforeHeading,
      beforeBody: resetSaved.imageSpaceBeforeBody,
      afterHeading: resetSaved.imageSpaceAfterHeading,
      afterBody: resetSaved.imageSpaceAfterBody,
      tableBefore: resetSaved.tableSpaceBefore,
      tableAfter: resetSaved.tableSpaceAfter
    })
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
