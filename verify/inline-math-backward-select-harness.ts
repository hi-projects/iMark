/**
 * 复现:在「得到数据样本:求解器输出的最终状态$x_1=\phi_1(x_0)$即是一个(近似)
 * 服从真实数据分布的样本;」这一行末尾按下左键往左拖,想把整行选中,但选区
 * 最多只能到行内公式 `$x_1=\phi_1(x_0)$` 的左边缘,再往左拖不动。
 *
 * 根因(实测):光标停在这一行时,行首「+」装饰(lineMenu 的 LinePlusWidget)
 * 在行首插入一个隐藏的零长 widget。它和 CodeMirror 补的 cm-widgetBuffer 一起
 * 把这一行的 tile 子节点从 6 个变成 8 个;CM 的 InlineCoordsScan 二分查找
 * 因此走上另一条路径,把列表圆点那格「font-size:0 / line-height:0」的零高
 * 矩形当成"在鼠标下方",把搜索范围收在前两个零长子节点里,再也没访问到公式
 * 左边那段文字。结果 view.posAtCoords 对公式左边的任意 x 都返回公式起点,
 * 拖选/点击都卡在公式左边缘。
 *
 * 断言:
 *   A 光标不在这一行(行首「+」不存在)时,公式左边文字的坐标能解析回文字
 *   B 光标停在这一行行尾(行首「+」出现)时,同样的坐标仍应解析回文字
 *   B2 列表行的行首「+」在文字行的垂直中线上(圆点是零高装饰,不能拿它当基准)
 *   C 从行尾往左拖到公式左侧,选区必须越过公式左边缘、包含公式前面的文字
 *
 * 修好之前 A 通过、B/C 失败;现在四条都应通过。
 *
 * 跑法(先 npx electron-vite build;Windows 无人值守加 IMARK_VERIFY_HIDDEN=1):
 *   IMARK_VERIFY_HIDDEN=1 node verify/run.mjs inline-math-backward-select
 */
import { app, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { APP_VERSION } from './appVersion'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const NEEDLE = '得到数据样本'

/** 目标行照抄 Flow Matching.md 第 40 行;前后各留一点内容,让行处在完整列表里 */
const DOC = [
  '# 复现',
  '',
  '- 从先验分布采样：从标准高斯分布中随机抽取一个纯噪声 $x_0∼N(0,I)$；',
  '- 送入 ODE 求解器：将$x_0$作为初始状态（t=0），利用训练好的神经网络$v_t(x)$作为导数；',
  '- 得到数据样本：求解器输出的最终状态$x_1=\\phi_1(x_0)$即是一个（近似）服从真实数据分布的样本；',
  '',
  '后记。',
  ''
].join('\n')

interface LineInfo {
  lineNumber: number
  lineFrom: number
  lineTo: number
  widgetFrom: number
  widgetTo: number
  /** 鼠标起点:行尾文字右缘 */
  endLeft: number
  /** 公式左侧文字的探测点(x 取文字格中点) */
  probeX: number
  y: number
  lineLeft: number
  /** 同一探测坐标在光标不在该行时应解析到的文档位置 */
  expectedProbePos: number
  rendered: boolean
}

interface ProbeState {
  hit: number | null
  anchor: number
  head: number
  from: number
  to: number
  selText: string
  rendered: boolean
  srcShown: boolean
  /** 行首「+」在文档里挂的第几行(data-line);没有按钮为 -1 */
  plusLine: number
  /** 「+」中心与目标行文字行中心的垂直偏差(px);按钮/文字有一侧缺坐标时为 null */
  plusDelta: number | null
}

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
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
  const note = join(vault, 'Flow Matching.md')
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
        autoSave: false,
        theme: 'dark',
        editorFontSize: 15,
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
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(1500, 1000)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1800)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  // 滚到目标行
  await evalJs(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const pos = v.state.doc.toString().indexOf(${JSON.stringify(NEEDLE)})
      if (pos < 0) return false
      document.querySelector('.cm-scroller').scrollTop = Math.max(0, v.lineBlockAt(pos).top - 200)
      return true
    })()`)
  await sleep(600)

  // 量出目标行 / 公式 / 探测点的坐标
  const target = await evalJs<LineInfo | null>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      const idx = doc.indexOf(${JSON.stringify(NEEDLE)})
      if (idx < 0) return null
      const line = v.state.doc.lineAt(idx)
      const widgetFrom = doc.indexOf('$x_1=', line.from)
      const widgetTo = doc.indexOf('$', widgetFrom + 1) + 1
      const lineEl = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(NEEDLE)}))
      const mathEl = lineEl ? lineEl.querySelector('.cm-md-math-inline') : null
      const end = v.coordsAtPos(line.to)
      const lineStart = v.coordsAtPos(line.from)
      // 公式左侧第 8 个字符附近(落在文字格中间,而不是格子边线上)
      const probeChar = Math.max(line.from + 1, widgetFrom - 8)
      const probeRect = v.coordsAtPos(probeChar)
      if (!end || !lineStart || !probeRect) return null
      const probeX = Math.round((probeRect.left + probeRect.right) / 2)
      const y = Math.round((probeRect.top + probeRect.bottom) / 2)
      const expectedProbePos = v.posAtCoords({ x: probeX, y })
      return {
        lineNumber: line.number,
        lineFrom: line.from,
        lineTo: line.to,
        widgetFrom,
        widgetTo,
        endLeft: Math.round(end.left),
        probeX,
        y,
        lineLeft: Math.round(lineStart.left),
        expectedProbePos: expectedProbePos ?? -1,
        rendered: !!mathEl
      }
    })()`)
  console.log('[target]', JSON.stringify(target))
  if (!target || target.expectedProbePos < 0) {
    console.log('目标行没量出来,文档/视口可能不对')
    app.exit(2)
    return
  }

  const probe = (): Promise<ProbeState> =>
    evalJs(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const doc = v.state.doc.toString()
        const sel = v.state.selection.main
        const lineEl = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => (el.textContent || '').includes(${JSON.stringify(NEEDLE)}))
        const plus = document.querySelector('.line-plus')
        const plusRect = plus ? plus.getBoundingClientRect() : null
        // 行尾文字的行盒:列表圆点本身是零高装饰,不能拿它当基准
        const textRect = v.coordsAtPos(${target.lineTo})
        const plusDelta =
          plusRect && textRect
            ? Math.round(
                (plusRect.top + plusRect.height / 2 - (textRect.top + textRect.bottom) / 2) *
                  10
              ) / 10
            : null
        return {
          hit: v.posAtCoords({ x: ${target.probeX}, y: ${target.y} }),
          anchor: sel.anchor,
          head: sel.head,
          from: sel.from,
          to: sel.to,
          selText: doc.slice(sel.from, sel.to),
          rendered: lineEl ? !!lineEl.querySelector('.cm-md-math-inline') : false,
          srcShown: lineEl ? (lineEl.textContent || '').includes('$x_1') : false,
          plusLine: plus ? Number(plus.dataset.line) : -1,
          plusDelta
        }
      })()`)

  console.log('[probe-away]', JSON.stringify(await probe()))

  // A: 光标不在这一行,行首「+」不存在 —— 探测坐标应解析到公式左边的文字
  const away = await probe()
  check(
    'A 光标不在该行时,公式左侧的坐标解析到左侧文字',
    away.hit !== null && away.hit < target.widgetFrom && away.plusLine !== target.lineNumber,
    JSON.stringify(away)
  )

  // 光标放到目标行行尾(行首「+」随之出现),同一条坐标再解析一次
  await evalJs(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.dispatch({ selection: { anchor: ${target.lineTo} }, userEvent: 'select' })
      return true
    })()`)
  await sleep(400)
  const caretOn = await probe()
  console.log('[probe-caret]', JSON.stringify(caretOn))
  check(
    'B 光标停在该行(行首「+」出现)时,同一条坐标仍解析到左侧文字',
    caretOn.plusLine === target.lineNumber &&
      caretOn.hit !== null &&
      caretOn.hit < target.widgetFrom,
    JSON.stringify({
      hit: caretOn.hit,
      widgetFrom: target.widgetFrom,
      plusLine: caretOn.plusLine,
      targetLine: target.lineNumber
    })
  )
  check(
    'B2 「+」在列表文字行的垂直中线上',
    caretOn.plusDelta !== null && Math.abs(caretOn.plusDelta) <= 1.5,
    JSON.stringify({ plusDelta: caretOn.plusDelta, plusLine: caretOn.plusLine })
  )

  // C: 复刻用户手势 —— 行尾按下,按住往左拖过公式,一直拖到行首左侧
  wc.debugger.attach('1.3')
  const cdp = (method: string, params?: unknown): Promise<unknown> =>
    wc.debugger.sendCommand(method, params)
  const mouse = async (
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    x: number,
    y: number,
    buttons: number
  ): Promise<void> => {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 })
  }

  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  await sleep(200)

  const startX = target.endLeft
  const stopX = target.lineLeft - 40
  await mouse('mousePressed', startX, target.y, 1)
  await sleep(150)
  console.log('[down]', JSON.stringify(await probe()))

  const steps = 24
  const states: ProbeState[] = []
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(startX + ((stopX - startX) * i) / steps)
    await mouse('mouseMoved', x, target.y, 1)
    await sleep(90)
    const s = await probe()
    states.push(s)
    console.log(`[move x=${x}]`, JSON.stringify(s))
  }
  await mouse('mouseReleased', stopX, target.y, 0)
  await sleep(350)
  const up = await probe()
  console.log('[up]', JSON.stringify(up))

  check(
    'C 拖到公式左侧后,选区包含公式前面的文字',
    up.from < target.widgetFrom && up.selText.includes('求解器输出的最终状态'),
    JSON.stringify({ from: up.from, widgetFrom: target.widgetFrom, selText: up.selText })
  )
  check(
    '拖选全程公式保持渲染态(不闪回源码)',
    states.length > 0 && states.every(s => s.rendered && !s.srcShown),
    JSON.stringify(states.map(s => s.srcShown))
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
