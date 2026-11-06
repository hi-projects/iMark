/**
 * 相邻代码块 → 文件标签页验收。
 *
 * 验的是 WYSIWYG 装饰层里「相邻 FencedCode 合成一组」这一轮改动
 * (src/renderer/src/editor/wysiwyg/codeTabs.ts + rules.ts 的 styleFencedCodeGroup):
 *
 *  · 两块围栏连在一起(中间只有空白 / 空行)时,组头上方出现文件标签条;
 *  · 标签文字取 info string 的 title=…,没有 title 时叫「未命名代码块N」;
 *    序号只数未命名的块(前面已命名的块不占号);
 *  · 默认只显示第一块,其余块整行折成零高度(源码仍在文档里);
 *  · 点标签切换显示的文件,文档内容一个字符都不改;
 *  · 光标进入某一块(点标签、键盘移动)时显示那一块,离开后回到上次选中的文件;
 *  · 跨块的整篇选中会把所有块都露出来,不隐藏选中的内容;
 *  · 中间只隔空行仍算「连在一起」(回车会补空行,不合并的话正常输入凑不出组);
 *  · 中间夹了正文的代码块**不**合并,仍按普通代码块显示;
 *  · 与 Mermaid 相邻不算「连在一起」(Mermaid 有自己的渲染态);
 *  · 选中块的开围栏行原样显示 ` ```js title="main.js" `(真实源码行,能直接点
 *    进去改):改语言 / 改 title= 都在这行上敲,标签名随之更新,没有额外的
 *    输入控件;title 删掉后标签退回「未命名代码块N」。
 *  · 没写 title 的块在用户编辑时自动补上 `title="未命名代码块N"`(写进源码,
 *    而不是只显示);光标正停在的那条围栏行不补,免得顶掉用户手敲的 title。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs code-tabs
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
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

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
const REPO = join(__dirname, '..', '..')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const GROUP = [
  '# 代码标签',
  '',
  '```js title="main.js"',
  'const a = 1',
  '```',
  '```js title="preload.js"',
  'const b = 2',
  '```',
  '```html title="index.html"',
  '<b>c</b>',
  '```',
  '',
  '末尾',
  ''
].join('\n')

const PLAIN = [
  '# 无标题',
  '',
  '```js',
  'const a = 1',
  '```',
  '```css',
  'a { color: red }',
  '```',
  ''
].join('\n')

/** 用户实际文件的样子:回车补出的空行隔在两块之间 */
const SPLIT = [
  '# 隔了空行',
  '',
  '```js title="a.js"',
  'const a = 1',
  '```',
  '',
  '```js title="b.js"',
  'const b = 2',
  '```',
  ''
].join('\n')

/** 中间夹了正文:两块各自独立,不合成标签组 */
const TEXT_BETWEEN = [
  '# 中间有正文',
  '',
  '```js title="a.js"',
  'const a = 1',
  '```',
  '',
  '中间的说明',
  '',
  '```js title="b.js"',
  'const b = 2',
  '```',
  ''
].join('\n')

/** 第一块已命名、后两块未命名:未命名编号从 1 起,不被已命名的块占号 */
const MIXED = [
  '# 混合命名',
  '',
  '```js title="main.js"',
  'const a = 1',
  '```',
  '```css',
  'a { color: red }',
  '```',
  '```html',
  '<b>c</b>',
  '```',
  ''
].join('\n')

const MERMAID = [
  '# 图表隔断',
  '',
  '```js title="a.js"',
  'const a = 1',
  '```',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '```js title="b.js"',
  'const b = 2',
  '```',
  ''
].join('\n')

/** 两个都没写 title 的相邻块:编辑时自动名要真的写进源码 */
const AUTO = [
  '# 自动命名',
  '',
  '```js',
  'const a = 1',
  '```',
  '```xml',
  'a a',
  '```',
  ''
].join('\n')

/** 用户反馈的场景:第一个块有 title,第二个块没有 title(空的 xml 块) */
const SWITCH_BACK = [
  '# 切回',
  '',
  '```js title="a.js"',
  'aaa',
  '```',
  '```xml',
  '',
  '```',
  ''
].join('\n')

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs code-tabs` 跑会自动带上)')
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
  const note = join(vault, '代码标签.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })

  await writeFile(note, GROUP, 'utf8')
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
        lineWrapping: true
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
  win.setContentSize(900, 1000)
  // 真鼠标事件要窗口在 xvfb 里真渲染出来才会派发
  win.show()
  const wc = win.webContents
  wc.on('console-message', (_event, ...args: unknown[]) => {
    const first = args[0]
    if (first && typeof first === 'object') {
      const details = first as { level?: string; message?: string }
      if (details.level !== 'debug') console.log(`[renderer:${details.level}] ${details.message}`)
    } else if (typeof args[1] === 'string') {
      console.log(`[renderer:${String(first)}] ${args[1]}`)
    }
  })
  wc.on('render-process-gone', (_event, details) => console.log('[render-process-gone]', details))
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1000)
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(120)
  }

  /** 编辑器视图:CM 把它挂在 .cm-content 的 cmTile.root.view 上 */
  const VIEW = `document.querySelector('.cm-content')?.cmTile?.root?.view`

  const tabsInfo = (): Promise<{
    count: number
    labels: string[]
    active: number
    fence: string
    fenceCount: number
    text: string
    source: string
    codeLineCount: number
    voidLineCount: number
    barTop: number | null
    barBottom: number | null
    barHeight: number | null
    firstCodeTop: number | null
  }> =>
    evalJs(`
      (() => {
        const view = ${VIEW}
        const bar = document.querySelector('.cm-md-code-tabs')
        const tabs = bar ? [...bar.querySelectorAll('.cm-md-code-tab')] : []
        const codeLines = [...document.querySelectorAll('.cm-line.cm-md-code')]
        return {
          count: tabs.length,
          labels: tabs.map(t => t.textContent),
          active: tabs.findIndex(t => t.classList.contains('is-active')),
          fence: document.querySelector('.cm-line.cm-md-code-fence')?.textContent ?? '',
          fenceCount: document.querySelectorAll('.cm-line.cm-md-code-fence').length,
          text: document.querySelector('.cm-content')?.textContent ?? '',
          source: view ? view.state.doc.toString() : '',
          codeLineCount: codeLines.length,
          voidLineCount: document.querySelectorAll('.cm-line.cm-md-code-void').length,
          barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
          firstCodeTop: codeLines.length ? Math.round(codeLines[0].getBoundingClientRect().top) : null,
          barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
          barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null
        }
      })()`)

  const clickTab = async (index: number): Promise<void> => {
    await evalJs(`
      (() => {
        const tabs = document.querySelectorAll('.cm-md-code-tabs .cm-md-code-tab')
        tabs[${index}]?.click()
        return true
      })()`)
    await sleep(300)
  }

  /** 真鼠标点击标签(走 mousedown → mouseup → click,和用户操作一致) */
  const clickTabReal = async (index: number): Promise<boolean> => {
    const spot = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const tab = document.querySelectorAll('.cm-md-code-tabs .cm-md-code-tab')[${index}]
        if (!tab) return null
        const r = tab.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!spot) return false
    wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await sleep(350)
    return true
  }

  /**
   * 选中源码里 needle 后面 offset 起的 length 个字符(模拟用户用鼠标圈住
   * `js` / `main.js` 这类片段)。返回 false 表示 needle 已经不在文档里。
   */
  const selectInSource = async (
    needle: string,
    offset: number,
    length: number
  ): Promise<boolean> => {
    const ok = await evalJs<boolean>(`
      (() => {
        const view = ${VIEW}
        if (!view) return false
        const pos = view.state.doc.toString().indexOf(${JSON.stringify(needle)})
        if (pos < 0) return false
        view.dispatch({ selection: { anchor: pos + ${offset}, head: pos + ${offset + length} } })
        view.focus()
        return true
      })()`)
    await sleep(150)
    return ok
  }

  /** 把光标放到 needle 所在那一行的行尾(围栏行末尾补 ` title="…"` 用) */
  const caretToLineEnd = async (needle: string): Promise<boolean> => {
    const ok = await evalJs<boolean>(`
      (() => {
        const view = ${VIEW}
        if (!view) return false
        const pos = view.state.doc.toString().indexOf(${JSON.stringify(needle)})
        if (pos < 0) return false
        view.dispatch({ selection: { anchor: view.state.doc.lineAt(pos).to } })
        view.focus()
        return true
      })()`)
    await sleep(150)
    return ok
  }

  /**
   * 往当前焦点里敲字。合成输入偶尔整段丢(窗口/编辑器失焦时尤其),
   * 一个字都没落进去就重新聚焦再打;只落了半截的由后面的断言报出来。
   */
  const typeInto = async (text: string): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await evalJs<string>(`${VIEW}?.state.doc.toString() ?? ''`)
      await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
      await sleep(80)
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(25)
      }
      await sleep(220)
      const after = await evalJs<string>(`${VIEW}?.state.doc.toString() ?? ''`)
      if (after !== before) return
      console.log(`    (第 ${attempt} 次输入整段没落进去:${JSON.stringify(text)})`)
    }
  }

  const press = async (keyCode: string): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(300)
  }

  /** 每行渲染出的文本与行类,排查「切换后显示错块」 */
  const lineDump = (): Promise<{ text: string; cls: string }[]> =>
    evalJs(`
      (() => [...document.querySelectorAll('.cm-content .cm-line')].map(line => {
        const copy = line.cloneNode(true)
        copy.querySelectorAll('.cm-md-code-copy, .cm-md-code-tabs').forEach(n => n.remove())
        return { text: copy.textContent, cls: line.className }
      }))()`)

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })

  const saveShot = async (name: string): Promise<boolean> => {
    for (let i = 0; i < 5; i++) {
      try {
        await writeFile(join(shots, name), (await wc.capturePage()).toPNG())
        return true
      } catch {
        await sleep(200)
      }
    }
    return false
  }

  // ---------- 1. 组头标签条 ----------

  console.log('\n【1】三块紧挨着的代码块合成一组,组头显示文件名标签')
  let info = await tabsInfo()
  console.log(`    [几何] ${JSON.stringify(info)}`)
  check('出现标签条', info.count === 3, String(info.count))
  check('标签取 title= 的文件名', JSON.stringify(info.labels) === '["main.js","preload.js","index.html"]', JSON.stringify(info.labels))
  check('默认选中第一块', info.active === 0, String(info.active))
  check('开围栏行按源码显示', info.fence === '```js title="main.js"', JSON.stringify(info.fence))
  check('标签条在代码上方', info.barTop !== null && info.firstCodeTop !== null && info.barTop < info.firstCodeTop, `${info.barTop} / ${info.firstCodeTop}`)
  check(
    '标签条紧贴代码正文(中间没有空行 / 多余留白)',
    info.barBottom !== null && info.firstCodeTop !== null && Math.abs(info.barBottom - info.firstCodeTop) <= 1,
    `${info.barBottom} vs ${info.firstCodeTop}`
  )
  check('标签条有可读高度', (info.barHeight ?? 0) >= 28, String(info.barHeight))

  // ---------- 2. 只显示选中的文件 ----------

  console.log('\n【2】只显示选中的文件,其余块折成零高度(源码仍在)')
  check('显示 main.js 的正文', info.text.includes('const a = 1'))
  check('preload.js / index.html 的正文没有渲染', !info.text.includes('const b = 2') && !info.text.includes('<b>c</b>'))
  check('其余块整行折成零高度', info.voidLineCount === 6, String(info.voidLineCount))
  check('文档源码没有被渲染改动', info.source === GROUP, JSON.stringify(info.source.slice(0, 40)))

  // ---------- 3. 点标签切换 ----------

  console.log('\n【3】点第二个标签 → 切换到 preload.js,文档不变,光标进入该块')
  await clickTab(1)
  info = await tabsInfo()
  check('选中项变成 preload.js', info.active === 1, String(info.active))
  check('开围栏行跟着切换', info.fence === '```js title="preload.js"', JSON.stringify(info.fence))
  check('显示 preload.js 的正文', info.text.includes('const b = 2'))
  check('main.js 的正文已隐藏', !info.text.includes('const a = 1'))
  check('切换显示不改文档', info.source === GROUP)
  const cursor = await evalJs<{ text: string; inBlock: boolean }>(`
    (() => {
      const view = ${VIEW}
      if (!view) return { text: '', inBlock: false }
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      return { text: line.text, inBlock: line.text === 'const b = 2' }
    })()`)
  check('光标落到所选文件的第一行', cursor.inBlock, JSON.stringify(cursor))

  // ---------- 4. 键盘进入某一块 ----------

  console.log('\n【4】光标进入第三块(模拟键盘移动)显示第三块;离开组后仍停在第三块')
  await evalJs(`
    (() => {
      const view = ${VIEW}
      const doc = view.state.doc.toString()
      const pos = doc.indexOf('<b>c</b>')
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
      return true
    })()`)
  await sleep(300)
  info = await tabsInfo()
  check('光标所在的 index.html 显示出来', info.text.includes('<b>c</b>') && !info.text.includes('const b = 2'))
  check('选中标签跟着光标走', info.active === 2, String(info.active))
  await evalJs(`(() => { const view = ${VIEW}; view.dispatch({ selection: { anchor: 0 } }); return true })()`)
  await sleep(300)
  info = await tabsInfo()
  check(
    '光标离开组后仍停在 index.html(在哪个就在哪个)',
    info.active === 2 && info.text.includes('<b>c</b>'),
    String(info.active)
  )

  // ---------- 5. 跨块选中不隐藏内容 ----------

  console.log('\n【5】整篇选中时所有块都按源码显示')
  await evalJs(`
    (() => {
      const view = ${VIEW}
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      view.focus()
      return true
    })()`)
  await sleep(400)
  info = await tabsInfo()
  check('三块正文都出现', info.text.includes('const a = 1') && info.text.includes('const b = 2') && info.text.includes('<b>c</b>'))
  check('三块的开围栏行都露出来', info.fenceCount === 3, String(info.fenceCount))
  check('标签条不挡住选中的源码', info.count === 3, String(info.count))

  // ---------- 6. 没有 title 时退回未命名编号 ----------

  console.log('\n【6】没有 title= 的相邻代码块也会合并,标签用「未命名代码块N」')
  await loadDoc(PLAIN)
  info = await tabsInfo()
  check(
    '标签是未命名代码块1 / 2,不是语言名',
    JSON.stringify(info.labels) === '["未命名代码块1","未命名代码块2"]',
    JSON.stringify(info.labels)
  )
  check('默认只显示第一块', info.text.includes('const a = 1') && !info.text.includes('color: red'))

  // ---------- 6b. 未命名编号不数已命名的块 ----------

  console.log('\n【6b】前面有已命名块时,未命名编号仍从 1 起')
  await loadDoc(MIXED)
  info = await tabsInfo()
  check(
    'main.js 之后是「未命名代码块1」「未命名代码块2」',
    JSON.stringify(info.labels) === '["main.js","未命名代码块1","未命名代码块2"]',
    JSON.stringify(info.labels)
  )

  // ---------- 7. 只隔空行仍然合并 ----------

  console.log('\n【7】中间只隔空行的代码块也算「连在一起」')
  await loadDoc(SPLIT)
  info = await tabsInfo()
  check('出现标签条', info.count === 2, String(info.count))
  check(
    '标签取两块的 title',
    JSON.stringify(info.labels) === '["a.js","b.js"]',
    JSON.stringify(info.labels)
  )
  check('默认只显示第一块', info.text.includes('const a = 1') && !info.text.includes('const b = 2'))
  check('组内空行也折成零高度', info.voidLineCount === 4, String(info.voidLineCount))

  // ---------- 7b. 中间夹正文不合并 ----------

  console.log('\n【7b】中间夹了正文的代码块不合并')
  await loadDoc(TEXT_BETWEEN)
  info = await tabsInfo()
  check('没有标签条', info.count === 0, String(info.count))
  check(
    '两块正文都按普通代码块显示',
    info.text.includes('const a = 1') && info.text.includes('const b = 2')
  )
  check('没有块被折叠', info.voidLineCount === 0, String(info.voidLineCount))

  // ---------- 8. Mermaid 不参与合并 ----------

  console.log('\n【8】Mermaid 两侧的代码块不算「连在一起」')
  await loadDoc(MERMAID)
  info = await tabsInfo()
  check('js 块没有被合成标签组', info.count === 0, String(info.count))
  check('Mermaid 仍是自己的图表渲染态', (await evalJs<number>(`document.querySelectorAll('.cm-md-mermaid').length`)) === 1)
  check('两侧 js 正文都显示', info.text.includes('const a = 1') && info.text.includes('const b = 2'))

  // ---------- 9. 用户反馈:真鼠标切到第二块再切回第一块 ----------

  console.log('\n【9】真鼠标来回切换:切回 a.js 后显示 a.js 正文与语言信息')
  await loadDoc(SWITCH_BACK)
  info = await tabsInfo()
  check('加载后默认选中 a.js', info.active === 0 && info.text.includes('aaa'), JSON.stringify(info.labels))
  check(
    '未命名块不再拿语言当标签',
    JSON.stringify(info.labels) === '["a.js","未命名代码块1"]',
    JSON.stringify(info.labels)
  )
  check('a.js 的围栏行在', info.fence === '```js title="a.js"', JSON.stringify(info.fence))

  check('真鼠标点中第二个标签', await clickTabReal(1))
  info = await tabsInfo()
  check('切到第二块后它处于选中态', info.active === 1, String(info.active))
  check('第二块的围栏行是 ```xml', info.fence === '```xml', JSON.stringify(info.fence))
  check('第二块是空的,不渲染 a.js 的正文', !info.text.includes('aaa'))
  await saveShot('code-tabs-empty-block.png')

  check('真鼠标点回 a.js 标签', await clickTabReal(0))
  info = await tabsInfo()
  check('选中态回到 a.js', info.active === 0, String(info.active))
  check('切回后围栏行重新显示 a.js', info.fence === '```js title="a.js"', JSON.stringify(info.fence))
  check('重新显示 a.js 的正文', info.text.includes('aaa'))
  check('标签条仍然完整', info.count === 2, String(info.count))
  await saveShot('code-tabs-switch-back.png')
  console.log(`    [切回后的行] ${JSON.stringify(await lineDump())}`)

  // ---------- 10. 光标进过哪一块,离开后就停在哪一块 ----------

  console.log('\n【10】不点标签、只用光标进块:离开组后停在最后所在的那一块')
  await loadDoc(GROUP)
  await evalJs(`
    (() => {
      const view = ${VIEW}
      const pos = view.state.doc.toString().indexOf('<b>c</b>')
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
      return true
    })()`)
  await sleep(300)
  info = await tabsInfo()
  check('光标进入第三块时它是选中态', info.active === 2, String(info.active))
  await evalJs(`(() => { const view = ${VIEW}; view.dispatch({ selection: { anchor: 0 } }); return true })()`)
  await sleep(300)
  info = await tabsInfo()
  check(
    '光标离开组后仍停在 index.html',
    info.active === 2 && info.text.includes('<b>c</b>'),
    String(info.active)
  )

  console.log('\n【10b】连续点两个标签再离开:停在最后点的那个')
  await loadDoc(GROUP)
  await clickTab(0)
  await clickTab(1)
  check('先点 main.js 再点 preload.js', (await tabsInfo()).active === 1)
  await evalJs(`(() => { const view = ${VIEW}; view.dispatch({ selection: { anchor: 0 } }); return true })()`)
  await sleep(300)
  info = await tabsInfo()
  check(
    '离开组后停在最后点的 preload.js',
    info.active === 1 && info.text.includes('const b = 2'),
    String(info.active)
  )

  // ---------- 11. 开围栏行就是源码,直接改语言 ----------

  console.log('\n【11】开围栏行原样显示,直接在上面改语言')
  await loadDoc(GROUP)
  info = await tabsInfo()
  check('围栏行是完整的源码行', info.fence === '```js title="main.js"', JSON.stringify(info.fence))
  check(
    '标签条里没有额外的语言行 / 输入框',
    (await evalJs<number>(
      `document.querySelectorAll('.cm-md-code-tabs-info, .cm-md-code-tabs input, .cm-md-code-tab input').length`
    )) === 0
  )
  // 圈住围栏行里的 js,像用户一样直接敲字符替换掉
  check('选中围栏行里的 js', await selectInSource('```js', 3, 2))
  await typeInto('python')
  info = await tabsInfo()
  check(
    '源码里的语言改成 python(title 保留)',
    info.source.includes('```python title="main.js"'),
    JSON.stringify(info.source.split('\n').slice(2, 4))
  )
  check('围栏行显示 python', info.fence === '```python title="main.js"', JSON.stringify(info.fence))
  check('标签名不受影响', JSON.stringify(info.labels) === '["main.js","preload.js","index.html"]', JSON.stringify(info.labels))
  check('正文一个字符没动', info.source.includes('const a = 1') && info.source.includes('const b = 2'))
  await saveShot('code-tabs-language-edit.png')

  // ---------- 12. 在同一行改 title= ----------

  console.log('\n【12】在同一行改 title=,标签名跟着变')
  await loadDoc(GROUP)
  check('选中 title 里的 main.js', await selectInSource('title="main.js"', 7, 'main.js'.length))
  await typeInto('app.js')
  info = await tabsInfo()
  check('源码里的 title 改成 app.js', info.source.includes('```js title="app.js"'), JSON.stringify(info.source.split('\n').slice(2, 3)))
  check('标签显示新名字', info.labels[0] === 'app.js', JSON.stringify(info.labels))
  check('其余标签不变', info.labels[1] === 'preload.js' && info.labels[2] === 'index.html', JSON.stringify(info.labels))
  check('围栏行跟着显示新名字', info.fence === '```js title="app.js"', JSON.stringify(info.fence))

  // ---------- 13. 未命名块:行尾补 title= / 删掉 title= ----------

  console.log('\n【13】未命名块:围栏行补上 title= 就有名字,删掉又退回「未命名代码块N」')
  await loadDoc(MIXED)
  info = await tabsInfo()
  check('起始标签', JSON.stringify(info.labels) === '["main.js","未命名代码块1","未命名代码块2"]', JSON.stringify(info.labels))
  await clickTab(1)
  info = await tabsInfo()
  check('切到第二块,围栏行是 ```css', info.fence === '```css', JSON.stringify(info.fence))
  // 光标放到围栏行末尾,补上 title——和用户在源码里写的一模一样
  check('光标落到 css 块围栏行末尾', await caretToLineEnd('```css'))
  await typeInto(' title="工具.js"')
  info = await tabsInfo()
  check('源码里写上 title="工具.js"', info.source.includes('```css title="工具.js"'), JSON.stringify(info.source.split('\n').slice(5, 6)))
  check(
    '标签显示工具.js;后面未命名块保留自动名(名字已写进源码,不再重排)',
    JSON.stringify(info.labels) === '["main.js","工具.js","未命名代码块2"]',
    JSON.stringify(info.labels)
  )
  // 再把 title 删掉:圈住 ` title="工具.js"` 按 Delete
  check('选中后面这段 title', await selectInSource(' title="工具.js"', 0, ' title="工具.js"'.length))
  await press('Delete')
  info = await tabsInfo()
  check(
    '名字清空后源码去掉 title=',
    info.source.includes('```css\n') && !info.source.includes('工具.js'),
    JSON.stringify(info.source.split('\n').slice(5, 7))
  )
  check(
    '标签退回自动名',
    JSON.stringify(info.labels) === '["main.js","未命名代码块1","未命名代码块2"]',
    JSON.stringify(info.labels)
  )

  // ---------- 14. 未命名块自动补 title= ----------

  console.log('\n【14】没写 title 的块:用户一编辑,自动名真的写进源码')
  await loadDoc(AUTO)
  info = await tabsInfo()
  check(
    '加载时只是显示自动名,源码里没有 title',
    JSON.stringify(info.labels) === '["未命名代码块1","未命名代码块2"]' &&
      !info.source.includes('title='),
    JSON.stringify(info.source.split('\n').slice(2, 8))
  )
  check('光标落到第二块正文末尾', await selectInSource('a a', 3, 0))
  await typeInto('!')
  info = await tabsInfo()
  check(
    '两块都补上了 title="未命名代码块N"',
    info.source.includes('```js title="未命名代码块1"') &&
      info.source.includes('```xml title="未命名代码块2"'),
    JSON.stringify(info.source.split('\n').slice(2, 8))
  )
  check('正文照常输入', info.source.includes('a a!'))
  check(
    '标签名不变(本来就是这个自动名)',
    JSON.stringify(info.labels) === '["未命名代码块1","未命名代码块2"]',
    JSON.stringify(info.labels)
  )
  check('围栏行显示补上的名字', info.fence === '```xml title="未命名代码块2"', JSON.stringify(info.fence))

  // ---------- 截图 ----------

  await loadDoc(GROUP)
  console.log(`\n截图:${(await saveShot('code-tabs.png')) ? join(shots, 'code-tabs.png') : '(不可用)'}`)
  try {
    await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true })()`)
    await sleep(400)
    await saveShot('code-tabs-dark.png')
    await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true })()`)
  } catch {
    /* 截图只是观感产物 */
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  app.exit(2)
})
