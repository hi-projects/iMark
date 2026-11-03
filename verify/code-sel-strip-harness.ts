/**
 * 代码块左侧留白(1.25em border)与选区的关系。
 *
 * 背景:`.cm-md-code::before` 是一块盖在选区图层之上的实色底,作用是把
 * drawSelection 多染出来的那截留白盖回去 —— 否则「只选代码块正文」时,
 * 首行从字首开始、其余行从正文栏左缘开始,左边参差不齐。
 *
 * 但全篇全选时,所有行本来就该整行连成一片;那块留白却仍是实色底,代码块
 * 左边就缺一条高亮,像被挖掉一块。两种场景应当不同:
 *   仅选代码块正文 → 留白保持代码底色(参差被盖住)
 *   全篇全选 / 选区从上方段落起 → 留白跟着选区一起染色
 *
 * 断言(截图取色 + DOM 类):
 *   A 未选中:留白区与右侧空白区同色(都是代码底色)
 *   B 仅选代码正文:留白仍是代码底色,右侧空白区带选区色;不挂 bleed 类
 *   C 全篇全选:留白与右侧空白区同色(左边没有缺口);代码行挂上 bleed 类
 *   D 选区从上方段落起到代码块内:留白同样染色
 *   E 取消选中:回到代码底色,bleed 类摘掉
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs code-sel-strip
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
  '这些文件通常放在一个名为 `<robot>_moveit_config` 的包里。',
  '',
  '如果没有 `MoveItConfigsBuilder`，你需要自己把参数写全：',
  '',
  '```python',
  'parameters = [',
  '    {"robot_description": open("/path/xxx.urdf").read()},',
  '    {"robot_description_semantic": open("/path/xxx.srdf").read()},',
  '    yaml.safe_load(open("/path/kinematics.yaml")),',
  '    yaml.safe_load(open("/path/ompl_planning.yaml")),',
  '    ...',
  ']',
  '```',
  '',
  '路径写错、文件改名、少传一个参数，都会让 MoveIt 起不来。',
  '',
  '# 二、默认读取的文件',
  '',
  '构造时传入机器人名后，它会去配置包里找下面这些文件。',
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

interface Rect {
  left: number
  top: number
  height: number
  width: number
}

interface Geom {
  /** `parameters = [` 这一行的行盒 */
  line: Rect
  /** 代码块左侧留白宽度(border-left) */
  strip: number
  /** 代码行里挂 bleed 类的数量 */
  bleedLines: number
  codeLines: number
}

const GEO = `
(() => {
  const lines = [...document.querySelectorAll('.cm-content .cm-line.cm-md-code')]
  const code = lines.find(l => l.textContent.includes('parameters'))
  if (!code) return null
  const r = code.getBoundingClientRect()
  return {
    line: { left: r.left, top: r.top, height: r.height, width: r.width },
    strip: parseFloat(getComputedStyle(code).borderLeftWidth),
    bleedLines: lines.filter(l => l.classList.contains('cm-md-code-sel-bleed')).length,
    codeLines: lines.length
  }
})()`

interface Rgb {
  r: number
  g: number
  b: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs code-sel-strip` 跑会自动带上)')
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
        lineWrapping: false,
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
  win.setContentSize(1000, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  const select = (anchor: string, head: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.dispatch({ selection: { anchor: ${anchor}, head: ${head} }, userEvent: 'select' })
      return true
    })()`)

  const posOf = (needle: string, extra = 0): Promise<number> =>
    evalJs<number>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      return v.state.doc.toString().indexOf(${JSON.stringify(needle)}) + ${extra}
    })()`)

  /** 初始装饰可能还没建(语法树未就绪),动一下选区把重建叫醒 */
  async function waitForCode(rounds = 30): Promise<boolean> {
    for (let i = 0; i < rounds; i++) {
      const ready = await evalJs<boolean>(
        `Boolean(document.querySelector('.cm-content .cm-line.cm-md-code'))`
      )
      if (ready) return true
      await select('0', '1')
      await sleep(100)
    }
    return false
  }

  const codeReady = await waitForCode()
  check('代码块装饰已建好(渲染态可见)', codeReady)

  const geom = (): Promise<Geom | null> => evalJs<Geom | null>(GEO)

  interface Shot {
    geom: Geom
    strip: Rgb
    bg: Rgb
    size: { width: number; height: number }
  }

  /** 截屏并在这条代码行上取两个点:左侧留白 / 右侧空白(纯底色) */
  async function shot(tag: string): Promise<Shot | null> {
    const g = await geom()
    if (!g) return null
    // 隐藏窗口的第一次 capturePage 可能拿到装饰重建之前的旧帧,先丢一帧
    await wc.capturePage()
    await sleep(120)
    const img = await wc.capturePage()
    const buf = img.toBitmap() // Linux 上是 BGRA
    const size = img.getSize()
    await writeFile(`/tmp/code-sel-strip-${tag}.png`, img.toPNG())
    const px = (x: number, y: number): Rgb => {
      const i = (Math.round(y) * size.width + Math.round(x)) * 4
      return { r: buf[i + 2], g: buf[i + 1], b: buf[i] }
    }
    const cy = g.line.top + g.line.height / 2
    return {
      geom: g,
      strip: px(g.line.left + 4, cy),
      bg: px(g.line.left + g.line.width - 30, cy),
      size
    }
  }

  const near = (a: Rgb, b: Rgb, tol = 6): boolean =>
    Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol
  const fmt = (c: Rgb): string => `rgb(${c.r},${c.g},${c.b})`
  const diff = (a: Rgb, b: Rgb): number =>
    Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)

  // ---------- A ----------
  console.log('\n【A】未选中:留白与右侧空白同色(都是代码底色)')
  await select('0', '0')
  await sleep(300)
  const a = await shot('a-none')
  if (!a) {
    console.log('找不到代码块,无法继续')
    app.exit(2)
    return
  }
  console.log(`     [几何] left=${a.geom.line.left.toFixed(1)} top=${a.geom.line.top.toFixed(1)} h=${a.geom.line.height.toFixed(1)} strip=${a.geom.strip}`)
  console.log(`     留白 ${fmt(a.strip)} / 右侧 ${fmt(a.bg)}  (代码行 ${a.geom.codeLines},bleed ${a.geom.bleedLines})`)
  check('留白与右侧空白同色', near(a.strip, a.bg), `${fmt(a.strip)} vs ${fmt(a.bg)}`)
  check('未选中时不挂 bleed 类', a.geom.bleedLines === 0, `${a.geom.bleedLines}`)
  const codeBg = a.bg

  // ---------- B ----------
  console.log('\n【B】仅选代码正文:留白保持底色,右侧带选区色')
  const codeFrom = await posOf('parameters = [')
  const codeTo = await posOf('\n]\n') + 2
  await select(String(codeFrom), String(codeTo))
  await sleep(350)
  const b = await shot('b-code-only')
  if (!b) throw new Error('B 取不到画面')
  console.log(`     留白 ${fmt(b.strip)} / 右侧 ${fmt(b.bg)}  (bleed ${b.geom.bleedLines})`)
  check('留白仍是代码底色', near(b.strip, codeBg, 8), `${fmt(b.strip)} vs ${fmt(codeBg)}`)
  check('右侧带选区色(与未选中不同)', diff(b.bg, codeBg) > 8, `${fmt(b.bg)} vs ${fmt(codeBg)}`)
  check('仅选正文时不挂 bleed 类', b.geom.bleedLines === 0, `${b.geom.bleedLines}`)

  // ---------- C ----------
  console.log('\n【C】全篇全选:留白跟着染色,左边没有缺口')
  await select('0', 'v.state.doc.length')
  await sleep(350)
  const c = await shot('c-select-all')
  if (!c) throw new Error('C 取不到画面')
  console.log(`     留白 ${fmt(c.strip)} / 右侧 ${fmt(c.bg)}  (bleed ${c.geom.bleedLines}/${c.geom.codeLines})`)
  check('右侧带选区色', diff(c.bg, codeBg) > 8, `${fmt(c.bg)} vs ${fmt(codeBg)}`)
  check('留白与右侧同色(左边没有缺口)', near(c.strip, c.bg, 4), `${fmt(c.strip)} vs ${fmt(c.bg)}`)
  check('代码行全部挂上 bleed 类', c.geom.bleedLines === c.geom.codeLines && c.geom.codeLines > 0, `${c.geom.bleedLines}/${c.geom.codeLines}`)

  // ---------- D ----------
  console.log('\n【D】选区从上方段落起到代码块内:留白同样染色')
  const dFrom = await posOf('如果没有')
  // 选到 `]` 行末:被取样的 parameters 行整行都在选区内,左右两点才可比
  const dTo = await posOf('\n]') + 2
  await select(String(dFrom), String(dTo))
  await sleep(350)
  const d = await shot('d-from-paragraph')
  if (!d) throw new Error('D 取不到画面')
  console.log(`     留白 ${fmt(d.strip)} / 右侧 ${fmt(d.bg)}  (bleed ${d.geom.bleedLines}/${d.geom.codeLines})`)
  check('留白与右侧同色', near(d.strip, d.bg, 4), `${fmt(d.strip)} vs ${fmt(d.bg)}`)
  check('挂上 bleed 类', d.geom.bleedLines === d.geom.codeLines && d.geom.codeLines > 0, `${d.geom.bleedLines}/${d.geom.codeLines}`)

  // ---------- E ----------
  console.log('\n【E】取消选中:回到代码底色,bleed 类摘掉')
  await select('0', '0')
  await sleep(350)
  const e = await shot('e-cleared')
  if (!e) throw new Error('E 取不到画面')
  console.log(`     留白 ${fmt(e.strip)} / 右侧 ${fmt(e.bg)}  (bleed ${e.geom.bleedLines})`)
  check('留白回到代码底色', near(e.strip, codeBg, 4), `${fmt(e.strip)} vs ${fmt(codeBg)}`)
  check('右侧也回到代码底色', near(e.bg, codeBg, 4), `${fmt(e.bg)} vs ${fmt(codeBg)}`)
  check('bleed 类已摘掉', e.geom.bleedLines === 0, `${e.geom.bleedLines}`)

  console.log(`\n截图: /tmp/code-sel-strip-*.png`)
  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
