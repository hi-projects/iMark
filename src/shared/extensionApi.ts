/**
 * 扩展作者看到的 `imark` 模块。
 *
 * 这是**类型与少量纯工具类**的唯一定义处:扩展工程的 tsconfig 把 `imark` 指到这里,
 * 宿主进程在运行时通过 `require('imark')` 注入按扩展归属构造的命名空间对象。
 * 两边共享同一份形状,扩展作者写出的 `import * as imark from 'imark'` 在
 * isolated / shared 两种宿主拓扑下逐字相同。
 *
 * 这里刻意不 import 任何 Node / Electron / DOM 模块:它同时被扩展工程、宿主进程
 * 与渲染层类型检查引用,一旦引入 Node 就会把渲染层拖下水。文件系统能力只以
 * `workspace.fs` 的接口出现,真实实现在宿主进程里。
 *
 * 与 VS Code 的差异(完整清单见 README):
 *   - 模块名是 `imark`,不是 `vscode`;
 *   - 不提供 TreeView / 终端 / 任务 / 调试 / LSP / notebook / 多根工作区;
 *   - `imark` 命名空间是本应用私有的几个入口(Markdown 渲染、状态上报等)。
 */

export type Thenable<T> = Promise<T>

export interface Disposable {
  dispose(): void
}

/** 把一个清理函数变成 Disposable —— 宿主内部与扩展作者都用得上 */
export function toDisposable(fn: () => void): Disposable {
  let done = false
  return {
    dispose(): void {
      if (done) return
      done = true
      fn()
    }
  }
}

interface DisposableConstructor {
  new (callOnDispose: () => unknown): Disposable
  from(...disposables: (Disposable | undefined | null)[]): Disposable
}

/**
 * 用「接口 + 构造器常量」而不是 `class` 导出。
 *
 * 原因：扩展工具函数（例如 `toDisposable`）返回的是普通对象，不应该被迫携带
 * 类的私有字段。TS 里带私有字段的 class 是名义类型，一个 `{ dispose() {} }`
 * 字面量就赋不过去；而扩展作者与宿主都需要这种结构化的小对象。运行时仍然是
 * 一个真正的类，`new imark.Disposable(fn)` 与 `Disposable.from(...)` 都成立。
 */
export const Disposable: DisposableConstructor = class implements Disposable {
  private disposed = false
  private readonly callOnDispose: () => unknown

  constructor(callOnDispose: () => unknown) {
    this.callOnDispose = callOnDispose
  }

  static from(...disposables: (Disposable | undefined | null)[]): Disposable {
    return new Disposable(() => {
      for (const item of disposables) item?.dispose()
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.callOnDispose()
  }
}

export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[]
) => Disposable

/**
 * 极简事件发射器。
 *
 * 监听器抛错时**继续通知其余监听器**并打印错误:一个扩展的处理器出错不该让
 * 同一事件链上的其他扩展收不到事件。宿主在整个扩展外面还有一层错误隔离。
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>()
  private disposed = false

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    if (this.disposed) return toDisposable(() => undefined)
    const bound = thisArgs ? listener.bind(thisArgs) : listener
    this.listeners.add(bound)
    const disposable = toDisposable(() => {
      this.listeners.delete(bound)
    })
    disposables?.push(disposable)
    return disposable
  }

  fire(data: T): void {
    if (this.disposed) return
    for (const listener of [...this.listeners]) {
      try {
        listener(data)
      } catch (err) {
        console.error('[imark] 事件监听器抛错:', err)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

// ---------- Uri / Position / Range / Selection ----------

const URI_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** 路径里的 `#` / `?` 必须转义,否则 toString() 会被下一次 parse 拆错 */
function encodePath(path: string): string {
  return encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/**
 * 查询串按 `&`/`=` 的结构逐段编码。
 *
 * 不能整段 `encodeURIComponent`:那会把 `token=abc` 变成 `token%3Dabc`,
 * 服务端按 `searchParams.get('token')` 读时就成了一个名为 `token=abc` 的键。
 */
function encodeQuery(query: string): string {
  return query
    .split('&')
    .map(part => {
      const eq = part.indexOf('=')
      if (eq < 0) return encodeURIComponent(part)
      return `${encodeURIComponent(part.slice(0, eq))}=${encodeURIComponent(part.slice(eq + 1))}`
    })
    .join('&')
}

export interface UriComponents {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
}

export class Uri {
  readonly scheme: string
  readonly authority: string
  readonly path: string
  readonly query: string
  readonly fragment: string

  constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme.toLowerCase()
    this.authority = authority
    this.path = path
    this.query = query
    this.fragment = fragment
  }

  static parse(value: string, _strict = false): Uri {
    const match = URI_RE.exec(value)
    if (!match) return new Uri('file', '', value, '', '')
    const [, scheme = 'file', authority = '', rawPath = '', query = '', fragment = ''] = match
    return new Uri(scheme, safeDecode(authority), safeDecode(rawPath), safeDecode(query), safeDecode(fragment))
  }

  static file(fsPath: string): Uri {
    let path = fsPath.replace(/\\/g, '/')
    let authority = ''
    if (path.startsWith('//')) {
      const rest = path.slice(2)
      const slash = rest.indexOf('/')
      authority = slash >= 0 ? rest.slice(0, slash) : rest
      path = slash >= 0 ? rest.slice(slash) : '/'
    } else if (!path.startsWith('/')) {
      // Windows 盘符:C:/foo -> /C:/foo;相对路径也补成绝对形状,避免 scheme 后面只有两个斜杠
      path = /^[a-zA-Z]:\//.test(path) ? `/${path}` : `/${path}`
    }
    return new Uri('file', authority, path, '', '')
  }

  static from(components: UriComponents): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? ''
    )
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    let path = base.path.replace(/\/+$/, '')
    for (const segment of pathSegments) {
      path += `/${segment.replace(/^\/+/, '')}`
    }
    return base.with({ path })
  }

  get fsPath(): string {
    let path = safeDecode(this.path)
    if (this.authority) path = `//${this.authority}${path}`
    // Windows 风格的 /C:/dir:fsPath 去掉前导斜杠并换回反斜杠。Linux 上真实的
    // `/C:/dir` 极罕见,这个判断与 VS Code 的 vscode-uri 一致。
    if (/^\/[a-zA-Z]:\//.test(path)) return path.slice(1).replace(/\//g, '\\')
    return path
  }

  with(change: Partial<UriComponents>): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    )
  }

  toString(skipEncoding = false): string {
    const path = skipEncoding ? this.path : encodePath(this.path)
    let out = `${this.scheme}:`
    if (this.authority || this.scheme === 'file') out += `//${this.authority}`
    out += path
    if (this.query) out += `?${skipEncoding ? this.query : encodeQuery(this.query)}`
    if (this.fragment) out += `#${skipEncoding ? this.fragment : encodeURIComponent(this.fragment)}`
    return out
  }

  toJSON(): UriComponents {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment
    }
  }
}

export class Position {
  readonly line: number
  readonly character: number

  constructor(line: number, character: number) {
    this.line = Math.max(0, Math.trunc(line))
    this.character = Math.max(0, Math.trunc(character))
  }

  static create(line: number, character: number): Position {
    return new Position(line, character)
  }

  static compare(a: Position, b: Position): number {
    if (a.line !== b.line) return a.line - b.line
    return a.character - b.character
  }

  isBefore(other: Position): boolean {
    return Position.compare(this, other) < 0
  }

  isBeforeOrEqual(other: Position): boolean {
    return Position.compare(this, other) <= 0
  }

  isAfter(other: Position): boolean {
    return Position.compare(this, other) > 0
  }

  isAfterOrEqual(other: Position): boolean {
    return Position.compare(this, other) >= 0
  }

  isEqual(other: Position): boolean {
    return Position.compare(this, other) === 0
  }

  compareTo(other: Position): number {
    return Position.compare(this, other)
  }

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta)
  }

  with(line = this.line, character = this.character): Position {
    return new Position(line, character)
  }
}

export class Range {
  readonly start: Position
  readonly end: Position

  constructor(start: Position, end: Position)
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number)
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, Number(b) || 0)
      this.end = new Position(Number(c) || 0, Number(d) || 0)
    } else {
      const end = b as Position
      this.start = Position.compare(a, end) <= 0 ? a : end
      this.end = Position.compare(a, end) <= 0 ? end : a
    }
  }

  static fromPositions(start: Position, end = start): Range {
    return new Range(start, end)
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end)
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end)
    }
    return positionOrRange.isAfterOrEqual(this.start) && positionOrRange.isBeforeOrEqual(this.end)
  }

  intersection(other: Range): Range | undefined {
    const start = Position.compare(this.start, other.start) > 0 ? this.start : other.start
    const end = Position.compare(this.end, other.end) < 0 ? this.end : other.end
    return Position.compare(start, end) <= 0 ? new Range(start, end) : undefined
  }

  union(other: Range): Range {
    const start = Position.compare(this.start, other.start) < 0 ? this.start : other.start
    const end = Position.compare(this.end, other.end) > 0 ? this.end : other.end
    return new Range(start, end)
  }

  with(start = this.start, end = this.end): Range {
    return new Range(start, end)
  }
}

export class Selection extends Range {
  readonly anchor: Position
  readonly active: Position

  constructor(anchor: Position, active: Position)
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number)
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      const anchor = new Position(a, Number(b) || 0)
      const active = new Position(Number(c) || 0, Number(d) || 0)
      super(anchor, active)
      this.anchor = anchor
      this.active = active
    } else {
      const anchor = a
      const active = b as Position
      super(anchor, active)
      this.anchor = anchor
      this.active = active
    }
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active)
  }
}

// ---------- 取消 ----------

export interface CancellationToken {
  readonly isCancellationRequested: boolean
  readonly onCancellationRequested: Event<void>
}

export const CancellationToken: { None: CancellationToken } = {
  None: Object.freeze({
    isCancellationRequested: false,
    onCancellationRequested: () => toDisposable(() => undefined)
  })
}

export class CancellationTokenSource {
  private cancelled = false
  private readonly emitter = new EventEmitter<void>()
  readonly token: CancellationToken

  constructor() {
    const source = this
    this.token = {
      get isCancellationRequested(): boolean {
        return source.cancelled
      },
      onCancellationRequested: this.emitter.event
    }
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.emitter.fire(undefined)
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

// ---------- 枚举 ----------

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3
}

export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

/** 状态栏颜色只能引用宿主主题里的令牌,不能传任意 CSS */
export class ThemeColor {
  constructor(readonly id: string) {}
}

// ---------- 文档与编辑器 ----------

export interface TextLine {
  readonly lineNumber: number
  readonly text: string
  readonly range: Range
  readonly rangeIncludingLineBreak: Range
  readonly firstNonWhitespaceCharacterIndex: number
  readonly isEmptyOrWhitespace: boolean
}

export interface TextDocument {
  readonly uri: Uri
  readonly fileName: string
  readonly languageId: string
  readonly version: number
  readonly isDirty: boolean
  readonly isClosed: boolean
  readonly eol: EndOfLine
  readonly lineCount: number
  getText(range?: Range): string
  lineAt(lineOrPosition: number | Position): TextLine
  offsetAt(position: Position): number
  positionAt(offset: number): Position
  save(): Thenable<boolean>
  validateRange(range: Range): Range
  validatePosition(position: Position): Position
}

export interface TextDocumentChangeEvent {
  readonly document: TextDocument
  readonly contentChanges: readonly TextDocumentContentChangeEvent[]
  readonly reason?: number
}

export interface TextDocumentContentChangeEvent {
  readonly range: Range
  readonly rangeOffset: number
  readonly rangeLength: number
  readonly text: string
}

export interface TextEditorSelectionChangeEvent {
  readonly textEditor: TextEditor
  readonly selections: readonly Selection[]
  readonly kind?: TextEditorSelectionChangeKind
}

export interface TextEditorVisibleRangesChangeEvent {
  readonly textEditor: TextEditor
  readonly visibleRanges: readonly Range[]
}

export interface TextEditorOptions {
  readonly tabSize?: number | string
  readonly insertSpaces?: boolean | string
}

export interface TextEditorDecorationType extends Disposable {
  readonly key: string
}

/**
 * 装饰样式白名单。
 *
 * 只接受 CSS 值,不接受任意样式表/选择器:装饰最终由渲染层的 CM6 生成,
 * 扩展无法借它注入 `position: fixed` 之类会盖住界面的规则。
 */
export interface DecorationRenderOptions {
  backgroundColor?: string
  borderColor?: string
  borderStyle?: string
  borderWidth?: string
  color?: string
  textDecoration?: string
  isWholeLine?: boolean
  overviewRulerColor?: string
}

export interface DecorationOptions {
  range: Range
  hoverMessage?: string
}

export interface TextEditorEdit {
  replace(location: Position | Range | Selection, value: string): void
  insert(position: Position, value: string): void
  delete(location: Range | Selection): void
}

export interface TextEditor {
  readonly document: TextDocument
  readonly selection: Selection
  readonly selections: readonly Selection[]
  readonly visibleRanges: readonly Range[]
  readonly options: TextEditorOptions
  readonly viewColumn?: ViewColumn
  edit(callback: (edit: TextEditorEdit) => void, options?: { undoStopBefore?: boolean; undoStopAfter?: boolean }): Thenable<boolean>
  setDecorations(decorationType: TextEditorDecorationType, rangesOrOptions: readonly (Range | DecorationOptions)[]): void
  revealRange(range: Range, revealType?: TextEditorRevealType): void
  setSelection(anchor: Position, active?: Position): void
  show?(column?: ViewColumn): void
  hide?(): void
}

// ---------- 命令 / 窗口 ----------

export interface Command {
  title: string
  command: string
  arguments?: unknown[]
}

export interface CommandsApi {
  registerCommand(command: string, callback: (...args: any[]) => unknown, thisArg?: unknown): Disposable
  executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>
  getCommands(filterInternal?: boolean): Thenable<string[]>
}

export interface MessageOptions {
  modal?: boolean
  detail?: string
}

export interface InputBoxOptions {
  title?: string
  prompt?: string
  /**
   * 把 `prompt` 当作说明而不是正文：标题旁显示一个小问号，完整文字在悬停时给出。
   * 省略时 `prompt` 照常显示在输入框上方（与 VS Code 一致）。
   */
  promptAsHelp?: boolean
  placeHolder?: string
  value?: string
  password?: boolean
  ignoreFocusOut?: boolean
  validateInput?(value: string): string | undefined | null | Thenable<string | undefined | null>
}

export interface QuickPickItem {
  label: string
  description?: string
  detail?: string
  picked?: boolean
}

export interface QuickPickOptions {
  title?: string
  placeHolder?: string
  matchOnDescription?: boolean
  matchOnDetail?: boolean
}

export interface StatusBarItem extends Disposable {
  readonly id: string
  alignment: StatusBarAlignment
  priority?: number
  text: string
  tooltip?: string
  color?: string | ThemeColor
  backgroundColor?: ThemeColor
  command?: string | Command
  name?: string
  show(): void
  hide(): void
}

export interface OutputChannel extends Disposable {
  readonly name: string
  append(value: string): void
  appendLine(value: string): void
  replace(value: string): void
  clear(): void
  show(preserveFocus?: boolean): void
  hide(): void
  info(message: string): void
  warn(message: string): void
  error(message: string | Error): void
  debug(message: string): void
  trace(message: string): void
}

export interface ColorTheme {
  readonly kind: ColorThemeKind
}

/**
 * 面板呈现方式。`tab` = 编辑区标签页：与文件标签并列，标题即 `panel.title`，
 * 关闭标签会销毁面板；`retainContextWhenHidden` 仍然生效（切走时只隐藏）。
 */
export type WebviewPresentation = 'sidebar' | 'overlay' | 'floating' | 'tab'
/** 面板状态:显示在宿主标题栏上的小圆点。idle = 绿点,busy = 蓝点脉冲 */
export type WebviewPanelStatus = 'idle' | 'busy'

export interface ImarkWebviewOptions {
  /** 默认 sidebar;需要浮层时用 floating */
  presentation?: WebviewPresentation
  width?: number
  height?: number
  transparent?: boolean
  /** floating 面板的初始锚点,如 bottom-right */
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}

export interface WebviewOptions {
  enableScripts?: boolean
  retainContextWhenHidden?: boolean
  localResourceRoots?: readonly Uri[]
  imark?: ImarkWebviewOptions
}

export interface Webview {
  html: string
  options: WebviewOptions
  readonly cspSource: string
  asWebviewUri(localResource: Uri): Uri
  postMessage(message: unknown): Thenable<boolean>
  readonly onDidReceiveMessage: Event<unknown>
  getState<T>(): T | undefined
  setState<T>(state: T): Thenable<void>
}

export interface WebviewPanel extends Disposable {
  readonly viewType: string
  title: string
  readonly webview: Webview
  readonly visible: boolean
  readonly active: boolean
  readonly viewColumn: ViewColumn
  readonly onDidDispose: Event<void>
  readonly onDidChangeViewState: Event<{ readonly webviewPanel: WebviewPanel; readonly visible: boolean; readonly active: boolean }>
  reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void
  dispose(): void
  /** iMark 私有:聊天侧栏 / 全屏浮层 / 可拖动小窗 */
  readonly imark: {
    setPresentation(presentation: WebviewPresentation): void
    setSize(width: number, height: number): void
    setPosition(anchor: ImarkWebviewOptions['anchor']): void
    /**
     * 显示 / 收起面板。
     *
     * 收起不同于 `dispose()`:面板与 iframe 都保留（配合
     * `retainContextWhenHidden`），下次显示时页面状态、草稿与滚动位置都还在。
     * `reveal()` 会重新显示。
     */
    setVisible(visible: boolean): void
    /** 标题栏状态点:扩展在忙/闲之间切换 */
    setStatus(status: WebviewPanelStatus): void
    /**
     * 未保存标记。tab 呈现时显示在标签标题右侧（与文件标签的脏点一致），
     * 同时参与窗口关闭前的「有未保存内容」判断。内容是否真的落盘由扩展负责。
     */
    setDirty(dirty: boolean): void
  }
}

export interface WebviewPanelSerializer {
  deserializeWebviewPanel(webviewPanel: WebviewPanel, state: unknown): Thenable<void>
}

export interface WebviewPanelShowOptions {
  viewColumn?: ViewColumn
  preserveFocus?: boolean
}

export interface WindowApi {
  readonly activeTextEditor: TextEditor | undefined
  readonly visibleTextEditors: readonly TextEditor[]
  readonly activeColorTheme: ColorTheme
  readonly onDidChangeActiveColorTheme: Event<ColorTheme>
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  readonly onDidChangeVisibleTextEditors: Event<readonly TextEditor[]>
  readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>
  readonly onDidChangeTextEditorVisibleRanges: Event<TextEditorVisibleRangesChangeEvent>
  showInformationMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>
  showInformationMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>
  showWarningMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>
  showWarningMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>
  showErrorMessage<T extends string>(message: string, ...items: T[]): Thenable<T | undefined>
  showErrorMessage<T extends string>(message: string, options: MessageOptions, ...items: T[]): Thenable<T | undefined>
  showInputBox(options?: InputBoxOptions, token?: CancellationToken): Thenable<string | undefined>
  showQuickPick(items: readonly string[] | Thenable<readonly string[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<string | undefined>
  showQuickPick<T extends QuickPickItem>(items: readonly T[] | Thenable<readonly T[]>, options?: QuickPickOptions, token?: CancellationToken): Thenable<T | undefined>
  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem
  createOutputChannel(name: string, options?: { log?: boolean }): OutputChannel
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType
  createWebviewPanel(viewType: string, title: string, showOptions: ViewColumn | WebviewPanelShowOptions, options?: WebviewOptions): WebviewPanel
  registerWebviewPanelSerializer(viewType: string, serializer: WebviewPanelSerializer): Disposable
  showTextDocument(document: TextDocument, column?: ViewColumn, preserveFocus?: boolean): Thenable<TextEditor>
  /**
   * 打开应用的「处理合并冲突」窗口。
   *
   * `files` 是**绝对路径**的文本文件(`.gitignore` 这类不在文件树里的文件也可以)。
   * `onlyUnopened` 为真时只处理没有在编辑器中打开的冲突文件 —— 已经在编辑器里
   * 打开的文档有内联冲突操作栏,不需要再弹一个窗口。
   * 返回窗口是否真的打开(没有可处理的文件、或渲染层未就绪时为 false)。
   */
  showConflictResolver(
    files: readonly string[],
    options?: { onlyUnopened?: boolean }
  ): Thenable<boolean>
}

// ---------- 工作区 ----------

export interface WorkspaceFolder {
  readonly uri: Uri
  readonly name: string
  readonly index: number
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean
}

export interface WorkspaceFoldersChangeEvent {
  readonly added: readonly WorkspaceFolder[]
  readonly removed: readonly WorkspaceFolder[]
}

export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined
  get<T>(section: string, defaultValue: T): T
  has(section: string): boolean
  inspect<T>(section: string): {
    key: string
    defaultValue?: T
    globalValue?: T
    workspaceValue?: T
    workspaceFolderValue?: T
  } | undefined
  update(section: string, value: unknown, target?: ConfigurationTarget): Thenable<void>
}

export interface FileStat {
  readonly type: FileType
  readonly ctime: number
  readonly mtime: number
  readonly size: number
}

export interface FileSystem {
  readFile(uri: Uri): Thenable<Uint8Array>
  writeFile(uri: Uri, content: Uint8Array): Thenable<void>
  stat(uri: Uri): Thenable<FileStat>
  readDirectory(uri: Uri): Thenable<readonly [string, FileType][]>
  createDirectory(uri: Uri): Thenable<void>
  delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>
  rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Thenable<void>
}

export interface WorkspaceApi {
  readonly workspaceFolders: readonly WorkspaceFolder[] | undefined
  readonly name: string | undefined
  getConfiguration(section?: string, scope?: unknown): WorkspaceConfiguration
  readonly onDidChangeConfiguration: Event<ConfigurationChangeEvent>
  readonly onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidCloseTextDocument: Event<TextDocument>
  readonly onDidSaveTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  openTextDocument(uri?: Uri | string | { language?: string; content?: string }): Thenable<TextDocument>
  saveAll(includeUntitled?: boolean): Thenable<boolean>
  /**
   * 让渲染层重新读取磁盘上的文件:刷新文件树,并把**未修改**的已打开文档
   * 换成磁盘内容。用于外部工具(如 git 合并)改过工作区之后。
   * 有未保存改动的文档不会被覆盖(返回的 Promise 仍会 resolve,FALSE 表示没有任何
   * 文档被重载,不代表失败)。
   */
  reloadFromDisk(): Thenable<boolean>
  readonly fs: FileSystem
}

// ---------- 扩展清单 / 上下文 ----------

export interface ExtensionPackageJSON {
  name: string
  publisher: string
  version: string
  displayName?: string
  description?: string
  engines: { imark?: string }
  main?: string
  activationEvents?: string[]
  extensionDependencies?: string[]
  capabilities?: Record<string, unknown>
  contributes?: Record<string, unknown>
  [key: string]: unknown
}

export interface Extension<T> {
  readonly id: string
  readonly extensionUri: Uri
  readonly extensionPath: string
  readonly isActive: boolean
  readonly packageJSON: ExtensionPackageJSON
  readonly exports: T | undefined
  activate(): Thenable<T>
  deactivate(): Thenable<void> | undefined
}

export interface ExtensionsApi {
  getExtension<T = unknown>(id: string): Extension<T> | undefined
  readonly all: readonly Extension<unknown>[]
}

export interface Memento {
  keys(): readonly string[]
  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Thenable<void>
}

export interface SecretStorageChangeEvent {
  readonly key: string
}

export interface SecretStorage {
  get(key: string): Thenable<string | undefined>
  store(key: string, value: string): Thenable<void>
  delete(key: string): Thenable<void>
  readonly onDidChange: Event<SecretStorageChangeEvent>
}

export interface ExtensionContext {
  readonly subscriptions: Disposable[]
  readonly extensionPath: string
  readonly extensionUri: Uri
  readonly extensionMode: ExtensionMode
  readonly extension: Extension<unknown>
  readonly globalState: Memento
  readonly workspaceState: Memento
  readonly secrets: SecretStorage
  readonly globalStorageUri: Uri
  readonly storageUri: Uri | undefined
  readonly logUri: Uri
  readonly globalStoragePath: string
  readonly logPath: string
  asAbsolutePath(relativePath: string): string
}

// ---------- iMark 私有入口 ----------

export type ImarkStatus = 'idle' | 'running' | 'ok' | 'partial' | 'error'
export type ImarkTargetResult = 'ok' | 'error'

export interface ImarkStatusUpdate {
  status: ImarkStatus
  /** 状态的唯一一段文本;不填则沿用上一次 */
  message?: string
  detail?: string
  /** 按目标 id 合并,不会清空其他目标的结果 */
  targetResults?: Record<string, ImarkTargetResult>
  lastRunAt?: number
}

export interface ImarkApi {
  reportStatus(update: ImarkStatusUpdate): void
  renderMarkdown(markdown: string): Thenable<string>
  flushActiveDocument(): Thenable<boolean>
  readonly onDidChangeTheme: Event<ColorTheme>
}

// ---------- 项目级 Git 远端 ----------

export type ProjectGitAuth = 'token' | 'password' | 'ssh'

/**
 * 当前仓库在应用里配置的 Git 远端(不含密钥)。
 *
 * 扩展设置页的「远端仓库」、仓库选择页的「Git 设置」与克隆仓库维护这一份;
 * 扩展只读。地址为空的项目不会
 * 出现在这里 —— `getGitRemote()` 返回 null。
 */
export interface ProjectGitRemote {
  readonly url: string
  readonly auth: ProjectGitAuth
  readonly username: string
  /** 本地分支(必填) */
  readonly localBranch: string
  /** 远端分支;空串 = 与本地分支同名 */
  readonly remoteBranch: string
  readonly hasSecret: boolean
}

/**
 * `imark.project`:由应用(而不是某个扩展)提供的项目级能力。
 *
 * 密钥与元数据分开取:绝大多数判断只需要 `getGitRemote()` 里的 `hasSecret`,
 * 真正要跑 git 时再调用 `getGitSecret()`,明文不会出现在事件或配置快照里。
 */
export interface ProjectApi {
  /** 当前仓库的项目级远端;没有打开仓库或未配置时返回 null */
  getGitRemote(): Thenable<ProjectGitRemote | null>
  /** 当前远端的密钥明文;未保存、认证方式为 SSH 或无法解密时返回空串 */
  getGitSecret(): Thenable<string>
  /** 应用里改了当前仓库的远端地址/认证方式/分支或密钥 */
  readonly onDidChangeGitRemote: Event<void>
}

// ---------- 应用级 Git 网络能力 ----------

/** auto = 自动探测本机代理；manual = 用调用方给的地址；找不到可用代理时都直连 */
export type GitProxyMode = 'auto' | 'manual'

/** 扩展设置里的「网络代理」两项;不传则由应用自己读克隆用的那份设置 */
export interface GitProxyConfig {
  mode?: GitProxyMode
  /** 手动模式的代理地址；空串 = 手动模式但不走代理 */
  proxyUrl?: string
}

/** 一次 git 网络操作实际要用的参数(由应用探测后给出) */
export interface GitNetworkSetup {
  /** 追加到 git 命令行(在子命令之前)的 `-c` 参数 */
  args: string[]
  /** 追加到子进程环境变量的部分(NO_PROXY 等) */
  env: Record<string, string>
  /** 实际生效的代理地址(已脱敏,可直接展示);null = 直连 */
  proxyUrl: string | null
  /** 代理来源(如「环境变量 HTTP_PROXY」「Linux 系统代理（GNOME）」) */
  proxySource: string | null
}

/** 「检测代理」的结果;措辞交给扩展,这里只给事实 */
export interface GitProxyReport {
  mode: GitProxyMode
  /** 手动模式下地址无法识别时,原样带回来给用户核对 */
  invalidManualUrl?: string
  /** 检测到的代理地址(已脱敏);null = 没检测到 */
  proxyUrl: string | null
  proxySource: string | null
  /** 代理端口是否可连接;没有代理可测时为 null */
  reachable: boolean | null
  /** 自动模式实际检查过的来源(平台相关) */
  checked: string
}

/**
 * `imark.git`:git 的网络能力由**应用**提供,扩展不要自己实现系统代理探测。
 *
 * 克隆发生在主进程,同步发生在扩展宿主;两边必须用同一套代理规则。代理地址
 * 可能带认证,返回的 `proxyUrl` 已脱敏,可以直接写进日志或状态文本。
 */
export interface GitApi {
  /** 为一次 git 网络操作准备 `-c http.proxy=…` 与 NO_PROXY;找不到代理时返回直连参数 */
  networkSetup(url: string, proxy?: GitProxyConfig): Thenable<GitNetworkSetup>
  /** 只探测不改设置:手动地址是否可识别、系统代理在哪、端口能不能连 */
  detectProxy(proxy?: GitProxyConfig): Thenable<GitProxyReport>
}

// ---------- 模块级命名空间 ----------
//
// 这些是**声明**:运行时由宿主进程按扩展归属构造并注入,扩展工程只拿它们做类型检查。
// 扩展代码里 `imark.window...` / `imark.commands...` 的写法即在两种宿主拓扑下都成立。

export declare const version: string
export declare const commands: CommandsApi
export declare const window: WindowApi
export declare const workspace: WorkspaceApi
export declare const extensions: ExtensionsApi
export declare const project: ProjectApi
export declare const git: GitApi
export declare const imark: ImarkApi
export declare const env: {
  readonly appName: string
  readonly appVersion: string
  readonly language: string
  readonly uriScheme: string
  readonly machineId: string
  readonly sessionId: string
}
