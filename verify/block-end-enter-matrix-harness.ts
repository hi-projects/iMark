/**
 * 矩阵验收:九类正文块都放在文档末尾,做同一套操作:
 *
 *   1. 光标到文档末尾(块的后一条空行 / 块的末尾)
 *   2. 回车,在新行输入阿
 *   3. 光标回到阿行行首,一次 Backspace 就应该把阿直接接在块后面
 *      (阿上面不再留空行),而不是要按两次
 *   4. 再按一次 Backspace 不能把阿塞进围栏行(公式 / 代码 / 表格 / 图表),
 *      也不能把文档清空
 *
 * 对应「$$ 块末尾回车 → 输入阿 → 行首退格要按两次」在 正文/标题/代码/列表/
 * 引用/图片/表格/公式/图表 上的通用性。
 *
 * 跑法:xvfb-run -a node verify/run.mjs block-end-enter-matrix
 */
import { app, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'
import { APP_VERSION } from './appVersion'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const BLOCKS: { kind: string; source: string; tail: string; fence?: boolean; table?: boolean; fromDocEnd?: boolean }[] = [
  { kind: '正文', source: '正文\n', tail: '正文' },
  { kind: '标题', source: '# 标题\n', tail: '# 标题' },
  { kind: '代码', source: '```\nx\n```\n', tail: '```', fence: true },
  { kind: '列表', source: '- 项\n', tail: '项' },
  { kind: '引用', source: '> 引用\n', tail: '引用' },
  { kind: '图片', source: `![图](${IMG})\n`, tail: ')' },
  // 表格末尾没有可敲字的「行」,用户在表格后自动创建的那一条空行上回车,所以从文档末尾开始。
  // 表格后面固定留着一条结构空行(插入表格时应用自己补的),这里也照那个形态铺。
  { kind: '表格', source: '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n', tail: '| 1 | 2 |', table: true, fromDocEnd: true },
  { kind: '公式', source: '$$\nx\n$$\n', tail: '$$', fence: true },
  { kind: '图表', source: '```mermaid\nflowchart LR\nA-->B\n```\n', tail: '```', fence: true }

]

/** 阿是否已经与上面的块贴在一起:同一行里有别的字,或上一行非空 */
function joinedToBlock(doc: string): { ok: boolean; prev: string; line: string } {
  const lines = doc.split('\n')
  const idx = lines.findIndex(l => l.includes('阿'))
  if (idx < 0) return { ok: false, prev: '', line: '' }
  const line = lines[idx]
  const prev = idx > 0 ? lines[idx - 1] : ''
  const sameLine = line.replace('阿', '').trim().length > 0
  return { ok: sameLine || /\S/.test(prev), prev, line }
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
  win.setContentSize(1300, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1400)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(60)
  }
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(350)
  }
  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(40)
    }
    await sleep(300)
  }
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
    await focusEditor()
  }
  const snap = (): Promise<{ doc: string; line: number; text: string }> =>
    evalJs<{ doc: string; line: number; text: string }>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const line = v.state.doc.lineAt(v.state.selection.main.head)
        return { doc: v.state.doc.toString(), line: line.number, text: line.text }
      })()`)

  const only = process.env.ONLY_KIND
  for (const block of BLOCKS) {
    if (only && block.kind !== only) continue
    await loadDoc(block.source)
    // 光标放到「块最后一行内容」的行尾(即用户说的「光标在块末尾」);
    // 表格这种行末不能敲字的块,从文档末尾那条自动建出的空行开始。
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc
      let pos = doc.length
      if (${block.fromDocEnd ? 'false' : 'true'}) {
        let n = doc.lines
        while (n > 1 && !/\\S/.test(doc.line(n).text)) n -= 1
        pos = doc.line(n).to
      }
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      v.focus()
      return true
    })()`)
    await sleep(150)
    await key('Return')
    await type('阿')
    // 光标回到阿行行首
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const line = v.state.doc.lineAt(v.state.selection.main.head)
      v.dispatch({ selection: { anchor: line.from } })
      v.focus()
      return true
    })()`)
    await sleep(250)
    const before = await snap()
    await key('Backspace')
    const after1 = await snap()
    await key('Backspace')
    const after2 = await snap()

    const join1 = joinedToBlock(after1.doc)
    console.log(
      `[${block.kind}]\n  光标处回车+输入后 ${JSON.stringify(before.doc)}\n` +
        `  一次退格   ${JSON.stringify(after1.doc)}\n  两次退格   ${JSON.stringify(after2.doc)}`
    )
    // 表格后面固定留一条结构空行(表格与后续文字的分隔),一次退格收掉的
    // 是用户自己回车多出来的那几行,只剩这条结构空行。
    const tableJoin = block.kind === '表格'
      ? (() => {
          const m = /\| 1 \| 2 \|\n(\n*)阿/.exec(after1.doc)
          return !!m && m[1].length <= 1
        })()
      : join1.ok
    check(
      block.kind === '表格'
        ? `${block.kind}:一次 Backspace 后阿只剩一条结构空行之隔`
        : `${block.kind}:一次 Backspace 后阿已经贴住块(不再隔空行)`,
      tableJoin && after1.doc.includes('阿'),
      JSON.stringify({ after1: after1.doc, prev: join1.prev, line: join1.line })
    )
    // 第二次退格:围栏类块必须原地不动(不能把文字塞进围栏/表格行);
    // 正文 / 列表这类本来就是「继续向上并一行」,只要求文档没被写坏。
    // 表格的第二下退格会收掉表格后面那条结构空行(不碰表格行本身)
    const secondOk = block.fence
      ? after2.doc === after1.doc
      : block.table
        ? after2.doc.includes('| 1 | 2 |') && after2.doc.includes('阿')
        : after2.doc.includes('阿') && after2.doc.length > 0
    check(
      block.fence
        ? `${block.kind}:再按一次 Backspace 不会把阿塞进围栏行`
        : block.table
          ? `${block.kind}:再按一次 Backspace 不会把表格写坏`
          : `${block.kind}:再按一次 Backspace 文档仍完整(含阿)`,
      secondOk,
      JSON.stringify(after2.doc)
    )
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
