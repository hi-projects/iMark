/**
 * 验收:标题与上下文(正文 / 相邻标题)的间距,按 Obsidian 默认主题的 live
 * preview 起手,上下各留一档正文字号。
 *
 * Obsidian 只给标题行 `padding-top: var(--p-spacing)`(一档正文字号),下方
 * 靠空行本身(见 app.css 的 `.cm-line.HyperMD-header { padding-top: ... }`)。
 * iMark 里那条空行只有 2 × 正文行高(默认行间距 1 档),比标题上方窄,所以上下都留一档:
 *
 *   · 有空行(本仓库笔记的常见写法):标题前 = 空行 + 一档留白,标题后 = 空行 + 一档留白;
 *   · 紧贴:标题前 = 一档留白,标题后 = 一档留白;
 *   · 标题紧挨标题:收掉上方那个的下留白,两者之间仍留一档正文尺寸(下一个
 *     标题的上留白),标题接正文的那一侧不受影响(见 rules.ts 的
 *     markHeadingEdgeBelow)。
 *
 * 量的是**文字**之间的距离(Range 矩形):padding 在行盒内部,量行盒 rect
 * 看不到标题上下方的留白。
 *
 * 跑法(仓库根目录,改了 CSS 先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs heading-spacing
 */

import { app, BrowserWindow, protocol, type NativeImage } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { buildAppMenu } from '../src/main/menu'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const REPO = join(__dirname, '..', '..')
const BODY = 16
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

/** 有空行:每个标题后面都隔一条空行再写正文(用户笔记里的常见写法) */
const LOOSE = [
  '# 一级标题',
  '',
  '正文段落一。',
  '',
  '## 二级标题',
  '',
  '正文段落二。',
  '',
  '### 三级标题',
  '',
  '正文段落三。',
  '',
  '#### 四级标题',
  '',
  '正文段落四。',
  '',
  '##### 五级标题',
  '',
  '正文段落五。',
  '',
  '###### 六级标题',
  '',
  '正文段落六。',
  ''
].join('\n')

/** 紧贴:标题上下都没有空行 */
const TIGHT = [
  '# 一级标题',
  '正文段落一。',
  '## 二级标题',
  '正文段落二。',
  '### 三级标题',
  '正文段落三。',
  ''
].join('\n')

/** 标题紧挨着标题(中间没有空行),最后一级接正文 */
const ADJACENT = [
  '# 一级标题',
  '## 二级标题',
  '### 三级标题',
  '正文段落。',
  ''
].join('\n')

type LevelGap = {
  level: number
  font: number
  pad: number
  padBottom: number
  /** 带标题留白时的视觉间距 */
  withPad: { before: number; after: number }
  /** 把标题留白临时归零后的同一组间距,用来验证留白只作用在上方 */
  noPad: { before: number; after: number }
}

// 验收窗口一律不显示:窗口照常创建与渲染,只是不出现在屏幕上。
// 截图例外 —— 隐藏窗口里 Chromium 会停掉合成,capturePage 只能拿到旧帧
// (设置面板这种浮层干脆不在画面里),所以 captureShot 临时用真 show 逼一次重绘。
const realShow = BrowserWindow.prototype.show
const realHide = BrowserWindow.prototype.hide
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs heading-spacing` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '标题间距.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, LOOSE, 'utf8')
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
  /*
   * 「+」的显示依赖扩展贡献的行首菜单条目(lineMenuEntries() 为空时不画按钮),
   * 所以这里要和 code-block-harness 一样装好内置扩展,再起窗口。
   */
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(860, 1000)
  const wc = win.webContents

  wc.on('console-message', (_event, ...args: unknown[]) => {
    const first = args[0]
    if (first && typeof first === 'object') {
      const details = first as { level?: string; message?: string }
      if (details.level !== 'debug') console.log(`[renderer:${details.level}] ${details.message}`)
    }
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  async function captureShot(): Promise<NativeImage | null> {
    // 窗口不显示时合成器不跑:先真显示一下、等两帧画完再截,截完马上藏回去。
    // 用例都跑在 xvfb 虚拟屏上,真实桌面不会看到窗口。
    realShow.call(win)
    win.moveTop()
    await sleep(200)
    await Promise.race([
      evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'),
      sleep(500)
    ])
    await sleep(120)
    try {
      for (let i = 0; i < 5; i++) {
        try {
          return await wc.capturePage()
        } catch {
          await sleep(200)
        }
      }
      return null
    } finally {
      realHide.call(win)
    }
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1000)
  }

  /**
   * 量各级标题的视觉间距:与上一段正文、与下一段正文。
   *
   * 用文字内容的 Range 取矩形,而不是 .cm-line 的矩形 —— padding 在行盒**里面**,
   * 行盒 rect 的上沿量不到标题上方的留白。为了排除字体上下沿的固定偏差,
   * 同一组间距量两遍:带留白,以及把标题行的 padding-top 临时归零后 ——
   * 两者之差就是留白真正贡献的距离。
   */
  function measure(): Promise<LevelGap[]> {
    return evalJs<LevelGap[]>(
      `(() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const text = el => el.textContent.trim()
        const ink = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect()
        }
        const gaps = h => {
          const i = lines.indexOf(h)
          let pi = i - 1
          while (pi >= 0 && !text(lines[pi])) pi--
          let ni = i + 1
          while (ni < lines.length && !text(lines[ni])) ni++
          const hr = ink(h)
          return {
            before: pi >= 0 ? Math.round((hr.top - ink(lines[pi]).bottom) * 10) / 10 : -1,
            after: ni < lines.length ? Math.round((ink(lines[ni]).top - hr.bottom) * 10) / 10 : -1
          }
        }
        const out = []
        for (let level = 1; level <= 6; level++) {
          const h = lines.find(el => el.classList.contains('cm-md-h' + level))
          if (!h) continue
          const withPad = gaps(h)
          /*
           * 归零留白时连 --md-heading-pad 一起归零:光标在这一行时行内有个
           * 绝对定位的「+」,它的 top 也吃这个变量。只改 padding-top 的话按钮
           * 停在原处,Range 的并集仍被它撑到行盒下方,量出来的「下方间距」就
           * 会凭空多出几像素。
           */
          h.style.setProperty('--md-heading-pad', '0px')
          h.style.paddingTop = '0px'
          h.style.paddingBottom = '0px'
          const noPad = gaps(h)
          h.style.removeProperty('--md-heading-pad')
          h.style.removeProperty('padding-top')
          h.style.removeProperty('padding-bottom')
          const cs = getComputedStyle(h)
          out.push({
            level,
            font: parseFloat(cs.fontSize),
            pad: parseFloat(cs.paddingTop),
            padBottom: parseFloat(cs.paddingBottom),
            withPad,
            noPad
          })
        }
        return out
      })()`
    )
  }

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })

  console.log('\n【A】有空行:标题上下各多一档正文尺寸,空行照常保留')
  const loose = await measure()
  console.log(`     [实测] ${JSON.stringify(loose)}`)
  check(
    '各级标题的上方留白 = 1 × 正文尺寸',
    loose.length === 6 && loose.every(g => Math.abs(g.pad - BODY) < 0.5),
    JSON.stringify(loose.map(g => ({ level: g.level, pad: g.pad })))
  )
  check(
    '上方间距正好多出一档正文尺寸',
    loose.every(g => g.noPad.before < 0 || Math.abs(g.withPad.before - g.noPad.before - BODY) < 0.5),
    JSON.stringify(loose.map(g => ({ level: g.level, d: g.withPad.before - g.noPad.before })))
  )
  check(
    '下方间距同样多出一档正文尺寸(空行之外)',
    loose.every(g => Math.abs(g.withPad.after - g.noPad.after - BODY) < 0.5),
    JSON.stringify(loose.map(g => ({ level: g.level, d: g.withPad.after - g.noPad.after })))
  )
  check(
    '标题下方留白 = 1 × 正文尺寸',
    loose.every(g => Math.abs(g.padBottom - BODY) < 0.5),
    JSON.stringify(loose.map(g => ({ level: g.level, padBottom: g.padBottom })))
  )
  const bodyMetrics = await evalJs<{ bodyLineHeight: number; blankHeight: number }>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const body = lines.find(l => l.textContent.includes('正文段落一'))
      const blank = lines.find(l => l.textContent.trim() === '')
      return {
        bodyLineHeight: parseFloat(getComputedStyle(body).lineHeight),
        blankHeight: Math.round(blank.getBoundingClientRect().height * 10) / 10
      }
    })()`)
  check(
    '正文行与普通空行的行高不受影响(默认行间距 1 档 = 2 个字号)',
    Math.abs(bodyMetrics.bodyLineHeight - BODY * 2) < 0.5 &&
      Math.abs(bodyMetrics.blankHeight - BODY * 2) < 0.5,
    JSON.stringify(bodyMetrics)
  )

  /*
   * 行首「+」按行盒顶边定位:标题行上方多了一档 padding 后,按钮也得跟着
   * 下移,否则会停在标题上方的留白里。把光标放到第一行(一级标题)再量。
   *
   * 光标不用鼠标点:窗口是隐藏的,合成 MouseEvent 走不到 CM 的点击映射里。
   * CM 把 EditorView 挂在 `.cm-content` 的 cmTile.root.view 上,直接 dispatch 选区。
   */
  const cursorOk = await evalJs<boolean>(`
    (() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      view.dispatch({ selection: { anchor: 0 } })
      view.focus()
      return true
    })()`)
  await sleep(250)
  const plusGeo = await evalJs<{ pad: number; offset: number } | null>(`
    (() => {
      const line = document.querySelector('.cm-line.cm-md-h1')
      const btn = line?.querySelector('.line-plus')
      if (!line || !btn) return null
      return {
        pad: parseFloat(getComputedStyle(line).paddingTop),
        offset: Math.round((btn.getBoundingClientRect().top - line.getBoundingClientRect().top) * 10) / 10
      }
    })()`)
  check(
    '标题行的「+」跟着标题下移,没有停在留白里',
    cursorOk && plusGeo !== null && Math.abs(plusGeo.offset - (plusGeo.pad + BODY * 0.15)) < 2,
    JSON.stringify({ cursorOk, plusGeo })
  )
  {
    const image = await captureShot()
    if (image) await writeFile(join(shots, 'heading-spacing-loose.png'), image.toPNG())
  }

  console.log('\n【B】紧贴:没有空行时,标题上下也各留一档正文尺寸')
  await loadDoc(TIGHT)
  const tight = await measure()
  console.log(`     [实测] ${JSON.stringify(tight)}`)
  check(
    '各级标题的上方留白 = 1 × 正文尺寸',
    tight.length === 3 && tight.every(g => Math.abs(g.pad - BODY) < 0.5),
    JSON.stringify(tight.map(g => ({ level: g.level, pad: g.pad })))
  )
  check(
    '上方间距正好多出一档正文尺寸',
    tight.every(g => g.noPad.before < 0 || Math.abs(g.withPad.before - g.noPad.before - BODY) < 0.5),
    JSON.stringify(tight.map(g => ({ level: g.level, d: g.withPad.before - g.noPad.before })))
  )
  check(
    '下方间距同样多出一档正文尺寸',
    tight.every(g => Math.abs(g.padBottom - BODY) < 0.5 && Math.abs(g.withPad.after - g.noPad.after - BODY) < 0.5),
    JSON.stringify(tight.map(g => ({ level: g.level, padBottom: g.padBottom, d: g.withPad.after - g.noPad.after })))
  )
  {
    const image = await captureShot()
    if (image) await writeFile(join(shots, 'heading-spacing-tight.png'), image.toPNG())
  }

  console.log('\n【C】标题紧挨标题:只收上方那个的下留白,两者之间仍留一档正文尺寸')
  await loadDoc(ADJACENT)
  type AdjacentMetrics = {
    pads: { top: number; bottom: number }[]
    tightBottom: boolean[]
    headingGap: number
    bodyGap: number
    headingGapDelta: number
    bodyGapDelta: number
  }
  const adj = await evalJs<AdjacentMetrics>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const text = el => el.textContent.trim()
      const ink = el => {
        const r = document.createRange()
        r.selectNodeContents(el)
        return r.getBoundingClientRect()
      }
      const next = i => {
        let n = i + 1
        while (n < lines.length && !text(lines[n])) n++
        return n < lines.length ? n : -1
      }
      const gapAfter = i => {
        const n = next(i)
        return n < 0 ? -1 : Math.round((ink(lines[n]).top - ink(lines[i]).bottom) * 10) / 10
      }
      const pad = el => {
        const cs = getComputedStyle(el)
        return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) }
      }
      const hs = [1, 2, 3].map(l => lines.find(el => el.classList.contains('cm-md-h' + l)))
      const i2 = lines.indexOf(hs[1])
      const i3 = lines.indexOf(hs[2])
      const headingGap = gapAfter(i2)
      const bodyGap = gapAfter(i3)
      // 归零最后一级标题的上下留白(它的上留白撑起标题间距、下留白撑起接正文的间距)
      hs[2].style.setProperty('--md-heading-pad', '0px')
      hs[2].style.paddingBottom = '0px'
      const headingGapNoPad = gapAfter(i2)
      const bodyGapNoPad = gapAfter(i3)
      hs[2].style.removeProperty('--md-heading-pad')
      hs[2].style.removeProperty('padding-bottom')
      return {
        pads: hs.map(pad),
        tightBottom: hs.map(h => h.classList.contains('cm-md-h-tight-bottom')),
        headingGap,
        bodyGap,
        headingGapDelta: Math.round((headingGap - headingGapNoPad) * 10) / 10,
        bodyGapDelta: Math.round((bodyGap - bodyGapNoPad) * 10) / 10
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(adj)}`)
  check(
    '只收朝下标题的那一侧留白:一级、二级下留白为 0,三级接正文仍有一档',
    adj.pads.length === 3 &&
      adj.tightBottom[0] &&
      adj.tightBottom[1] &&
      !adj.tightBottom[2] &&
      Math.abs(adj.pads[0].top - BODY) < 0.5 &&
      adj.pads[0].bottom === 0 &&
      Math.abs(adj.pads[1].top - BODY) < 0.5 &&
      adj.pads[1].bottom === 0 &&
      Math.abs(adj.pads[2].top - BODY) < 0.5 &&
      Math.abs(adj.pads[2].bottom - BODY) < 0.5,
    JSON.stringify({ pads: adj.pads, tightBottom: adj.tightBottom })
  )
  check(
    '两个标题之间仍留一档正文尺寸(下一个标题的上留白)',
    Math.abs(adj.headingGapDelta - BODY) < 0.5,
    JSON.stringify({ headingGap: adj.headingGap, headingGapDelta: adj.headingGapDelta })
  )
  check(
    '标题接正文的下留白仍在(间距不变)',
    Math.abs(adj.bodyGapDelta - BODY) < 0.5,
    JSON.stringify({ bodyGap: adj.bodyGap, bodyGapDelta: adj.bodyGapDelta })
  )
  check(
    '标题之间的间距仍比标题接正文窄',
    adj.headingGap >= BODY && adj.headingGap < adj.bodyGap,
    JSON.stringify({ headingGap: adj.headingGap, bodyGap: adj.bodyGap })
  )
  await evalJs(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const idx = lines.findIndex(el => el.classList.contains('cm-md-h2'))
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view || idx < 0) return false
      view.dispatch({ selection: { anchor: view.state.doc.line(idx + 1).from } })
      view.focus()
      return true
    })()`)
  await sleep(250)
  const adjPlus = await evalJs<{ pad: number; offset: number } | null>(`
    (() => {
      const line = document.querySelector('.cm-line.cm-md-h2')
      const btn = line?.querySelector('.line-plus')
      if (!line || !btn) return null
      return {
        pad: parseFloat(getComputedStyle(line).paddingTop),
        offset: Math.round((btn.getBoundingClientRect().top - line.getBoundingClientRect().top) * 10) / 10
      }
    })()`)
  check(
    '紧跟标题的标题行里,「+」仍贴着标题文字',
    adjPlus !== null &&
      Math.abs(adjPlus.offset - (adjPlus.pad + BODY * 0.15)) < 2,
    JSON.stringify(adjPlus)
  )
  {
    const image = await captureShot()
    if (image) await writeFile(join(shots, 'heading-spacing-adjacent.png'), image.toPNG())
  }

  /*
   * 【D】设置 → 外观 → 标题间距
   *
   * 三根滑块(上方 / 下方 / 之间)分别落到 --md-heading-space-*;拖动即时生效、
   * 松手写盘;重新加载后按磁盘值还原。把三个值设成互不相同,才能看出哪根
   * 滑块管哪一侧(2 / 1.5 / 0.5 档,正文字号 16px → 32 / 24 / 8px)。
   */
  console.log('\n【D】设置 → 外观 → 标题间距:滑块即时生效、落盘、重载后保留')
  await loadDoc(LOOSE)
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  check(
    '「样式」区里有三根标题间距滑块',
    await waitFor(`document.querySelectorAll('input[data-heading-space]').length === 3`),
    '找不到 data-heading-space 滑块'
  )

  async function setHeadingSlider(side: string, value: number): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const input = document.querySelector('input[data-heading-space="${side}"]')
        if (!input) return false
        input.value = '${value}'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
  }

  const sliderOk =
    (await setHeadingSlider('before', 2)) &&
    (await setHeadingSlider('after', 1.5)) &&
    (await setHeadingSlider('between', 0.5))
  await sleep(400)

  const ui = await evalJs<{
    vars: Record<string, string>
    readouts: { side: 'before' | 'after' | 'between'; value: number; text: string }[]
    padTop: number
    padBottom: number
  }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      const h2 = [...document.querySelectorAll('.cm-line')].find(el => el.classList.contains('cm-md-h2'))
      const cs = h2 ? getComputedStyle(h2) : null
      return {
        vars: {
          before: root.getPropertyValue('--md-heading-space-before').trim(),
          after: root.getPropertyValue('--md-heading-space-after').trim(),
          between: root.getPropertyValue('--md-heading-space-between').trim()
        },
        readouts: [...document.querySelectorAll('input[data-heading-space]')].map(input => ({
          side: input.dataset.headingSpace,
          value: Number(input.value),
          text: input.parentElement?.querySelector('.settings-readout')?.textContent?.trim() ?? ''
        })),
        padTop: cs ? parseFloat(cs.paddingTop) : -1,
        padBottom: cs ? parseFloat(cs.paddingBottom) : -1
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(ui)}`)
  check(
    '三根滑块拖动后根变量与读数同步',
    sliderOk &&
      ui.vars.before === '2' &&
      ui.vars.after === '1.5' &&
      ui.vars.between === '0.5' &&
      ui.readouts.every(r => r.value === { before: 2, after: 1.5, between: 0.5 }[r.side]) &&
      ui.readouts.some(r => r.side === 'before' && r.text.includes('2.0 档') && r.text.includes('32 px')) &&
      ui.readouts.some(r => r.side === 'after' && r.text.includes('1.5 档') && r.text.includes('24 px')) &&
      ui.readouts.some(r => r.side === 'between' && r.text.includes('0.5 档') && r.text.includes('8 px')),
    JSON.stringify(ui)
  )
  check(
    '编辑器不等关闭面板就已跟着变(上方 32px / 下方 24px)',
    Math.abs(ui.padTop - 2 * BODY) < 0.5 && Math.abs(ui.padBottom - 1.5 * BODY) < 0.5,
    JSON.stringify({ padTop: ui.padTop, padBottom: ui.padBottom })
  )
  {
    const image = await captureShot()
    if (image) await writeFile(join(shots, 'settings-heading-space.png'), image.toPNG())
  }

  // 松手后才写盘:等 IPC + 原子写落完,直接看磁盘
  await sleep(500)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '三个档位都落到了 settings.json',
    saved.headingSpaceBefore === 2 && saved.headingSpaceAfter === 1.5 && saved.headingSpaceBetween === 0.5,
    JSON.stringify({
      before: saved.headingSpaceBefore,
      after: saved.headingSpaceAfter,
      between: saved.headingSpaceBetween
    })
  )

  // 关掉面板,换到「标题紧挨标题」的文档重新加载:新档位要按磁盘值还原
  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  await loadDoc(ADJACENT)
  const restored = await evalJs<{ pads: { top: number; bottom: number }[]; vars: string[] }>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const hs = [1, 2, 3].map(l => lines.find(el => el.classList.contains('cm-md-h' + l)))
      const root = getComputedStyle(document.documentElement)
      return {
        pads: hs.map(el => {
          const cs = getComputedStyle(el)
          return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) }
        }),
        vars: [
          root.getPropertyValue('--md-heading-space-before').trim(),
          root.getPropertyValue('--md-heading-space-after').trim(),
          root.getPropertyValue('--md-heading-space-between').trim()
        ]
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(restored)}`)
  check(
    '重载后按磁盘值还原:上方 32 / 之间 8 / 下方 24',
    restored.pads.length === 3 &&
      Math.abs(restored.pads[0].top - 2 * BODY) < 0.5 &&
      restored.pads[0].bottom === 0 &&
      Math.abs(restored.pads[1].top - 0.5 * BODY) < 0.5 &&
      restored.pads[1].bottom === 0 &&
      Math.abs(restored.pads[2].top - 0.5 * BODY) < 0.5 &&
      Math.abs(restored.pads[2].bottom - 1.5 * BODY) < 0.5 &&
      restored.vars.join(',') === '2,1.5,0.5',
    JSON.stringify(restored)
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[heading-spacing] 未捕获异常:', err)
  app.exit(2)
})
