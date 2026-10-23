/**
 * 文档标签页模型。
 *
 * ## 为什么只有一个 EditorView
 *
 * 每个标签页各自持有一份 **EditorState**(文档、撤销栈、选区都在里面),
 * 切换标签时对同一个视图 `setState()`。这样:
 *   - 撤销历史天然按标签隔离,不会出现「在 B 里撤销出 A 的内容」;
 *   - 扩展拿到的始终是当前视图(它们只认 `editorHolder.view`),不用为每个标签
 *     重新注册一遍扩展;
 *   - 滚动位置用 CM6 的 `scrollSnapshot()` 随 state 一起存:它正是为
 *     「同一个视图换文档」设计的,比手动记 scrollTop 可靠。
 *
 * ## 响应式边界
 *
 * 标签的**元数据**(标题、脏标记、字数、大纲)放在 `appStore.tabs` 里由 Vue 跟踪;
 * EditorState 放在模块级 Map 里,绝不进响应式 —— 它是不可变的大对象,
 * 让 Vue 深层代理它既没必要,也会踩到 CodeMirror 的模块身份/同一性判断。
 *
 * 界面要读当前文档时走 `activeTab()`,不要在 store 里再存一份镜像。
 */
import { ChangeSet, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { applyWrapping, buildDocumentState } from '../editor/setup'
import { extractOutline, updateActiveOutline } from '../editor/outline'
import { flushTableEdits } from '../editor/wysiwyg/widgets'
import { activeTab, appStore, editorHolder, type OutlineItem } from '../stores/app'
import { basename, computeStats, stripMarkdownExt } from '../utils/text'
import { isInside } from '../utils/paths'
import { api } from './api'

export interface DocTab {
  id: string
  /** 绝对路径;未命名文档为 null */
  filePath: string | null
  /** 文件本名(含扩展名);未命名文档为「未命名」 */
  fileName: string
  eol: 'LF' | 'CRLF'
  /** 上次落盘的纯文本(LF),脏检查用字符串全等 */
  savedContent: string
  dirty: boolean
  words: number
  chars: number
  lines: number
  /** 该标签自己的大纲;切换回来时直接复用 */
  outline: OutlineItem[]
}

interface TabRuntime {
  state: EditorState
  /**
   * 离开这个标签时的滚动快照。CM6 保证它只对同一份文档生效,
   * 而这个 effect 与 state 是同一次捕获的,正好成对。
   */
  scrollEffect: ReturnType<EditorView['scrollSnapshot']> | null
}

const runtime = new Map<string, TabRuntime>()

/**
 * 文档级事件的上报口(编辑器桥订阅)。
 *
 * 表格输入、另存为、外部重载这些路径改完标签之后没必要让桥去轮询文本 ——
 * 由这里在**改动落定的那一刻**说一声,桥负责版本号与跨进程消息。
 */
export type TabDocumentEvent =
  | { kind: 'saved'; tabId: string }
  | { kind: 'replaced'; tabId: string; text: string; eol: 'LF' | 'CRLF' }

let documentObserver: ((event: TabDocumentEvent) => void) | null = null

export function setTabDocumentObserver(
  fn: ((event: TabDocumentEvent) => void) | null
): void {
  documentObserver = fn
}

function notifyDocumentEvent(event: TabDocumentEvent): void {
  try {
    documentObserver?.(event)
  } catch (err) {
    console.error('[iMark] 文档事件通知失败', err)
  }
}

let nextId = 1
let metaTimer: ReturnType<typeof setTimeout> | undefined
let outlineTimer: ReturnType<typeof setTimeout> | undefined
/** 恢复会话期间逐个建标签,别每一步都写一次 settings.json */
let suspendingPersist = false
/**
 * 会话写盘的合并标记。
 *
 * 一次「关闭当前标签」会连续改两次状态(先激活邻居,再移除自己)。
 * 同一个任务里的多次调用不必各发一条 saveSettings:合并到微任务末尾只写最终状态
 * (主进程那边还有写盘串行队列,跨任务的顺序也有保证)。
 */
let persistPending = false

function freshId(): string {
  return `tab-${nextId++}`
}

// ---------- 读取 ----------

export function tabById(id: string | null): DocTab | null {
  return id ? (appStore.tabs.find(t => t.id === id) ?? null) : null
}

export function tabByPath(path: string): DocTab | null {
  return appStore.tabs.find(t => t.filePath === path) ?? null
}

/** 标签的 EditorState;当前标签要读视图里的那一份(它比 Map 里的新) */
export function tabState(id: string): EditorState | null {
  if (id === appStore.activeTabId && editorHolder.view) return editorHolder.view.state
  return runtime.get(id)?.state ?? null
}

/**
 * 取文档文本。
 *
 * `flush` 只在当前标签上有效:表格单元格里未提交的字符活在视图的 contenteditable
 * 里,后台标签没有 DOM,自然也没有待刷新的东西。
 */
export function tabText(id: string, opts?: { flush?: boolean }): string | null {
  const state = tabState(id)
  if (!state) return null
  if (opts?.flush !== false && id === appStore.activeTabId) flushTableEdits()
  const fresh = id === appStore.activeTabId && editorHolder.view ? editorHolder.view.state : state
  return fresh.doc.toString()
}

// ---------- 新建 / 激活 / 关闭 ----------

export interface NewTabInput {
  filePath: string | null
  fileName: string
  content: string
  eol: 'LF' | 'CRLF'
  /** 不传时按 content 算(打开/恢复的文件是干净的) */
  savedContent?: string
}

export interface AddTabOptions {
  /** 不激活(恢复会话时先把标签全建出来,最后一次激活目标页) */
  activate?: boolean
  /** 插入位置;默认插在当前标签右边,没有当前标签时追加到末尾 */
  index?: number
  /** 每建一个标签都写盘没必要;恢复会话时由调用方最后统一持久化 */
  persist?: boolean
}

/** 创建一个标签页(含它自己的 EditorState),默认立即激活 */
export function addTab(input: NewTabInput, opts?: AddTabOptions): DocTab {
  const savedContent = input.savedContent ?? input.content
  const tab: DocTab = {
    id: freshId(),
    filePath: input.filePath,
    fileName: input.fileName,
    eol: input.eol,
    savedContent,
    dirty: input.content !== savedContent,
    ...computeStats(input.content),
    outline: []
  }
  const state = buildDocumentState(input.content, v => editorHolder.onDocChange?.(v), {
    editable: true
  })
  tab.outline = extractOutline(state)
  runtime.set(tab.id, { state, scrollEffect: null })

  const current = activeTab()
  const at =
    opts?.index ??
    (current ? appStore.tabs.findIndex(t => t.id === current.id) + 1 : appStore.tabs.length)
  appStore.tabs.splice(at, 0, tab)

  if (opts?.activate !== false) activateTab(tab.id, { persist: opts?.persist })
  if (opts?.persist !== false) persistSession()
  return tab
}

/** 离开当前标签前,把视图里的一切(未提交的表格输入、滚动位置)收进它的 runtime */
export function captureActiveTab(): void {
  const tab = activeTab()
  const view = editorHolder.view
  if (!tab || !view) return
  // 表格单元格里最后几个字还只在 contenteditable 里;setState 会换掉整块 DOM,
  // 不先刷回文档就会静默丢掉
  flushTableEdits()
  const text = view.state.doc.toString()
  tab.dirty = text !== tab.savedContent
  Object.assign(tab, computeStats(text))
  tab.outline = extractOutline(view.state)
  const rt = runtime.get(tab.id)
  if (rt) {
    rt.state = view.state
    rt.scrollEffect = view.scrollSnapshot()
  }
  clearTimers()
}

/** 把某个标签的 state 装进视图(光标、撤销栈、滚动位置都随 state 走) */
function mountTabState(id: string, view: EditorView): void {
  const rt = runtime.get(id)
  if (!rt) return
  view.setState(rt.state)
  applyWrapping(view, appStore.lineWrapping)
  if (rt.scrollEffect) view.dispatch({ effects: rt.scrollEffect })
}

/** 激活一个标签;不存在的 id 静默忽略 */
export function activateTab(id: string, opts?: { focus?: boolean; persist?: boolean }): void {
  const tab = tabById(id)
  if (!tab) return

  if (appStore.activeTabId !== id) {
    captureActiveTab()
    appStore.activeTabId = id

    const view = editorHolder.view
    if (view) mountTabState(id, view)
    if (view) updateActiveOutline(view)
    if (opts?.persist !== false) persistSession()
  }

  if (opts?.focus !== false) editorHolder.view?.focus()
}

/**
 * 编辑器视图刚挂载时把当前标签装进去。
 *
 * 正常流程里挂载发生在标签创建之前(先有编辑器,再从空状态恢复会话),
 * 但把「已存在的当前标签」也接住不需要任何额外成本 —— 否则那条顺序一旦
 * 改变,界面会停在一个空编辑器上,而标签栏说文档开着。
 */
export function attachActiveTab(): void {
  const tab = activeTab()
  const view = editorHolder.view
  if (!tab || !view) return
  mountTabState(tab.id, view)
  updateActiveOutline(view)
}

/**
 * 关闭一个标签(不含脏确认 —— 那一步要弹原生对话框,放在 fileService)。
 *
 * 关掉当前标签时先激活邻居:captureActiveTab 要把即将消失的标签里的
 * 表格输入与滚动位置收好,视图也得先切走,最后才移除数据。
 */
export function closeTabNow(id: string): void {
  const index = appStore.tabs.findIndex(t => t.id === id)
  if (index < 0) return
  const wasActive = appStore.activeTabId === id

  if (wasActive) {
    const next = appStore.tabs[index + 1] ?? appStore.tabs[index - 1] ?? null
    if (next) activateTab(next.id)
    else deactivateToEmpty()
  }

  appStore.tabs.splice(index, 1)
  runtime.delete(id)
  persistSession()
}

/** 当前没有标签:编辑器回到只读空状态 */
export function deactivateToEmpty(): void {
  clearTimers()
  appStore.activeTabId = null
  const view = editorHolder.view
  if (view) {
    view.setState(buildDocumentState('', v => editorHolder.onDocChange?.(v), { editable: false }))
    view.contentDOM.blur()
  }
  // 没有页面就没有可恢复的页面;openFiles 仍可能为空或由 clearTabs 处理
  persistSession()
}

/** 清空全部标签(调用方负责先处理脏文档);切仓库、恢复失败时用 */
export function clearTabs(): void {
  clearTimers()
  appStore.tabs = []
  appStore.activeTabId = null
  runtime.clear()
  const view = editorHolder.view
  if (view) {
    view.setState(buildDocumentState('', v => editorHolder.onDocChange?.(v), { editable: false }))
    view.contentDOM.blur()
  }
  persistSession()
}

/** 下一个/上一个标签(Ctrl+Tab / Ctrl+Shift+Tab),两端循环 */
export function stepTab(delta: 1 | -1): void {
  const n = appStore.tabs.length
  if (n < 2) return
  const current = appStore.activeTabId
  const i = current ? appStore.tabs.findIndex(t => t.id === current) : -1
  // 没有当前标签时从两端进入:下一项取第一个,上一项取最后一个
  const at = i < 0 ? (delta === 1 ? 0 : n - 1) : ((i + delta) % n + n) % n
  const target = appStore.tabs[at]
  if (target) activateTab(target.id)
}

/** 拖动排序:把 dragged 放到 target 的前面/后面 */
export function moveTab(draggedId: string, targetId: string, after: boolean): void {
  if (draggedId === targetId) return
  const from = appStore.tabs.findIndex(t => t.id === draggedId)
  if (from < 0) return
  const [tab] = appStore.tabs.splice(from, 1)
  if (!tab) return
  let to = appStore.tabs.findIndex(t => t.id === targetId)
  if (to < 0) to = appStore.tabs.length
  else if (after) to += 1
  appStore.tabs.splice(to, 0, tab)
  persistSession()
}

// ---------- 内容变化 ----------

function stateOf(id: string): EditorState | null {
  return tabState(id)
}

function refreshMeta(id: string): void {
  const tab = tabById(id)
  const state = stateOf(id)
  if (!tab || !state) return
  const text = state.doc.toString()
  Object.assign(tab, computeStats(text))
  tab.dirty = text !== tab.savedContent
}

function refreshOutline(id: string): void {
  const tab = tabById(id)
  const state = stateOf(id)
  if (!tab || !state) return
  tab.outline = extractOutline(state)
  if (id === appStore.activeTabId && editorHolder.view) updateActiveOutline(editorHolder.view)
}

/**
 * 把一批「旧坐标」的增量修改应用到某个标签。
 *
 * 当前标签走视图 dispatch —— 撤销栈、选区映射、WYSIWYG 都按正常输入处理;
 * 后台标签没有视图,只能 `state.update()`,再顺手把字数/大纲结清
 * (它下一次被激活时看到的就是新内容,不会等一次 250ms 的防抖)。
 *
 * 返回 false 表示修改不合法(越界/重叠):调用方据此回 `invalid-edit`,
 * 而不是让 ChangeSet 的异常穿到 IPC 层变成一句看不清的错误。
 */
export function applyTabChanges(
  id: string,
  changes: ReadonlyArray<{ from: number; to: number; text: string }>
): boolean {
  const state = tabState(id)
  if (!state) return false
  let set: ChangeSet
  try {
    // ChangeSet 的字段叫 `insert`；协议 DTO 用的是 `text`，这里必须显式转换。
    // 传错字段不会抛错，只会得到一份空 ChangeSet —— 症状是「扩展说改成功了，文档没动」。
    set = ChangeSet.of(
      changes.map(change => ({ from: change.from, to: change.to, insert: change.text })),
      state.doc.length
    )
  } catch {
    return false
  }
  if (id === appStore.activeTabId && editorHolder.view) {
    editorHolder.view.dispatch({ changes: set, userEvent: 'input' })
    return true
  }
  const rt = runtime.get(id)
  if (!rt) return false
  rt.state = rt.state.update({ changes: set }).state
  refreshMeta(id)
  refreshOutline(id)
  return true
}

/**
 * 对某个标签的 state 施加一个事务(目前只用于装饰:它不产生文本变化)。
 *
 * 没有 span/撤销栈的副作用,因此不需要过滤;后台标签也只是把 runtime 里
 * 那份 state 换掉,等切回来时 `mountTabState` 会连同装饰一起装进视图。
 */
export function updateTabState(id: string, spec: TransactionSpec): boolean {
  if (id === appStore.activeTabId && editorHolder.view) {
    editorHolder.view.dispatch(spec)
    return true
  }
  const rt = runtime.get(id)
  if (!rt) return false
  rt.state = rt.state.update(spec).state
  return true
}

function clearTimers(): void {
  clearTimeout(metaTimer)
  clearTimeout(outlineTimer)
  metaTimer = undefined
  outlineTimer = undefined
}

/**
 * 编辑器每次内容变化时调用。
 *
 * 字数/脏标记按原节奏防抖(250ms);定时器回调按**标签 id** 取文本,
 * 所以即使回调触发前用户已经切走,也只会更新原来那个标签,不会把新标签
 * 的字数/脏标记写错。
 */
export function handleEditorDocChange(_view: EditorView): void {
  const tab = activeTab()
  if (!tab) {
    // 没有当前标签却有人改了文档:只可能是扩展直接写视图。把它收编成一个
    // 未命名标签,而不是让内容停在一个「没有文档」的视图里。
    // update listener 里不能 setState,挪到微任务。
    queueMicrotask(() => {
      if (appStore.activeTabId || !editorHolder.view) return
      const text = editorHolder.view.state.doc.toString()
      if (!text) return
      addTab({ filePath: null, fileName: '未命名', content: text, eol: 'LF', savedContent: '' })
    })
    return
  }
  const id = tab.id
  // 先标脏:250ms 后才结算只是为了省下每次按键的全文比较,
  // 但「刚敲完就关窗口/关标签」不能因为这段延迟而看不到改动。
  // 结算时如果撤销回了保存时的内容,会再改回 false。
  if (!tab.dirty) tab.dirty = true
  clearTimeout(metaTimer)
  clearTimeout(outlineTimer)
  metaTimer = setTimeout(() => refreshMeta(id), 250)
  outlineTimer = setTimeout(() => refreshOutline(id), 300)
}

// ---------- 保存 / 外部重载 ----------

/** 写完盘后更新这个标签的基准内容;只有内容仍是刚写的那份才清脏标记 */
export function markTabSaved(id: string, text: string): void {
  const tab = tabById(id)
  if (!tab) return
  tab.savedContent = text
  const current = stateOf(id)
  tab.dirty = current ? current.doc.toString() !== text : false
  notifyDocumentEvent({ kind: 'saved', tabId: id })
}

/** 另存为/重命名后更新路径与名字 */
export function setTabPath(id: string, path: string, eol: 'LF' | 'CRLF'): void {
  const tab = tabById(id)
  if (!tab) return
  tab.filePath = path
  tab.fileName = basename(path)
  tab.eol = eol
  persistSession()
}

/**
 * 用磁盘内容替换一个标签(扩展的 vault.write 改了正开着的文件)。
 * 当前标签会换掉 state;后台标签只换 Map 里那份,不打扰用户。
 */
export function replaceTabDocument(id: string, content: string, eol: 'LF' | 'CRLF'): void {
  const tab = tabById(id)
  if (!tab) return
  const state = buildDocumentState(content, v => editorHolder.onDocChange?.(v), { editable: true })
  tab.eol = eol
  tab.savedContent = content
  tab.dirty = false
  Object.assign(tab, computeStats(content))
  tab.outline = extractOutline(state)
  runtime.set(id, { state, scrollEffect: null })

  const view = editorHolder.view
  if (id === appStore.activeTabId && view) {
    view.setState(state)
    updateActiveOutline(view)
  }
  notifyDocumentEvent({ kind: 'replaced', tabId: id, text: content, eol })
}

// ---------- 文件树改名 / 删除 ----------

/** 文件树重命名后,把路径恰好是它(或位于被改名目录下)的标签一并修正 */
export function renameTabPaths(from: string, to: string, isDir: boolean): void {
  let changed = false
  for (const tab of appStore.tabs) {
    if (!tab.filePath) continue
    if (tab.filePath === from) {
      tab.filePath = to
      tab.fileName = basename(to)
      changed = true
    } else if (isDir && isInside(from, tab.filePath)) {
      const next = to + tab.filePath.slice(from.length)
      tab.filePath = next
      tab.fileName = basename(next)
      changed = true
    }
  }
  if (changed) persistSession()
}

/**
 * 文件/目录被删除后,受影响的标签转为「未保存的未命名文档」(内容保留)。
 * 删除的是磁盘上的文件,不是用户正在看的文字。
 */
export function detachDeletedPath(path: string, isDir: boolean): void {
  let changed = false
  for (const tab of appStore.tabs) {
    if (!tab.filePath) continue
    if (!isInside(path, tab.filePath) || (!isDir && tab.filePath !== path)) continue
    const text = stateOf(tab.id)?.doc.toString() ?? ''
    tab.filePath = null
    tab.fileName = '未命名'
    tab.savedContent = ''
    tab.dirty = text.length > 0
    changed = true
  }
  if (changed) persistSession()
}

// ---------- 会话持久化 ----------

export function sessionSnapshot(): { openFiles: string[]; lastFile: string | null } {
  const openFiles = appStore.tabs
    .map(t => t.filePath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
  return { openFiles, lastFile: activeTab()?.filePath ?? null }
}

/** 把当前标签会话写进 settings(openFiles + 当前页 lastFile),同一任务内只写一次 */
export function persistSession(): void {
  if (suspendingPersist || persistPending) return
  persistPending = true
  queueMicrotask(() => {
    persistPending = false
    if (suspendingPersist) return
    void api.saveSettings(sessionSnapshot())
  })
}

/** 恢复会话期间挂起逐次写盘,由调用方在结束时统一持久化一次 */
export function setSessionPersistSuspended(suspended: boolean): void {
  suspendingPersist = suspended
}

// ---------- 显示 ----------

/** 标签上显示的名字:去掉 .md 后缀;多个未命名按出现顺序编号 */
export function tabLabel(tab: DocTab): string {
  if (tab.filePath) return stripMarkdownExt(tab.fileName)
  const untitled = appStore.tabs.filter(t => !t.filePath)
  const i = untitled.findIndex(t => t.id === tab.id)
  return i <= 0 ? '未命名' : `未命名 ${i + 1}`
}

export function tabTooltip(tab: DocTab): string {
  return tab.filePath ?? '未保存到磁盘'
}
