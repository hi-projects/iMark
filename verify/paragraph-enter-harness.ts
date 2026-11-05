/**
 * 回车 = 新段 / Shift+回车 = 段内换行的端到端验证。
 *
 * 规则(源码层面,别的 Markdown 编辑器打开也成立):
 *   - 正文里回车:源码补空行,光标落下去接着写;两行之间真的隔着一个空行。
 *   - 光标在行尾、下一行还是同一段(源码软换行):回车从中间断段,光标落到
 *     断点后面的文字上,只补一个换行 —— 原来的行尾换行就充当空行。
 *   - 下一行已经是另一个块(标题等):新段两边都要空行,否则会并进相邻段。
 *   - 标题行尾回车:标题自己就是块边界,标题和新段之间不再补空行(比正文少
 *     一条),否则标题后面一按回车就出现三条空行;标题后面只剩空行(文末)
 *     时只把光标挪到空行上,源码不动。
 *   - Shift+回车:硬换行(行尾两个空格),两行仍是同一段;iMark 里是行间距,
 *     别的编辑器里是段内换行。列表 / 引用里把容器前缀带到下一行。
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

  const readSource = async (): Promise<string[]> => {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(600)
    const text = await readFile(note, 'utf8')
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
  await type('下半')
  {
    const src = await readSource()
    check('落盘:行尾是两个空格 + 换行(标准硬换行)', src.join('|') === '上半  |下半', JSON.stringify(src))
    const lines = await domLines()
    const p = pitch(lines, '上半', '下半')
    const h = lines[0]?.height ?? 0
    check('两行按行间距排,不是段间距', p !== null && Math.abs(p - h) <= 1, `pitch=${p} h=${h} ${JSON.stringify(lines)}`)
    check('第二行没有段间距 class', !/cm-md-block-gap/.test(lines[1]?.cls ?? ''), lines[1]?.cls ?? 'none')
  }

  console.log('\n【F】列表项 Shift+回车 —— 硬换行留在同一项里(续行缩进到内容列)')
  await loadDoc('\n')
  await type('- 第一项')
  await key('Enter', ['shift'])
  await type('续行')
  {
    const src = await readSource()
    check('落盘:第二行缩进到内容列,仍是同一项', src.join('|') === '- 第一项  |  续行', JSON.stringify(src))
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

  console.log('\n【H】代码块里回车 / Shift+回车 —— 都是普通换行,不补空行也不写硬换行空格')
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
    check('代码行尾没有硬换行空格', src.slice(1, 5).every(l => !/\s$/.test(l)), JSON.stringify(src.slice(1, 5)))
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
    check('Shift+回车:硬换行 + 下一行仍是引用', src.join('|') === '|> 引用  |> 续', JSON.stringify(src))
  }

  console.log('\n【J】空行上回车只补一行')
  await loadDoc('\n正文')
  await key('Enter')
  {
    const src = await readSource()
    check('落盘:从 2 行变 3 行,不是连出两条空行', src.length === 3 && src[2] === '正文', JSON.stringify(src))
  }

  console.log('\n【K】标题行尾回车 —— 新段是正文,且紧贴标题(标题自己就是块边界)')
  await loadDoc('\n# 标题')
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

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
