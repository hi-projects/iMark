/**
 * 验收:「外观 → 间距」右栏预览画出来的距离 = 编辑器里实际排出来的距离。
 *
 * 用户报告:设置里的正文预览三条「正文内容。」挨得近,回到编辑器里三段
 * 「阿」却拉得开 —— 预览和渲染不一致。
 *
 * 预览里正文样本用 text-box-trim 裁掉了首行上 / 末行下的半份行距,段与段
 * 之间只剩配对间距;编辑器里 rules.ts 也挂了同样的 cm-md-para-trim-* 类,
 * 但 CSS 里如果没有对应规则,那半份行距根本没被裁掉,于是编辑器比预览
 * 多出「上半份 + 下半份」两截行距。
 *
 * 断言:
 *   A 正文自身配对:预览三行的缝 = 编辑器四行里对应的缝(段内换行 / 段与段);
 *   B 预览里的缝高度 = 配对值 × 正文字号(1 档 × 15px);
 *   C 预览正文的字体 / 字号与编辑器正文一致(同一套度量才会画到一条线上);
 *   D 正文在上 / 标题在下:预览里正文样本到标题样本的距离 = 编辑器里
 *     正文文字到标题文字的距离(段落面向任何顶层块都要裁)。
 *
 * 跑法(改了 src/renderer/** 之后先 `npm run build`,再在仓库根目录):
 *   xvfb-run -a node verify/run.mjs spacing-preview-match
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

const BODY = 15

/**
 * 第一段两行(段内换行)+ 空行 + 第二段 + 空行 + 第三段。
 * 编辑器里四条文字依次是:段内、段与段、段与段;
 * 预览里恰好也是三条缝:前两行属同一段,第三行是另一段。
 */
const DOC = ['阿', '阿', '', '阿', '', '阿', ''].join('\n')

/** 正文在上、标题在下:检查跨块配对时预览与编辑器也画到同一条缝 */
const PAIR_DOC = ['阿', '', '## 标题', ''].join('\n')

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

/** 验收窗口一律不真显示(跑在 xvfb 上,桌面看不到窗口) */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

interface Metrics {
  /** 编辑器里每条非空文字行的文字盒子 */
  editor: { top: number; bottom: number; height: number }[]
  /** 预览里三行文字(上样本两行 + 下样本一行) */
  preview: { top: number; bottom: number; height: number }[]
  /** 预览里的缝 div 高度 */
  previewGap: number
  /** 预览正文的字体 / 字号 */
  previewFontFamily: string
  previewFontSize: number
  /** 编辑器正文的字体 / 字号 */
  editorFontFamily: string
  editorFontSize: number
  /** 段内两行行盒高度(编辑器) */
  editorBoxHeight: number
}

interface PairMetrics {
  /** 编辑器里的正文行、标题行 */
  editor: { top: number; bottom: number }[]
  /** 预览里的正文样本、标题样本 */
  preview: { top: number; bottom: number }[]
  pairKey: string
  previewGap: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error(
      '拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs spacing-preview-match` 跑会自动带上)'
    )
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
  const note = join(vault, '预览.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, DOC, 'utf8')
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
        editorFontSizeVersion: 2,
        lineSpace: 1,
        pairGaps: { 'body-body': 1 }
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
  win.setContentSize(1000, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
  }

  /** 打开设置 → 外观(圆环在空状态) */
  async function openAppearance(): Promise<boolean> {
    await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
    if (!(await waitFor(`document.querySelector('.settings-nav-item')`))) return false
    await evalJs(`
      [...document.querySelectorAll('.settings-nav-item')]
        .find(b => b.textContent.trim() === '外观')
        ?.click()`)
    return waitFor(`document.querySelector('[data-spacing-ring]')`)
  }

  async function pick(kind: string): Promise<void> {
    await evalJs(
      `document.querySelector('.spacing-ring-node[data-block-node="${kind}"]')?.click()`
    )
    await sleep(150)
  }

  /** 打开设置 → 外观,连点两次「正文」进入同类配对(段间距 + 行间距) */
  async function openBodySelf(): Promise<boolean> {
    if (!(await openAppearance())) return false
    await pick('body')
    await pick('body')
    return waitFor(`document.querySelector('[data-pair-mode="self"]')`)
  }

  /** 打开设置 → 外观,先点正文(上)再点标题(下) */
  async function openBodyHeading(): Promise<boolean> {
    if (!(await openAppearance())) return false
    await pick('body')
    await pick('heading')
    return waitFor(`document.querySelector('[data-pair-mode="cross"]')`)
  }

  const metrics = (): Promise<Metrics | null> =>
    evalJs<Metrics | null>(`
      (() => {
        const rects = els => els.map(el => {
          const range = document.createRange()
          range.selectNodeContents(el)
          const r = range.getBoundingClientRect()
          return {
            top: Math.round(r.top * 100) / 100,
            bottom: Math.round(r.bottom * 100) / 100,
            height: Math.round(r.height * 100) / 100
          }
        })

        const editorLines = [...document.querySelectorAll('.cm-content .cm-line')]
          .filter(el => (el.textContent || '').trim())
        const previewRows = [
          ...document.querySelectorAll('.spacing-doc-sample[data-sample="body"] .spacing-doc-body > div')
        ]
        const gapEl = document.querySelector('[data-preview-gap]')
        const previewDoc = document.querySelector('[data-preview-doc]')
        const scroller = document.querySelector('.cm-scroller')
        if (editorLines.length < 4 || previewRows.length !== 3 || !gapEl || !previewDoc || !scroller) {
          return null
        }
        const previewStyle = getComputedStyle(previewDoc)
        const editorStyle = getComputedStyle(scroller)
        return {
          editor: rects(editorLines),
          preview: rects(previewRows),
          previewGap: Math.round(parseFloat(getComputedStyle(gapEl).height) * 100) / 100,
          previewFontFamily: previewStyle.fontFamily,
          previewFontSize: parseFloat(previewStyle.fontSize),
          editorFontFamily: editorStyle.fontFamily,
          editorFontSize: parseFloat(editorStyle.fontSize),
          editorBoxHeight: Math.round(editorLines[0].getBoundingClientRect().height * 100) / 100
        }
      })()`)

  /** 相邻两段文字的空白:上一块底 → 下一块顶 */
  const gapOf = (rows: { top: number; bottom: number }[], i: number): number =>
    Math.round((rows[i + 1].top - rows[i].bottom) * 100) / 100

  const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol

  console.log('\n【A】预览与编辑器的三处缝一一对齐')
  const opened = await openBodySelf()
  check('设置面板打开并进入「正文与正文」', opened)
  const m = await metrics()
  check('能同时量到编辑器与预览', !!m, JSON.stringify(m))
  if (!m) {
    console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
    app.exit(1)
    return
  }

  const editorSoft = gapOf(m.editor, 0)
  const editorPara1 = gapOf(m.editor, 1)
  const editorPara2 = gapOf(m.editor, 2)
  const previewSoft = gapOf(m.preview, 0)
  const previewPara = gapOf(m.preview, 1)
  console.log(
    `     编辑器: 段内 ${editorSoft} / 段间 ${editorPara1}, ${editorPara2}` +
      ` | 预览: 段内 ${previewSoft} / 段间 ${previewPara} | 预览缝 ${m.previewGap}px`
  )
  console.log(
    `     字体: 编辑器 ${m.editorFontFamily} ${m.editorFontSize}px` +
      ` | 预览 ${m.previewFontFamily} ${m.previewFontSize}px`
  )

  check(
    '段内换行:预览与编辑器的文字距离一致',
    near(previewSoft, editorSoft),
    JSON.stringify({ previewSoft, editorSoft })
  )
  check(
    '段与段:预览与编辑器的文字距离一致(第一条)',
    near(previewPara, editorPara1),
    JSON.stringify({ previewPara, editorPara1 })
  )
  check(
    '段与段:预览与编辑器的文字距离一致(第二条,前后段相同)',
    near(previewPara, editorPara2),
    JSON.stringify({ previewPara, editorPara2 })
  )
  check(
    '段与段的距离不随行间距之外的因素漂移(两处段间一致)',
    near(editorPara1, editorPara2),
    JSON.stringify({ editorPara1, editorPara2 })
  )

  console.log('\n【B】预览的缝就是配对值')
  check(
    `预览缝 = 1 档 × ${BODY}px`,
    near(m.previewGap, BODY),
    JSON.stringify({ previewGap: m.previewGap, expected: BODY })
  )
  check(
    '段与段的文字距离 = 预览缝(裁掉半份行距后只剩这一档)',
    near(previewPara, m.previewGap),
    JSON.stringify({ previewPara, previewGap: m.previewGap })
  )

  console.log('\n【C】预览与编辑器用同一套正文字体 / 字号')
  check(
    '字号一致',
    m.previewFontSize === m.editorFontSize,
    JSON.stringify({ preview: m.previewFontSize, editor: m.editorFontSize })
  )
  check(
    '字体栈一致(预览沿用文档正文的 --font-text)',
    m.previewFontFamily === m.editorFontFamily,
    JSON.stringify({ preview: m.previewFontFamily, editor: m.editorFontFamily })
  )

  console.log('\n【D】正文在上 / 标题在下:跨块配对也画到同一条缝')
  await loadDoc(PAIR_DOC)
  const openedPair = await openBodyHeading()
  check('设置面板打开并进入「正文在上 / 标题在下」', openedPair)
  const pm = await evalJs<PairMetrics | null>(`
    (() => {
      const rect = el => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const r = range.getBoundingClientRect()
        return {
          top: Math.round(r.top * 100) / 100,
          bottom: Math.round(r.bottom * 100) / 100
        }
      }
      const editorLines = [...document.querySelectorAll('.cm-content .cm-line')]
        .filter(el => (el.textContent || '').trim())
      const bodySample = document.querySelector('.spacing-doc-sample[data-sample="body"]')
      const headSample = document.querySelector('.spacing-doc-sample[data-sample="heading"]')
      const gapEl = document.querySelector('[data-preview-gap]')
      const panel = document.querySelector('[data-pair-panel]')
      if (editorLines.length < 2 || !bodySample || !headSample || !gapEl || !panel) return null
      return {
        editor: editorLines.slice(0, 2).map(rect),
        preview: [rect(bodySample), rect(headSample)],
        pairKey: panel.getAttribute('data-pair-panel') ?? '',
        previewGap: Math.round(parseFloat(getComputedStyle(gapEl).height) * 100) / 100
      }
    })()`)
  check('能同时量到正文、标题与两侧样本', !!pm, JSON.stringify(pm))
  if (pm) {
    const editorPairGap = Math.round((pm.editor[1].top - pm.editor[0].bottom) * 100) / 100
    const previewPairGap = Math.round((pm.preview[1].top - pm.preview[0].bottom) * 100) / 100
    console.log(
      `     配对 ${pm.pairKey}: 编辑器 ${editorPairGap} | 预览 ${previewPairGap}` +
        ` | 预览缝 ${pm.previewGap}px`
    )
    check('选中的是正文 → 标题配对', pm.pairKey === 'body-heading', JSON.stringify(pm))
    check(
      '跨块配对:预览与编辑器的文字距离一致',
      near(previewPairGap, editorPairGap),
      JSON.stringify({ previewPairGap, editorPairGap })
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
