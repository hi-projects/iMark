/**
 * 行内 HTML 白名单(services/inlineHtml)端到端验证。
 *
 * 覆盖三处落点,它们必须看到同一套标签:
 *   1. 导出的 HTML(markdown-it):白名单标签渲染、属性被丢弃、脚本/未知标签仍转义;
 *   2. 编辑器正文:成对标签留下等价样式、`<br>` 造成视觉换行、光标碰到时翻回源码;
 *   3. 表格单元格:走 renderInline,`<br>` / `<b>` 渲染成真元素。
 *
 * 跑法(在仓库根目录,无头,不弹窗口):
 *   xvfb-run -a node verify/run.mjs html-inline
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { renderMarkdownFragment } from '../src/renderer/src/services/exportHtml'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
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

const BODY_DOC =
  'a <b>粗体</b> 中间 <br> 换行 <del>删除</del> <kbd>Ctrl</kbd> <script>alert(1)</script>\n普通一行\n'

const TABLE_DOC = [
  '| 说明 |',
  '| --- |',
  '| 第一行<br>第二行 |',
  '| <b>粗体</b> |'
].join('\n')

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
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
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })

  await writeFile(note, BODY_DOC, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off'
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
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        console.log('    (页面重载超时:did-finish-load 没到)')
        resolve()
      }, 15000)
      wc.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
      wc.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer)
        console.log(`    (页面重载失败:${code} ${desc})`)
        resolve()
      })
    })
    wc.reload()
    await done
    await sleep(1000)
    await focusEditor()
  }

  // ---------- 1. 导出侧(markdown-it) ----------

  console.log('\n【1】导出:白名单标签渲染,属性丢弃,脚本与未知标签仍转义')
  const exportHtml = await renderMarkdownFragment(
    'a <br>b <b class="x" onclick="x()">粗</b> <mark>高</mark> ' +
      '<script>alert(1)</script> <img src=x onerror=1> <span style="color:red">s</span>'
  )
  check('白名单标签渲染成真元素', exportHtml.includes('<br>') && exportHtml.includes('<b>粗</b>'), exportHtml)
  check('属性被丢弃', !exportHtml.includes('class="x"') && !exportHtml.includes('onclick'), exportHtml)
  check(
    '脚本与未知标签仍按字面转义',
    exportHtml.includes('&lt;script&gt;') &&
      !exportHtml.includes('<script') &&
      exportHtml.includes('&lt;img') &&
      !exportHtml.includes('<img'),
    exportHtml
  )
  check('span 保留标签、丢掉 style', exportHtml.includes('<span>s</span>'), exportHtml)

  const blockHtml = await renderMarkdownFragment('a <div>x</div> **b**')
  check(
    '块级 HTML 维持字面显示,后面的 Markdown 照常解析',
    blockHtml.includes('&lt;div&gt;') && blockHtml.includes('<strong>b</strong>'),
    blockHtml
  )

  // ---------- 2. 编辑器正文 ----------

  console.log('\n【2】编辑器正文:成对标签出样式,<br> 真的换行')
  const docState = (): Promise<{ text: string; strong: number; strike: number; kbd: number; br: number }> =>
    evalJs(`
      (() => {
        const content = document.querySelector('.cm-content')
        return {
          text: content ? content.textContent : '',
          strong: document.querySelectorAll('.cm-content .cm-md-strong').length,
          strike: document.querySelectorAll('.cm-content .cm-md-strike').length,
          kbd: document.querySelectorAll('.cm-content .cm-md-html-kbd').length,
          br: document.querySelectorAll('.cm-content br.cm-md-html-br').length
        }
      })()`)

  const rendered = await docState()
  check('成对 <b> 渲染成加粗', rendered.strong > 0, JSON.stringify(rendered))
  check('成对 <del> 渲染成删除线', rendered.strike > 0, JSON.stringify(rendered))
  check('<kbd> 渲染成键帽', rendered.kbd > 0, JSON.stringify(rendered))
  check('<br> 换成真的 <br> 元素', rendered.br === 1, JSON.stringify(rendered))
  check('<script> 保持字面文本', rendered.text.includes('<script>alert(1)</script>'), rendered.text)
  check('隐藏状态下不显示标签源码', !rendered.text.includes('<b>'), rendered.text)

  const lineHeight = await evalJs<{ htmlLine: number; plainLine: number }>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const htmlLine = lines.find(l => l.querySelector('br.cm-md-html-br'))
      const plainLine = lines.find(l => l !== htmlLine && l.textContent.trim().length > 0)
      return {
        htmlLine: htmlLine ? htmlLine.getBoundingClientRect().height : 0,
        plainLine: plainLine ? plainLine.getBoundingClientRect().height : 0
      }
    })()`)
  check(
    '含 <br> 的行比普通行高(视觉上断成两行)',
    lineHeight.htmlLine > lineHeight.plainLine * 1.5,
    JSON.stringify(lineHeight)
  )

  // 选中整行(与标签区间相交)时翻回源码
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Home' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Home' })
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['shift'] })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['shift'] })
  await sleep(300)
  const selected = await docState()
  check(
    '选区碰到标签时显示 <b> / <br> 源码',
    selected.text.includes('<b>') && selected.text.includes('<br>'),
    selected.text
  )

  // ---------- 3. 表格单元格 ----------

  console.log('\n【3】表格单元格:renderInline 也走同一份白名单')
  await loadDoc(`${TABLE_DOC}\n`)
  const cellState = await evalJs<{
    table: number
    cellHtml: string
    brHeight: number
    plainHeight: number
    bold: number
  }>(`
    (() => {
      const cells = [...document.querySelectorAll('.cm-content .cm-md-table-widget td')]
      const withBr = cells.find(el => el.querySelector('br'))
      const plain = cells.find(el => el !== withBr)
      return {
        table: document.querySelectorAll('.cm-content .cm-md-table-widget table').length,
        cellHtml: withBr ? withBr.innerHTML : '',
        brHeight: withBr ? withBr.getBoundingClientRect().height : 0,
        plainHeight: plain ? plain.getBoundingClientRect().height : 0,
        bold: document.querySelectorAll('.cm-content .cm-md-table-widget td b').length
      }
    })()`)
  check('表格渲染出来了', cellState.table === 1, String(cellState.table))
  check('单元格里的 <br> 是元素而不是文本', cellState.cellHtml.includes('<br>'), cellState.cellHtml)
  check('含 <br> 的单元格比普通格高', cellState.brHeight > cellState.plainHeight, JSON.stringify(cellState))
  check('单元格里的 <b> 是元素', cellState.bold > 0, JSON.stringify(cellState))

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  try {
    await writeFile(join(shots, 'html-inline.png'), (await wc.capturePage()).toPNG())
  } catch (err) {
    console.warn(`[verify] 截图失败(不影响断言):${err instanceof Error ? err.message : String(err)}`)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
