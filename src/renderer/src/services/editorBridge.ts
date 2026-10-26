/**
 * 编辑器桥:renderer(CodeMirror,文档真身)↔ main(文档注册表)的唯一通道。
 *
 * 职责:
 *   - 把打开/关闭/切换/保存/内容变化/选区变化报给 main;
 *   - 执行 main 转来的编辑器请求(批处理编辑、选区、reveal、打开、保存、装饰),
 *     并把结果按 requestId 回给 main;
 *   - 给出启动快照(`editor.ready`)与主题/上下文变化。
 *
 * 版本号的唯一来源在这里:每个 URI 一份单调递增的版本,渲染层每次事务 +1。
 * main 与宿主只按这个版本号判断增量是否连续 —— 扩展看到的文本会不会落后于
 * 用户输入,取决于这里有没有把每一条变更都发出去,所以 `setEditorUpdateObserver`
 * 是**所有**内容变化的必经之路(输入、撤销、扩展编辑、表格输入过滤器)。
 *
 * URI 约定:已落盘文档用 `file://` 绝对路径,未命名文档用 `untitled:<tabId>`。
 * 标签另存为会换 URI,桥按「先关闭旧文档、再打开新文档」处理。
 */

import { watch } from 'vue'
import { EditorSelection } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import type {
  DecorationRangeDto,
  DocumentStateDto,
  EditorRequestDto,
  EditorSelectionDto,
  MainToRendererMessage,
  PositionDto,
  RendererApplyEditsResult,
  RendererToMainMessage,
  TextChangeDto,
  ThemeDto
} from '@shared/extensionProtocol'
import type { ExtensionContextKeys } from '@shared/extensions'
import { activeTab, appStore, editorHolder } from '../stores/app'
import { setEditorUpdateObserver } from '../editor/setup'
import { setExtensionDecorationsEffect } from '../editor/extensionDecorations'
import { focusRenderedTableAtPosition } from '../editor/wysiwyg/widgets'
import { renderMarkdownFragment } from './exportHtml'
import {
  activateTab,
  applyTabChanges,
  setTabDocumentObserver,
  tabById,
  tabState,
  tabText,
  updateTabState,
  type DocTab,
  type TabDocumentEvent
} from './tabs'
import {
  openFileByPath,
  saveAllDirtyTabs,
  saveAllFileTabsSilently,
  saveTab
} from './fileService'
import { api } from './api'

// ---------- URI ----------

/**
 * 路径 → `file://` URI。
 *
 * 逐段 `encodeURIComponent`:文件名里的空格、`#`、`?` 都必须转义,否则
 * `file:///a#b.md` 会被当成「文件 a,锚点 b」。Windows 盘符的冒号保留原样,
 * 这是 file URL 里唯一允许不转义的冒号。
 */
function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  const encoded = prefixed
    .split('/')
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file://${encoded}`
}

/** `file://` URI → 绝对路径;非 file URI 返回 null */
function pathFromUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  let path: string
  try {
    path = decodeURIComponent(uri.slice('file://'.length))
  } catch {
    return null
  }
  // Windows:`file:///C:/x` → `/C:/x`,盘符前的斜杠不属于路径
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
  return path || null
}

function uriOfTab(tab: DocTab): string {
  return tab.filePath ? pathToUri(tab.filePath) : `untitled:${tab.id}`
}

// ---------- 模块状态 ----------

const versions = new Map<string, number>()
const uriByTab = new Map<string, string>()

let ready = false
let suppressSelection = false
let lastContextKey = ''

function send(message: RendererToMainMessage): void {
  try {
    api.sendExtensionMessage(message)
  } catch (err) {
    // 窗口正在关闭:主进程已经取消订阅,丢掉一条事件不等于扩展失败
    console.error('[iMark] 编辑器桥发送失败', err)
  }
}

function eolOf(tab: DocTab): 'lf' | 'crlf' {
  return tab.eol === 'CRLF' ? 'crlf' : 'lf'
}

function documentState(tab: DocTab): DocumentStateDto {
  const uri = uriByTab.get(tab.id) ?? uriOfTab(tab)
  return {
    uri,
    version: versions.get(uri) ?? 1,
    text: tabText(tab.id, { flush: false }) ?? '',
    eol: eolOf(tab),
    isDirty: tab.dirty,
    languageId: 'markdown'
  }
}

function tabByUri(uri: string): DocTab | null {
  for (const tab of appStore.tabs) {
    if ((uriByTab.get(tab.id) ?? uriOfTab(tab)) === uri) return tab
  }
  return null
}

// ---------- 上下文与主题 ----------

const THEME_COLORS = [
  '--bg-app',
  '--bg-editor',
  '--bg-toolbar',
  // 扩展面板里的悬停行 / 选中行:没有它们,插件只能写死深色回退值(亮色下就是黑块)
  '--bg-toolbar-btn-hover',
  '--bg-active',
  '--shadow',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--border',
  '--accent',
  '--bg-code',
  '--bg-codeblock',
  '--bg-selection',
  '--success',
  '--warn',
  '--danger',
  // 字体与正文排版：webview 里的 Markdown 要和编辑器保持同一套度量
  '--font-text',
  '--font-mono',
  '--font-editor',
  '--editor-font-size',
  '--editor-body-size',
  '--quote-bar',
  '--scrollbar-thumb-bg',
  '--scrollbar-hover-thumb-bg',
  '--scrollbar-active-thumb-bg'
] as const

/** webview 的 bootstrap 与主题推送复用同一份取值，避免两边颜色漂移 */
export function readTheme(): ThemeDto {
  const computed = getComputedStyle(document.documentElement)
  const colors: Record<string, string> = {}
  for (const name of THEME_COLORS) {
    const value = computed.getPropertyValue(name).trim()
    if (value) colors[name] = value
  }
  return { kind: appStore.theme === 'dark' ? 'dark' : 'light', colors }
}

function buildContext(): ExtensionContextKeys {
  const tab = activeTab()
  const view = editorHolder.view
  const focused =
    !!view && !!document.activeElement && view.contentDOM.contains(document.activeElement)
  return {
    hasEditor: tab !== null,
    hasVault: !!appStore.vaultPath,
    isDirty: tab?.dirty ?? false,
    editorFocus: focused,
    editorTextFocus: focused && !!view?.state.facet(EditorView.editable),
    resourceLangId: tab ? 'markdown' : null,
    workspaceFolderCount: appStore.vaultPath ? 1 : 0
  }
}

/** 只在真正变化时发:焦点事件会连续触发,没必要每次都跨进程 */
function sendContext(): void {
  if (!ready) return
  const context = buildContext()
  const key = JSON.stringify(context)
  if (key === lastContextKey) return
  lastContextKey = key
  send({ type: 'editor.contextChanged', context })
}

// ---------- 选区 ----------

function toPositionDto(doc: { lineAt(pos: number): { number: number; from: number } }, pos: number): PositionDto {
  const line = doc.lineAt(pos)
  return { line: line.number - 1, character: pos - line.from }
}

function selectionOf(state: { doc: { lineAt(pos: number): { number: number; from: number } }; selection: { ranges: readonly { anchor: number; head: number }[] } }): EditorSelectionDto[] {
  return state.selection.ranges.map(range => ({
    anchor: toPositionDto(state.doc, range.anchor),
    active: toPositionDto(state.doc, range.head)
  }))
}

function sendSelection(state = editorHolder.view?.state): void {
  if (!ready || !state) return
  const tab = activeTab()
  if (!tab) return
  const uri = uriByTab.get(tab.id)
  if (!uri) return
  send({ type: 'editor.selectionChanged', uri, selections: selectionOf(state) })
}

function sendActive(): void {
  if (!ready) return
  const tab = activeTab()
  const uri = tab ? (uriByTab.get(tab.id) ?? null) : null
  send({ type: 'editor.activeChanged', uri, visible: uri ? [uri] : [] })
  sendSelection()
  sendContext()
}

// ---------- 生命周期 ----------

/** 同步 URI/版本映射,不发送任何消息(启动快照前用) */
function primeTabs(): void {
  const seen = new Set<string>()
  for (const tab of appStore.tabs) {
    seen.add(tab.id)
    const uri = uriOfTab(tab)
    uriByTab.set(tab.id, uri)
    if (!versions.has(uri)) versions.set(uri, 1)
  }
  for (const tabId of [...uriByTab.keys()]) {
    if (seen.has(tabId)) continue
    const uri = uriByTab.get(tabId)!
    uriByTab.delete(tabId)
    versions.delete(uri)
  }
}

/**
 * 编辑器视图挂载完成后由 EditorPane 调用。
 *
 * 这里才把「当前有哪些文档」交给 main:在视图建好之前发送,拿到的是空标签集,
 * 之后每个标签又得补一条 documentOpened —— 两份真相的来源没有意义。
 */
export function notifyEditorReady(): void {
  primeTabs()
  ready = true
  lastContextKey = ''
  const tab = activeTab()
  const activeUri = tab ? (uriByTab.get(tab.id) ?? null) : null
  send({
    type: 'editor.ready',
    payload: {
      documents: appStore.tabs.map(tabItem => documentState(tabItem)),
      activeDocumentUri: activeUri,
      visibleDocumentUris: activeUri ? [activeUri] : [],
      context: buildContext(),
      theme: readTheme()
    }
  })
  sendSelection()
  sendContext()
}

/**
 * 标签结构变化(新增/关闭/换路径)时同步。
 *
 * 内容变化不走这里:那条路径由 CM6 更新观察者逐次发送,避免每次按键都
 * 全量比较一遍文本。
 */
function syncTabs(): void {
  const seen = new Set<string>()
  for (const tab of appStore.tabs) {
    seen.add(tab.id)
    const uri = uriOfTab(tab)
    const previous = uriByTab.get(tab.id)
    if (previous === uri) continue
    if (previous) {
      uriByTab.delete(tab.id)
      versions.delete(previous)
      send({ type: 'editor.documentClosed', uri: previous })
    }
    uriByTab.set(tab.id, uri)
    versions.set(uri, 1)
    send({ type: 'editor.documentOpened', document: documentState(tab) })
  }

  for (const [tabId, uri] of [...uriByTab]) {
    if (seen.has(tabId)) continue
    uriByTab.delete(tabId)
    versions.delete(uri)
    send({ type: 'editor.documentClosed', uri })
  }
  sendActive()
}

// ---------- CM6 更新 ----------

function onEditorUpdate(update: ViewUpdate): void {
  if (!ready) return
  const tab = activeTab()
  if (!tab) return
  const uri = uriByTab.get(tab.id)
  if (!uri) return

  if (update.docChanged) {
    const version = (versions.get(uri) ?? 1) + 1
    versions.set(uri, version)
    const changes: TextChangeDto[] = []
    // iterChanges 给的是**变更前**坐标;宿主按同样规则套用
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, text: inserted.toString() })
    })
    send({
      type: 'editor.documentChanged',
      change: { uri, version, changes, eol: eolOf(tab), isDirty: tab.dirty }
    })
  }

  // 扩展自己 setSelection 引起的回流不需要再发一遍(否则宿主会收到自己刚设的值)
  if ((update.docChanged || update.selectionSet) && !suppressSelection) {
    sendSelection(update.state)
  }
  if (update.docChanged || update.selectionSet) sendContext()
}

function onTabEvent(event: TabDocumentEvent): void {
  if (!ready) return
  const tab = tabById(event.tabId)
  if (!tab) return
  const uri = uriByTab.get(event.tabId)
  if (!uri) return

  if (event.kind === 'saved') {
    send({ type: 'editor.documentSaved', uri, version: versions.get(uri) ?? 1 })
    sendContext()
    return
  }

  // 另存为/外部重载:整篇替换。版本仍然前进一格,宿主不必先关闭再打开。
  const version = (versions.get(uri) ?? 1) + 1
  versions.set(uri, version)
  send({
    type: 'editor.documentChanged',
    change: {
      uri,
      version,
      changes: [],
      text: event.text,
      eol: event.eol === 'CRLF' ? 'crlf' : 'lf',
      isDirty: false
    }
  })
  sendContext()
}

// ---------- 请求 ----------

function positionToOffset(
  doc: { line(n: number): { from: number; to: number }; lines: number },
  position: PositionDto
): number {
  const lineNumber = Math.min(Math.max(0, Math.trunc(position.line)), doc.lines - 1)
  const line = doc.line(lineNumber + 1)
  const character = Math.min(Math.max(0, Math.trunc(position.character)), line.to - line.from)
  return line.from + character
}

function decoOffsets(
  doc: { line(n: number): { from: number; to: number }; lines: number; length: number },
  range: DecorationRangeDto
): { from: number; to: number } {
  const from = positionToOffset(doc, range.start)
  const to = positionToOffset(doc, range.end)
  return { from: Math.min(from, to), to: Math.max(from, to) }
}

function applyEdits(
  request: Extract<EditorRequestDto, { op: 'applyEdits' }>
): RendererApplyEditsResult {
  const tab = tabByUri(request.uri)
  if (!tab) return { ok: false, reason: 'not-open' }
  const current = versions.get(request.uri) ?? 1
  if (request.expectedVersion !== undefined && request.expectedVersion !== current) {
    return { ok: false, reason: 'version-mismatch' }
  }
  const wasActive = tab.id === appStore.activeTabId && !!editorHolder.view
  if (!applyTabChanges(tab.id, request.edits)) {
    return { ok: false, reason: 'invalid-edit' }
  }
  // 当前标签的变更由 CM6 观察者发出;后台标签由这里补发
  if (!wasActive) {
    if (request.edits.length > 0) {
      const version = current + 1
      versions.set(request.uri, version)
      send({
        type: 'editor.documentChanged',
        change: {
          uri: request.uri,
          version,
          changes: request.edits,
          eol: eolOf(tab),
          isDirty: tab.dirty
        }
      })
    }
    sendContext()
    return { ok: true, version: versions.get(request.uri) ?? current }
  }
  return { ok: true, version: versions.get(request.uri) ?? current }
}

function applySelection(
  tabId: string,
  selection: { start: PositionDto; end: PositionDto }
): boolean {
  const state = tabState(tabId)
  if (!state) return false
  const from = positionToOffset(state.doc, selection.start)
  const to = positionToOffset(state.doc, selection.end)
  suppressSelection = true
  try {
    // 选区落进已渲染的表格时不能直接 dispatch:光标护栏会在微任务里把它挪走。
    // 交给表格层立刻进入单元格编辑态(autoFocus 只在 widget 创建时跑一次)。
    if (
      tabId === appStore.activeTabId &&
      editorHolder.view &&
      focusRenderedTableAtPosition(editorHolder.view, to)
    ) {
      return true
    }
    return updateTabState(tabId, {
      selection: EditorSelection.create([EditorSelection.range(from, to)])
    })
  } finally {
    suppressSelection = false
  }
}

function setSelections(
  request: Extract<EditorRequestDto, { op: 'setSelections' }>
): boolean {
  const tab = tabByUri(request.uri)
  if (!tab) return false
  const state = tabState(tab.id)
  if (!state) return false
  const ranges = request.selections
    .slice(0, 100)
    .map(item =>
      EditorSelection.range(
        positionToOffset(state.doc, item.anchor),
        positionToOffset(state.doc, item.active)
      )
    )
  if (ranges.length === 0) ranges.push(EditorSelection.cursor(0))
  const selection = EditorSelection.create(ranges, 0)

  suppressSelection = true
  try {
    // 与 applySelection 一样:选区落进已渲染的表格时,立刻进入单元格编辑态,
    // 不能先 dispatch —— 光标护栏会在微任务里把它挪回表格外。
    const inTable =
      tab.id === appStore.activeTabId &&
      editorHolder.view !== null &&
      focusRenderedTableAtPosition(editorHolder.view, selection.main.head)
    if (!inTable && !updateTabState(tab.id, { selection })) return false
  } finally {
    suppressSelection = false
  }
  // 后台标签没有视图,选区只在 state 里;切换回来时自然可见
  if (tab.id === appStore.activeTabId) sendSelection()
  sendContext()
  return true
}

function reveal(
  request: Extract<EditorRequestDto, { op: 'reveal' }>
): boolean {
  const tab = tabByUri(request.uri)
  if (!tab) return false
  activateTab(tab.id, { focus: false })
  const view = editorHolder.view
  const state = tabState(tab.id)
  if (!view || !state) return false
  const offset = positionToOffset(state.doc, request.range.start)
  const y =
    request.revealType === 'center'
      ? 'center'
      : request.revealType === 'top'
        ? 'start'
        : request.revealType === 'bottom'
          ? 'end'
          : 'nearest'
  view.dispatch({ effects: EditorView.scrollIntoView(offset, { y }) })
  return true
}

async function openDocument(
  request: Extract<EditorRequestDto, { op: 'openDocument' }>
): Promise<boolean> {
  const existing = tabByUri(request.uri)
  if (existing) {
    if (!request.options?.preserveFocus) activateTab(existing.id)
    if (request.options?.selection) applySelection(existing.id, request.options.selection)
    return true
  }

  const path = pathFromUri(request.uri)
  if (!path) return false
  const opened = await openFileByPath(path, { silent: true })
  if (!opened) return false
  const tab = tabByUri(request.uri)
  if (!tab) return true
  if (request.options?.preserveFocus) {
    // openFileByPath 默认聚焦;保持焦点时把它还回去(调用方的焦点由它自己维持)
    editorHolder.view?.contentDOM.blur()
  }
  if (request.options?.selection) applySelection(tab.id, request.options.selection)
  return true
}

function setDecorations(
  request: Extract<EditorRequestDto, { op: 'setDecorations' }>
): boolean {
  const tab = tabByUri(request.uri)
  if (!tab) return false
  const state = tabState(tab.id)
  if (!state) return false
  const ranges = request.ranges.slice(0, 2000).map(range => decoOffsets(state.doc, range))
  const effect = setExtensionDecorationsEffect.of({
    typeId: request.typeId,
    ranges,
    options: request.options
  })
  return updateTabState(tab.id, { effects: effect })
}

async function handleRequest(requestId: string, request: EditorRequestDto): Promise<void> {
  try {
    switch (request.op) {
      case 'applyEdits':
        reply(requestId, true, applyEdits(request))
        return
      case 'setSelections':
        reply(requestId, true, setSelections(request))
        return
      case 'reveal':
        reply(requestId, true, reveal(request))
        return
      case 'openDocument':
        reply(requestId, true, await openDocument(request))
        return
      case 'saveAll': {
        if (request.includeUntitled) reply(requestId, true, await saveAllDirtyTabs())
        else {
          await saveAllFileTabsSilently()
          reply(requestId, true, true)
        }
        return
      }
      case 'saveDocument': {
        const tab = tabByUri(request.uri)
        reply(requestId, true, tab ? await saveTab(tab.id) : false)
        return
      }
      case 'setDecorations':
        reply(requestId, true, setDecorations(request))
        return
      case 'renderMarkdown':
        reply(requestId, true, await renderMarkdownFragment(request.text, request.theme))
        return
      default:
        reply(requestId, false, undefined, '未知的编辑器请求')
    }
  } catch (err) {
    reply(requestId, false, undefined, err instanceof Error ? err.message : String(err))
  }
}

function reply(requestId: string, ok: boolean, value?: unknown, error?: string): void {
  send({
    type: 'editor.response',
    requestId,
    ok,
    ...(value !== undefined ? { value } : {}),
    ...(error ? { error } : {})
  })
}

/** main 的镜像与渲染层对不上:整篇重发,让宿主直接 reset */
function resync(uri: string): void {
  const tab = tabByUri(uri)
  if (!tab) {
    send({ type: 'editor.documentClosed', uri })
    return
  }
  const version = (versions.get(uri) ?? 1) + 1
  versions.set(uri, version)
  const text = tabText(tab.id, { flush: false }) ?? ''
  send({
    type: 'editor.documentChanged',
    change: {
      uri,
      version,
      changes: [],
      text,
      eol: eolOf(tab),
      isDirty: tab.dirty
    }
  })
}

function handleMainMessage(message: MainToRendererMessage): void {
  switch (message.type) {
    case 'editor.request':
      void handleRequest(message.requestId, message.request)
      return
    case 'editor.resync':
      resync(message.uri)
      return
    default:
      return
  }
}

// ---------- 安装 ----------

/**
 * 由 main.ts 在挂载编辑器之前调用;返回取消函数。
 *
 * 这里不设置 `ready`:要等 EditorPane 建好视图、调用 `notifyEditorReady()`,
 * 否则第一份快照里的活动文档可能是个还没装进视图的标签。
 */
export function initEditorBridge(): () => void {
  setEditorUpdateObserver(onEditorUpdate)
  setTabDocumentObserver(onTabEvent)
  const offMessage = api.onExtensionMessage(handleMainMessage)

  const stopTabWatch = watch(
    () =>
      appStore.tabs
        .map(tab => `${tab.id}\u0000${tab.filePath ?? ''}\u0000${tab.eol}`)
        .join('\u0001'),
    () => {
      if (ready) syncTabs()
    }
  )
  const stopActiveWatch = watch(
    () => appStore.activeTabId,
    () => sendActive()
  )
  const stopDirtyWatch = watch(
    () => activeTab()?.dirty ?? false,
    () => sendContext()
  )
  const stopVaultWatch = watch(
    () => appStore.vaultPath,
    () => sendContext()
  )
  const stopThemeWatch = watch(
    () => appStore.theme,
    () => {
      if (ready) send({ type: 'editor.themeChanged', theme: readTheme() })
    }
  )

  const onFocusChange = (): void => sendContext()
  document.addEventListener('focusin', onFocusChange, true)
  document.addEventListener('focusout', onFocusChange, true)

  return () => {
    setEditorUpdateObserver(null)
    setTabDocumentObserver(null)
    offMessage()
    stopTabWatch()
    stopActiveWatch()
    stopDirtyWatch()
    stopVaultWatch()
    stopThemeWatch()
    document.removeEventListener('focusin', onFocusChange, true)
    document.removeEventListener('focusout', onFocusChange, true)
    ready = false
    uriByTab.clear()
    versions.clear()
    lastContextKey = ''
  }
}
