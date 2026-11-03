/**
 * 验收:正文排版的三组间距(设置「外观 → 样式」)。
 *
 *   1. 行间距 —— 同一段里行与行之间额外留出的空白(含折行),档 × 正文字号;
 *   2. 段间距 —— 两段正文之间那条空行的留白(1 档 = 一个正文字号);
 *   3. 代码块 / 列表与前后正文的间距 —— 有空行时把空行压到该高度,
 *      没空行时做在相邻正文行的 padding 上,按「块类型 × 方向」各管各的。
 *
 * 断言:
 *   A 默认值 = 1 档:有空行时落在空行的 line-height 上,四个方向各管各的;
 *   B 默认值 = 1 档:紧贴正文时落在相邻正文行的 padding 上,同一行
 *     (代码块后面紧接列表)的上下两侧可以各用各的档位;
 *   C 设置面板七根块间距滑块即时生效、写盘,重载后按磁盘值还原;
 *   D 文本间距的变化量与档位变化一致(不是只改了变量、画面没动);
 *   E 「恢复默认设置」把行间距、标题与块间距一起带回默认档;
 *   F 点收紧的结构空行不会把它撑成一行(光标落到相邻正文),
 *     方向键停上去时仍按正文行渲染,输入首字不跳;
 *   G 两段正文之间的空行按「段间距」这一档收紧,滑块 / 写盘 / 恢复默认可用;
 *   H 行间距滑块改的是同一段内连续行的行高 —— 不需要空行,折行也按它算。
 *
 * 跑法(仓库根目录,改了 CSS / 渲染层先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs block-spacing
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
/** 默认 1 档:一个正文字号 */
const DEFAULT_GAP = 1 * BODY
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

/** 有空行:代码块和列表前后都隔一条空行 */
const BLANK = [
  '正文甲。',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '正文乙。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '正文丙。',
  ''
].join('\n')

/** 紧贴:代码块 / 列表前后都没有空行(正文乙同时贴着代码块下方和列表上方) */
const TIGHT = [
  '正文甲。',
  '```ts',
  'const x = 1',
  '```',
  '正文乙。',
  '- 第一项',
  '- 第二项',
  '正文丙。',
  ''
].join('\n')

// 验收窗口一律不显示;截图时再临时真显示一次(隐藏窗口的合成器不跑,只能拿到旧帧)
const realShow = BrowserWindow.prototype.show
const realHide = BrowserWindow.prototype.hide
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

/** 量文本自身的矩形:padding 在行盒内部,行盒 rect 看不出块与正文之间的留白 */
const TEXT_BOX = `
  const textBox = el => {
    if (!el) return null
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let top = Infinity
    let bottom = -Infinity
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.data.trim()) continue
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) {
        top = Math.min(top, r.top)
        bottom = Math.max(bottom, r.bottom)
      }
    }
    return Number.isFinite(top) ? { top, bottom } : null
  }
`

interface BlankMetrics {
  /** 四条结构空行的 line-height(按类名取,顺序同 blankLines) */
  blankLines: Record<string, number>
  /** 文本间距:代码块前 / 后,列表前 / 后 */
  gaps: Record<string, number>
}

interface TightMetrics {
  /** 正文甲 padding-bottom(代码块上方的间距) */
  codeBeforePad: number
  /** 正文乙 padding-top(代码块下方) */
  codeAfterPad: number
  /** 正文乙 padding-bottom(列表上方) */
  listBeforePad: number
  /** 正文丙 padding-top(列表下方) */
  listAfterPad: number
  gaps: Record<string, number>
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs block-spacing` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '块间距.md')
  const shots = join(REPO, '.verify-ud', 'shots')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await mkdir(shots, { recursive: true })
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
  // 不装扩展时渲染层会报「扩展系统尚未就绪」并弹一条读取失败提示,截图里很扎眼;
  // 顺带保证窗口环境与应用启动时一致。
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(860, 1000)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function captureShot(): Promise<NativeImage | null> {
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

  const blankMetrics = (): Promise<BlankMetrics> =>
    evalJs<BlankMetrics>(`
      (() => {
        ${TEXT_BOX}
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const find = text => lines.find(el => el.textContent.includes(text)) || null
        const round = n => Math.round(n * 100) / 100
        const gap = (a, b) => {
          const x = textBox(a)
          const y = textBox(b)
          return x && y ? round(y.top - x.bottom) : -1
        }
        const blank = kind => {
          const el = lines.find(l => l.classList.contains('cm-md-block-gap-' + kind))
          return el ? round(parseFloat(getComputedStyle(el).lineHeight)) : -1
        }
        return {
          blankLines: {
            'code-before': blank('code-before'),
            'code-after': blank('code-after'),
            'list-before': blank('list-before'),
            'list-after': blank('list-after')
          },
          gaps: {
            codeBefore: gap(find('正文甲'), find('const x = 1')),
            codeAfter: gap(find('const x = 1'), find('正文乙')),
            listBefore: gap(find('正文乙'), find('第一项')),
            listAfter: gap(find('第二项'), find('正文丙'))
          }
        }
      })()`)

  const tightMetrics = (): Promise<TightMetrics> =>
    evalJs<TightMetrics>(`
      (() => {
        ${TEXT_BOX}
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const find = text => lines.find(el => el.textContent.includes(text)) || null
        const round = n => Math.round(n * 100) / 100
        const pad = (el, side) => el ? round(parseFloat(getComputedStyle(el)['padding' + side])) : -1
        const gap = (a, b) => {
          const x = textBox(a)
          const y = textBox(b)
          return x && y ? round(y.top - x.bottom) : -1
        }
        const bodyA = find('正文甲')
        const bodyB = find('正文乙')
        const bodyC = find('正文丙')
        return {
          codeBeforePad: pad(bodyA, 'Bottom'),
          codeAfterPad: pad(bodyB, 'Top'),
          listBeforePad: pad(bodyB, 'Bottom'),
          listAfterPad: pad(bodyC, 'Top'),
          gaps: {
            codeBefore: gap(bodyA, find('const x = 1')),
            codeAfter: gap(find('const x = 1'), bodyB),
            listBefore: gap(bodyB, find('第一项')),
            listAfter: gap(find('第二项'), bodyC)
          }
        }
      })()`)

  const near = (a: number, b: number, tol = 0.6): boolean => Math.abs(a - b) <= tol

  // ---------- A ----------
  console.log('\n【A】有空行:默认 1 档,四个方向的空行各按各的档位收紧')

  const blankDefault = await blankMetrics()
  console.log(`     [实测] ${JSON.stringify(blankDefault)}`)
  const blankOk = (Object.keys(blankDefault.blankLines) as (keyof typeof blankDefault.blankLines)[]).every(
    k => near(blankDefault.blankLines[k], DEFAULT_GAP)
  )
  check('四条结构空行都是 1 × 正文尺寸(16px)', blankOk, JSON.stringify(blankDefault.blankLines))
  check(
    '四条空行确实属于不同的块 / 方向(类名互不覆盖)',
    (Object.values(blankDefault.blankLines) as number[]).filter(v => v >= 0).length === 4,
    JSON.stringify(blankDefault.blankLines)
  )

  // ---------- B ----------
  console.log('\n【B】紧贴正文:默认 1 档,间距落在相邻正文行的 padding 上')

  await loadDoc(TIGHT)
  // 装饰异步计算:等两侧 padding 类挂上再量
  await waitFor(
    `document.querySelector('.cm-md-gap-code-before') && document.querySelector('.cm-md-gap-list-after')`
  )
  const tightDefault = await tightMetrics()
  console.log(`     [实测] ${JSON.stringify(tightDefault)}`)
  check(
    '正文甲下留白(代码块上方)= 16px',
    near(tightDefault.codeBeforePad, DEFAULT_GAP),
    String(tightDefault.codeBeforePad)
  )
  check(
    '正文乙上留白(代码块下方)= 16px',
    near(tightDefault.codeAfterPad, DEFAULT_GAP),
    String(tightDefault.codeAfterPad)
  )
  check(
    '正文乙下留白(列表上方)= 16px',
    near(tightDefault.listBeforePad, DEFAULT_GAP),
    String(tightDefault.listBeforePad)
  )
  check(
    '正文丙上留白(列表下方)= 16px',
    near(tightDefault.listAfterPad, DEFAULT_GAP),
    String(tightDefault.listAfterPad)
  )

  // ---------- C ----------
  console.log('\n【C】设置 → 外观 → 块间距:滑块即时生效、写盘、重载后保留')

  await loadDoc(BLANK)
  const blankBefore = await blankMetrics()
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  check(
    '「样式」区里有七根块间距滑块(段间距 + 代码 / 列表 / 引用各上下两根)',
    await waitFor(`document.querySelectorAll('input[data-block-space]').length === 7`),
    '找不到 data-block-space 滑块'
  )

  async function setBlockSlider(side: string, value: number): Promise<boolean> {
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

  const sliderOk =
    (await setBlockSlider('codeBefore', 2)) &&
    (await setBlockSlider('codeAfter', 1.5)) &&
    (await setBlockSlider('listBefore', 0.5)) &&
    (await setBlockSlider('listAfter', 2.5))
  await sleep(400)

  const ui = await evalJs<{
    vars: Record<string, string>
    readouts: { side: string; value: number; text: string }[]
  }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      return {
        vars: {
          codeBefore: root.getPropertyValue('--md-code-space-before').trim(),
          codeAfter: root.getPropertyValue('--md-code-space-after').trim(),
          listBefore: root.getPropertyValue('--md-list-space-before').trim(),
          listAfter: root.getPropertyValue('--md-list-space-after').trim()
        },
        readouts: [...document.querySelectorAll('input[data-block-space]')].map(input => ({
          side: input.dataset.blockSpace,
          value: Number(input.value),
          text: input.parentElement?.querySelector('.settings-readout')?.textContent?.trim() ?? ''
        }))
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(ui)}`)
  const expectedVars = { codeBefore: '2', codeAfter: '1.5', listBefore: '0.5', listAfter: '2.5' }
  check(
    '四根滑块拖动后根变量同步',
    sliderOk && (Object.keys(expectedVars) as (keyof typeof expectedVars)[]).every(k => ui.vars[k] === expectedVars[k]),
    JSON.stringify(ui.vars)
  )
  check(
    '读数按「档 · px」显示',
    ui.readouts.some(r => r.side === 'codeBefore' && r.text.includes('2.0 档') && r.text.includes('32 px')) &&
      ui.readouts.some(r => r.side === 'codeAfter' && r.text.includes('1.5 档') && r.text.includes('24 px')) &&
      ui.readouts.some(r => r.side === 'listBefore' && r.text.includes('0.5 档') && r.text.includes('8 px')) &&
      ui.readouts.some(r => r.side === 'listAfter' && r.text.includes('2.5 档') && r.text.includes('40 px')),
    JSON.stringify(ui.readouts)
  )

  const blankAfter = await blankMetrics()
  console.log(`     [实测] ${JSON.stringify(blankAfter)}`)
  check(
    '编辑器不等关闭面板就已跟着变(空行 32 / 24 / 8 / 40px)',
    near(blankAfter.blankLines['code-before'], 32) &&
      near(blankAfter.blankLines['code-after'], 24) &&
      near(blankAfter.blankLines['list-before'], 8) &&
      near(blankAfter.blankLines['list-after'], 40),
    JSON.stringify(blankAfter.blankLines)
  )

  // D:文本间距的位移必须等于档位变化 × 正文字号(1 档 = 16px)
  const gapDelta = (side: keyof typeof blankBefore.gaps): number =>
    Math.round((blankAfter.gaps[side] - blankBefore.gaps[side]) * 100) / 100
  console.log(
    `     [文本间距变化] ${JSON.stringify({
      codeBefore: gapDelta('codeBefore'),
      codeAfter: gapDelta('codeAfter'),
      listBefore: gapDelta('listBefore'),
      listAfter: gapDelta('listAfter')
    })}`
  )
  check(
    '文本间距随档位变化(2/1.5/0.5/2.5 档的位移分别是 16 / 8 / −8 / 24px)',
    near(gapDelta('codeBefore'), (2 - 1) * BODY, 1) &&
      near(gapDelta('codeAfter'), (1.5 - 1) * BODY, 1) &&
      near(gapDelta('listBefore'), (0.5 - 1) * BODY, 1) &&
      near(gapDelta('listAfter'), (2.5 - 1) * BODY, 1),
    JSON.stringify({
      codeBefore: gapDelta('codeBefore'),
      codeAfter: gapDelta('codeAfter'),
      listBefore: gapDelta('listBefore'),
      listAfter: gapDelta('listAfter')
    })
  )

  {
    // 模块在「外观」页偏下,滚到「样式」标题,截图里才能看全整块
    await evalJs(`
      (() => {
        const title = [...document.querySelectorAll('.settings-section-title')]
          .find(t => t.textContent.trim() === '样式')
        title?.closest('.settings-section')?.scrollIntoView({ block: 'start' })
      })()`)
    await sleep(250)
    const image = await captureShot()
    if (image) await writeFile(join(shots, 'settings-block-space.png'), image.toPNG())
  }

  await sleep(500)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '四个档位都落到了 settings.json',
    saved.codeSpaceBefore === 2 &&
      saved.codeSpaceAfter === 1.5 &&
      saved.listSpaceBefore === 0.5 &&
      saved.listSpaceAfter === 2.5,
    JSON.stringify({
      codeBefore: saved.codeSpaceBefore,
      codeAfter: saved.codeSpaceAfter,
      listBefore: saved.listSpaceBefore,
      listAfter: saved.listSpaceAfter
    })
  )

  // 关掉面板,换回「紧贴」文档重新加载:新档位要按磁盘值还原,且各管各的
  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  await loadDoc(TIGHT)
  await waitFor(
    `document.querySelector('.cm-md-gap-code-before') && document.querySelector('.cm-md-gap-list-after')`
  )
  const restored = await tightMetrics()
  console.log(`     [实测] ${JSON.stringify(restored)}`)
  check(
    '重载后按磁盘值还原:代码块 32 / 24,列表 8 / 40',
    near(restored.codeBeforePad, 32) &&
      near(restored.codeAfterPad, 24) &&
      near(restored.listBeforePad, 8) &&
      near(restored.listAfterPad, 40),
    JSON.stringify(restored)
  )

  // ---------- E ----------
  console.log('\n【E】「样式」区的恢复默认设置:行间距、标题与块间距一起回到默认档')

  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  check('外观页里有「恢复默认设置」按钮', await waitFor(`document.querySelector('.settings-reset')`))
  await evalJs(`document.querySelector('.settings-reset')?.click()`)
  await sleep(700)

  const afterReset = await evalJs<{
    vars: Record<string, string>
    heading: number[]
    blocks: number[]
    line: number[]
  }>(`
    (() => {
      const root = getComputedStyle(document.documentElement)
      return {
        vars: {
          lineSpace: root.getPropertyValue('--editor-line-space').trim(),
          headingBefore: root.getPropertyValue('--md-heading-space-before').trim(),
          headingAfter: root.getPropertyValue('--md-heading-space-after').trim(),
          headingBetween: root.getPropertyValue('--md-heading-space-between').trim(),
          codeBefore: root.getPropertyValue('--md-code-space-before').trim(),
          codeAfter: root.getPropertyValue('--md-code-space-after').trim(),
          listBefore: root.getPropertyValue('--md-list-space-before').trim(),
          listAfter: root.getPropertyValue('--md-list-space-after').trim(),
          quoteBefore: root.getPropertyValue('--md-quote-space-before').trim(),
          quoteAfter: root.getPropertyValue('--md-quote-space-after').trim(),
          bodyBetween: root.getPropertyValue('--md-body-space-between').trim()
        },
        heading: [...document.querySelectorAll('input[data-heading-space]')].map(i => Number(i.value)),
        blocks: [...document.querySelectorAll('input[data-block-space]')].map(i => Number(i.value)),
        line: [...document.querySelectorAll('input[data-line-space]')].map(i => Number(i.value))
      }
    })()`)
  console.log(`     [实测] ${JSON.stringify(afterReset)}`)
  check(
    '十一根滑块与根变量都回到默认(行间距 1 档,标题 / 块 1 档)',
    afterReset.line.length === 1 &&
      afterReset.line[0] === 1 &&
      afterReset.vars.lineSpace === '1' &&
      afterReset.heading.every(v => v === 1) &&
      afterReset.blocks.length === 7 &&
      afterReset.blocks.every(v => v === 1) &&
      afterReset.vars.headingBefore === '1' &&
      afterReset.vars.headingAfter === '1' &&
      afterReset.vars.headingBetween === '1' &&
      afterReset.vars.bodyBetween === '1' &&
      afterReset.vars.codeBefore === '1' &&
      afterReset.vars.codeAfter === '1' &&
      afterReset.vars.listBefore === '1' &&
      afterReset.vars.listAfter === '1' &&
      afterReset.vars.quoteBefore === '1' &&
      afterReset.vars.quoteAfter === '1',
    JSON.stringify(afterReset)
  )

  const resetSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '恢复默认也写回了 settings.json',
    resetSaved.lineSpace === 1 &&
      resetSaved.headingSpaceBefore === 1 &&
      resetSaved.headingSpaceAfter === 1 &&
      resetSaved.headingSpaceBetween === 1 &&
      resetSaved.bodySpaceBetween === 1 &&
      resetSaved.codeSpaceBefore === 1 &&
      resetSaved.codeSpaceAfter === 1 &&
      resetSaved.listSpaceBefore === 1 &&
      resetSaved.listSpaceAfter === 1,
    JSON.stringify(resetSaved)
  )

  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  await loadDoc(TIGHT)
  // 重载后装饰是异步算的:等两侧 padding 类都挂上再量,避免读到首帧的裸行
  await waitFor(
    `document.querySelector('.cm-md-gap-code-before') && document.querySelector('.cm-md-gap-list-after')`
  )
  const resetPads = await tightMetrics()
  check(
    '重载后四个方向都是默认的 16px',
    near(resetPads.codeBeforePad, DEFAULT_GAP) &&
      near(resetPads.codeAfterPad, DEFAULT_GAP) &&
      near(resetPads.listBeforePad, DEFAULT_GAP) &&
      near(resetPads.listAfterPad, DEFAULT_GAP),
    JSON.stringify(resetPads)
  )

  // ---------- F ----------
  console.log('\n【F】收紧空行上的点击与光标:点空白不撑出一行,方向键停上去仍按正文行渲染')

  interface CaretMetrics {
    classes: string
    lineHeight: number
    cursorTop: number
    cursorBottom: number
    listBottom: number
    nextTop: number
    nextBoxTop: number
    blankTop: number
    doc: string
    selText: string
    selHead: number
    selLineFrom: number
    selLineTo: number
  }

  /**
   * 量「结构空行上的光标」。空行按 blockClass / padClass 二选一查找 ——
   * 光标不在上面时是 `cm-md-block-gap-*`,落上去之后换成 padding 类。
   */
  const caretMetrics = (blockClass: string, padClass: string, nextText: string): Promise<CaretMetrics> =>
    evalJs<CaretMetrics>(`
      (() => {
        ${TEXT_BOX}
        const view = document.querySelector('.cm-content').cmTile.root.view
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const find = text => lines.find(el => el.textContent.includes(text)) || null
        const blank = lines.find(
          el => el.classList.contains(${JSON.stringify(blockClass)}) || el.classList.contains(${JSON.stringify(padClass)})
        )
        const round = n => Math.round(n * 100) / 100
        const head = view.state.selection.main.head
        const coords = view.coordsAtPos(head)
        const caretLine = view.state.doc.lineAt(head)
        const last = find('第二项')
        const next = find(${JSON.stringify(nextText)})
        const lb = textBox(last)
        const nt = textBox(next)
        return {
          classes: blank ? blank.className : '',
          lineHeight: blank ? round(blank.getBoundingClientRect().height) : -1,
          cursorTop: coords ? round(coords.top) : -1,
          cursorBottom: coords ? round(coords.bottom) : -1,
          listBottom: lb ? round(lb.bottom) : -1,
          nextTop: nt ? round(nt.top) : -1,
          nextBoxTop: next ? round(next.getBoundingClientRect().top) : -1,
          blankTop: blank ? round(blank.getBoundingClientRect().top) : -1,
          doc: view.state.doc.toString(),
          selText: caretLine.text,
          selHead: head,
          selLineFrom: caretLine.from,
          selLineTo: caretLine.to
        }
      })()`)

  /** 用 Chromium 的真实输入事件点这条收紧空行的行盒中心 */
  async function clickGapLine(blockClass: string): Promise<boolean> {
    const point = await evalJs<{ x: number; y: number }>(`
      (() => {
        const el = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(l => l.classList.contains(${JSON.stringify(blockClass)}))
        if (!el) return { x: -1, y: -1 }
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (point.x < 0) return false
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await sleep(350)
    return true
  }

  /** 那条空行在文档里的位置(模拟方向键把光标移上去) */
  const gapLinePos = (blockClass: string): Promise<number> =>
    evalJs<number>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const el = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(l => l.classList.contains(${JSON.stringify(blockClass)}))
        return el ? view.posAtDOM(el) : -1
      })()`)

  async function caretFlow(
    blockClass: string,
    padClass: string,
    nextText: string,
    expected: string,
    side: 'before' | 'after',
    label: string
  ): Promise<void> {
    await loadDoc(BLANK)
    // 重载是整页的,文件读取 / 语法树 / 首轮装饰和 did-finish-load 不同步
    const ready = await waitFor(
      `[...document.querySelectorAll('.cm-content .cm-line')].some(l => l.classList.contains(${JSON.stringify(blockClass)}))`
    )
    check(`${label}:重载后结构空行已渲染`, ready, blockClass)
    const compact = await caretMetrics(blockClass, padClass, nextText)
    check(
      `${label}:光标不在时仍按 1 档收紧`,
      compact.classes.includes(blockClass) && !compact.classes.includes(padClass) && near(compact.lineHeight, DEFAULT_GAP),
      JSON.stringify(compact)
    )

    // 鼠标点空白:空行保持收紧,光标落到相邻正文,下面的内容一动不动
    const clickedOk = await clickGapLine(blockClass)
    const clicked = await caretMetrics(blockClass, padClass, nextText)
    check(
      `${label}:点空白不会把空行撑成一行`,
      clickedOk &&
        clicked.classes.includes(blockClass) &&
        !clicked.classes.includes(padClass) &&
        near(clicked.lineHeight, DEFAULT_GAP) &&
        // 版式没动:下一块的行盒相对空行不变(文字盒/绝对坐标会被焦点等微调)
        near(clicked.nextBoxTop - clicked.blankTop, compact.nextBoxTop - compact.blankTop),
      JSON.stringify({ compact, clicked })
    )
    check(
      `${label}:光标落到相邻正文(${expected})`,
      clicked.selText.includes(expected) && clicked.doc === compact.doc,
      JSON.stringify({ expected, selText: clicked.selText })
    )
    check(
      `${label}:落点是${side === 'before' ? '上一行行尾' : '下一行行首'}`,
      side === 'before' ? clicked.selHead === clicked.selLineTo : clicked.selHead === clicked.selLineFrom,
      JSON.stringify({ side, head: clicked.selHead, from: clicked.selLineFrom, to: clicked.selLineTo })
    )

    // 方向键停上空行(直接落选区):仍按正文行撑开,输入首字不再跳
    const pos = await gapLinePos(blockClass)
    await evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        view.dispatch({ selection: { anchor: ${pos} } })
        return true
      })()`)
    await sleep(350)
    const expanded = await caretMetrics(blockClass, padClass, nextText)
    check(
      `${label}:方向键停上去后空行按正文行渲染(间距改走 padding)`,
      pos >= 0 &&
        expanded.classes.includes(padClass) &&
        !expanded.classes.includes('cm-md-block-gap') &&
        expanded.lineHeight > DEFAULT_GAP,
      JSON.stringify({ pos, expanded })
    )
    check(
      `${label}:光标不再贴在上一块的下沿`,
      expanded.cursorTop > compact.cursorTop + DEFAULT_GAP / 2,
      JSON.stringify({ before: compact.cursorTop, after: expanded.cursorTop })
    )

    await evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const sel = view.state.selection.main
        view.dispatch({ changes: { from: sel.from, insert: '1' } })
        return true
      })()`)
    await sleep(350)
    const typed = await caretMetrics(blockClass, padClass, nextText)
    check(
      `${label}:输入首字前后光标与下一段正文的位置完全一致`,
      near(typed.cursorTop, expanded.cursorTop) &&
        near(typed.cursorBottom, expanded.cursorBottom) &&
        near(typed.nextTop, expanded.nextTop),
      JSON.stringify({ expanded, typed })
    )
  }

  await caretFlow('cm-md-block-gap-list-after', 'cm-md-gap-list-after', '正文丙', '正文丙。', 'after', '列表后')
  await caretFlow('cm-md-block-gap-list-before', 'cm-md-gap-list-before', '第一项', '正文乙。', 'before', '列表前')
  await caretFlow('cm-md-block-gap-code-after', 'cm-md-gap-code-after', '正文乙', '正文乙。', 'after', '代码块后')
  // 上侧同样走一遍:空行在块前面(间距做成 padding-bottom,光标本来就在行顶)
  await caretFlow('cm-md-block-gap-code-before', 'cm-md-gap-code-before', 'const x = 1', '正文甲。', 'before', '代码块前')

  // 光标离开后必须恢复收紧,不能留下变高的空行
  await loadDoc(BLANK)
  await waitFor(`[...document.querySelectorAll('.cm-content .cm-line')].some(l => l.classList.contains('cm-md-block-gap-list-after'))`)
  const leavePos = await gapLinePos('cm-md-block-gap-list-after')
  await evalJs(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${leavePos} } })
      return true
    })()`)
  await sleep(350)
  const expandedBeforeLeave = await caretMetrics('cm-md-block-gap-list-after', 'cm-md-gap-list-after', '正文丙')
  await evalJs(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: view.state.doc.line(1).from } })
      return true
    })()`)
  await sleep(350)
  const afterLeave = await caretMetrics('cm-md-block-gap-list-after', 'cm-md-gap-list-after', '正文丙')
  check(
    '光标离开后空行恢复收紧(16px),不留变高的空行',
    leavePos >= 0 &&
      expandedBeforeLeave.classes.includes('cm-md-gap-list-after') &&
      afterLeave.classes.includes('cm-md-block-gap-list-after') &&
      near(afterLeave.lineHeight, DEFAULT_GAP),
    JSON.stringify({ leavePos, expandedBeforeLeave, afterLeave })
  )

  // ---------- G ----------
  console.log('\n【G】段间距:两段正文之间的空行按「段间距」这一档收紧')

  /** 两段正文之间、以及段落与标题之间各有一条空行 */
  const BODY_BLANK = ['第一段正文。', '', '第二段正文。', '', '## 二级标题', '', '第三段正文。', ''].join('\n')

  interface BodyGapMetrics {
    lines: { i: number; cls: string; h: number; text: string }[]
    bodyCount: number
    bodyH: number
    selText: string
  }

  const bodyGapMetrics = (): Promise<BodyGapMetrics> =>
    evalJs<BodyGapMetrics>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const round = n => Math.round(n * 100) / 100
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const body = lines.filter(el => el.classList.contains('cm-md-block-gap-body'))
        return {
          lines: lines.map((el, i) => ({ i, cls: el.className, h: round(el.getBoundingClientRect().height), text: el.textContent })),
          bodyCount: body.length,
          bodyH: body[0] ? round(body[0].getBoundingClientRect().height) : -1,
          selText: view.state.doc.lineAt(view.state.selection.main.head).text
        }
      })()`)

  await loadDoc(BODY_BLANK)
  check(
    '正文之间的空行已按「段间距」渲染',
    await waitFor(`document.querySelectorAll('.cm-line.cm-md-block-gap-body').length === 1`),
    '找不到 cm-md-block-gap-body'
  )
  const bodyDefault = await bodyGapMetrics()
  console.log(`     [实测] ${JSON.stringify(bodyDefault)}`)
  check('默认 1 档(16px)', near(bodyDefault.bodyH, DEFAULT_GAP), String(bodyDefault.bodyH))
  check(
    '只有两段正文之间的空行被收紧(段落与标题之间仍是正常行距)',
    bodyDefault.bodyCount === 1 &&
      bodyDefault.lines[3]?.cls.split(/\s+/).includes('cm-line') &&
      !bodyDefault.lines[3]?.cls.includes('cm-md-block-gap') &&
      bodyDefault.lines[3].h > DEFAULT_GAP + 8,
    JSON.stringify(bodyDefault.lines)
  )

  // 点这条空行:不撑开,光标落到上一段末尾
  const bodyClick = await evalJs<{ x: number; y: number }>(`
    (() => {
      const el = document.querySelector('.cm-line.cm-md-block-gap-body')
      if (!el) return { x: -1, y: -1 }
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }
    })()`)
  if (bodyClick.x >= 0) {
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x: bodyClick.x, y: bodyClick.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: bodyClick.x, y: bodyClick.y, button: 'left', clickCount: 1 })
    await sleep(350)
  }
  const bodyClicked = await bodyGapMetrics()
  check(
    '点正文之间的空行:空行不撑开,光标落到上一段末尾',
    bodyClick.x >= 0 &&
      near(bodyClicked.bodyH, DEFAULT_GAP) &&
      bodyClicked.selText.includes('第一段正文。'),
    JSON.stringify({ bodyClick, bodyClicked })
  )

  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  check(
    '「样式」区里有「段间距」滑块',
    await waitFor(`document.querySelector('input[data-block-space="bodyBetween"]')`),
    '找不到 data-block-space="bodyBetween"'
  )
  const bodySlider = await evalJs<boolean>(`
    (() => {
      const input = document.querySelector('input[data-block-space="bodyBetween"]')
      if (!input) return false
      input.value = '2'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  await sleep(400)
  const bodySet = await bodyGapMetrics()
  const bodyUi = await evalJs<{ space: string; readout: string }>(`
    (() => {
      const input = document.querySelector('input[data-block-space="bodyBetween"]')
      return {
        space: getComputedStyle(document.documentElement).getPropertyValue('--md-body-space-between').trim(),
        readout: input?.closest('.settings-control')?.querySelector('.settings-readout')?.textContent ?? ''
      }
    })()`)
  check(
    '拖到 2 档后空行变成 32px,读数正确',
    bodySlider &&
      near(bodySet.bodyH, 32) &&
      bodyUi.space === '2' &&
      bodyUi.readout.includes('2.0 档') &&
      bodyUi.readout.includes('32 px'),
    JSON.stringify({ bodyH: bodySet.bodyH, bodyUi })
  )
  await sleep(500)
  const bodySaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check('「段间距」写进了 settings.json', bodySaved.bodySpaceBetween === 2, String(bodySaved.bodySpaceBetween))

  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  await loadDoc(BODY_BLANK)
  await waitFor(`document.querySelectorAll('.cm-line.cm-md-block-gap-body').length === 1`)
  const bodyReloaded = await bodyGapMetrics()
  check('重载后按磁盘值还原(32px)', near(bodyReloaded.bodyH, 32), String(bodyReloaded.bodyH))

  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  await waitFor(`document.querySelector('.settings-reset')`)
  await evalJs(`document.querySelector('.settings-reset')?.click()`)
  await sleep(700)
  const bodyReset = await bodyGapMetrics()
  check('恢复默认后「段间距」回到 1 档(16px)', near(bodyReset.bodyH, DEFAULT_GAP), String(bodyReset.bodyH))

  // ---------- H ----------
  console.log('\n【H】行间距:同一段内连续行的行高按档位变化,不需要空行')

  /** 三行连写 = 一个段落(CommonMark 里没有空行就是同一段),文中没有任何结构空行 */
  const LINES = ['第一行正文。', '第二行正文。', '第三行正文。', ''].join('\n')
  /** 默认 1 档:行高 = (1 + 1) × 正文字号 */
  const LINE_H = 2 * BODY

  interface LineSpaceMetrics {
    texts: string[]
    heights: number[]
    advance: number
    vars: string
  }

  const lineSpaceMetrics = (): Promise<LineSpaceMetrics> =>
    evalJs<LineSpaceMetrics>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const round = n => Math.round(n * 100) / 100
        return {
          texts: lines.map(el => el.textContent),
          heights: lines.map(el => round(el.getBoundingClientRect().height)),
          advance:
            lines.length > 1
              ? round(lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top)
              : -1,
          vars: getComputedStyle(document.documentElement).getPropertyValue('--editor-line-space').trim()
        }
      })()`)

  await loadDoc(LINES)
  await waitFor(`document.querySelectorAll('.cm-content .cm-line').length === 4`)
  const lineDefault = await lineSpaceMetrics()
  console.log(`     [实测] ${JSON.stringify(lineDefault)}`)
  check(
    '默认 1 档:同一段三行都是 32px,行与行紧挨着',
    lineDefault.heights.length >= 3 &&
      lineDefault.heights.slice(0, 3).every(h => near(h, LINE_H, 0.8)) &&
      near(lineDefault.advance, LINE_H, 0.8) &&
      lineDefault.vars === '1',
    JSON.stringify(lineDefault)
  )

  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  check(
    '「样式」区里有「行间距」滑块',
    await waitFor(`document.querySelector('input[data-line-space="lineSpace"]')`),
    '找不到 data-line-space="lineSpace"'
  )

  const SPACING_SLIDERS =
    'input[data-heading-space], input[data-block-space], input[data-line-space]'
  const spacingWidths = await evalJs<number[]>(`
    [...document.querySelectorAll(${JSON.stringify(SPACING_SLIDERS)})]
      .map(i => Math.round(i.getBoundingClientRect().width * 10) / 10)`)
  check(
    '行间距与标题 / 段间距 / 块间距十一根滑块等宽',
    spacingWidths.length === 11 && spacingWidths.every(w => Math.abs(w - spacingWidths[0]) <= 0.5),
    JSON.stringify(spacingWidths)
  )

  // 读数从「1.0 档 · 16 px」缩成「0.1 档 · 2 px」:滑杆不能跟着变短
  const narrowSlider = await evalJs<boolean>(`
    (() => {
      const input = document.querySelector('input[data-block-space="bodyBetween"]')
      if (!input) return false
      input.value = '0.1'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  await sleep(400)
  const narrowInfo = await evalJs<{ widths: number[]; readout: string }>(`
    (() => {
      const input = document.querySelector('input[data-block-space="bodyBetween"]')
      return {
        widths: [...document.querySelectorAll(${JSON.stringify(SPACING_SLIDERS)})]
          .map(i => Math.round(i.getBoundingClientRect().width * 10) / 10),
        readout: input?.closest('.settings-control')?.querySelector('.settings-readout')?.textContent ?? ''
      }
    })()`)
  check(
    '拖到 0.1 档、读数变短后滑块长度不变',
    narrowSlider &&
      narrowInfo.readout.includes('0.1 档') &&
      narrowInfo.readout.includes('2 px') &&
      narrowInfo.widths.every(w => Math.abs(w - spacingWidths[0]) <= 0.5),
    JSON.stringify(narrowInfo)
  )

  const lineSlider = await evalJs<boolean>(`
    (() => {
      const input = document.querySelector('input[data-line-space="lineSpace"]')
      if (!input) return false
      input.value = '1.6'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  await sleep(400)
  const lineSet = await lineSpaceMetrics()
  const lineUi = await evalJs<string>(`
    (() => {
      const input = document.querySelector('input[data-line-space="lineSpace"]')
      return input?.closest('.settings-control')?.querySelector('.settings-readout')?.textContent ?? ''
    })()`)
  console.log(`     [实测] ${JSON.stringify({ lineSet, readout: lineUi })}`)
  check(
    '拖到 1.6 档:行高与行间位移都变成 41.6px,读数按「档 · px」显示',
    lineSlider &&
      lineSet.heights.slice(0, 3).every(h => near(h, (1 + 1.6) * BODY, 0.8)) &&
      near(lineSet.advance, (1 + 1.6) * BODY, 0.8) &&
      lineSet.vars === '1.6' &&
      lineUi.includes('1.6 档') &&
      lineUi.includes('26 px'),
    JSON.stringify({ lineSet, readout: lineUi })
  )

  await sleep(500)
  const lineSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check('行间距写进了 settings.json', lineSaved.lineSpace === 1.6, String(lineSaved.lineSpace))

  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await sleep(200)
  await loadDoc(LINES)
  await waitFor(`document.querySelectorAll('.cm-content .cm-line').length === 4`)
  const lineReloaded = await lineSpaceMetrics()
  check(
    '重载后按磁盘值还原(41.6px)',
    lineReloaded.heights.slice(0, 3).every(h => near(h, (1 + 1.6) * BODY, 0.8)) &&
      lineReloaded.vars === '1.6',
    JSON.stringify(lineReloaded)
  )

  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  await waitFor(`document.querySelector('.settings-reset')`)
  await evalJs(`document.querySelector('.settings-reset')?.click()`)
  await sleep(700)
  const lineReset = await lineSpaceMetrics()
  check(
    '恢复默认后行间距回到 1 档(32px)',
    near(lineReset.heights[0], LINE_H, 0.8) && lineReset.vars === '1',
    JSON.stringify(lineReset)
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
