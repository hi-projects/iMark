/**
 * 验收:扩展的编辑器桥(阶段三)。
 *
 * 这一轮不碰市场、不装内置包,直接往数据目录里放一个 `test.editor` 扩展,
 * 盯的是宿主进程与真实 CodeMirror 之间的往返:
 *
 *   [1] 启动快照:打开的文档、活动编辑器、工作区文件夹都进了宿主镜像
 *   [2] 用户打字 → `onDidChangeTextDocument` 的增量与版本号
 *   [3] `TextEditor.edit` 一次事务改两处;一次 Ctrl+Z 两处一起撤销
 *   [4] `setSelection` / `revealRange` 真的落到渲染层(选区可见、长文档滚动)
 *   [5] 装饰渲染、随输入映射、清空,以及切换标签后恢复
 *   [6] `openTextDocument` / `showTextDocument` 打开编辑器里没有的文件
 *   [7] `document.save()` → 磁盘、isDirty、`onDidSaveTextDocument` 三者一致
 *   [8] 关闭标签 → `onDidCloseTextDocument`,活动编辑器回到另一个标签
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs extensions-editor
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { dataRoot } from '../src/main/dataDir'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import type { ExtensionManifest } from '../src/shared/extensionPackage'

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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const EXT_ID = 'test.editor'
const APP_VERSION = '0.1.0'

const MANIFEST: ExtensionManifest = {
  publisher: 'test',
  name: 'editor',
  version: '1.0.0',
  displayName: '编辑器桥探针',
  description: 'extensions-editor harness 用的合成扩展',
  engines: { imark: '^0.1.0' },
  main: './main.js',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [
      { command: 'test.editor.state', title: 'State' },
      { command: 'test.editor.editAtomic', title: 'Atomic Edit' },
      { command: 'test.editor.decorate', title: 'Decorate' },
      { command: 'test.editor.clearDecorations', title: 'Clear Decorations' },
      { command: 'test.editor.select', title: 'Select' },
      { command: 'test.editor.openAndReveal', title: 'Open And Reveal' },
      { command: 'test.editor.save', title: 'Save' }
    ]
  }
}

/**
 * 宿主里跑的探针。
 *
 * 所有观测值都在扩展侧收集,命令只负责把快照交回来 —— 这样断言看到的是
 * 「扩展真正收到的事件」,而不是 main 自己记的账。`imark` 由宿主按调用方注入。
 */
const FIXTURE_CODE = `
const imark = require('imark')
const { Position, Range } = imark

let decorationType = null
const stats = {
  changes: 0,
  lastChangeText: '',
  opens: 0,
  lastOpenedUri: '',
  closes: 0,
  lastClosedUri: '',
  saves: 0,
  lastSavedUri: '',
  lastSavedDirty: false,
  activeChanges: 0,
  selectionChanges: 0,
  lastSelectionText: ''
}

function activeEditor() {
  const editor = imark.window.activeTextEditor
  if (!editor) throw new Error('没有活动编辑器')
  return editor
}

function positionOf(position) {
  return { line: position.line, character: position.character }
}

function snapshot() {
  const editor = imark.window.activeTextEditor
  const doc = editor ? editor.document : null
  return {
    hasEditor: Boolean(editor),
    uri: doc ? doc.uri.toString() : null,
    fileName: doc ? doc.fileName : null,
    text: doc ? doc.getText() : '',
    version: doc ? doc.version : -1,
    dirty: doc ? doc.isDirty : false,
    lineCount: doc ? doc.lineCount : 0,
    selection: editor
      ? {
          anchor: positionOf(editor.selection.anchor),
          active: positionOf(editor.selection.active),
          text: doc.getText(editor.selection)
        }
      : null,
    selections: editor ? editor.selections.length : 0,
    visible: imark.window.visibleTextEditors.length,
    workspaceFolders: (imark.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath),
    stats: Object.assign({}, stats)
  }
}

exports.activate = (context) => {
  context.subscriptions.push(imark.commands.registerCommand('test.editor.state', () => snapshot()))

  context.subscriptions.push(
    imark.commands.registerCommand('test.editor.editAtomic', async () => {
      const editor = activeEditor()
      const doc = editor.document
      const beta = doc.lineAt(1)
      const ok = await editor.edit(edit => {
        edit.insert(new Position(0, 0), 'AA ')
        edit.replace(beta.range, 'BETA')
      })
      return { ok }
    })
  )

  context.subscriptions.push(
    imark.commands.registerCommand('test.editor.decorate', line => {
      const editor = activeEditor()
      if (!decorationType) {
        decorationType = imark.window.createTextEditorDecorationType({
          backgroundColor: '#ff0000',
          color: '#ffffff',
          borderColor: '#00ff00',
          borderStyle: 'solid',
          borderWidth: '2px'
        })
        context.subscriptions.push(decorationType)
      }
      const target = editor.document.lineAt(line).range
      editor.setDecorations(decorationType, [target])
      return { line: target.start.line, text: editor.document.getText(target) }
    })
  )

  context.subscriptions.push(
    imark.commands.registerCommand('test.editor.clearDecorations', () => {
      const editor = activeEditor()
      if (decorationType) editor.setDecorations(decorationType, [])
      return true
    })
  )

  context.subscriptions.push(
    imark.commands.registerCommand('test.editor.select', (from, to) => {
      const editor = activeEditor()
      editor.setSelection(new Position(from[0], from[1]), new Position(to[0], to[1]))
      return snapshot()
    })
  )

  context.subscriptions.push(
    imark.commands.registerCommand('test.editor.openAndReveal', async (uri, line) => {
      const doc = await imark.workspace.openTextDocument(uri)
      const editor = await imark.window.showTextDocument(doc)
      // 用 showTextDocument 返回的编辑器对象,不读 activeTextEditor:
      // 活动文档要等渲染层回报 activeChanged,此刻可能还是上一个标签。
      editor.setSelection(new Position(line, 0), new Position(line, 3))
      editor.revealRange(
        new Range(line, 0, line, doc.lineAt(line).text.length),
        imark.TextEditorRevealType.InCenter
      )
      return {
        uri: doc.uri.toString(),
        lineCount: doc.lineCount,
        version: doc.version,
        firstLine: doc.lineAt(0).text,
        lastLine: doc.lineAt(doc.lineCount - 1).text
      }
    })
  )

  context.subscriptions.push(
    imark.commands.registerCommand('test.editor.save', async () => {
      const editor = activeEditor()
      const ok = await editor.document.save()
      return { ok }
    })
  )

  context.subscriptions.push(
    imark.workspace.onDidChangeTextDocument(event => {
      stats.changes += event.contentChanges.length
      stats.lastChangeText = event.contentChanges.map(change => change.text).join('')
    })
  )
  context.subscriptions.push(
    imark.workspace.onDidOpenTextDocument(doc => {
      stats.opens += 1
      stats.lastOpenedUri = doc.uri.toString()
    })
  )
  context.subscriptions.push(
    imark.workspace.onDidCloseTextDocument(doc => {
      stats.closes += 1
      stats.lastClosedUri = doc.uri.toString()
    })
  )
  context.subscriptions.push(
    imark.workspace.onDidSaveTextDocument(doc => {
      stats.saves += 1
      stats.lastSavedUri = doc.uri.toString()
      stats.lastSavedDirty = doc.isDirty
    })
  )
  context.subscriptions.push(
    imark.window.onDidChangeActiveTextEditor(() => {
      stats.activeChanges += 1
    })
  )
  context.subscriptions.push(
    imark.window.onDidChangeTextEditorSelection(event => {
      stats.selectionChanges += 1
      stats.lastSelectionText = event.textEditor.document.getText(event.selections[0])
    })
  )
}

exports.deactivate = () => {}
`

interface EditorState {
  hasEditor: boolean
  uri: string | null
  fileName: string | null
  text: string
  version: number
  dirty: boolean
  lineCount: number
  selection: {
    anchor: { line: number; character: number }
    active: { line: number; character: number }
    text: string
  } | null
  selections: number
  visible: number
  workspaceFolders: string[]
  stats: {
    changes: number
    lastChangeText: string
    opens: number
    lastOpenedUri: string
    closes: number
    lastClosedUri: string
    saves: number
    lastSavedUri: string
    lastSavedDirty: boolean
    activeChanges: number
    selectionChanges: number
    lastSelectionText: string
  }
}

/** 与渲染层 `pathToUri` 同一套编码:先归一为 `/`,逐段 encodeURIComponent,Windows 盘符的冒号保留 */
function fileUri(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = prefixed
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/')
  return `file://${encoded}`
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs extensions-editor` 跑会自动带上）')
    app.exit(2)
    return
  }

  await app.whenReady()

  // 这一轮不应该弹任何需要人点的原生对话框
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  const longNote = join(vault, 'long.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await rm(join(ud, 'extensions-data'), { recursive: true, force: true })

  const START = 'alpha\nbeta\ngamma\n'
  // 末尾不留换行:文档行数正好 120,reveal 第 100 行时才有足够的可滚动区
  const LONG = Array.from({ length: 120 }, (_, index) => `L${String(index).padStart(3, '0')}`).join('\n')
  await writeFile(note, START, 'utf8')
  await writeFile(longNote, LONG, 'utf8')
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

  // 直接放一份扩展目录:安装记录扫描、清单校验、宿主加载都会走到,
  // 但不经过市场/内置包,失败时能一眼分清是桥的问题还是安装的问题。
  const extDir = join(dataRoot(), 'plugins', EXT_ID)
  await mkdir(extDir, { recursive: true })
  await writeFile(join(extDir, 'package.json'), JSON.stringify(MANIFEST, null, 2), 'utf8')
  await writeFile(join(extDir, 'main.js'), FIXTURE_CODE, 'utf8')

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)
  await service.startup()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  const state = (): Promise<EditorState> =>
    service.executeCommand('test.editor.state') as Promise<EditorState>

  /** 轮询扩展侧快照。宿主镜像靠 IPC 追,当场读一次经常还差最后一拍 */
  async function waitForState(
    predicate: (value: EditorState) => boolean,
    ms = 8000
  ): Promise<EditorState | null> {
    const until = Date.now() + ms
    let last: EditorState | null = null
    while (Date.now() < until) {
      try {
        last = await state()
        if (predicate(last)) return last
      } catch {
        /* 宿主还没激活/重启中,继续等 */
      }
      await sleep(100)
    }
    return last
  }

  async function focusEditor(): Promise<boolean> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    const ok = await evalJs<boolean>(
      `(() => { const el = document.querySelector('.cm-content'); if (!el) return false; el.focus(); return document.activeElement === el })()`
    )
    await sleep(80)
    return ok
  }

  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }

  /** sendInputEvent 要的是 W3C 旧键名(`Left`/`Down`),写成 `ArrowLeft` 会被静默丢掉 */
  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(200)
  }

  /**
   * 打字必须自检:窗口没焦点时注入的按键会被静默丢掉,后面就会变成一串
   * 看着像产品 bug 的断言失败(与 autosave-modes / editor-enter 同一套做法)。
   */
  async function type(text: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!(await focusEditor())) continue
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(240)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return true
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)} → ${JSON.stringify(doc)})`)
    }
    return false
  }

  const tabs = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.tab .tab-title')].map(el => el.textContent.trim())`)

  async function clickTab(label: string): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const tab = [...document.querySelectorAll('.tab')]
          .find(el => el.querySelector('.tab-title')?.textContent.trim() === ${JSON.stringify(label)})
        if (!tab) return false
        tab.click()
        return true
      })()`)
  }

  async function closeTab(label: string): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const tab = [...document.querySelectorAll('.tab')]
          .find(el => el.querySelector('.tab-title')?.textContent.trim() === ${JSON.stringify(label)})
        const button = tab ? tab.querySelector('.tab-close') : null
        if (!button) return false
        button.click()
        return true
      })()`)
  }

  /** 扩展装饰在 DOM 里的样子(数量、文本、内联样式、计算后的背景色) */
  const decorationInfo = (): Promise<{
    count: number
    texts: string[]
    style: string
    background: string
  }> =>
    evalJs(`
      (() => {
        const nodes = [...document.querySelectorAll('.imark-ext-decoration')]
        return {
          count: nodes.length,
          texts: nodes.map(el => el.textContent),
          style: nodes[0]?.getAttribute('style') ?? '',
          background: nodes[0] ? getComputedStyle(nodes[0]).backgroundColor : ''
        }
      })()`)

  const scrollTop = (): Promise<number> => evalJs<number>(`document.querySelector('.cm-scroller')?.scrollTop ?? -1`)

  const noteUri = fileUri(note)
  const longUri = fileUri(longNote)
  const noteText = START

  // ---------- 1. 启动快照 ----------

  console.log('\n【1】启动快照：打开的文档、活动编辑器、工作区都在宿主镜像里')
  check('扩展已按 onStartupFinished 激活', service.isActivated(EXT_ID))
  const start = await waitForState(value => value.hasEditor && value.text === noteText)
  check('宿主拿到了活动编辑器', start?.hasEditor === true, JSON.stringify(start))
  check('文档 URI 是打开的那份文件', start?.uri === noteUri, String(start?.uri))
  check('文件名与磁盘路径一致', start?.fileName === note, String(start?.fileName))
  check('文档全文与磁盘一致', start?.text === noteText, JSON.stringify(start?.text))
  check('行数包含末尾空行', start?.lineCount === 4, String(start?.lineCount))
  check('初始版本号是 1', start?.version === 1, String(start?.version))
  check('初始不是脏文档', start?.dirty === false, String(start?.dirty))
  check('只有一份可见编辑器', start?.visible === 1, String(start?.visible))
  check(
    'workspaceFolders 指向 vault',
    JSON.stringify(start?.workspaceFolders) === JSON.stringify([vault]),
    JSON.stringify(start?.workspaceFolders)
  )
  check('初始没有收到任何内容变更', start?.stats.changes === 0, JSON.stringify(start?.stats))

  // ---------- 2. 增量变更 ----------

  console.log('\n【2】用户打字 → 宿主收到逐条增量与单调版本号')
  check('焦点在编辑器里', await focusEditor())
  check('输入 XYZ', await type('XYZ'))
  const typed = await waitForState(
    value => value.text === `XYZ${noteText}` && value.stats.changes === 3
  )
  check('宿主镜像逐字符更新', typed?.text === `XYZ${noteText}`, JSON.stringify(typed?.text))
  check('3 次输入 = 3 条 contentChange', typed?.stats.changes === 3, JSON.stringify(typed?.stats))
  check('版本号前进 3 格(1 → 4)', typed?.version === 4, String(typed?.version))
  check('最后一条增量是 Z', typed?.stats.lastChangeText === 'Z', String(typed?.stats.lastChangeText))

  // ---------- 3. 装饰:渲染、映射、清空 ----------

  console.log('\n【3】装饰渲染到 DOM、随输入映射、清空后消失')
  // executeCommand 的第二个参数是**参数数组**;直接传值会被当成 `args` 展开
  const decorated = (await service.executeCommand('test.editor.decorate', [1])) as {
    line: number
    text: string
  }
  check('命令作用在第 1 行(beta)', decorated.line === 1 && decorated.text === 'beta', JSON.stringify(decorated))
  check('DOM 出现一个扩展装饰', await waitFor(`document.querySelectorAll('.imark-ext-decoration').length === 1`))
  let deco = await decorationInfo()
  check('装饰包住的仍是 beta', deco.texts.join('|') === 'beta', JSON.stringify(deco))
  // Chromium 会把 style 属性规范化(`#ff0000` → `rgb(255, 0, 0)`,冒号后补空格),
  // 所以去掉空白再比,而不是指望原样保留扩展传入的写法。
  const normalizedStyle = deco.style.replace(/\s+/g, '')
  check(
    '白名单里的样式落到了内联 style',
    normalizedStyle.includes('background-color:rgb(255,0,0)') &&
      normalizedStyle.includes('border-bottom:2pxsolidrgb(0,255,0)'),
    deco.style
  )
  check('浏览器算出来的背景色是红色', deco.background === 'rgb(255, 0, 0)', deco.background)

  // 在装饰区间之前插入一个字符:偏移量必须跟着映射,而不是留在原地
  check('输入 Q 触发装饰映射', await type('Q'))
  check('宿主镜像收到 Q', !!(await waitForState(value => value.text === `XYZQ${noteText}`)))
  await sleep(300)
  deco = await decorationInfo()
  check('装饰仍只有一个', deco.count === 1, JSON.stringify(deco))
  check('装饰仍包住 beta(没有被输入挪走)', deco.texts.join('|') === 'beta', JSON.stringify(deco))

  await service.executeCommand('test.editor.clearDecorations')
  check('清空后 DOM 里没有装饰', await waitFor(`document.querySelectorAll('.imark-ext-decoration').length === 0`))

  // ---------- 4. 原子编辑与撤销 ----------

  console.log('\n【4】TextEditor.edit：两处修改一次事务，一次 Ctrl+Z 全部撤销')
  // 让上一轮输入与扩展编辑分到两个撤销组(CM6 默认按 500ms 合并)
  await sleep(700)
  const beforeEdit = await state()
  const editResult = (await service.executeCommand('test.editor.editAtomic')) as { ok: boolean }
  check('edit() 返回 true', editResult.ok === true, JSON.stringify(editResult))
  const editedText = `AA XYZQ${noteText}`.replace('beta', 'BETA')
  const edited = await waitForState(value => value.text === editedText)
  check('两处修改都落进文档', edited?.text === editedText, JSON.stringify(edited?.text))
  check(
    '一次批量编辑收到两条 contentChange',
    edited?.stats.changes === (beforeEdit?.stats.changes ?? 0) + 2,
    JSON.stringify(edited?.stats)
  )
  const domText = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
  check(
    'DOM 同时显示插入的前缀与被替换的 BETA',
    domText.includes('AA XYZQalpha') && domText.includes('BETA'),
    domText
  )

  await sleep(700)
  if (!(await focusEditor())) check('撤销前重新聚焦编辑器', false)
  await key('Z', ['control'])
  const undone = await waitForState(value => value.text === `XYZQ${noteText}`)
  check('一次撤销回到编辑前', undone?.text === `XYZQ${noteText}`, JSON.stringify(undone?.text))
  check('前缀 AA 一起被撤销', undone?.text.startsWith('AA') === false, JSON.stringify(undone?.text))
  check('BETA 一起被撤销', undone?.text.includes('BETA') === false, JSON.stringify(undone?.text))

  // ---------- 5. 选区 / reveal / 打开另一份文档 ----------

  console.log('\n【5】选区、reveal 与 openTextDocument/showTextDocument')
  await service.executeCommand('test.editor.select', [[0, 3], [0, 6]])
  const selected = await waitForState(
    value => value.selection?.text === 'Qal' && value.stats.selectionChanges >= 1
  )
  check('宿主选区是 Qal', selected?.selection?.text === 'Qal', JSON.stringify(selected?.selection))
  check(
    '选区事件回到了宿主',
    (selected?.stats.selectionChanges ?? 0) >= 1,
    JSON.stringify(selected?.stats)
  )
  check(
    '选区锚点/活动端正确',
    selected?.selection?.anchor.line === 0 &&
      selected.selection.anchor.character === 3 &&
      selected.selection.active.character === 6,
    JSON.stringify(selected?.selection)
  )
  await focusEditor()
  const domSelection = await evalJs<string>(`String(window.getSelection())`)
  check('DOM 里也选中了 Qal', domSelection === 'Qal', domSelection)

  // 切标签前的装饰:回来时必须还在(装饰按文档存在 EditorState 里)
  const beforeSwitch = (await service.executeCommand('test.editor.decorate', [2])) as {
    line: number
    text: string
  }
  check('切换前标记第 2 行(gamma)', beforeSwitch.text === 'gamma', JSON.stringify(beforeSwitch))
  check('装饰渲染出来了', await waitFor(`document.querySelectorAll('.imark-ext-decoration').length === 1`))

  const opened = (await service.executeCommand('test.editor.openAndReveal', [longUri, 100])) as {
    uri: string
    lineCount: number
    version: number
    firstLine: string
    lastLine: string
  }
  check('openTextDocument 读到 120 行', opened.lineCount === 120, JSON.stringify(opened))
  check('新文档版本从 1 开始', opened.version === 1, String(opened.version))
  check('首尾行与磁盘一致', opened.firstLine === 'L000' && opened.lastLine === 'L119', JSON.stringify(opened))

  check('第二个标签打开了', await waitFor(`document.querySelectorAll('.tab').length === 2`))
  check('活动标签是 long', (await tabs())[1] === 'long', JSON.stringify(await tabs()))
  const onLong = await waitForState(
    value =>
      value.uri === longUri &&
      value.lineCount === 120 &&
      value.selection?.anchor.line === 100 &&
      value.stats.opens >= 1
  )
  check('活动编辑器切到 long.md', onLong?.uri === longUri, String(onLong?.uri))
  check('onDidOpenTextDocument 收到了它', onLong?.stats.lastOpenedUri === longUri, JSON.stringify(onLong?.stats))
  check('选区落在第 100 行', onLong?.selection?.anchor.line === 100, JSON.stringify(onLong?.selection))
  check(
    '活动编辑器变化事件到达宿主',
    (onLong?.stats.activeChanges ?? 0) >= 1,
    JSON.stringify(onLong?.stats)
  )
  const scrolled = await (async () => {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      if ((await scrollTop()) > 0) return true
      await sleep(100)
    }
    return false
  })()
  check('revealRange 把长文档滚到了第 100 行附近', scrolled, `scrollTop=${await scrollTop()}`)

  check('点回笔记标签', await clickTab('笔记'))
  const back = await waitForState(value => value.uri === noteUri)
  check('活动编辑器回到笔记', back?.uri === noteUri, String(back?.uri))
  check(
    '切换标签后装饰恢复',
    await waitFor(`document.querySelectorAll('.imark-ext-decoration').length === 1`),
    JSON.stringify(await decorationInfo())
  )
  deco = await decorationInfo()
  check('恢复的装饰仍包住 gamma', deco.texts.join('|') === 'gamma', JSON.stringify(deco))

  // ---------- 6. 保存 ----------

  console.log('\n【6】document.save()：磁盘、isDirty、保存事件三者一致')
  check('输入 S 让文档变脏', await type('S'))
  const dirty = await waitForState(value => value.dirty === true)
  check('宿主看到 isDirty', dirty?.dirty === true, JSON.stringify(dirty?.dirty))

  const saveResult = (await service.executeCommand('test.editor.save')) as { ok: boolean }
  check('save() 返回 true', saveResult.ok === true, JSON.stringify(saveResult))
  const saved = await waitForState(
    value => !value.dirty && value.stats.saves === 1 && value.stats.lastSavedUri === noteUri
  )
  check('保存后 isDirty 变回 false', saved?.dirty === false, String(saved?.dirty))
  check('onDidSaveTextDocument 收到一次', saved?.stats.saves === 1, JSON.stringify(saved?.stats))
  check('保存事件里文档已经不脏', saved?.stats.lastSavedDirty === false, JSON.stringify(saved?.stats))
  const onDisk = await readFile(note, 'utf8')
  check('磁盘内容与宿主镜像一致', onDisk === saved?.text, JSON.stringify(onDisk))
  check('磁盘上确实有这次输入', onDisk.includes('S'), JSON.stringify(onDisk))

  // ---------- 7. 关闭标签 ----------

  console.log('\n【7】关闭 long 标签：close 事件与活动编辑器回退')
  check('关闭 long 标签', await closeTab('long'))
  check('只剩一个标签', await waitFor(`document.querySelectorAll('.tab').length === 1`))
  const closed = await waitForState(
    value => value.stats.closes >= 1 && value.stats.lastClosedUri === longUri && value.uri === noteUri
  )
  check('onDidCloseTextDocument 收到 long', closed?.stats.lastClosedUri === longUri, JSON.stringify(closed?.stats))
  check('活动编辑器回到笔记', closed?.uri === noteUri, String(closed?.uri))
  check('活动标签是笔记', (await tabs())[0] === '笔记', JSON.stringify(await tabs()))

  await shutdownExtensions()
  console.log(`\n${pass} 通过, ${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
