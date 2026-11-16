/**
 * 验收:反斜线转义(CommonMark)在编辑器里按「渲染后只留被转义字符」显示。
 *
 * 用户报告:`被 \[lower, upper\] 限制` 里的反斜线原样显示在屏幕上。期望:
 *   · `\[` `\]` `\*` `\_` `\#` `\$` `\\` 这些写法在离开选区时藏起反斜线,
 *     屏幕上只留被转义的字符;
 *   · 光标贴到转义字符上时仍按源码显示(方便删改);
 *   · 行首 `\[lower, upper\] 限制` 这种「收尾后面还有正文」的写法按转义处理,
 *     不会被当成块级公式吞掉后面的段落(与导出侧 markdown-it 一致);
 *   · 公式本身不受影响:多行 `\[ ... \]`、单行 `\[E=mc^2\]`、行内 `\(x\)`
 *     仍然渲染成公式。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs escape
 */

import { app, dialog, protocol } from 'electron'
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

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface LineInfo {
  text: string
  cls: string
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs escape` 跑会自动带上)')
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
  const note = join(vault, '测试.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '', 'utf8')
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
        lineWrapping: false
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

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  const docText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)

  const domLines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => ({
        text: el.textContent ?? '',
        cls: el.className
      }))`)

  const mathWidgets = (which = ''): Promise<number> =>
    evalJs<number>(
      `document.querySelectorAll(${JSON.stringify(`.cm-content .cm-md-math${which}`)}).length`
    )

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1100)
    await focusEditor()
  }

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(200)
  }

  const dump = (lines: LineInfo[]): string =>
    JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}[${l.cls}]`))

  // ---------- 1. 用户报告:段落中间的 \[ ... \] ----------

  console.log('\n【1】段落中间 `被 \\[lower, upper\\] 限制`:屏幕上没有反斜线')
  const DOC1 = String.raw`被 \[lower, upper\] 限制` + '\n'
  await loadDoc(DOC1)
  await setCaret(0)
  {
    const src = await docText()
    const lines = await domLines()
    check('源码没有被改动(转义仍是源码里的样子)', src === DOC1, JSON.stringify(src))
    check(
      '渲染后是「被 [lower, upper] 限制」',
      lines.some(l => l.text === '被 [lower, upper] 限制'),
      dump(lines)
    )
    check('屏幕上没有反斜线', !lines.some(l => l.text.includes('\\')), dump(lines))
    check('没有被误当成公式', (await mathWidgets()) === 0)
  }

  // ---------- 2. 光标贴在转义上:显示源码 ----------

  console.log('\n【2】光标贴到转义字符上时按源码显示,离开后又藏起来')
  await setCaret(2) // 第一个反斜线
  {
    const lines = await domLines()
    check(
      '光标在 `\\[` 上:反斜线露出来',
      lines.some(l => l.text === String.raw`被 \[lower, upper] 限制`),
      dump(lines)
    )
  }
  await setCaret(8) // `lower` 中间
  {
    const lines = await domLines()
    check(
      '光标移进正文:反斜线又藏起来',
      lines.some(l => l.text === '被 [lower, upper] 限制'),
      dump(lines)
    )
  }

  // ---------- 3. 其它与 Markdown 冲突的符号 ----------

  console.log('\n【3】`\\*` `\\_` `\\#` `\\$` `\\\\` 同样按字面显示')
  const DOC3 = [
    String.raw`\*不是斜体\*`,
    String.raw`\_不是下划线\_`,
    String.raw`\# 行首井号不是标题`,
    String.raw`价格 \$100 与一个反斜线` + ' \\\\'
  ].join('\n') + '\n'
  await loadDoc(DOC3)
  // 别停在文档开头:`\*` 正好在 0 处,光标贴着它时会按源码显示,盖住「藏起来」的效果
  await setCaret(3)
  {
    const src = await docText()
    const lines = await domLines()
    const byText = (t: string): LineInfo | undefined => lines.find(l => l.text === t)
    check('源码没有被改动', src === DOC3, JSON.stringify(src))
    check('`\\*` 渲染成字面星号', !!byText('*不是斜体*'), dump(lines))
    check(
      '没有变成斜体',
      !lines.some(l => /cm-md-em/.test(l.cls)),
      dump(lines)
    )
    check('`\\_` 渲染成字面下划线', !!byText('_不是下划线_'), dump(lines))
    const h = byText('# 行首井号不是标题')
    check('`\\#` 渲染成字面井号', !!h, dump(lines))
    check('行首不再按标题渲染', !!h && !/cm-md-h[1-6]/.test(h.cls), dump(lines))
    check('`\\$` 渲染成字面美元符号,`\\\\` 显示成一个反斜线', !!byText('价格 $100 与一个反斜线 \\'), dump(lines))
    check('屏幕上没有残留反斜线(除了 `\\\\` 本身要显示的那一个)', !lines.some(l => l.text.includes('\\\\')), dump(lines))
  }

  // ---------- 4. 行首 \[lower, upper\] 限制:转义,不是公式 ----------

  console.log('\n【4】行首 `\\[lower, upper\\] 限制` 按转义处理,不吞后面的段落')
  const DOC4 = ['区间', '', String.raw`\[lower, upper\] 限制`, '', '后文'].join('\n') + '\n'
  await loadDoc(DOC4)
  await setCaret(0)
  {
    const src = await docText()
    const lines = await domLines()
    check('源码没有被改动', src === DOC4, JSON.stringify(src))
    check('没有被当成公式块', (await mathWidgets()) === 0, dump(lines))
    check(
      '这一段显示成「[lower, upper] 限制」',
      lines.some(l => l.text === '[lower, upper] 限制'),
      dump(lines)
    )
    check(
      '后面的段落没有被吞掉',
      lines.some(l => l.text === '后文'),
      dump(lines)
    )
  }

  // ---------- 5. 回归:多行 \[ ... \] 仍是公式 ----------

  console.log('\n【5】回归:多行 `\\[ ... \\]` 公式照常渲染')
  const DOC5 = ['正文', '', String.raw`\[`, 'E = mc^2', String.raw`\]`].join('\n') + '\n'
  await loadDoc(DOC5)
  await setCaret(0)
  {
    const lines = await domLines()
    check('公式 widget 出现', (await mathWidgets('-display')) === 1, dump(lines))
    check('公式下面是折叠行', lines.some(l => /cm-md-math-void/.test(l.cls)), dump(lines))
    check(
      '源码里仍然保留 `\\[` 与 `\\]`',
      (await docText()).includes(String.raw`\[`) && (await docText()).includes(String.raw`\]`)
    )
  }

  // ---------- 6. 回归:单行 \[E=mc^2\] 仍是公式 ----------

  console.log('\n【6】回归:单独一行的 `\\[E=mc^2\\]` 仍是公式')
  const DOC6 = ['正文', '', String.raw`\[E=mc^2\]`].join('\n') + '\n'
  await loadDoc(DOC6)
  await setCaret(0)
  {
    const lines = await domLines()
    check('公式 widget 出现', (await mathWidgets('-display')) === 1, dump(lines))
    check(
      '公式源码没有被拆成转义文本',
      (await docText()) === DOC6,
      JSON.stringify(await docText())
    )
  }

  // ---------- 7. 回归:行内 \(x\) 仍是公式 ----------

  console.log('\n【7】回归:行内 `\\(x^2\\)` 仍是行内公式')
  const DOC7 = String.raw`正文 \(x^2\) 结束` + '\n'
  await loadDoc(DOC7)
  await setCaret(0)
  {
    const lines = await domLines()
    check('行内公式 widget 出现', (await mathWidgets('-inline')) === 1, dump(lines))
    check(
      '行内不残留 `\\(` 文本',
      !lines.some(l => l.text.includes('\\(')),
      dump(lines)
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
