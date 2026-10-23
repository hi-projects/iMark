/**
 * 扩展宿主进程里的运行时。
 *
 * 同一份代码服务两种拓扑：
 *   - isolated：进程里只有 1 个扩展；
 *   - shared：进程里有 N 个扩展，`globalThis` / 事件循环 / require 缓存共享。
 *
 * 它负责三件事，且只负责这三件事：
 *   1. 按**调用方**把 `imark` 模块注入给扩展（patch `Module._load`）；
 *   2. 调用 `activate` / `deactivate`，管理每个扩展自己的 disposable 与定时器；
 *   3. 把宿主 API 的调用翻译成 main ↔ 宿主 RPC，把 main 的事件翻译成扩展 API 事件。
 *
 * 文档与编辑器的真身在 renderer；这里只维护镜像。扩展改动文档必须经 RPC 回到
 * renderer 的同一个 CM6 transaction，镜像只从 main 的变更事件更新。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import Module from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  CancellationToken,
  CancellationTokenSource,
  ColorThemeKind,
  ConfigurationTarget,
  Disposable,
  EndOfLine,
  EventEmitter,
  ExtensionMode,
  FileType,
  Position,
  Range,
  Selection,
  StatusBarAlignment,
  TextEditorRevealType,
  Uri,
  ViewColumn,
  toDisposable
} from '@shared/extensionApi'
import type {
  ColorTheme,
  DecorationOptions,
  DecorationRenderOptions,
  Event,
  FileStat,
  MessageOptions,
  QuickPickItem,
  QuickPickOptions,
  InputBoxOptions,
  TextDocument,
  TextDocumentChangeEvent,
  TextDocumentContentChangeEvent,
  TextEditor,
  TextEditorDecorationType,
  TextEditorEdit,
  TextEditorSelectionChangeEvent,
  TextLine,
  Webview,
  WebviewOptions,
  WebviewPanel,
  WebviewPanelSerializer,
  WorkspaceConfiguration,
  WorkspaceFolder
} from '@shared/extensionApi'
import type { ExtensionManifest } from '@shared/extensionPackage'
import { entryFileOf } from '@shared/extensionPackage'
import type {
  DecorationRenderOptionsDto,
  DocumentChangeDto,
  DocumentStateDto,
  EditorSelectionDto,
  ExtensionHostInitPayload,
  HostActivationReason,
  HostErrorDto,
  HostExtensionInit,
  HostRequestMessage,
  HostToMainMessage,
  MainToHostMessage,
  RendererApplyEditsResult,
  StatusBarItemDto,
  TextChangeDto,
  ThemeDto,
  WebviewPanelCreateResult,
  WebviewPanelStateDto,
  WebviewPanelStatusDto,
  WebviewPresentationDto
} from '@shared/extensionProtocol'

// ---------- 传输层 ----------

export interface RuntimeTransport {
  send(message: HostToMainMessage): void
  onMessage(handler: (message: MainToHostMessage) => void): void
  onShutdown(): void
}

// ---------- 扩展运行时状态 ----------

interface RuntimeEvents {
  activeEditor: EventEmitter<TextEditor | undefined>
  visibleEditors: EventEmitter<readonly TextEditor[]>
  selectionChanged: EventEmitter<TextEditorSelectionChangeEvent>
  visibleRanges: EventEmitter<unknown>
  openDocument: EventEmitter<TextDocument>
  closeDocument: EventEmitter<TextDocument>
  saveDocument: EventEmitter<TextDocument>
  changeDocument: EventEmitter<TextDocumentChangeEvent>
  configChanged: EventEmitter<{ affectsConfiguration(section: string): boolean }>
  themeChanged: EventEmitter<ColorTheme>
  workspaceFolders: EventEmitter<{ added: readonly WorkspaceFolder[]; removed: readonly WorkspaceFolder[] }>
  secretsChanged: EventEmitter<{ key: string }>
  webviewMessage: EventEmitter<unknown>
}

interface RuntimeExtension {
  init: HostExtensionInit
  id: string
  manifest: ExtensionManifest
  root: string
  realRoot: string
  /** 生效配置(合并后) */
  config: Record<string, unknown>
  /** 显式全局值;`inspect().globalValue` 用 */
  globalConfig: Record<string, unknown>
  /** 当前仓库的显式覆盖值;`inspect().workspaceValue` 用 */
  workspaceConfig: Record<string, unknown>
  globalState: Record<string, unknown>
  workspaceState: Record<string, unknown>
  module: { activate?: (context: unknown) => unknown; deactivate?: () => unknown } | null
  exports: unknown
  context: unknown
  activated: boolean
  activation: Promise<void> | null
  disposables: unknown[]
  timers: Set<unknown>
  events: RuntimeEvents
  statusItems: Map<string, HostStatusBarItem>
  statusSeq: number
  decorationSeq: number
  decorations: Map<string, TextEditorDecorationType>
  panels: Map<string, HostWebviewPanel>
  serializers: Map<string, WebviewPanelSerializer>
  commands: Map<string, { callback: (...args: unknown[]) => unknown; thisArg?: unknown }>
  api: Record<string, unknown> | null
}

type Thenable<T> = Promise<T>

function thenable<T>(value: T): Promise<T> {
  return Promise.resolve(value)
}

function errorDto(err: unknown): HostErrorDto {
  if (err instanceof Error) return { message: err.message, stack: err.stack }
  return { message: String(err) }
}

// ---------- 定时器归属（用于停用时清理） ----------

const als = new AsyncLocalStorage<RuntimeExtension>()

/** 给宿主入口的 console 转发用：当前异步上下文属于哪个扩展 */
export function currentExtensionId(): string | null {
  return als.getStore()?.id ?? null
}

const rawSetTimeout = globalThis.setTimeout
const rawSetInterval = globalThis.setInterval
const rawSetImmediate = globalThis.setImmediate
const rawClearTimeout = globalThis.clearTimeout
const rawClearInterval = globalThis.clearInterval
const rawClearImmediate = globalThis.clearImmediate

let timerTrackingInstalled = false

/**
 * 扩展里裸写的 `setTimeout` / `setInterval` 也必须能在停用时清掉。
 *
 * 用 AsyncLocalStorage 给“当前正在为哪个扩展执行”打标签：激活、命令回调、
 * 事件监听器、webview 消息都包在 `als.run(ext, …)` 里，定时器创建时把 handle
 * 记到该扩展名下。补丁只装在宿主进程内，不影响 Electron main。
 */
function installTimerTracking(): void {
  if (timerTrackingInstalled) return
  timerTrackingInstalled = true
  const g = globalThis as unknown as {
    setTimeout: typeof setTimeout
    setInterval: typeof setInterval
    setImmediate: typeof setImmediate
    clearTimeout: typeof clearTimeout
    clearInterval: typeof clearInterval
    clearImmediate: typeof clearImmediate
  }

  const wrappedSetTimeout = ((
    handler: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    let handle: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      const owner = als.getStore()
      if (owner && handle !== undefined) owner.timers.delete(handle)
      handler(...args)
    }
    handle = rawSetTimeout(run, timeout)
    const owner = als.getStore()
    if (owner) owner.timers.add(handle)
    return handle
  }) as unknown as typeof setTimeout
  Object.assign(wrappedSetTimeout, rawSetTimeout)
  ;(wrappedSetTimeout as unknown as Record<symbol, unknown>)[promisify.custom] = (
    rawSetTimeout as unknown as Record<symbol, unknown>
  )[promisify.custom]

  const wrappedSetInterval = ((
    handler: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const handle = rawSetInterval(handler, timeout, ...args)
    const owner = als.getStore()
    if (owner) owner.timers.add(handle)
    return handle
  }) as unknown as typeof setInterval
  Object.assign(wrappedSetInterval, rawSetInterval)

  const wrappedSetImmediate = ((handler: (...args: unknown[]) => void, ...args: unknown[]) => {
    let handle: ReturnType<typeof setImmediate> | undefined
    const run = (): void => {
      const owner = als.getStore()
      if (owner && handle !== undefined) owner.timers.delete(handle)
      handler(...args)
    }
    handle = rawSetImmediate(run)
    const owner = als.getStore()
    if (owner) owner.timers.add(handle)
    return handle
  }) as unknown as typeof setImmediate
  Object.assign(wrappedSetImmediate, rawSetImmediate)

  const wrappedClearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    const owner = als.getStore()
    if (owner && handle !== undefined) owner.timers.delete(handle)
    rawClearTimeout(handle)
  }) as unknown as typeof clearTimeout
  const wrappedClearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    const owner = als.getStore()
    if (owner && handle !== undefined) owner.timers.delete(handle)
    rawClearInterval(handle)
  }) as unknown as typeof clearInterval
  const wrappedClearImmediate = ((handle?: ReturnType<typeof setImmediate>) => {
    const owner = als.getStore()
    if (owner && handle !== undefined) owner.timers.delete(handle)
    rawClearImmediate(handle)
  }) as unknown as typeof clearImmediate

  g.setTimeout = wrappedSetTimeout
  g.setInterval = wrappedSetInterval
  g.setImmediate = wrappedSetImmediate
  g.clearTimeout = wrappedClearTimeout
  g.clearInterval = wrappedClearInterval
  g.clearImmediate = wrappedClearImmediate
}

// ---------- 文档镜像 ----------

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

class HostDocument implements TextDocument {
  readonly uri: Uri
  version: number
  isDirty: boolean
  isClosed = false
  languageId: string
  private text: string
  private readonly starts: number[]
  private eolValue: EndOfLine

  constructor(
    state: DocumentStateDto,
    private readonly runtime: ExtensionHostRuntime,
    private readonly owner: string
  ) {
    this.uri = Uri.parse(state.uri)
    this.version = state.version
    this.text = state.text
    this.starts = lineStartsOf(state.text)
    this.isDirty = state.isDirty
    this.languageId = state.languageId || 'markdown'
    this.eolValue = state.eol === 'crlf' ? EndOfLine.CRLF : EndOfLine.LF
  }

  get fileName(): string {
    return this.uri.fsPath
  }

  get eol(): EndOfLine {
    return this.eolValue
  }

  get lineCount(): number {
    return this.starts.length
  }

  getText(range?: Range): string {
    if (!range) return this.text
    const start = this.offsetAt(range.start)
    const end = this.offsetAt(range.end)
    return this.text.slice(Math.min(start, end), Math.max(start, end))
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
    const index = Math.min(Math.max(0, Math.trunc(line)), this.lineCount - 1)
    const start = this.starts[index]!
    const nextStart = index + 1 < this.lineCount ? this.starts[index + 1]! : this.text.length
    const hasBreak = nextStart > start && this.text[nextStart - 1] === '\n'
    const end = hasBreak ? nextStart - 1 : nextStart
    const content = this.text.slice(start, end)
    const firstNonWhitespaceCharacterIndex = content.search(/\S/)
    return {
      lineNumber: index,
      text: content,
      range: new Range(index, 0, index, content.length),
      rangeIncludingLineBreak: new Range(index, 0, index, hasBreak ? content.length + 1 : content.length),
      firstNonWhitespaceCharacterIndex:
        firstNonWhitespaceCharacterIndex < 0 ? content.length : firstNonWhitespaceCharacterIndex,
      isEmptyOrWhitespace: content.trim().length === 0
    }
  }

  offsetAt(position: Position): number {
    const line = Math.min(Math.max(0, position.line), this.lineCount - 1)
    const start = this.starts[line]!
    const lineObj = this.lineAt(line)
    const character = Math.min(Math.max(0, position.character), lineObj.text.length)
    return start + character
  }

  positionAt(offset: number): Position {
    const value = Math.min(Math.max(0, Math.trunc(offset)), this.text.length)
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (this.starts[mid]! <= value) lo = mid
      else hi = mid - 1
    }
    return new Position(lo, value - this.starts[lo]!)
  }

  validateRange(range: Range): Range {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end))
  }

  validatePosition(position: Position): Position {
    const line = Math.min(Math.max(0, position.line), this.lineCount - 1)
    const maxChar = this.lineAt(line).text.length
    return new Position(line, Math.min(Math.max(0, position.character), maxChar))
  }

  save(): Thenable<boolean> {
    return this.uri.scheme === 'file'
      ? this.runtime.request(r => ({
          kind: 'workspace.saveAll',
          requestId: r,
          extensionId: this.owner,
          includeUntitled: false
        })).then(() => true)
      : thenable(false)
  }

  /** 全量同步（版本不连续时） */
  reset(state: DocumentStateDto): void {
    this.version = state.version
    this.text = state.text
    this.isDirty = state.isDirty
    this.starts.length = 0
    this.starts.push(...lineStartsOf(this.text))
    this.languageId = state.languageId || this.languageId
    this.eolValue = state.eol === 'crlf' ? EndOfLine.CRLF : EndOfLine.LF
    this.isClosed = false
  }

  /**
   * 增量应用。
   *
   * CM6 的偏移量按**变更前**的文档计算；顺序应用时要把前面的增删量补上，
   * 否则第二条变更会落到错误位置。
   */
  apply(change: DocumentChangeDto): { contentChanges: TextDocumentContentChangeEvent[] } {
    const contentChanges: TextDocumentContentChangeEvent[] = []
    if (typeof change.text === 'string') {
      const oldLength = this.text.length
      const oldEnd = this.positionAt(oldLength)
      this.reset({ ...this.toState(), text: change.text, version: change.version })
      if (change.isDirty !== undefined) this.isDirty = change.isDirty
      contentChanges.push({
        range: new Range(0, 0, oldEnd.line, oldEnd.character),
        rangeOffset: 0,
        rangeLength: oldLength,
        text: change.text
      })
      return { contentChanges }
    }

    let delta = 0
    for (const item of change.changes) {
      const from = Math.min(Math.max(0, item.from + delta), this.text.length)
      const to = Math.min(Math.max(from, item.to + delta), this.text.length)
      const start = this.positionAt(from)
      const end = this.positionAt(to)
      contentChanges.push({
        range: new Range(start, end),
        rangeOffset: from,
        rangeLength: to - from,
        text: item.text
      })
      this.text = this.text.slice(0, from) + item.text + this.text.slice(to)
      delta += item.text.length - (item.to - item.from)
    }
    this.starts.length = 0
    this.starts.push(...lineStartsOf(this.text))
    this.version = change.version
    if (change.isDirty !== undefined) this.isDirty = change.isDirty
    return { contentChanges }
  }

  toState(): DocumentStateDto {
    return {
      uri: this.uri.toString(),
      version: this.version,
      text: this.text,
      eol: this.eolValue === EndOfLine.CRLF ? 'crlf' : 'lf',
      isDirty: this.isDirty,
      languageId: this.languageId
    }
  }
}

// ---------- 编辑器代理 ----------

class HostTextEditor implements TextEditor {
  constructor(
    private readonly runtime: ExtensionHostRuntime,
    private readonly ext: RuntimeExtension,
    private readonly uri: string
  ) {}

  get document(): TextDocument {
    return this.runtime.documentFor(this.uri)
  }

  get selection(): Selection {
    return this.selections[0] ?? new Selection(0, 0, 0, 0)
  }

  get selections(): readonly Selection[] {
    return this.runtime.selectionsOf(this.uri)
  }

  get visibleRanges(): readonly Range[] {
    const doc = this.document
    return [new Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)]
  }

  get options(): { tabSize: number; insertSpaces: boolean } {
    return { tabSize: 2, insertSpaces: true }
  }

  get viewColumn(): ViewColumn | undefined {
    return this.runtime.isVisible(this.uri) ? ViewColumn.One : undefined
  }

  async edit(callback: (edit: TextEditorEdit) => void): Promise<boolean> {
    const doc = this.document
    const edits: TextChangeDto[] = []
    const edit: TextEditorEdit = {
      replace: (location, value) => {
        if (location instanceof Position) {
          const at = doc.offsetAt(location)
          edits.push({ from: at, to: at, text: value })
        } else {
          edits.push({
            from: doc.offsetAt(location.start),
            to: doc.offsetAt(location.end),
            text: value
          })
        }
      },
      insert: (position, value) => {
        const at = doc.offsetAt(position)
        edits.push({ from: at, to: at, text: value })
      },
      delete: location => {
        edits.push({ from: doc.offsetAt(location.start), to: doc.offsetAt(location.end), text: '' })
      }
    }
    try {
      callback(edit)
    } catch (err) {
      this.runtime.log(this.ext.id, 'error', `edit 回调抛错：${String(err)}`)
      return false
    }
    if (edits.length === 0) return true
    edits.sort((a, b) => a.from - b.from)
    for (let i = 1; i < edits.length; i++) {
      if (edits[i]!.from < edits[i - 1]!.to) {
        this.runtime.log(this.ext.id, 'error', 'edit 回调产生了重叠的修改，已拒绝')
        return false
      }
    }
    try {
      const result = await this.runtime.request<RendererApplyEditsResult>(r => ({
        kind: 'editor.applyEdits',
        requestId: r,
        extensionId: this.ext.id,
        uri: this.uri,
        edits,
        expectedVersion: doc.version
      }))
      return result.ok === true
    } catch (err) {
      this.runtime.log(this.ext.id, 'error', `编辑文档失败：${String(err)}`)
      return false
    }
  }

  setDecorations(
    decorationType: TextEditorDecorationType,
    rangesOrOptions: readonly (Range | DecorationOptions)[]
  ): void {
    const doc = this.document
    const ranges = rangesOrOptions.map(item => {
      if (item instanceof Range) {
        return { start: toPositionDto(item.start), end: toPositionDto(item.end) }
      }
      return {
        start: toPositionDto(item.range.start),
        end: toPositionDto(item.range.end),
        hoverMessage: item.hoverMessage
      }
    })
    const options = this.runtime.decorationOptionsOf(decorationType)
    this.runtime.send({
      kind: 'editor.setDecorations',
      extensionId: this.ext.id,
      uri: this.uri,
      typeId: decorationType.key,
      options,
      ranges
    })
    void doc
  }

  revealRange(range: Range, revealType?: TextEditorRevealType): void {
    this.runtime.send({
      kind: 'editor.reveal',
      requestId: `reveal-${++this.runtime.requestSeq}`,
      extensionId: this.ext.id,
      uri: this.uri,
      range: { start: toPositionDto(range.start), end: toPositionDto(range.end) },
      revealType: revealTypeName(revealType)
    })
  }

  setSelection(anchor: Position, active?: Position): void {
    this.runtime.setSelections(this.ext, this.uri, [
      { anchor: toPositionDto(anchor), active: toPositionDto(active ?? anchor) }
    ])
  }

  show(): void {
    this.runtime.sendEditorShow(this.ext, this.uri)
  }

  hide(): void {
    /* 由 renderer 决定标签可见性；扩展不能藏用户的标签 */
  }
}

function toPositionDto(position: Position): { line: number; character: number } {
  return { line: position.line, character: position.character }
}

function revealTypeName(type: TextEditorRevealType | undefined): 'default' | 'center' | 'top' | 'bottom' {
  switch (type) {
    case TextEditorRevealType.InCenter:
      return 'center'
    case TextEditorRevealType.AtTop:
      return 'top'
    case TextEditorRevealType.InCenterIfOutsideViewport:
      return 'center'
    default:
      return 'default'
  }
}

// ---------- 状态栏 ----------

class HostStatusBarItem {
  readonly id: string
  alignment: StatusBarAlignment
  priority = 0
  text = ''
  tooltip?: string
  /** StatusBarItem 允许传 ThemeColor；这里存令牌 id */
  color?: unknown
  backgroundColor?: unknown
  /** 允许传 string 或 Command；这里存命令 id */
  command?: unknown
  name?: string
  visible = true
  private disposed = false

  constructor(
    private readonly runtime: ExtensionHostRuntime,
    private readonly ext: RuntimeExtension,
    id: string,
    alignment: StatusBarAlignment,
    priority: number
  ) {
    this.id = id
    this.alignment = alignment
    this.priority = priority
  }

  show(): void {
    this.visible = true
    this.push()
  }

  hide(): void {
    this.visible = false
    this.push()
  }

  private commandId(): string | undefined {
    if (typeof this.command === 'string') return this.command
    const command = this.command as { command?: unknown } | undefined
    return typeof command?.command === 'string' ? command.command : undefined
  }

  private colorId(value: unknown): string | undefined {
    if (typeof value === 'string') return value
    const token = value as { id?: unknown } | undefined
    return typeof token?.id === 'string' ? token.id : undefined
  }

  push(action: 'create' | 'update' = 'update'): void {
    if (this.disposed) return
    const item: StatusBarItemDto = {
      id: this.id,
      alignment: this.alignment === StatusBarAlignment.Right ? 'right' : 'left',
      priority: this.priority,
      text: this.text,
      tooltip: this.tooltip,
      command: this.commandId(),
      color: this.colorId(this.color),
      backgroundColor: this.colorId(this.backgroundColor),
      name: this.name,
      visible: this.visible
    }
    this.runtime.send({ kind: 'statusbar', extensionId: this.ext.id, action, item })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.runtime.send({
      kind: 'statusbar',
      extensionId: this.ext.id,
      action: 'dispose',
      itemId: this.id
    })
    this.ext.statusItems.delete(this.id)
  }
}

/** 用 getter/setter 让 `item.text = 'x'` 自动同步到主进程 */
function statusBarItemProxy(item: HostStatusBarItem): Record<string, unknown> {
  const setters = [
    'alignment',
    'priority',
    'text',
    'tooltip',
    'color',
    'backgroundColor',
    'command',
    'name'
  ] as const
  const proxy: Record<string, unknown> = {
    show: () => item.show(),
    hide: () => item.hide(),
    dispose: () => item.dispose()
  }
  Object.defineProperty(proxy, 'id', { get: () => item.id })
  for (const key of setters) {
    Object.defineProperty(proxy, key, {
      get: () => item[key],
      set: (value: unknown) => {
        ;(item as unknown as Record<string, unknown>)[key] = value
        item.push()
      },
      enumerable: true
    })
  }
  return proxy
}

// ---------- Webview ----------

class HostWebview implements Webview {
  readonly onDidReceiveMessage: Event<unknown>
  htmlValue = ''
  options: WebviewOptions = {}
  private state: unknown = undefined
  private readonly messageEmitter = new EventEmitter<unknown>()

  constructor(private readonly panel: HostWebviewPanel) {
    this.onDidReceiveMessage = (listener, thisArgs, disposables) =>
      this.messageEmitter.event(
        event => this.panel.runInExtension(() => listener.call(thisArgs, event)),
        undefined,
        disposables
      )
  }

  get html(): string {
    return this.htmlValue
  }

  set html(value: string) {
    this.htmlValue = value
    this.panel.sendHtml(value)
  }

  get cspSource(): string {
    return this.panel.cspSource
  }

  asWebviewUri(localResource: Uri): Uri {
    return this.panel.asWebviewUri(localResource)
  }

  postMessage(message: unknown): Thenable<boolean> {
    this.panel.sendMessage(message)
    return thenable(true)
  }

  getState<T>(): T | undefined {
    return this.state as T | undefined
  }

  setState<T>(state: T): Thenable<void> {
    this.state = state
    this.panel.sendState(state)
    return thenable(undefined)
  }

  receive(message: unknown): void {
    this.messageEmitter.fire(message)
  }

  dispose(): void {
    this.messageEmitter.dispose()
  }
}

class HostWebviewPanel implements WebviewPanel {
  private _title: string
  readonly webview: HostWebview
  visible = false
  active = false
  readonly viewColumn = ViewColumn.One
  private readonly disposeEmitter = new EventEmitter<void>()
  private readonly viewStateEmitter = new EventEmitter<{
    webviewPanel: WebviewPanel
    visible: boolean
    active: boolean
  }>()
  private readonly _onDidDispose: Event<void>
  private readonly _onDidChangeViewState: Event<{
    webviewPanel: WebviewPanel
    visible: boolean
    active: boolean
  }>

  panelId: string | null = null
  token = ''
  cspSource = ''
  private disposed = false
  private readonly pendingOps: (() => void)[] = []
  // 这三个不是 readonly：setPresentation/setSize/setPosition 是增量补丁，
  // 后续调用必须基于上一次的结果，否则 `setSize` 会把刚切好的 floating 重置回 sidebar。
  private presentation: WebviewPresentationDto
  private width?: number
  private height?: number
  private readonly transparent?: boolean
  private anchor?: WebviewPanelStateDto['anchor']

  constructor(
    private readonly runtime: ExtensionHostRuntime,
    private readonly ext: RuntimeExtension,
    readonly viewType: string,
    title: string,
    options: WebviewOptions = {}
  ) {
    this._title = title
    this.webview = new HostWebview(this)
    this.webview.options = options
    const imark = options.imark ?? {}
    this.presentation = imark.presentation ?? 'sidebar'
    this.width = imark.width
    this.height = imark.height
    this.transparent = imark.transparent
    this.anchor = imark.anchor
    this.cspSource = `${this.runtime.webviewScheme()}://${ext.id}`
    this._onDidDispose = (listener, thisArgs, disposables) =>
      this.disposeEmitter.event(
        event => this.runInExtension(() => listener.call(thisArgs, event)),
        undefined,
        disposables
      )
    this._onDidChangeViewState = (listener, thisArgs, disposables) =>
      this.viewStateEmitter.event(
        event => this.runInExtension(() => listener.call(thisArgs, event)),
        undefined,
        disposables
      )
    void runtime
  }

  get title(): string {
    return this._title
  }

  set title(value: string) {
    if (this._title === value) return
    this._title = value
    this.whenReady(() => {
      this.runtime.send({
        kind: 'webview.setTitle',
        extensionId: this.ext.id,
        panelId: this.panelId!,
        title: value
      })
    })
  }

  get onDidDispose(): Event<void> {
    return this._onDidDispose
  }

  get onDidChangeViewState(): Event<{
    webviewPanel: WebviewPanel
    visible: boolean
    active: boolean
  }> {
    return this._onDidChangeViewState
  }

  readonly imark = {
    setPresentation: (presentation: WebviewPresentationDto): void => {
      this.sendPresentation({ presentation })
    },
    setSize: (width: number, height: number): void => {
      this.sendPresentation({ width, height })
    },
    setPosition: (anchor: WebviewPanelStateDto['anchor']): void => {
      this.sendPresentation({ anchor })
    },
    setStatus: (status: WebviewPanelStatusDto): void => {
      // 状态是瞬时信息，不进面板记录之外的任何地方；main 只负责转给 renderer
      this.whenReady(() => {
        this.runtime.send({
          kind: 'webview.setStatus',
          extensionId: this.ext.id,
          panelId: this.panelId!,
          status
        })
      })
    }
  }

  runInExtension<T>(fn: () => T): T {
    return als.run(this.ext, fn)
  }

  private sendPresentation(patch: {
    presentation?: WebviewPresentationDto
    width?: number
    height?: number
    anchor?: WebviewPanelStateDto['anchor']
  }): void {
    // 先把补丁记在自己的状态里，再连同完整状态发给 main。
    // main 的记录是展示真身；这里保持一份副本只是为了下一次补丁能正确合并。
    if (patch.presentation !== undefined) this.presentation = patch.presentation
    if (patch.width !== undefined) this.width = patch.width
    if (patch.height !== undefined) this.height = patch.height
    if (patch.anchor !== undefined) this.anchor = patch.anchor
    const run = (): void => {
      this.runtime.send({
        kind: 'webview.setPresentation',
        extensionId: this.ext.id,
        panelId: this.panelId!,
        presentation: this.presentation,
        width: this.width,
        height: this.height,
        transparent: this.transparent,
        anchor: this.anchor
      })
    }
    this.whenReady(run)
  }

  whenReady(fn: () => void): void {
    if (this.panelId) fn()
    else this.pendingOps.push(fn)
  }

  attach(result: WebviewPanelCreateResult): void {
    // 创建时先用 token 当 map key（那时还没有 panelId）；现在换成真正的 id
    if (this.ext.panels.get(this.token) === this) this.ext.panels.delete(this.token)
    this.panelId = result.panelId
    if (result.token) this.token = result.token
    this.cspSource = result.cspSource || this.cspSource
    this.ext.panels.set(this.panelId, this)
    for (const op of this.pendingOps.splice(0)) op()
  }

  sendHtml(html: string): void {
    this.whenReady(() => {
      this.runtime.send({
        kind: 'webview.setHtml',
        extensionId: this.ext.id,
        panelId: this.panelId!,
        html
      })
    })
  }

  sendMessage(message: unknown): void {
    this.whenReady(() => {
      this.runtime.send({
        kind: 'webview.postMessage',
        extensionId: this.ext.id,
        panelId: this.panelId!,
        message
      })
    })
  }

  sendState(state: unknown): void {
    this.whenReady(() => {
      this.runtime.send({
        kind: 'webview.setState',
        extensionId: this.ext.id,
        panelId: this.panelId!,
        state
      })
    })
  }

  asWebviewUri(localResource: Uri): Uri {
    const fsPath = localResource.fsPath
    let rel = relative(this.ext.root, fsPath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      rel = relative(this.ext.realRoot, fsPath)
    }
    if (rel.startsWith('..') || isAbsolute(rel)) rel = localResource.path.replace(/^\/+/, '')
    const encoded = rel.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/')
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : ''
    return Uri.parse(`${this.cspSource}/${encoded}${query}`)
  }

  reveal(): void {
    /* renderer 根据 presentation 决定它显示在哪；这里没有额外动作 */
  }

  updateViewState(visible: boolean, active: boolean): void {
    this.visible = visible
    this.active = active
    this.viewStateEmitter.fire({ webviewPanel: this, visible, active })
  }

  receive(message: unknown): void {
    this.webview.receive(message)
  }

  fireDisposed(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeEmitter.fire()
    this.viewStateEmitter.dispose()
    this.disposeEmitter.dispose()
    this.webview.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.fireDisposed()
    for (const [key, panel] of this.ext.panels) {
      if (panel === this) this.ext.panels.delete(key)
    }
    if (this.panelId) {
      this.runtime.send({
        kind: 'webview.dispose',
        extensionId: this.ext.id,
        panelId: this.panelId
      })
    }
  }
}

// ---------- 主运行时 ----------

export class ExtensionHostRuntime {
  private readonly extensions = new Map<string, RuntimeExtension>()
  private readonly documents = new Map<string, HostDocument>()
  private readonly editorCache = new Map<string, HostTextEditor>()
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  private readonly workspaces: WorkspaceFolder[] = []
  private activeUri: string | null = null
  private visibleUris: string[] = []
  private readonly selections = new Map<string, Selection[]>()
  private theme: ThemeDto = { kind: 'light', colors: {} }
  private initPayload: ExtensionHostInitPayload | null = null
  private ownerRoots: { root: string; ext: RuntimeExtension }[] = []
  requestSeq = 0

  constructor(private readonly transport: RuntimeTransport) {
    installTimerTracking()
    this.patchRequire()
    transport.onMessage(message => this.handleMessage(message))
    this.theme = { kind: 'light', colors: {} }
  }

  webviewScheme(): string {
    return 'imark-webview'
  }

  send(message: HostToMainMessage): void {
    try {
      this.transport.send(message)
    } catch {
      /* 宿主要退出了 */
    }
  }

  log(extensionId: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.send({ kind: 'log', extensionId, level, message })
  }

  request<T>(
    build: (requestId: string) => HostRequestMessage,
    timeoutMs = 20000
  ): Promise<T> {
    const requestId = `host-${++this.requestSeq}`
    const message = build(requestId)
    return new Promise<T>((resolvePromise, reject) => {
      const timer = rawSetTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`宿主请求 ${message.kind} 超时`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, {
        resolve: value => resolvePromise(value as T),
        reject,
        timer
      })
      this.send(message)
    })
  }

  private handleResponse(message: {
    requestId: string
    ok: boolean
    value?: unknown
    error?: HostErrorDto
  }): void {
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error?.message ?? 'main 请求失败'))
  }

  // ---------- 模块注入 ----------

  private patchRequire(): void {
    const moduleAny = Module as unknown as {
      _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown
    }
    const originalLoad = moduleAny._load
    const runtime = this
    moduleAny._load = function patchedLoad(
      request: string,
      parent: NodeModule | undefined,
      isMain: boolean
    ): unknown {
      if (request === 'imark') {
        const owner = runtime.ownerOf(parent)
        if (!owner) {
          throw new Error(
            'require("imark") 无法确定调用方扩展。请在扩展入口文件或其目录内的模块中调用。'
          )
        }
        return runtime.apiFor(owner)
      }
      return originalLoad.call(this, request, parent, isMain)
    }
  }

  private ownerOf(parent: NodeModule | undefined): RuntimeExtension | null {
    const filename = parent?.filename
    if (filename) {
      let real = filename
      try {
        real = realpathSync.native(filename)
      } catch {
        real = resolve(filename)
      }
      for (const item of this.ownerRoots) {
        if (real === item.root || real.startsWith(item.root + sep)) return item.ext
      }
    }
    if (this.extensions.size === 1) return [...this.extensions.values()][0]!
    return null
  }

  apiFor(ext: RuntimeExtension): Record<string, unknown> {
    if (!ext.api) ext.api = this.createApi(ext)
    return ext.api
  }

  // ---------- 初始化 ----------

  private handleMessage(message: MainToHostMessage): void {
    switch (message.kind) {
      case 'init':
        void this.initialize(message.payload)
        return
      case 'response':
        this.handleResponse(message)
        return
      case 'activate':
        void this.activate(message.extensionId, message.reason).catch(err => {
          this.log(message.extensionId, 'error', `激活失败：${String(err)}`)
        })
        return
      case 'deactivate':
        void this.deactivate(message.extensionId, message.removeData)
        return
      case 'command.execute':
        void this.executeLocalCommand(message.requestId, message.command, message.args)
        return
      case 'configuration.changed':
        this.applyConfiguration(
          message.extensionId,
          message.values,
          message.globalConfig,
          message.workspaceConfig
        )
        return
      case 'secrets.changed': {
        // 外部改动(设置页填写/清空)也要让 onDidChange 收到;扩展自己 store/delete
        // 时宿主侧已经 fire 过一次,这里只处理 main 主动推送的
        const target = this.extensions.get(message.extensionId)
        target?.events.secretsChanged.fire({ key: message.key })
        return
      }
      case 'document.opened':
        this.onDocumentOpened(message.document)
        return
      case 'document.changed':
        this.onDocumentChanged(message.change)
        return
      case 'document.closed':
        this.onDocumentClosed(message.uri)
        return
      case 'document.saved':
        this.onDocumentSaved(message.uri, message.version)
        return
      case 'editor.activeChanged':
        this.onActiveChanged(message.uri, message.visible)
        return
      case 'editor.selectionChanged':
        this.onSelectionChanged(message.uri, message.selections)
        return
      case 'theme.changed':
        this.theme = message.theme
        for (const ext of this.extensions.values()) {
          ext.events.themeChanged.fire({ kind: this.colorThemeKind() })
        }
        return
      case 'workspaceFolders.changed':
        this.applyWorkspaceFolders(message.folders)
        return
      case 'webview.message': {
        const panel = this.panelById(message.panelId)
        panel?.receive(message.message)
        return
      }
      case 'webview.viewState': {
        const panel = this.panelById(message.panelId)
        panel?.updateViewState(message.visible, message.active)
        return
      }
      case 'webview.disposed': {
        const panel = this.panelById(message.panelId)
        if (panel) {
          panel.fireDisposed()
          this.findExtensionOfPanel(panel)?.panels.delete(message.panelId)
        }
        return
      }
      case 'webview.restore':
        this.onWebviewRestore(
          message.panelId,
          message.viewType,
          message.state,
          message.panel,
          message.token
        )
        return
      case 'shutdown':
        void this.shutdown()
        return
      default:
        return
    }
  }

  private async initialize(payload: ExtensionHostInitPayload): Promise<void> {
    this.initPayload = payload
    this.theme = payload.theme
    this.activeUri = payload.activeDocumentUri
    this.visibleUris = payload.visibleDocumentUris
    this.workspaces.length = 0
    payload.workspaceFolders.forEach((folder, index) => {
      this.workspaces.push({ uri: Uri.parse(folder.uri), name: folder.name, index })
    })
    for (const doc of payload.documents) {
      this.documents.set(doc.uri, new HostDocument(doc, this, ''))
    }
    for (const init of payload.extensions) {
      const root = resolve(init.extensionPath)
      let realRoot = root
      try {
        realRoot = realpathSync.native(root)
      } catch {
        /* 目录不存在：稍后加载会给出更清楚的错误 */
      }
      const ext: RuntimeExtension = {
        init,
        id: init.id,
        manifest: init.manifest,
        root,
        realRoot,
        config: { ...init.config },
        globalConfig: { ...(init.globalConfig ?? {}) },
        workspaceConfig: { ...(init.workspaceConfig ?? {}) },
        globalState: { ...init.globalState },
        workspaceState: { ...init.workspaceState },
        module: null,
        exports: undefined,
        context: null,
        activated: false,
        activation: null,
        disposables: [],
        timers: new Set(),
        events: this.createEmitters(),
        statusItems: new Map(),
        statusSeq: 0,
        decorationSeq: 0,
        decorations: new Map(),
        panels: new Map(),
        serializers: new Map(),
        commands: new Map(),
        api: null
      }
      this.extensions.set(init.id, ext)
    }
    this.rebuildOwnerRoots()
    this.send({ kind: 'ready', hostId: payload.hostId, phase: 'initialized' })
  }

  private createEmitters(): RuntimeEvents {
    return {
      activeEditor: new EventEmitter(),
      visibleEditors: new EventEmitter(),
      selectionChanged: new EventEmitter(),
      visibleRanges: new EventEmitter(),
      openDocument: new EventEmitter(),
      closeDocument: new EventEmitter(),
      saveDocument: new EventEmitter(),
      changeDocument: new EventEmitter(),
      configChanged: new EventEmitter(),
      themeChanged: new EventEmitter(),
      workspaceFolders: new EventEmitter(),
      secretsChanged: new EventEmitter(),
      webviewMessage: new EventEmitter()
    }
  }

  private applyWorkspaceFolders(folders: { uri: string; name: string }[]): void {
    const prior = new Map(this.workspaces.map(folder => [folder.uri.toString(), folder]))
    this.workspaces.length = 0
    folders.forEach((folder, index) => {
      this.workspaces.push({ uri: Uri.parse(folder.uri), name: folder.name, index })
    })
    const nextUris = new Set(this.workspaces.map(folder => folder.uri.toString()))
    const added = this.workspaces.filter(folder => !prior.has(folder.uri.toString()))
    const removed = [...prior.values()].filter(folder => !nextUris.has(folder.uri.toString()))
    for (const ext of this.extensions.values()) {
      ext.events.workspaceFolders.fire({ added, removed })
    }
  }

  private rebuildOwnerRoots(): void {
    this.ownerRoots = [...this.extensions.values()]
      .map(ext => ({ root: ext.realRoot, ext }))
      .sort((a, b) => b.root.length - a.root.length)
  }

  private colorThemeKind(): ColorThemeKind {
    switch (this.theme.kind) {
      case 'dark':
        return ColorThemeKind.Dark
      case 'high-contrast':
        return ColorThemeKind.HighContrast
      case 'high-contrast-light':
        return ColorThemeKind.HighContrastLight
      default:
        return ColorThemeKind.Light
    }
  }

  // ---------- 激活 / 停用 ----------

  async activate(id: string, _reason: HostActivationReason): Promise<void> {
    const ext = this.extensions.get(id)
    if (!ext) {
      this.send({
        kind: 'activated',
        extensionId: id,
        ok: false,
        error: { message: `扩展 ${id} 不在本宿主内` }
      })
      return
    }
    if (ext.activated) {
      this.send({ kind: 'activated', extensionId: id, ok: true })
      return
    }
    if (ext.activation) {
      await ext.activation
      return
    }
    const task = this.doActivate(ext).finally(() => {
      ext.activation = null
    })
    ext.activation = task
    await task
  }

  private async doActivate(ext: RuntimeExtension): Promise<void> {
    try {
      // 先清空，避免激活失败时同宿主里的依赖方读到上一次激活留下的旧对象
      ext.exports = undefined
      await this.loadModule(ext)
      const context = this.createContext(ext)
      ext.context = context
      const activate = ext.module?.activate
      const exported =
        typeof activate === 'function'
          ? await als.run(ext, () => activate.call(ext.module, context))
          : undefined
      ext.activated = true
      ext.exports = exported
      this.send({ kind: 'activated', extensionId: ext.id, ok: true })
    } catch (err) {
      ext.activated = false
      ext.exports = undefined
      this.cleanupExtension(ext, false)
      this.clearModuleCache(ext)
      const dto = errorDto(err)
      this.log(ext.id, 'error', `激活失败：${dto.message}`)
      this.send({ kind: 'activated', extensionId: ext.id, ok: false, error: dto })
      throw err
    }
  }

  private async loadModule(ext: RuntimeExtension): Promise<void> {
    const entry = entryFileOf(ext.manifest)
    if (!entry) return
    const entryPath = join(ext.root, entry)
    if (!existsSync(entryPath)) throw new Error(`入口文件不存在：${entryPath}`)
    const requireFromExtension = Module.createRequire(entryPath)
    const loaded = requireFromExtension(entryPath) as {
      activate?: (context: unknown) => unknown
      deactivate?: () => unknown
    }
    ext.module = loaded ?? {}
  }

  private clearModuleCache(ext: RuntimeExtension): void {
    try {
      const requireFromExtension = Module.createRequire(join(ext.root, 'package.json'))
      for (const key of Object.keys(requireFromExtension.cache)) {
        if (key === ext.realRoot || key.startsWith(ext.realRoot + sep)) {
          delete requireFromExtension.cache[key]
        }
      }
    } catch {
      /* 缓存清理失败不影响重试 */
    }
    ext.module = null
  }

  async deactivate(id: string, removeData: boolean): Promise<void> {
    const ext = this.extensions.get(id)
    if (!ext) return
    try {
      if (ext.activated && typeof ext.module?.deactivate === 'function') {
        await als.run(ext, () => ext.module!.deactivate!())
      }
    } catch (err) {
      this.log(id, 'warn', `deactivate 抛错：${String(err)}`)
    }
    ext.activated = false
    ext.exports = undefined
    this.cleanupExtension(ext, removeData)
    if (removeData) {
      this.clearModuleCache(ext)
    }
    this.send({ kind: 'deactivated', extensionId: id })
  }

  /** 释放扩展注册的一切；可重复调用 */
  private cleanupExtension(ext: RuntimeExtension, removeData: boolean): void {
    const seen = new Set<unknown>()
    for (const item of [...ext.disposables].reverse()) {
      if (seen.has(item)) continue
      seen.add(item)
      try {
        ;(item as { dispose?: () => void }).dispose?.()
      } catch (err) {
        this.log(ext.id, 'warn', `dispose 抛错：${String(err)}`)
      }
    }
    ext.disposables.length = 0
    const contextSubs = (ext.context as { subscriptions?: unknown[] } | null)?.subscriptions
    if (Array.isArray(contextSubs)) {
      for (const item of [...contextSubs].reverse()) {
        if (seen.has(item)) continue
        seen.add(item)
        try {
          ;(item as { dispose?: () => void }).dispose?.()
        } catch {
          /* 与上面相同 */
        }
      }
      contextSubs.length = 0
    }
    for (const handle of ext.timers) {
      rawClearTimeout(handle as ReturnType<typeof setTimeout>)
      rawClearInterval(handle as ReturnType<typeof setInterval>)
      rawClearImmediate(handle as ReturnType<typeof setImmediate>)
    }
    ext.timers.clear()
    for (const item of [...ext.statusItems.values()]) item.dispose()
    ext.statusItems.clear()
    for (const panel of [...ext.panels.values()]) panel.dispose()
    ext.panels.clear()
    for (const emitter of Object.values(ext.events)) emitter.dispose()
    for (const command of ext.commands.keys()) {
      this.send({ kind: 'command.unregistered', extensionId: ext.id, command })
    }
    ext.commands.clear()
    ext.context = null
    // 再次激活时重新创建事件发射器；卸载的扩展不再需要
    if (!removeData) ext.events = this.createEmitters()
    if (removeData) {
      this.extensions.delete(ext.id)
      this.rebuildOwnerRoots()
      for (const key of [...this.editorCache.keys()]) {
        if (key.startsWith(`${ext.id}\0`)) this.editorCache.delete(key)
      }
    }
  }

  private async shutdown(): Promise<void> {
    for (const ext of this.extensions.values()) {
      await this.deactivate(ext.id, false).catch(() => undefined)
    }
    this.transport.onShutdown()
  }

  private executeLocalCommand(requestId: string, command: string, args: unknown[]): void {
    for (const ext of this.extensions.values()) {
      const entry = ext.commands.get(command)
      if (!entry) continue
      Promise.resolve()
        .then(() => als.run(ext, () => entry.callback.apply(entry.thisArg, args)))
        .then(
          value => {
            try {
              const cloned = structuredClone(value)
              this.send({ kind: 'response', requestId, ok: true, value: cloned })
            } catch {
              this.send({
                kind: 'response',
                requestId,
                ok: false,
                error: { message: `命令「${command}」的返回值无法跨进程传递` }
              })
            }
          },
          err => this.send({ kind: 'response', requestId, ok: false, error: errorDto(err) })
        )
      return
    }
    this.send({
      kind: 'response',
      requestId,
      ok: false,
      error: { message: `命令「${command}」没有处理器` }
    })
  }

  // ---------- 文档与编辑器事件 ----------

  documentFor(uri: string): HostDocument {
    const doc = this.documents.get(uri)
    if (!doc) throw new Error(`文档没有同步到宿主：${uri}`)
    return doc
  }

  selectionsOf(uri: string): readonly Selection[] {
    return this.selections.get(uri) ?? [new Selection(0, 0, 0, 0)]
  }

  isVisible(uri: string): boolean {
    return this.visibleUris.includes(uri)
  }

  private onDocumentOpened(state: DocumentStateDto): void {
    let doc = this.documents.get(state.uri)
    if (!doc) {
      doc = new HostDocument(state, this, '')
      this.documents.set(state.uri, doc)
    } else {
      doc.reset(state)
    }
    doc.isClosed = false
    for (const ext of this.extensions.values()) {
      if (ext.activated) ext.events.openDocument.fire(doc)
    }
  }

  private onDocumentChanged(change: DocumentChangeDto): void {
    const doc = this.documents.get(change.uri)
    if (!doc) {
      if (typeof change.text === 'string') {
        this.onDocumentOpened({
          uri: change.uri,
          version: change.version,
          text: change.text,
          eol: change.eol ?? 'lf',
          isDirty: change.isDirty ?? true,
          languageId: 'markdown'
        })
      }
      return
    }
    // 版本不连续且没有全量文本：镜像已经不可信，向 main 要一份整篇文档
    if (typeof change.text !== 'string' && change.version !== doc.version + 1) {
      void this.resyncDocument(doc)
      return
    }
    const { contentChanges } = doc.apply(change)
    for (const ext of this.extensions.values()) {
      if (!ext.activated) continue
      ext.events.changeDocument.fire({ document: doc, contentChanges })
    }
  }

  private async resyncDocument(doc: HostDocument): Promise<void> {
    try {
      const state = await this.request<DocumentStateDto>(r => ({
        kind: 'documents.resync',
        requestId: r,
        extensionId: '',
        uri: doc.uri.toString()
      }))
      const oldLength = doc.getText().length
      const oldLine = doc.lineCount - 1
      const oldChar = doc.lineAt(oldLine).text.length
      doc.reset(state)
      for (const ext of this.extensions.values()) {
        if (!ext.activated) continue
        ext.events.changeDocument.fire({
          document: doc,
          contentChanges: [
            {
              range: new Range(0, 0, oldLine, oldChar),
              rangeOffset: 0,
              rangeLength: oldLength,
              text: state.text
            }
          ]
        })
      }
    } catch (err) {
      this.log('', 'warn', `文档 ${doc.uri.toString()} 重新同步失败：${String(err)}`)
    }
  }

  private onDocumentClosed(uri: string): void {
    const doc = this.documents.get(uri)
    if (!doc) return
    doc.isClosed = true
    this.selections.delete(uri)
    for (const ext of this.extensions.values()) {
      if (ext.activated) ext.events.closeDocument.fire(doc)
    }
  }

  private onDocumentSaved(uri: string, version: number): void {
    const doc = this.documents.get(uri)
    if (!doc) return
    doc.version = version
    doc.isDirty = false
    for (const ext of this.extensions.values()) {
      if (ext.activated) ext.events.saveDocument.fire(doc)
    }
  }

  private onActiveChanged(uri: string | null, visible: string[]): void {
    this.activeUri = uri
    this.visibleUris = visible
    for (const ext of this.extensions.values()) {
      if (!ext.activated) continue
      ext.events.activeEditor.fire(this.activeEditorFor(ext))
      ext.events.visibleEditors.fire(this.visibleEditorsFor(ext))
    }
  }

  private onSelectionChanged(uri: string, selections: EditorSelectionDto[]): void {
    this.selections.set(
      uri,
      selections.map(item => new Selection(item.anchor.line, item.anchor.character, item.active.line, item.active.character))
    )
    const doc = this.documents.get(uri)
    if (!doc) return
    for (const ext of this.extensions.values()) {
      if (!ext.activated) continue
      const editor = this.editorFor(ext, uri)
      ext.events.selectionChanged.fire({
        textEditor: editor,
        selections: this.selectionsOf(uri)
      })
      ext.events.visibleRanges.fire({ textEditor: editor, visibleRanges: editor.visibleRanges })
    }
  }

  private activeEditorFor(ext: RuntimeExtension): TextEditor | undefined {
    if (!this.activeUri || !this.documents.has(this.activeUri)) return undefined
    return this.editorFor(ext, this.activeUri)
  }

  private visibleEditorsFor(ext: RuntimeExtension): readonly TextEditor[] {
    return this.visibleUris.filter(uri => this.documents.has(uri)).map(uri => this.editorFor(ext, uri))
  }

  private editorFor(ext: RuntimeExtension, uri: string): HostTextEditor {
    const key = `${ext.id}\0${uri}`
    let editor = this.editorCache.get(key)
    if (!editor) {
      editor = new HostTextEditor(this, ext, uri)
      this.editorCache.set(key, editor)
    }
    return editor
  }

  setSelections(ext: RuntimeExtension, uri: string, selections: EditorSelectionDto[]): void {
    this.selections.set(
      uri,
      selections.map(item => new Selection(item.anchor.line, item.anchor.character, item.active.line, item.active.character))
    )
    this.send({
      kind: 'editor.setSelections',
      requestId: `sel-${++this.requestSeq}`,
      extensionId: ext.id,
      uri,
      selections
    })
  }

  sendEditorShow(ext: RuntimeExtension, uri: string): void {
    this.send({
      kind: 'editor.showDocument',
      requestId: `show-${++this.requestSeq}`,
      extensionId: ext.id,
      uri,
      options: {}
    })
  }

  // ---------- 配置 ----------

  private applyConfiguration(
    extensionId: string,
    values: Record<string, unknown>,
    globalConfig?: Record<string, unknown>,
    workspaceConfig?: Record<string, unknown>
  ): void {
    const ext = this.extensions.get(extensionId)
    if (!ext) return
    if (globalConfig) ext.globalConfig = { ...globalConfig }
    if (workspaceConfig) ext.workspaceConfig = { ...workspaceConfig }
    const changed = new Set<string>()
    for (const [key, value] of Object.entries(values)) {
      if (ext.config[key] !== value) changed.add(key)
      ext.config[key] = value
    }
    if (changed.size === 0) return
    ext.events.configChanged.fire({
      affectsConfiguration: (section: string) => {
        for (const key of changed) {
          if (key === section || key.startsWith(`${section}.`)) return true
        }
        return false
      }
    })
  }

  private findProperty(key: string): { default: unknown } | null {
    for (const ext of this.extensions.values()) {
      const config = ext.manifest.contributes?.configuration
      if (!config) continue
      const sections = Array.isArray(config) ? config : [config]
      for (const section of sections) {
        const property = section.properties?.[key]
        if (property) return { default: property.default }
      }
    }
    return null
  }

  private configFor(ext: RuntimeExtension, section?: string): WorkspaceConfiguration {
    // VS Code 语义：getConfiguration('a.b').get('c') 读的是 a.b.c
    const fullKey = (key: string): string => (section ? `${section}.${key}` : key)
    return {
      get: <T>(key: string, defaultValue?: T): T => {
        const full = fullKey(key)
        if (Object.prototype.hasOwnProperty.call(ext.config, full)) {
          return ext.config[full] as T
        }
        const property = this.findProperty(full)
        if (property && property.default !== undefined) return property.default as T
        return defaultValue as T
      },
      has: (key: string): boolean => {
        const full = fullKey(key)
        return (
          Object.prototype.hasOwnProperty.call(ext.config, full) || this.findProperty(full) !== null
        )
      },
      inspect: <T>(key: string): {
        key: string
        defaultValue?: T
        globalValue?: T
        workspaceValue?: T
      } | undefined => {
        const full = fullKey(key)
        const property = this.findProperty(full)
        const hasEffective = Object.prototype.hasOwnProperty.call(ext.config, full)
        const hasGlobal = Object.prototype.hasOwnProperty.call(ext.globalConfig, full)
        const hasWorkspace = Object.prototype.hasOwnProperty.call(ext.workspaceConfig, full)
        if (!property && !hasEffective && !hasGlobal && !hasWorkspace) return undefined
        return {
          key: full,
          defaultValue: property?.default as T | undefined,
          ...(hasGlobal ? { globalValue: ext.globalConfig[full] as T } : {}),
          ...(hasWorkspace ? { workspaceValue: ext.workspaceConfig[full] as T } : {})
        }
      },
      update: async (key: string, value: unknown, target?: ConfigurationTarget): Promise<void> => {
        const full = fullKey(key)
        await this.request<void>(
          r => ({
            kind: 'configuration.update',
            requestId: r,
            extensionId: ext.id,
            key: full,
            value,
            ...(target !== undefined ? { target } : {})
          }),
          15000
        )
        // 不在本地乐观写入 `ext.config`:main 在响应前已经推了一份**合并后**的
        // 配置(全局值可能被当前仓库的覆盖值压住),这里再写会把覆盖值盖掉。
      }
    }
  }

  // ---------- API 构造 ----------

  private createContext(ext: RuntimeExtension): Record<string, unknown> {
    const extensionObject = {
      id: ext.id,
      extensionPath: ext.root,
      extensionUri: Uri.file(ext.root),
      get isActive(): boolean {
        return ext.activated
      },
      packageJSON: ext.manifest,
      get exports(): unknown {
        return ext.exports
      },
      activate: () => this.activateRemote(ext),
      deactivate: () => this.deactivate(ext.id, false)
    }
    const globalStoragePath = ext.init.globalStoragePath
    const logPath = ext.init.logPath
    return {
      subscriptions: [],
      extensionPath: ext.root,
      extensionUri: Uri.file(ext.root),
      extensionMode: ExtensionMode.Production,
      extension: extensionObject,
      globalState: this.memento(ext, 'global'),
      workspaceState: this.memento(ext, 'workspace'),
      secrets: {
        get: async (key: string): Promise<string | undefined> => {
          const value = await this.request<string | null>(
            r => ({ kind: 'secret.get', requestId: r, extensionId: ext.id, key }),
            15000
          )
          return value ?? undefined
        },
        store: async (key: string, value: string): Promise<void> => {
          await this.request<void>(
            r => ({ kind: 'secret.store', requestId: r, extensionId: ext.id, key, value }),
            15000
          )
          ext.events.secretsChanged.fire({ key })
        },
        delete: async (key: string): Promise<void> => {
          await this.request<void>(
            r => ({ kind: 'secret.delete', requestId: r, extensionId: ext.id, key }),
            15000
          )
          ext.events.secretsChanged.fire({ key })
        },
        onDidChange: (listener: (e: { key: string }) => unknown) =>
          ext.events.secretsChanged.event(listener)
      },
      globalStorageUri: Uri.file(globalStoragePath),
      storageUri: Uri.file(globalStoragePath),
      logUri: Uri.file(logPath),
      globalStoragePath,
      logPath,
      asAbsolutePath: (relativePath: string) => join(ext.root, relativePath)
    }
  }

  private memento(ext: RuntimeExtension, scope: 'global' | 'workspace'): {
    keys(): readonly string[]
    get<T>(key: string, defaultValue?: T): T | undefined
    update(key: string, value: unknown): Promise<void>
  } {
    const bucket = (): Record<string, unknown> =>
      scope === 'global' ? ext.globalState : ext.workspaceState
    return {
      keys: () => Object.keys(bucket()),
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const values = bucket()
        return Object.prototype.hasOwnProperty.call(values, key)
          ? (values[key] as T)
          : defaultValue
      },
      update: async (key: string, value: unknown): Promise<void> => {
        const values = bucket()
        if (value === undefined) delete values[key]
        else values[key] = value
        // 状态写回是通知性质：main 自己做防抖落盘，不需要等响应
        this.send({ kind: 'state.set', extensionId: ext.id, scope, key, value })
      }
    }
  }

  private activateRemote(ext: RuntimeExtension): Promise<void> {
    return this.request<void>(r => ({
      kind: 'extension.activate',
      requestId: r,
      extensionId: ext.id,
      targetExtensionId: ext.id
    }))
  }

  private createApi(ext: RuntimeExtension): Record<string, unknown> {
    const runtime = this
    const run = <T>(fn: () => T): T => als.run(ext, fn)

    const subscribe = <T>(
      emitter: EventEmitter<T>,
      listener: (event: T) => unknown,
      thisArgs?: unknown,
      disposables?: Disposable[]
    ): Disposable => {
      const disposable = emitter.event(event => run(() => listener.call(thisArgs, event)))
      if (disposables) disposables.push(disposable)
      this.track(ext, disposable)
      return disposable
    }

    const commands = {
      registerCommand: (
        command: string,
        callback: (...args: unknown[]) => unknown,
        thisArg?: unknown
      ): Disposable => {
        const existing = ext.commands.get(command)
        if (existing) {
          this.log(ext.id, 'warn', `命令「${command}」重复注册，保留先注册的处理器`)
          return toDisposable(() => undefined)
        }
        ext.commands.set(command, { callback, thisArg })
        this.send({ kind: 'command.registered', extensionId: ext.id, command })
        const disposable = toDisposable(() => {
          if (!ext.commands.has(command)) return
          ext.commands.delete(command)
          this.send({ kind: 'command.unregistered', extensionId: ext.id, command })
        })
        this.track(ext, disposable)
        return disposable
      },
      executeCommand: <T>(command: string, ...args: unknown[]): Promise<T> =>
        this.request<T>(r => ({
          kind: 'command.execute',
          requestId: r,
          extensionId: ext.id,
          command,
          args
        })),
      getCommands: (): Promise<string[]> =>
        this.request<string[]>(r => ({ kind: 'commands.list', requestId: r, extensionId: ext.id }))
    }

    const windowApi = {
      get activeTextEditor(): TextEditor | undefined {
        return runtime.activeEditorFor(ext)
      },
      get visibleTextEditors(): readonly TextEditor[] {
        return runtime.visibleEditorsFor(ext)
      },
      get activeColorTheme(): ColorTheme {
        return { kind: runtime.colorThemeKind() }
      },
      onDidChangeActiveColorTheme: (listener: (e: ColorTheme) => unknown) =>
        subscribe(ext.events.themeChanged, listener),
      onDidChangeActiveTextEditor: (listener: (e: TextEditor | undefined) => unknown) =>
        subscribe(ext.events.activeEditor, listener),
      onDidChangeVisibleTextEditors: (listener: (e: readonly TextEditor[]) => unknown) =>
        subscribe(ext.events.visibleEditors, listener),
      onDidChangeTextEditorSelection: (listener: (e: TextEditorSelectionChangeEvent) => unknown) =>
        subscribe(ext.events.selectionChanged, listener),
      onDidChangeTextEditorVisibleRanges: (listener: (e: unknown) => unknown) =>
        subscribe(ext.events.visibleRanges as EventEmitter<unknown>, listener),
      showInformationMessage: (message: string, ...rest: unknown[]) =>
        runtime.showMessage(ext, 'info', message, rest),
      showWarningMessage: (message: string, ...rest: unknown[]) =>
        runtime.showMessage(ext, 'warning', message, rest),
      showErrorMessage: (message: string, ...rest: unknown[]) =>
        runtime.showMessage(ext, 'error', message, rest),
      showInputBox: (options?: InputBoxOptions) => runtime.showInputBox(ext, options),
      showQuickPick: (items: readonly unknown[] | Thenable<readonly unknown[]>, options?: QuickPickOptions) =>
        runtime.showQuickPick(ext, items, options),
      createStatusBarItem: (alignment?: StatusBarAlignment, priority?: number) =>
        runtime.createStatusBarItem(ext, alignment, priority),
      createOutputChannel: (name: string) => runtime.createOutputChannel(ext, name),
      createTextEditorDecorationType: (options: DecorationRenderOptions) =>
        runtime.createDecorationType(ext, options),
      createWebviewPanel: (
        viewType: string,
        title: string,
        _showOptions: unknown,
        options?: WebviewOptions
      ) => runtime.createWebviewPanel(ext, viewType, title, options),
      registerWebviewPanelSerializer: (viewType: string, serializer: WebviewPanelSerializer) =>
        runtime.registerWebviewSerializer(ext, viewType, serializer),
      showTextDocument: (document: TextDocument, _column?: ViewColumn, _preserveFocus?: boolean) =>
        runtime.showTextDocument(ext, document)
    }

    const workspaceApi = {
      get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
        return runtime.workspaceFolders()
      },
      get name(): string | undefined {
        return runtime.workspaceFolders()?.[0]?.name
      },
      getConfiguration: (section?: string) => runtime.configFor(ext, section),
      onDidChangeConfiguration: (listener: (e: { affectsConfiguration(section: string): boolean }) => unknown) =>
        subscribe(ext.events.configChanged, listener),
      onDidChangeWorkspaceFolders: (listener: (e: { added: readonly WorkspaceFolder[]; removed: readonly WorkspaceFolder[] }) => unknown) =>
        subscribe(ext.events.workspaceFolders, listener),
      onDidOpenTextDocument: (listener: (e: TextDocument) => unknown) =>
        subscribe(ext.events.openDocument, listener),
      onDidCloseTextDocument: (listener: (e: TextDocument) => unknown) =>
        subscribe(ext.events.closeDocument, listener),
      onDidSaveTextDocument: (listener: (e: TextDocument) => unknown) =>
        subscribe(ext.events.saveDocument, listener),
      onDidChangeTextDocument: (listener: (e: TextDocumentChangeEvent) => unknown) =>
        subscribe(ext.events.changeDocument, listener),
      openTextDocument: (target?: Uri | string | { language?: string; content?: string }) =>
        runtime.openTextDocument(ext, target),
      saveAll: (includeUntitled?: boolean) =>
        runtime.request<boolean>(r => ({
          kind: 'workspace.saveAll',
          requestId: r,
          extensionId: ext.id,
          includeUntitled: includeUntitled ?? false
        })),
      fs: runtime.fileSystem(ext)
    }

    const extensionsApi = {
      getExtension: (id: string) => runtime.extensionFacade(id),
      get all() {
        return runtime.allExtensionFacades()
      }
    }

    const imarkApi = {
      reportStatus: (update: {
        status: string
        message?: string
        detail?: string
        targetResults?: Record<string, 'ok' | 'error'>
        lastRunAt?: number
      }): void => {
        this.send({
          kind: 'status',
          extensionId: ext.id,
          status: update.status,
          message: update.message ?? '',
          detail: update.detail,
          targetResults: update.targetResults,
          lastRunAt: update.lastRunAt
        })
      },
      renderMarkdown: (markdown: string): Promise<string> =>
        this.request<string>(r => ({
          kind: 'markdown.render',
          requestId: r,
          extensionId: ext.id,
          text: markdown
        })),
      flushActiveDocument: (): Promise<boolean> =>
        this.request<boolean>(r => ({
          kind: 'document.flush',
          requestId: r,
          extensionId: ext.id,
          uri: runtime.activeUri ?? ''
        })),
      onDidChangeTheme: (listener: (e: ColorTheme) => unknown) =>
        subscribe(ext.events.themeChanged, listener)
    }

    const env = {
      appName: 'iMark',
      appVersion: this.initPayload?.appVersion ?? '0.0.0',
      language: this.initPayload?.environment.language ?? 'zh-CN',
      uriScheme: this.initPayload?.environment.uriScheme ?? 'imark',
      machineId: this.initPayload?.environment.machineId ?? '',
      sessionId: this.initPayload?.environment.sessionId ?? ''
    }

    return {
      version: env.appVersion,
      commands,
      window: windowApi,
      workspace: workspaceApi,
      extensions: extensionsApi,
      imark: imarkApi,
      env,
      Uri,
      Position,
      Range,
      Selection,
      EventEmitter,
      Disposable,
      CancellationToken,
      CancellationTokenSource,
      ThemeColor: class {
        constructor(readonly id: string) {}
      },
      StatusBarAlignment,
      ViewColumn,
      TextEditorRevealType,
      ColorThemeKind,
      ExtensionMode,
      EndOfLine,
      ConfigurationTarget,
      FileType
    }
  }

  private track(ext: RuntimeExtension, disposable: unknown): void {
    ext.disposables.push(disposable)
  }

  // ---------- window / workspace 辅助 ----------

  workspaceFolders(): WorkspaceFolder[] | undefined {
    if (this.workspaces.length === 0) return undefined
    return [...this.workspaces]
  }

  private async showMessage(
    ext: RuntimeExtension,
    level: 'info' | 'warning' | 'error',
    message: string,
    rest: unknown[]
  ): Promise<string | undefined> {
    let options: MessageOptions = {}
    let items = rest
    if (rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      options = rest[0] as MessageOptions
      items = rest.slice(1)
    }
    const strings = items.filter((item): item is string => typeof item === 'string')
    const value = await this.request<string | null>(r => ({
      kind: 'message.show',
      requestId: r,
      extensionId: ext.id,
      level,
      message,
      detail: options.detail,
      items: strings,
      modal: options.modal ?? false
    }))
    return value ?? undefined
  }

  private async showInputBox(ext: RuntimeExtension, options?: InputBoxOptions): Promise<string | undefined> {
    const value = await this.request<string | null>(r => ({
      kind: 'inputBox.show',
      requestId: r,
      extensionId: ext.id,
      options: {
        title: options?.title,
        prompt: options?.prompt,
        placeHolder: options?.placeHolder,
        value: options?.value,
        password: options?.password,
        ignoreFocusOut: options?.ignoreFocusOut,
        validateInput: typeof options?.validateInput === 'function'
      }
    }))
    return value ?? undefined
  }

  private async showQuickPick(
    ext: RuntimeExtension,
    items: readonly unknown[] | Thenable<readonly unknown[]>,
    options?: QuickPickOptions
  ): Promise<QuickPickItem | string | undefined> {
    const list = (await Promise.resolve(items)) as readonly (string | QuickPickItem)[]
    const mapped = list.map(item =>
      typeof item === 'string'
        ? { label: item }
        : {
            label: String(item.label ?? ''),
            description: item.description,
            detail: item.detail,
            picked: item.picked
          }
    )
    const value = await this.request<string | string[] | null>(r => ({
      kind: 'quickPick.show',
      requestId: r,
      extensionId: ext.id,
      items: mapped,
      options: {
        title: options?.title,
        placeHolder: options?.placeHolder,
        canPickMany: false,
        ignoreFocusOut: false,
        matchOnDescription: options?.matchOnDescription,
        matchOnDetail: options?.matchOnDetail
      }
    }))
    if (value === null || value === undefined) return undefined
    const label = Array.isArray(value) ? value[0] : value
    return list.find(item => (typeof item === 'string' ? item === label : item.label === label))
  }

  createStatusBarItem(
    ext: RuntimeExtension,
    alignment?: StatusBarAlignment,
    priority?: number
  ): Record<string, unknown> {
    const id = `sb${++ext.statusSeq}`
    const item = new HostStatusBarItem(
      this,
      ext,
      id,
      alignment ?? StatusBarAlignment.Left,
      priority ?? 0
    )
    ext.statusItems.set(id, item)
    item.push('create')
    return statusBarItemProxy(item)
  }

  createOutputChannel(ext: RuntimeExtension, name: string): Record<string, unknown> {
    let disposed = false
    const append = (
      text: string,
      level: 'debug' | 'info' | 'warn' | 'error' = 'info'
    ): void => {
      if (disposed || !text) return
      this.send({ kind: 'output.append', extensionId: ext.id, channel: name, text, level })
    }
    const channel = {
      name,
      append,
      appendLine: (value: string) => append(`${value}\n`),
      replace: (value: string) => append(value),
      clear: () => append(''),
      show: () => undefined,
      hide: () => undefined,
      info: (message: string) => append(`${message}\n`, 'info'),
      warn: (message: string) => append(`[warn] ${message}\n`, 'warn'),
      error: (message: string | Error) =>
        append(
          `[error] ${message instanceof Error ? message.stack ?? message.message : message}\n`,
          'error'
        ),
      debug: (message: string) => append(`[debug] ${message}\n`, 'debug'),
      trace: (message: string) => append(`[trace] ${message}\n`, 'debug'),
      dispose: () => {
        disposed = true
      }
    }
    this.track(ext, channel)
    return channel
  }

  /**
   * 只把白名单里的 CSS 值交给 main。值本身还会在 renderer 再校验一次；两边都做，
   * 是因为宿主进程里跑的是不受信任的扩展代码，不能指望它只传合法值。
   */
  decorationOptionsOf(type: TextEditorDecorationType): DecorationRenderOptionsDto {
    const raw = (type as unknown as { options?: DecorationRenderOptions }).options ?? {}
    const out: DecorationRenderOptionsDto = {}
    const strings = [
      'backgroundColor',
      'borderColor',
      'borderWidth',
      'color',
      'textDecoration'
    ] as const
    for (const key of strings) {
      if (typeof raw[key] === 'string') out[key] = raw[key]
    }
    if (raw.borderStyle === 'solid' || raw.borderStyle === 'dashed' || raw.borderStyle === 'dotted') {
      out.borderStyle = raw.borderStyle
    }
    if (typeof raw.isWholeLine === 'boolean') out.isWholeLine = raw.isWholeLine
    return out
  }

  createDecorationType(ext: RuntimeExtension, options: DecorationRenderOptions): TextEditorDecorationType {
    const key = `${ext.id}:dec${++ext.decorationSeq}`
    const type: TextEditorDecorationType & { options: Record<string, unknown> } = {
      key,
      options: options as Record<string, unknown>,
      dispose: () => {
        if (!ext.decorations.has(key)) return
        ext.decorations.delete(key)
        for (const uri of this.documents.keys()) {
          this.send({
            kind: 'editor.setDecorations',
            extensionId: ext.id,
            uri,
            typeId: key,
            options: this.decorationOptionsOf(type),
            ranges: []
          })
        }
      }
    }
    ext.decorations.set(key, type)
    this.track(ext, type)
    return type
  }

  private createWebviewPanel(
    ext: RuntimeExtension,
    viewType: string,
    title: string,
    options?: WebviewOptions
  ): HostWebviewPanel {
    const panel = new HostWebviewPanel(this, ext, viewType, title, options)
    const token = randomToken()
    panel.token = token
    ext.panels.set(token, panel)
    void this.request<WebviewPanelCreateResult>(r => ({
      kind: 'webview.create',
      requestId: r,
      extensionId: ext.id,
      options: {
        viewType,
        title,
        html: panel.webview.htmlValue,
        presentation: (options?.imark?.presentation ?? 'sidebar') as WebviewPresentationDto,
        width: options?.imark?.width,
        height: options?.imark?.height,
        transparent: options?.imark?.transparent,
        anchor: options?.imark?.anchor,
        retainContextWhenHidden: options?.retainContextWhenHidden,
        enableScripts: options?.enableScripts,
        localResourceRoots: (options?.localResourceRoots ?? []).map(uri => uri.fsPath),
        token
      }
    }))
      .then(result => panel.attach(result))
      .catch(err => {
        this.log(ext.id, 'error', `创建 webview 失败：${String(err)}`)
        panel.fireDisposed()
        ext.panels.delete(token)
      })
    this.track(ext, panel)
    return panel
  }

  private registerWebviewSerializer(
    ext: RuntimeExtension,
    viewType: string,
    serializer: WebviewPanelSerializer
  ): Disposable {
    ext.serializers.set(viewType, serializer)
    this.send({ kind: 'webview.serializer.registered', extensionId: ext.id, viewType })
    const disposable = toDisposable(() => {
      ext.serializers.delete(viewType)
      this.send({ kind: 'webview.serializer.unregistered', extensionId: ext.id, viewType })
    })
    this.track(ext, disposable)
    return disposable
  }

  private onWebviewRestore(
    panelId: string,
    viewType: string,
    state: unknown,
    panelState: WebviewPanelStateDto,
    token: string
  ): void {
    for (const ext of this.extensions.values()) {
      const serializer = ext.serializers.get(viewType)
      if (!serializer) continue
      const panel = new HostWebviewPanel(this, ext, viewType, panelState.title, {
        imark: {
          presentation: panelState.presentation,
          width: panelState.width,
          height: panelState.height,
          transparent: panelState.transparent,
          anchor: panelState.anchor
        }
      })
      panel.panelId = panelId
      panel.token = token
      ext.panels.set(panelId, panel)
      Promise.resolve(serializer.deserializeWebviewPanel(panel, state)).catch(err => {
        this.log(ext.id, 'error', `恢复 webview 失败：${String(err)}`)
      })
      return
    }
  }

  private panelById(panelId: string): HostWebviewPanel | null {
    for (const ext of this.extensions.values()) {
      const panel = ext.panels.get(panelId)
      if (panel) return panel
    }
    return null
  }

  private findExtensionOfPanel(panel: HostWebviewPanel): RuntimeExtension | null {
    for (const ext of this.extensions.values()) {
      if ([...ext.panels.values()].includes(panel)) return ext
    }
    return null
  }

  private async showTextDocument(ext: RuntimeExtension, document: TextDocument): Promise<TextEditor> {
    const uri = document.uri.toString()
    await this.request<unknown>(r => ({
      kind: 'editor.showDocument',
      requestId: r,
      extensionId: ext.id,
      uri,
      options: {}
    }))
    return this.editorFor(ext, uri)
  }

  private async openTextDocument(
    ext: RuntimeExtension,
    target?: Uri | string | { language?: string; content?: string }
  ): Promise<TextDocument> {
    if (target && typeof target === 'object' && 'content' in target) {
      const uri = `untitled:Untitled-${this.documents.size + 1}`
      const state: DocumentStateDto = {
        uri,
        version: 1,
        text: target.content ?? '',
        eol: 'lf',
        isDirty: true,
        languageId: target.language ?? 'markdown'
      }
      const doc = new HostDocument(state, this, ext.id)
      this.documents.set(uri, doc)
      return doc
    }
    const uri = typeof target === 'string' ? Uri.parse(target) : (target ?? Uri.parse('untitled:Untitled'))
    const key = uri.toString()
    const existing = this.documents.get(key)
    if (existing) return existing
    const state = await this.request<DocumentStateDto>(r => ({
      kind: 'documents.open',
      requestId: r,
      extensionId: ext.id,
      uri: key
    }))
    const doc = new HostDocument(state, this, ext.id)
    this.documents.set(key, doc)
    return doc
  }

  private fileSystem(ext: RuntimeExtension): Record<string, unknown> {
    void ext
    const pathOf = (uri: Uri): string => {
      if (uri.scheme !== 'file') throw new Error(`只支持 file: URI，收到 ${uri.toString()}`)
      return uri.fsPath
    }
    return {
      readFile: async (uri: Uri): Promise<Uint8Array> => new Uint8Array(await readFile(pathOf(uri))),
      writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
        await mkdir(dirname(pathOf(uri)), { recursive: true })
        await writeFile(pathOf(uri), content)
      },
      stat: async (uri: Uri): Promise<FileStat> => {
        const info = await stat(pathOf(uri))
        const type = info.isDirectory()
          ? FileType.Directory
          : info.isSymbolicLink()
            ? FileType.SymbolicLink
            : FileType.File
        return { type, ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size }
      },
      readDirectory: async (uri: Uri): Promise<[string, FileType][]> => {
        const entries = await readdir(pathOf(uri), { withFileTypes: true })
        return entries.map(entry => [
          entry.name,
          entry.isDirectory()
            ? FileType.Directory
            : entry.isSymbolicLink()
              ? FileType.SymbolicLink
              : FileType.File
        ])
      },
      createDirectory: async (uri: Uri): Promise<void> => {
        await mkdir(pathOf(uri), { recursive: true })
      },
      delete: async (uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> => {
        await rm(pathOf(uri), { recursive: options?.recursive ?? false, force: true })
      },
      rename: async (source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> => {
        if (!options?.overwrite) {
          const exists = await stat(pathOf(target)).then(
            () => true,
            () => false
          )
          if (exists) throw new Error('目标已存在')
        }
        await rename(pathOf(source), pathOf(target))
      }
    }
  }

  /** 扩展元数据门面；`exports` 只在本宿主内可读，跨宿主不传对象 */
  private extensionFacade(id: string): Record<string, unknown> | undefined {
    const target = this.extensions.get(id)
    if (!target) return undefined
    return {
      id,
      extensionPath: target.root,
      extensionUri: Uri.file(target.root),
      get isActive(): boolean {
        return target.activated
      },
      packageJSON: target.manifest,
      get exports(): unknown {
        return target.exports
      },
      activate: () => this.activateRemote(target),
      deactivate: () => this.deactivate(id, false)
    }
  }

  private allExtensionFacades(): Record<string, unknown>[] {
    return [...this.extensions.keys()]
      .map(id => this.extensionFacade(id))
      .filter((item): item is Record<string, unknown> => Boolean(item))
  }
}

function randomToken(): string {
  // 宿主侧生成，保证 createWebviewPanel 返回后立刻能拼 asWebviewUri。
  // 128 bit CSPRNG，猜中概率可以忽略；主进程会校验面板归属。
  return randomBytes(16).toString('hex')
}
