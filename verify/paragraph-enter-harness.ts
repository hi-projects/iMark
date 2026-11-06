/**
 * 回车 = 新段 / Shift+回车 = 段内换行的端到端验证。
 *
 * 规则(源码层面,别的 Markdown 编辑器打开也成立):
 *   - 正文里回车:源码补空行,光标落下去接着写;两行之间真的隔着一个空行。
 *   - 空行上回车同样是新段:原来的空段落按整行留着,新段在它下面,和下面
 *     紧接的正文之间也隔着空行(不是只往下挪一行、看起来像段内换行)。
 *   - 光标在行尾、下一行还是同一段(源码软换行):回车从中间断段,光标落到
 *     断点后面的文字上,只补一个换行 —— 原来的行尾换行就充当空行。
 *   - 下一行已经是另一个块(标题等):新段两边都要空行,否则会并进相邻段。
 *   - 标题行尾回车:标题自己就是块边界,标题和新段之间不再补空行(比正文少
 *     一条),否则标题后面一按回车就出现三条空行;标题后面只剩空行(文末)
 *     时只把光标挪到空行上,源码不动。
 *   - Shift+回车:硬换行(行尾反斜杠),两行仍是同一段;iMark 里是行间距,
 *     别的编辑器里是段内换行。列表 / 引用里把容器前缀带到下一行。
 *   - 新段里退格:把这次分段收回 —— 补出来的空行连同段落分隔一起删掉,光标
 *     回到上一段行尾(不是只退到空行上、要再按一次)。连按多次回车生成的多条
 *     空段落一次只收回一条。代码块里的空行是代码内容,仍按普通退格逐字符删。
 *   - 重新打开文件后「回车建出的空段落」记录会丢,但文末那条空行仍按整行
 *     留出、退格同样一次收回整段 —— 它后面没有内容可分隔,只能是接着写的那行。
 *   - 光标点回上一段后,空着的新段仍按整行留出、点得回去(不被当成结构空行
 *     收紧成段间距);点回去再输入,字落在那一行上,不会被并进上一段。
 *   - 在块 / 段的**行首**回车:光标按普通编辑器的习惯留在原行的行首,新段是
 *     上面那条空行 —— 它也得是「可点进去的一行」,不能当成块间距收掉。
 *     文档第一行行首回车只补一条换行:新段就是文件第一行,上面没有上一段要分隔,
 *     多补出来的那条纯结构空行在点击时会撑开、把下面的正文顶下去。
 *   - 列表项回车仍是下一项;代码块 / 引用 / 表格 / 公式里的回车保持原样。
 *
 * 跑法(在仓库根目录,改了 src/renderer/ 先 npx electron-vite build):
 *   node verify/run.mjs paragraph-enter
 */

import { app, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

const REPO = join(__dirname, '..', '..')

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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

type LineInfo = { text: string; cls: string; top: number; height: number }

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

async function main(): Promise<void> {
  await app.whenReady()

  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false
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

  const domLines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const r = el.getBoundingClientRect()
        return { text: el.textContent, cls: el.className, top: r.top, height: r.height }
      })`)

  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(160)
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

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
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)})`)
    }
  }

  async function loadDoc(content: string): Promise<boolean> {
    const lines = content.split('\n').length
    const ready = `document.querySelectorAll('.cm-content .cm-line').length === ${lines}`
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(note, content, 'utf8')
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      if (await waitFor(ready, 6000)) {
        await focusEditor()
        return true
      }
    }
    return false
  }

  const caretInfo = (): Promise<{ line: number; text: string; head: number; from: number; to: number }> =>
    evalJs<{ line: number; text: string; head: number; from: number; to: number }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const head = view.state.selection.main.head
        const line = view.state.doc.lineAt(head)
        return { line: line.number, text: line.text, head, from: line.from, to: line.to }
      })()`)

  /** 编辑器里的源码(保留文末空行;readSource 会把它们剪掉,数不了条数) */
  const docText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)

  /** 把光标放到绝对位置(合成按键只负责触发命令,落点必须是确定的) */
  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(120)
  }

  /** 把光标放到文末最后一行,模拟用户点进文末的空行 */
  async function caretToDocEnd(): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true })
      return true
    })()`)
    await sleep(120)
  }

  /** 按 DOM 行序号模拟一次真实鼠标点击(点在行首附近,避开行尾的浮动按钮) */
  async function clickDomLine(index: number): Promise<boolean> {
    const spot = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const el = [...document.querySelectorAll('.cm-content .cm-line')][${index}]
        if (!el) return null
        const r = el.getBoundingClientRect()
        // 离行首远一点:避开行首左侧的「+」按钮,不然点到的是行菜单
        return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!spot) return false
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await sleep(320)
    return true
  }

  const readSource = async (): Promise<string[]> => {
    // 菜单保存是异步的:固定等 600ms 偶尔会在写盘前就读文件,读到上一次的内容
    // (偶发假失败)。这里以「文件内容和编辑器当前文档一致」为准,最多等 2 秒。
    const docLines = (await docText()).split('\n')
    while (docLines.length && docLines[docLines.length - 1] === '') docLines.pop()
    const same = (text: string): boolean => {
      const lines = text.split('\n')
      while (lines.length && lines[lines.length - 1] === '') lines.pop()
      return lines.join('\n') === docLines.join('\n')
    }
    wc.send(IPC.MenuCommand, 'file:save')
    let text = ''
    for (let i = 0; i < 20; i++) {
      await sleep(100)
      text = await readFile(note, 'utf8').catch(() => '')
      if (same(text)) break
    }
    const lines = text.split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /** 行 DOM 的垂直坐标(按光标所在行取,不依赖行号) */
  const pitch = (lines: LineInfo[], fromText: string, toText: string): number | null => {
    const a = lines.find(l => l.text.trim() === fromText)
    const b = lines.find(l => l.text.trim() === toText)
    return a && b ? b.top - a.top : null
  }

  console.log('\n【A】正文段尾回车 —— 源码补空行,接着写的就是新段')
  await loadDoc('\n')
  await type('第一段')
  await key('Enter')
  await type('第二段')
  {
    const src = await readSource()
    check('落盘:两段之间有一条空行', src.join('|') === '第一段||第二段', JSON.stringify(src))
    const lines = await domLines()
    const gap = lines.find(l => l.text === '')
    check('空行带段间距(class 由显示规则补)', !!gap && /cm-md-block-gap-body/.test(gap.cls), gap?.cls ?? 'none')
    const p = pitch(lines, '第一段', '第二段')
    const h = lines[0]?.height ?? 0
    check('两段行距是「行高 + 段间距」,不是普通行距', p !== null && p > h + 6, `pitch=${p} h=${h}`)
  }

  console.log('\n【B】段落中间回车 —— 断成两段,后半段另起一行')
  await loadDoc('\n')
  await type('前半后半')
  await key('ArrowLeft')
  await key('ArrowLeft')
  await key('Enter')
  await type('X')
  {
    const src = await readSource()
    check('落盘:光标处断段,后半段是新行', src.join('|') === '前半||X后半', JSON.stringify(src))
  }

  console.log('\n【C】行尾回车,下一行仍是同一段(软换行)—— 只补一条空行,光标到下一行行首')
  await loadDoc('\n建 PlanningScene')
  // 打开文件时光标会落到第一条有内容的行(见 setup.ts 的 initialCaret),这里要
  // 测的是「从文首第一行开始写」,显式把光标放到第一行行首。
  await setCaret(0)
  await type('加载模型')
  await key('Enter')
  {
    const src = await readSource()
    check('落盘:两行之间隔一条空行,没有多出空行', src.join('|') === '加载模型||建 PlanningScene', JSON.stringify(src))
  }
  await type('X')
  {
    const src = await readSource()
    check('光标落在下一行行首(再输入是接在它前面)', src.join('|') === '加载模型||X建 PlanningScene', JSON.stringify(src))
    const lines = await domLines()
    check('断出来的两行都按正文渲染', lines.slice(0, 3).every(l => !/cm-md-h[1-6]/.test(l.cls)), JSON.stringify(lines.slice(0, 3)))
  }

  console.log('\n【D】行尾回车,下一行是另一个块(标题)—— 新段两边都留空行')
  await loadDoc('\n# 标题')
  await setCaret(0) // 同上:文首第一行(空行)开始写,下面紧跟着标题块
  await type('正文')
  await key('Enter')
  await type('新段')
  {
    const src = await readSource()
    check(
      '落盘:正文 / 空行 / 新段 / 空行 / 标题',
      src.join('|') === '正文||新段||# 标题',
      JSON.stringify(src)
    )
    const lines = await domLines()
    check('标题仍按标题渲染', /cm-md-h1/.test(lines[4]?.cls ?? ''), JSON.stringify(lines.map(l => `${l.text}[${l.cls}]`)))
  }

  console.log('\n【E】Shift+回车 —— 段内换行(硬换行),两行仍是同一段')
  await loadDoc('\n')
  await type('上半')
  await key('Enter', ['shift'])
  {
    const lines = await domLines()
    check(
      '刚按完 Shift+回车(下一行还空着)也不显示反斜杠',
      lines[0]?.text === '上半',
      JSON.stringify(lines.map(l => l.text))
    )
  }
  await type('下半')
  {
    const src = await readSource()
    check('落盘:行尾是反斜杠 + 换行(标准硬换行)', src.join('|') === '上半\\|下半', JSON.stringify(src))
    const lines = await domLines()
    const p = pitch(lines, '上半', '下半')
    const h = lines[0]?.height ?? 0
    check('两行按行间距排,不是段间距', p !== null && Math.abs(p - h) <= 1, `pitch=${p} h=${h} ${JSON.stringify(lines)}`)
    check('第二行没有段间距 class', !/cm-md-block-gap/.test(lines[1]?.cls ?? ''), lines[1]?.cls ?? 'none')
    check(
      '渲染态不显示硬换行反斜杠(光标不在上一行)',
      lines[0]?.text === '上半',
      JSON.stringify(lines.map(l => l.text))
    )
  }

  console.log('\n【F】列表项 Shift+回车 —— 硬换行留在同一项里(续行缩进到内容列)')
  await loadDoc('\n')
  await type('- 第一项')
  await key('Enter', ['shift'])
  await type('续行')
  {
    const src = await readSource()
    check('落盘:第二行缩进到内容列,仍是同一项', src.join('|') === '- 第一项\\|  续行', JSON.stringify(src))
    const lines = await domLines()
    const bullets = await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-listmark-bullet').length`)
    check('只有第一行画列表圆点(第二行是项内容)', bullets === 1, `bullets=${bullets}`)
    check('两行都没有被当成标题', lines.slice(0, 2).every(l => !/cm-md-h[1-6]/.test(l.cls)), JSON.stringify(lines.slice(0, 2)))
  }

  console.log('\n【G】对照组:列表项回车仍是下一项')
  await loadDoc('\n')
  await type('- 第一项')
  await key('Enter')
  await type('第二项')
  {
    const src = await readSource()
    check('落盘:第二行自动带 `- `', src.join('|') === '- 第一项|- 第二项', JSON.stringify(src))
  }

  console.log('\n【H】代码块里回车 / Shift+回车 —— 都是普通换行,不补空行也不写硬换行标记')
  await loadDoc('```js\ncode\ndone\n```\n')
  await key('ArrowDown')
  await key('End')
  await key('Enter')
  await type('x')
  await key('Enter', ['shift'])
  await type('y')
  {
    const src = await readSource()
    check('落盘:代码行逐行往下,没有空行', src.join('|') === '```js|code|x|y|done|```', JSON.stringify(src))
    check(
      '代码行尾没有硬换行标记',
      src.slice(1, 5).every(l => !/\s$/.test(l) && !/\\$/.test(l)),
      JSON.stringify(src.slice(1, 5))
    )
  }

  console.log('\n【I】引用里回车仍续 `> `;Shift+回车在引用里也留在引用内')
  await loadDoc('\n> 引用')
  await key('ArrowDown')
  await key('End')
  await key('Enter')
  await type('续')
  {
    const src = await readSource()
    check('回车续出 `> `(原有行为不变)', src.join('|') === '|> 引用|> 续', JSON.stringify(src))
  }
  await loadDoc('\n> 引用')
  await key('ArrowDown')
  await key('End')
  await key('Enter', ['shift'])
  await type('续')
  {
    const src = await readSource()
    check('Shift+回车:硬换行 + 下一行仍是引用', src.join('|') === '|> 引用\\|> 续', JSON.stringify(src))
  }

  console.log('\n【J】空行上回车也是新段 —— 原空段落留着,新段和正文之间留空行')
  await loadDoc('\n正文')
  await setCaret(0) // 光标停在文首那条空行上(用户点/方向键停上去的那一步)
  await key('Enter')
  {
    const src = await readSource()
    check(
      '落盘:光标所在空段落和下面正文之间隔着一条空行',
      src.join('|') === '||||正文',
      JSON.stringify(src)
    )
    const lines = await domLines()
    const body = lines[4]?.height ?? 0
    check(
      '空行也是当前段落:回车后它仍按整行留着,新段在它下面',
      lines.length === 5 &&
        /cm-md-empty-paragraph/.test(lines[0]?.cls ?? '') &&
        lines[1].height < body - 8 &&
        lines[2].height >= body - 1,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }
  await type('X')
  {
    const src = await readSource()
    check('落盘:新段和下面正文各占一段(中间都隔空行)', src.join('|') === '||X||正文', JSON.stringify(src))
  }

  console.log('\n【J2】空文档第一行回车 —— 同样是新段,不是往下挪一行')
  await loadDoc('')
  await key('Enter')
  {
    const lines = await domLines()
    const body = lines[2]?.height ?? 0
    check(
      '原空段落仍按整行留着,新段在段间距下面',
      lines.length === 3 &&
        /cm-md-empty-paragraph/.test(lines[0]?.cls ?? '') &&
        lines[0].height >= body - 1 &&
        lines[1].height < body - 8,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }
  await type('X')
  {
    const src = await readSource()
    check('落盘:输入落在新段里', src.join('|') === '||X', JSON.stringify(src))
  }

  console.log('\n【K】标题行尾回车 —— 新段是正文,且紧贴标题(标题自己就是块边界)')
  await loadDoc('\n# 标题')
  await setCaret(0) // 文首空行开始写新标题,原来的「# 标题」在下面
  await type('### 参数')
  await key('Enter')
  await type('正文')
  {
    const src = await readSource()
    check('落盘:标题 / 正文 / 空行 / 标题', src.join('|') === '### 参数|正文||# 标题', JSON.stringify(src))
    const lines = await domLines()
    check(
      '新行按正文渲染,不是标题',
      /cm-md-h3/.test(lines[0]?.cls ?? '') && !/cm-md-h[1-6]/.test(lines[1]?.cls ?? '') && /cm-md-h1/.test(lines[3]?.cls ?? ''),
      JSON.stringify(lines.slice(0, 4).map(l => `${JSON.stringify(l.text)}[${l.cls}]`))
    )
  }

  console.log('\n【K2】标题后面本来就有空行 —— 回车不再连出三条空行')
  await loadDoc('# 标题\n\n正文\n')
  await key('End')
  await key('Enter')
  {
    const lines = await domLines()
    // 源码补了一条换行:标题 / 空行(光标行)/ 空行(压成段间距)/ 正文 / 文末空行
    check(
      '回车后只有两条空行(其中一条是段间距),不是三条',
      lines.length === 5,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}[${l.cls}]`))
    )
    const caretBlank = lines[1]
    check('光标落在标题下面第一条空行上', caretBlank?.text === '', JSON.stringify(caretBlank))
    check(
      '第二条空行收紧成段间距(比光标空行矮),屏幕上只有一行空白',
      !!lines[2] && lines[2].height < caretBlank.height - 8,
      JSON.stringify({ caret: caretBlank?.height, gap: lines[2]?.height })
    )
  }
  await type('新段')
  {
    const src = await readSource()
    check('落盘:新段紧贴标题,和正文之间隔一条空行', src.join('|') === '# 标题|新段||正文', JSON.stringify(src))
  }

  console.log('\n【K3】标题在文末(文件以换行结尾)—— 回车只挪光标,不再往源码里堆空行')
  await loadDoc('# 标题\n')
  await key('End')
  await key('Enter')
  {
    const src = await readSource()
    check('落盘:源码没有多出空行', src.join('|') === '# 标题', JSON.stringify(src))
  }
  await type('正文')
  {
    const src = await readSource()
    check('落盘:新段紧接在标题下面', src.join('|') === '# 标题|正文', JSON.stringify(src))
  }

  console.log('\n【L】段尾回车(后面已有空行 + 下一段)—— 新段插在中间,不并进下一段')
  await loadDoc('第一段\n\n第二段\n')
  await key('End')
  await key('Enter')
  {
    // 两段之间空出一个真正的空段落:源码必须写三条空行(上下各一条分隔),
    // 显示层只把光标那条留成整行,其余收紧成段间距 —— 屏幕上就是一条空行。
    const src = await readSource()
    check('落盘:中间空出三条空行(上下各一条分隔)', src.join('|') === '第一段||||第二段', JSON.stringify(src))
    const lines = await domLines()
    const body = lines[0]?.height ?? 0
    check(
      '显示:只有光标那条空行是整行,其余空行收紧成段间距',
      lines.length === 6 &&
        lines[2].height >= body - 1 &&
        lines[1].height < body - 8 &&
        lines[3].height < body - 8,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}`))
    )
  }
  await type('新段')
  {
    const src = await readSource()
    check('落盘:第一段 / 空行 / 新段 / 空行 / 第二段', src.join('|') === '第一段||新段||第二段', JSON.stringify(src))
    const lines = await domLines()
    check('新段按正文渲染', !!lines[2] && !/cm-md-h[1-6]/.test(lines[2].cls), JSON.stringify(lines.slice(0, 5)))
  }

  console.log('\n【M】新段里退格 —— 收回这次分段,光标回到上一段行尾')
  await loadDoc('\n')
  await type('啊')
  await key('Enter')
  await key('Backspace')
  {
    const src = await readSource()
    check('落盘:空行连同段落分隔一起删掉,回到分段前的样子', src.join('|') === '啊', JSON.stringify(src))
    const caret = await caretInfo()
    check('光标回到上一段行尾(不是停在空行上)', caret.line === 1 && caret.text === '啊' && caret.head === 1, JSON.stringify(caret))
  }

  console.log('\n【M2】文档中间起的新段 —— 退格同样收回,不留连排空行')
  await loadDoc('第一段\n\n第二段\n')
  await key('End')
  await key('Enter')
  await key('Backspace')
  {
    const src = await readSource()
    check('落盘:恢复成原来的两段(中间只有一条空行)', src.join('|') === '第一段||第二段', JSON.stringify(src))
    const caret = await caretInfo()
    check('光标回到第一段行尾', caret.line === 1 && caret.text === '第一段' && caret.head === 3, JSON.stringify(caret))
  }

  console.log('\n【M3】代码块里的空行不是段落分隔 —— 退格仍逐字符删')
  await loadDoc('```js\ncode\n\n\n```\n')
  await key('ArrowDown')
  await key('ArrowDown')
  await key('Backspace')
  {
    const expected = ['```js', 'code', '', '```']
    const src = await readSource()
    check('落盘:只少了一条换行(代码里留一条空行),没有退到 code 行尾', src.join('|') === expected.join('|'), JSON.stringify(src))
  }

  console.log('\n【M4】回车后点回第一段 —— 空段落仍按整行留着,点得回去')
  await loadDoc('\n')
  await type('啊')
  await key('Enter')
  {
    const before = await caretInfo()
    check('回车后光标就在空段落上', before.line === 3 && before.text === '', JSON.stringify(before))
  }
  await clickDomLine(0)
  {
    const caret = await caretInfo()
    check('点击落到第一段', caret.line === 1 && caret.text === '啊', JSON.stringify(caret))
    const lines = await domLines()
    const body = lines[0]?.height ?? 0
    const emptyIndex = lines.findIndex(l => l.text === '' && l.height >= body - 1)
    check(
      '空段落仍按整行留出(没有收紧成段间距)',
      emptyIndex >= 0,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}`))
    )
    check(
      '空段落行被认作可点击的空段落',
      emptyIndex >= 0 && /cm-md-empty-paragraph/.test(lines[emptyIndex].cls),
      emptyIndex >= 0 ? lines[emptyIndex].cls : 'none'
    )
    const clicked = await clickDomLine(emptyIndex)
    const back = await caretInfo()
    check(
      '点空段落时光标能落回去',
      clicked && back.line === 3 && back.text === '',
      JSON.stringify({ clicked, back })
    )
  }
  await type('X')
  {
    const src = await readSource()
    check('落盘:输入落在空段落那一行,没有被并进第一段', src.join('|') === '啊||X', JSON.stringify(src))
  }

  console.log('\n【M5】文档中间起的新段 —— 点开再点回来,内容落在原来那一行')
  await loadDoc('第一段\n\n第二段\n')
  await key('End')
  await key('Enter')
  await clickDomLine(0)
  {
    const lines = await domLines()
    const body = lines[0]?.height ?? 0
    const emptyIndex = lines.findIndex(l => l.text === '' && l.height >= body - 1)
    check(
      '空段落仍在两段之间按整行留出',
      emptyIndex >= 0,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}`))
    )
    await clickDomLine(emptyIndex)
    const caret = await caretInfo()
    check('点空段落时光标能落回去', caret.line === 3 && caret.text === '', JSON.stringify(caret))
  }
  await type('X')
  {
    const src = await readSource()
    check(
      '落盘:新内容插在两段之间,前后各一条空行',
      src.join('|') === '第一段||X||第二段',
      JSON.stringify(src)
    )
  }

  console.log('\n【M6】点空段落上方的段间距 —— 落到空段落,不被送回第一段')
  await loadDoc('\n')
  await type('啊')
  await key('Enter')
  await clickDomLine(0)
  {
    const lines = await domLines()
    const gapIndex = lines.findIndex(l => l.text === '' && /cm-md-block-gap/.test(l.cls))
    const clicked = await clickDomLine(gapIndex)
    const caret = await caretInfo()
    check(
      '点刚离开的第一段正下方(段间距)时光标落到空段落',
      clicked && caret.line === 3 && caret.text === '',
      JSON.stringify({ gapIndex, caret })
    )
  }
  await type('X')
  {
    const src = await readSource()
    check('落盘:输入落在空段落那一行,没有被并进第一段', src.join('|') === '啊||X', JSON.stringify(src))
  }

  console.log('\n【N】方向键在空段落与文末空行上 —— 落点回到上一段行尾,不撑开结构空行')
  await loadDoc('\n\n\n\n')
  await type('啊')
  await key('Enter')
  await key('ArrowUp')
  {
    const caret = await caretInfo()
    check(
      '从空段落往上:光标落在上一段最后一个字后面',
      caret.line === 1 && caret.text === '啊' && caret.head === 1,
      JSON.stringify(caret)
    )
  }
  await key('ArrowDown')
  {
    const caret = await caretInfo()
    check('再往下回到空段落', caret.line === 3 && caret.text === '', JSON.stringify(caret))
  }
  await key('ArrowDown')
  await key('ArrowDown')
  {
    const lines = await domLines()
    const body = lines[2]?.height ?? 0
    const marker = lines.findIndex(l => /cm-md-empty-paragraph/.test(l.cls))
    // 文末空行始终按整行留(重新打开文件后它就是用户接着写的那一行),
    // 中间的连排空行仍要收紧;这里只数光标空段落和它下面的结构空行。
    const fullBlanks = lines.filter(
      (l, i) => i < lines.length - 1 && l.text === '' && l.height >= body - 1
    ).length
    const caret = await caretInfo()
    check(
      '光标仍停在回车创建的空段落上',
      caret.line === 3 && caret.text === '',
      JSON.stringify({ caret, marker })
    )
    check('空段落标记没有移动', marker === 2, JSON.stringify({ marker }))
    check(
      '后面的结构空行没有被撑成整行',
      fullBlanks === 1,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
    check(
      '文末空行按整行留出',
      lines.length > 0 &&
        lines[lines.length - 1].text === '' &&
        lines[lines.length - 1].height >= body - 1,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }

  console.log('\n【P】连续四段 —— 最后起的新空段落也要有段间距')
  await loadDoc('')
  for (let i = 0; i < 4; i++) {
    await type('啊')
    await key('Enter')
  }
  {
    const src = await readSource()
    const lines = await domLines()
    const ah = lines.flatMap((l, i) => (l.text === '啊' ? [i] : []))
    const lastEmpty = lines.findIndex(l => /cm-md-empty-paragraph/.test(l.cls))
    const pitch = (i: number, j: number): number => lines[j].top - lines[i].top
    const dump = JSON.stringify(lines.map(l => `${JSON.stringify(l.text)} top=${Math.round(l.top)} h=${Math.round(l.height)}`))
    check('落盘:四段「啊」', src.filter(t => t === '啊').length === 4, JSON.stringify(src))
    check(
      '最后一段到新空段落的间距与段间距一致',
      ah.length === 4 && lastEmpty > ah[3] && Math.abs(pitch(ah[3], lastEmpty) - pitch(ah[0], ah[1])) <= 2,
      dump
    )
  }

  console.log('\n【R】长正文行下回车,按上键 —— 落到长行最后一个字后面')
  await loadDoc('')
  await type('啊')
  await key('Enter')
  await type('啊')
  await key('Enter')
  await type('啊')
  await key('Enter')
  const long = '啊'.repeat(17)
  await type(long)
  await key('Enter')
  await key('ArrowUp')
  {
    const caret = await caretInfo()
    check(
      '光标落在长行最后一个字后面(不是行首)',
      caret.line === 7 && caret.text === long && caret.head === caret.to,
      JSON.stringify(caret)
    )
  }

  console.log('\n【R2】从下一段正文行按上键 —— 同样落到上一段长行末尾')
  await loadDoc('')
  await type('啊')
  await key('Enter')
  await type('啊')
  await key('Enter')
  await type('啊')
  await key('Enter')
  await type(long)
  await key('Enter')
  await type('啊')
  await key('Home')
  await key('ArrowUp')
  {
    const caret = await caretInfo()
    check(
      '光标落到长行最后一个字后面(不是行首)',
      caret.line === 7 && caret.text === long && caret.head === caret.to,
      JSON.stringify(caret)
    )
  }

  console.log('\n【Q】多个空段落逐个退格 —— 一次只收回一段')
  await loadDoc('')
  await type('啊')
  await key('Enter')
  await key('Enter')
  await key('Backspace')
  {
    const caret = await caretInfo()
    check(
      '第一次退格只收回最近一段,光标停在上一段空段落上',
      caret.line === 3 && caret.text === '',
      JSON.stringify(caret)
    )
  }
  await type('X')
  {
    const src = await readSource()
    check('落盘:输入仍落在新段里', src.join('|') === '啊||X', JSON.stringify(src))
  }

  await loadDoc('')
  await type('啊')
  await key('Enter')
  await key('Enter')
  await key('Backspace')
  await key('Backspace')
  {
    const caret = await caretInfo()
    check(
      '连续退格,最后才回到正文行尾',
      caret.line === 1 && caret.text === '啊' && caret.head === 1,
      JSON.stringify(caret)
    )
  }

  console.log('\n【S】新段里敲短横线再删掉 —— 再退格仍能收回整段')
  await loadDoc('')
  await type('啊')
  await key('Enter')
  await type('-')
  await key('Backspace')
  {
    const caret = await caretInfo()
    check('删掉短横线后光标仍在空段落上', caret.line === 3 && caret.text === '', JSON.stringify(caret))
  }
  await key('Backspace')
  {
    const caret = await caretInfo()
    check(
      '再退格收回整段,回到正文行尾(中间不留整行空行)',
      caret.line === 1 && caret.text === '啊' && caret.head === 1,
      JSON.stringify(caret)
    )
    const src = await readSource()
    check('落盘:只剩正文', src.join('|') === '啊', JSON.stringify(src))
  }

  console.log('\n【T】不完整的短横线后回车 —— 仍然是新段,不是段内换行')
  await loadDoc('')
  await type('啊')
  await key('Enter')
  await type('-')
  await key('Enter')
  await waitFor(`document.querySelectorAll('.cm-content .cm-line').length === 5`)
  {
    const caret = await caretInfo()
    const lines = await domLines()
    const dash = lines.findIndex(l => l.text === '-')
    const pitch = dash > 0 && caret.line - 1 < lines.length ? lines[caret.line - 1].top - lines[dash].top : -1
    const paragraphPitch = dash > 0 ? lines[dash].top - lines[0].top : -1
    check(
      '光标落到新段落的空行上',
      caret.line === 5 && caret.text === '',
      JSON.stringify(caret)
    )
    check(
      '新段与短横线之间是段间距(不是行间距)',
      dash >= 0 && Math.abs(pitch - paragraphPitch) <= 1,
      JSON.stringify({ pitch, paragraphPitch, lines: lines.map(l => `${JSON.stringify(l.text)}:${l.top}:${l.cls}`) })
    )
    const topBefore = lines[caret.line - 1]?.top ?? -1
    await type('X')
    const after = await domLines()
    const typed = after.find(l => l.text === 'X')
    check(
      '在新段里输入后光标行位置不动',
      !!typed && Math.abs(typed.top - topBefore) <= 1,
      JSON.stringify({ topBefore, after: typed?.top, lines: after.map(l => `${JSON.stringify(l.text)}:${l.top}:${l.cls}`) })
    )
  }

  console.log('\n【U】Shift+回车后输入无序列表 —— 仍是段内行距')
  await loadDoc('')
  await type('啊')
  await key('Enter', ['shift'])
  await type('- ')
  {
    const lines = await domLines()
    const marker = lines[1]
    const pitch = marker ? marker.top - lines[0].top : -1
    const bullets = await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-listmark-bullet').length`)
    check(
      '硬换行后的列表标记仍按行间距排(不是段间距)',
      !!marker && Math.abs(pitch - marker.height) <= 1 && bullets === 1,
      JSON.stringify({ pitch, bullets, lines: lines.map(l => `${JSON.stringify(l.text)}:${l.top}:${l.height}[${l.cls}]`) })
    )
  }

  console.log('\n【V】段内硬换行后的空列表标记回车 —— 取消标记,不新开段')
  await loadDoc('')
  await type('啊')
  await key('Enter', ['shift'])
  await type('- ')
  await key('Enter')
  {
    const bullets = await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-listmark-bullet').length`)
    const caret = await caretInfo()
    const lines = await domLines()
    const src = await readSource()
    const pitch = lines.length === 2 ? lines[1].top - lines[0].top : -1
    check('标记被取消(没有残留圆点)', bullets === 0, `bullets=${bullets}`)
    check(
      '光标回到原续行的空行上,没有新开一行',
      caret.line === 2 && caret.text === '' && lines.length === 2,
      JSON.stringify({ caret, count: lines.length })
    )
    check('落盘:标记已清掉,硬换行还在', src.length === 1 && src[0] === '啊\\', JSON.stringify(src))
    check(
      '仍是段内行距',
      lines.length === 2 && Math.abs(pitch - lines[1].height) <= 1,
      JSON.stringify({ pitch, lines: lines.map(l => `${JSON.stringify(l.text)}:${l.top}:${l.height}[${l.cls}]`) })
    )
  }

  console.log('\n【W】硬换行后输入短横线 —— 上一行不露出反斜杠')
  await loadDoc('')
  await type('啊')
  await key('Enter', ['shift'])
  await type('-')
  {
    const lines = await domLines()
    check('敲 `-` 后上一行不显示反斜杠', lines[0]?.text === '啊', JSON.stringify(lines.map(l => l.text)))
  }
  await type(' ')
  {
    const lines = await domLines()
    check('补空格后上一行仍不显示反斜杠', lines[0]?.text === '啊', JSON.stringify(lines.map(l => l.text)))
  }

  console.log('\n【X】Shift+回车后直接退格 —— 硬换行标记和换行一起删掉')
  await loadDoc('')
  await type('啊')
  await key('Enter', ['shift'])
  await key('Backspace')
  {
    const caret = await caretInfo()
    const lines = await domLines()
    const src = await readSource()
    check('落盘:回到一行正文,没有残留反斜杠', src.length === 1 && src[0] === '啊', JSON.stringify(src))
    check('光标回到正文行尾', caret.line === 1 && caret.text === '啊' && caret.head === 1, JSON.stringify(caret))
    check('DOM 只剩一行', lines.length === 1, JSON.stringify(lines.map(l => l.text)))
  }

  console.log('\n【Y】硬换行后按方向键回到上一行 —— 仍不显示反斜杠')
  await loadDoc('')
  await type('啊')
  await key('Enter', ['shift'])
  await key('ArrowUp')
  {
    const caret = await caretInfo()
    const lines = await domLines()
    check('上一行不显示反斜杠', lines[0]?.text === '啊', JSON.stringify(lines.map(l => l.text)))
    check('光标回到上一行', caret.line === 1 && caret.head === 0, JSON.stringify(caret))
  }

  console.log('\n【Z】新段里先 Shift+回车再输入 —— 不再多出一条空行')
  await loadDoc('')
  await type('啊')
  await key('Enter')
  await key('Enter', ['shift'])
  await type('啊')
  {
    const src = await readSource()
    const lines = await domLines()
    const caret = await caretInfo()
    check('落盘:两段之间只有一条空行', src.join('|') === '啊||啊', JSON.stringify(src))
    check(
      'DOM 只有三行,光标在新段的正文行上',
      lines.length === 3 && caret.line === 3 && caret.text === '啊',
      JSON.stringify({ caret, lines: lines.map(l => l.text) })
    )
  }

  console.log('\n【AA】重新打开存过的新段(没有空段落记录)—— 文末空行仍是整行,退格收回整段')
  await loadDoc('啊\n\n')
  {
    const lines = await domLines()
    const body = lines[0]?.height ?? 0
    const last = lines[lines.length - 1]
    check(
      '文末空行按整行留出',
      lines.length === 3 && last?.text === '' && last.height >= body - 1,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }
  await caretToDocEnd()
  await key('Backspace')
  {
    const doc = await docText()
    const caret = await caretInfo()
    check('落盘:整段收回,只剩正文', doc === '啊', JSON.stringify(doc))
    check(
      '光标回到上一段行尾,没有多出空行',
      caret.line === 1 && caret.text === '啊' && caret.head === 1,
      JSON.stringify(caret)
    )
  }

  console.log('\n【AB】重新打开多条空段落 —— 一次仍只收回一段')
  await loadDoc('啊\n\n\n\n')
  {
    const lines = await domLines()
    const body = lines[0]?.height ?? 0
    const last = lines[lines.length - 1]
    check(
      '文末空行按整行留出',
      lines.length === 5 && last?.text === '' && last.height >= body - 1,
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }
  await caretToDocEnd()
  await key('Backspace')
  {
    const doc = await docText()
    const caret = await caretInfo()
    check('一次只收回最近一段,源码只少一条空段落', doc === '啊\n\n', JSON.stringify(doc))
    check(
      '光标停在剩下那条空段落上',
      caret.line === 3 && caret.text === '',
      JSON.stringify(caret)
    )
  }

  console.log('\n【AC】在标题前面回车 —— 新段(标题上面那条空行)要能点进去接着写')
  await loadDoc('正文\n\n# 标题\n\n内容\n')
  await setCaret(4) // 「# 标题」行首
  await key('Enter')
  {
    const doc = await docText()
    check('源码:新段占一条空行,上下各隔一条', doc === '正文\n\n\n\n# 标题\n\n内容\n', JSON.stringify(doc))
    const lines = await domLines()
    // DOM 行:正文 / 空 / 空 / 空 / # 标题 / 空 / 内容 / 文末空行
    const para = lines[3]
    check(
      '标题上面那条空行是新段,不按结构空行收紧',
      !!para && para.text === '' && !/cm-md-block-gap/.test(para.cls),
      para?.cls ?? 'none'
    )
    check('标题仍按标题渲染', /cm-md-h1/.test(lines[4]?.cls ?? ''), JSON.stringify(lines.map(l => `${l.text}[${l.cls}]`)))
  }
  check('能点进这条新段', await clickDomLine(3))
  {
    const caret = await caretInfo()
    check('光标落在这条空行上(没被送回上一段/标题)', caret.line === 4 && caret.text === '', JSON.stringify(caret))
  }
  await type('新段')
  {
    const src = await readSource()
    check('落盘:写在新段里,标题没被吞', src.join('|') === '正文|||新段|# 标题||内容', JSON.stringify(src))
    const lines = await domLines()
    check('标题仍是标题', /cm-md-h1/.test(lines[4]?.cls ?? ''), JSON.stringify(lines.map(l => `${l.text}[${l.cls}]`)))
  }

  console.log('\n【AD】在正文段行首回车 —— 光标留在原行行首,上面那条空行同样点得进去')
  await loadDoc('甲\n\n乙\n')
  await setCaret(3) // 「乙」行首
  await key('Enter')
  {
    const doc = await docText()
    check('源码:甲 / 空 / 空 / 乙', doc === '甲\n\n\n\n乙\n', JSON.stringify(doc))
    const lines = await domLines()
    const para = lines[3] // 「乙」上面那条空行
    check(
      '新段不按结构空行收紧',
      !!para && para.text === '' && !/cm-md-block-gap/.test(para.cls),
      para?.cls ?? 'none'
    )
    check('新段和下面的正文之间留着段间距', !!para && /cm-md-gap-body/.test(para.cls), para?.cls ?? 'none')
  }
  check('能点进这条新段', await clickDomLine(3))
  {
    const caret = await caretInfo()
    check('光标落在这条空行上', caret.line === 4 && caret.text === '', JSON.stringify(caret))
  }

  console.log('\n【AE】代码块和标题之间回车 —— 代码块间距和标题上留白夹着的新段也点得进去')
  await loadDoc('```\ncode\n```\n\n# 标题\n\n内容\n')
  await setCaret(14) // 「# 标题」行首
  await key('Enter')
  {
    const doc = await docText()
    check('源码:标题前面多出一条空段落', doc === '```\ncode\n```\n\n\n\n# 标题\n\n内容\n', JSON.stringify(doc))
    const lines = await domLines()
    // DOM 行:``` / code / ``` / 空 / 空 / 空 / # 标题 / 空 / 内容 / 文末空行
    const para = lines[5]
    check(
      '新段没有被代码块间距收成结构空行',
      !!para && para.text === '' && !/cm-md-block-gap/.test(para.cls),
      para?.cls ?? 'none'
    )
  }
  check('能点进这条新段', await clickDomLine(5))
  {
    const caret = await caretInfo()
    check('光标落在这条空行上', caret.line === 6 && caret.text === '', JSON.stringify(caret))
  }
  await type('新段')
  {
    const src = await readSource()
    check('落盘:新段在代码块和标题之间', src.join('|') === '```|code|```|||新段|# 标题||内容', JSON.stringify(src))
  }

  console.log('\n【AF】文档第一行行首回车 —— 新段是第一行,下面正文之间要留段落间距')
  await loadDoc('1\n')
  await setCaret(0)
  await key('Enter')
  {
    const doc = await docText()
    check('源码:第一行是新段,和下面正文之间隔着一条空行', doc === '\n\n1\n', JSON.stringify(doc))
    const lines = await domLines()
    check(
      '第一行就是新段,按整行留出,和下面的正文隔开段落间距',
      lines.length === 4 &&
        lines[0]?.text === '' &&
        /cm-md-empty-paragraph/.test(lines[0].cls) &&
        !/cm-md-block-gap/.test(lines[0].cls) &&
        lines[0].height >= 30 &&
        !!lines[1] &&
        /cm-md-block-gap/.test(lines[1].cls) &&
        lines[2]?.text === '1',
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }
  const topBefore = (await domLines())[2]?.top ?? 0
  check('能点进这条新段', await clickDomLine(0))
  {
    const caret = await caretInfo()
    check('光标落在第一行', caret.line === 1 && caret.text === '', JSON.stringify(caret))
    const topAfter = (await domLines())[2]?.top ?? 0
    check('点进去后下面那行没有往下挪', topAfter === topBefore, `${topBefore} → ${topAfter}`)
  }
  await type('X')
  {
    const src = await readSource()
    check('落盘:写在新段里,原有正文仍在下面', src.join('|') === 'X||1', JSON.stringify(src))
  }

  console.log('\n【AG】文件开头留着空行时,点最上面那条结构空行 —— 光标挪到正文,不把行撑开')
  await loadDoc('\n\n1\n')
  await setCaret(4)
  {
    const lines = await domLines()
    check(
      '前导空行按结构空行收紧',
      lines.length === 4 && !!lines[0] && /cm-md-block-gap/.test(lines[0].cls),
      JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))
    )
  }
  const topsBefore = (await domLines()).map(l => l.top)
  check('点最上面那条', await clickDomLine(0))
  {
    const caret = await caretInfo()
    const after = await domLines()
    check('光标落到正文行,不留在结构空行上', caret.line === 3 && caret.text === '1', JSON.stringify(caret))
    check(
      '各行位置不变(结构空行没有被撑开)',
      after.length === topsBefore.length && after.every((l, i) => l.top === topsBefore[i]),
      JSON.stringify({ before: topsBefore, after: after.map(l => l.top) })
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
