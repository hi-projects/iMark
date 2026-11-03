/**
 * 选中行内代码时,列表项之间的间距不能抖动。
 *
 * 现象:选中一条含行内代码的列表项(整行选中 / 拖选两个代码)时,那一行会
 * 矮约 1px —— 行内代码用等宽字体 + 0.9em + 内边距,行盒本来就比普通正文高
 * 一点;选中时 `.cm-md-inlinecode` 被摘掉,字体度量退回普通正文,行盒缩回
 * 普通高度,后面所有列表项跟着上移,看起来像"列表间距变小了"。
 *
 * 修法:选中时仍给代码内容挂 `.cm-md-inlinecode`(反引号照常露出,选区图层
 * 在正文之上,不会挡住高亮),字体度量恒定。
 *
 * 断言:
 *   A 未选中:含代码的行比普通行高约 1px(这是设计,不是抖动)
 *   B 整行选中(同一行两处代码都被碰触)→ 所有行 top / height 不变
 *   C 只选中其中一处代码 → 不变
 *   D 选中只有一处代码的行 → 不变
 *   E 取消选中 → 不变
 *   F 窄窗口(行折成两行)下整行选中 → 不变
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs inline-code-selection
 */

import { app, BrowserWindow, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// 验收窗口一律不显示
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

const DOC = [
  'MoveIt 要控制一个机器人，需要一大堆配置：',
  '',
  '- **.xacro、.urdf：机器人长什么样** → `URDF` / `xacro`',
  '- **哪些关节能一起动、哪些不能碰** → SRDF',
  '- **逆运动学用哪个求解器** → kinematics.yaml',
  '- **用哪个规划算法、参数多少** → `ompl_planning.yaml`',
  '- **规划完交给哪个控制器执行** → moveit_controllers.yaml',
  '- **关节速度 / 加速度限制** → joint_limits.yaml',
  '- ……',
  ''
].join('\n')

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

interface LineMetrics {
  text: string
  top: number
  height: number
  codes: number
}

interface Snapshot {
  items: LineMetrics[]
}

const SNAP = `
(() => {
  const round = n => Math.round(n * 100) / 100
  const lines = [...document.querySelectorAll('.cm-content .cm-line')]
  return {
    items: lines.map(el => {
      const r = el.getBoundingClientRect()
      return {
        text: el.textContent.slice(0, 48),
        top: round(r.top),
        height: round(r.height),
        codes: el.querySelectorAll('.cm-md-inlinecode').length
      }
    })
  }
})()`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs inline-code-selection` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'probe.md')
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
        lineWrapping: true,
        editorFontSize: 16,
        editorFontSizeVersion: 2
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  const win = createMainWindow(settings)
  win.setContentSize(1400, 800)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const snap = (): Promise<Snapshot> => evalJs<Snapshot>(SNAP)

  /** 按文档行号整行选中 */
  async function selectLine(lineNo: number): Promise<void> {
    await evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const ln = view.state.doc.line(${lineNo})
        view.dispatch({ selection: { anchor: ln.from, head: ln.to } })
        return true
      })()`)
    await sleep(350)
  }

  /** 选中某段文字的一部分 */
  async function selectText(needle: string, from: number, to: number): Promise<void> {
    await evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const p = view.state.doc.toString().indexOf(${JSON.stringify(needle)})
        if (p < 0) return false
        view.dispatch({ selection: { anchor: p + ${from}, head: p + ${to} } })
        return true
      })()`)
    await sleep(350)
  }

  async function clearSelection(): Promise<void> {
    await evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        view.dispatch({ selection: { anchor: view.state.doc.line(1).from } })
        return true
      })()`)
    await sleep(350)
  }

  const sameLayout = (a: Snapshot, b: Snapshot): boolean =>
    a.items.length === b.items.length &&
    a.items.every((x, i) => {
      const y = b.items[i]
      return Math.abs(x.top - y.top) < 0.01 && Math.abs(x.height - y.height) < 0.01
    })

  const item = (s: Snapshot, text: string): LineMetrics | undefined => s.items.find(l => l.text.includes(text))

  const dump = (s: Snapshot): string =>
    JSON.stringify(s.items.map(l => [l.text.slice(0, 10), l.top, l.height, l.codes]))

  // ---------- A ----------
  console.log('\n【A】未选中:含行内代码的行比普通行高约 1px(字体度量,属于设计)')
  const base = await snap()
  const twoCode = item(base, 'URDF')
  const oneCode = item(base, 'ompl_planning')
  const plain = item(base, '哪些关节')
  console.log(
    `     [实测] 两处代码 ${twoCode?.height}px / 一处代码 ${oneCode?.height}px / 普通 ${plain?.height}px`
  )
  check(
    '含代码的行确实略高,且两种含代码的行等高',
    !!twoCode && !!oneCode && !!plain && twoCode.height > plain.height + 0.5 && Math.abs(twoCode.height - oneCode.height) < 0.5,
    dump(base)
  )
  check('未选中时行内代码挂了样式类', (twoCode?.codes ?? 0) === 2 && (oneCode?.codes ?? 0) === 1, dump(base))

  // ---------- B ----------
  console.log('\n【B】整行选中同一行里的两处代码:所有行位置不变')
  await selectLine(3)
  const whole = await snap()
  check('整行选中后,所有行的 top / height 与未选中完全一致', sameLayout(base, whole), dump(whole))
  check('选中期间代码内容仍挂样式类(反引号外露)', (item(whole, 'URDF')?.codes ?? 0) === 2, dump(whole))
  check(
    '选中期间反引号已露出(源码态)',
    (item(whole, 'URDF')?.text ?? '').includes('`'),
    item(whole, 'URDF')?.text ?? ''
  )

  // ---------- C ----------
  console.log('\n【C】只选中其中一处代码:所有行位置不变')
  await clearSelection()
  await selectText('URDF', 1, 4)
  const partial = await snap()
  check('只选中一个代码后,所有行的 top / height 与未选中完全一致', sameLayout(base, partial), dump(partial))
  check('该行两处代码的样式都还在', (item(partial, 'URDF')?.codes ?? 0) === 2, dump(partial))

  // ---------- D ----------
  console.log('\n【D】选中只有一处代码的行:所有行位置不变')
  await clearSelection()
  await selectLine(6)
  const single = await snap()
  check('整行选中单代码行后,所有行的 top / height 与未选中完全一致', sameLayout(base, single), dump(single))
  check('该行的代码样式仍在', (item(single, 'ompl_planning')?.codes ?? 0) === 1, dump(single))

  // ---------- E ----------
  console.log('\n【E】取消选中:位置保持不变')
  await clearSelection()
  const cleared = await snap()
  check('取消选中后,所有行的 top / height 仍与初始一致', sameLayout(base, cleared), dump(cleared))

  // ---------- F ----------
  console.log('\n【F】窄窗口(列表项折成两行)下整行选中:位置不变')
  win.setContentSize(860, 800)
  await sleep(500)
  const narrowBase = await snap()
  const wrapped = item(narrowBase, 'URDF')
  check(
    '窄窗口下该列表项确实折成两行(行盒约 2 倍)',
    !!wrapped && wrapped.height > (item(base, '哪些关节')?.height ?? Infinity) * 1.5,
    dump(narrowBase)
  )
  await selectLine(3)
  const narrowWhole = await snap()
  check('窄窗口整行选中后,所有行的 top / height 仍不变', sameLayout(narrowBase, narrowWhole), dump(narrowWhole))

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
