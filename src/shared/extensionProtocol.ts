/**
 * 扩展系统的线协议:扩展宿主进程 ↔ main,main ↔ renderer。
 *
 * 三条硬规则:
 *
 * 1. **只传可结构化克隆的值。** 不传函数、Electron 对象、Buffer、类实例。
 *    `commands.executeCommand` 的返回值也是 —— 不可克隆就报错,而不是悄悄变成 `{}`。
 * 2. **密钥只出现在 main ↔ 宿主的方向。** renderer 与 webview 的消息类型里没有任何
 *    密钥字段;这不是注释约定,是类型上就没有地方放。
 * 3. **文档以 renderer 为准。** 宿主收到的是增量与版本号;编辑请求带 `expectedVersion`,
 *    版本不连续时 renderer 拒绝,由宿主等待下一次全量同步。
 *
 * 所有 request 都带 `requestId`,由发起方生成;响应统一是 `{ kind: 'response' }`。
 */

import type { ExtensionContextKeys } from './extensions'
import type { ExtensionManifest } from './extensionPackage'

export const EXTENSION_WEBVIEW_SCHEME = 'imark-webview'

// ---------- 基础 DTO ----------

export interface PositionDto {
  line: number
  character: number
}

export interface RangeDto {
  start: PositionDto
  end: PositionDto
}

export interface EditorSelectionDto {
  anchor: PositionDto
  active: PositionDto
}

/** CM6 的偏移量;host 用自己那份文档镜像把 Position 换算成它 */
export interface TextChangeDto {
  from: number
  to: number
  text: string
}

export interface DocumentStateDto {
  uri: string
  version: number
  text: string
  eol: 'lf' | 'crlf'
  isDirty: boolean
  languageId: string
}

/**
 * 一次文档变化。
 *
 * `text` 只在版本不连续(或首次同步)时出现;正常情况下宿主用 `changes` 增量更新,
 * 避免每次按键都把整篇文档跨进程复制一遍。
 */
export interface DocumentChangeDto {
  uri: string
  version: number
  changes: TextChangeDto[]
  text?: string
  eol?: 'lf' | 'crlf'
  isDirty?: boolean
}

export interface WorkspaceFolderDto {
  uri: string
  name: string
}

export interface ThemeDto {
  kind: 'light' | 'dark' | 'high-contrast' | 'high-contrast-light'
  /** 主题的 CSS 自定义属性,webview 直接注入 iframe */
  colors: Record<string, string>
}

export type HostLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface HostErrorDto {
  message: string
  stack?: string
}

// ---------- 装饰 ----------

/** 只允许这些 CSS 属性;renderer 会再校验一次,不信任宿主传来的字符串 */
export interface DecorationRenderOptionsDto {
  backgroundColor?: string
  borderColor?: string
  borderStyle?: 'solid' | 'dashed' | 'dotted'
  borderWidth?: string
  color?: string
  textDecoration?: string
  fontWeight?: string
  fontStyle?: string
  isWholeLine?: boolean
}

export interface DecorationRangeDto {
  start: PositionDto
  end: PositionDto
  hoverMessage?: string
}

// ---------- 宿主初始化 ----------

export interface HostExtensionInit {
  id: string
  /** 扩展目录的绝对路径 */
  extensionPath: string
  manifest: ExtensionManifest
  /** 生效配置:全局值 → 当前仓库覆盖值 → 默认值,已归一化 */
  config: Record<string, unknown>
  /** 显式保存在全局层的值(`inspect().globalValue`) */
  globalConfig?: Record<string, unknown>
  /** 显式保存在当前仓库层的覆盖值(`inspect().workspaceValue`) */
  workspaceConfig?: Record<string, unknown>
  globalState: Record<string, unknown>
  workspaceState: Record<string, unknown>
  /** main 分配的 storage 目录与日志文件;宿主不自己猜 userData 布局 */
  globalStoragePath: string
  logPath: string
}

export interface ExtensionHostEnvironmentDto {
  language: string
  uriScheme: string
  /** 同一台机器上稳定;用于扩展做设备级去重 */
  machineId: string
  /** 本次应用会话唯一 */
  sessionId: string
}

export interface ExtensionHostInitPayload {
  hostId: number
  appVersion: string
  environment: ExtensionHostEnvironmentDto
  workspaceFolders: WorkspaceFolderDto[]
  theme: ThemeDto
  /** 宿主启动时已经打开的文档;未打开的文档由扩展按需请求 */
  documents: DocumentStateDto[]
  activeDocumentUri: string | null
  visibleDocumentUris: string[]
  extensions: HostExtensionInit[]
}

export type HostActivationReason =
  | 'startup'
  | 'startupFinished'
  | 'command'
  | 'language'
  | 'webview'
  | 'dependency'
  | 'api'

/** 状态栏条目(宿主创建/更新时发送) */
export interface StatusBarItemDto {
  /** 扩展内唯一;主进程再拼上 extensionId 变成全局 ID */
  id: string
  alignment: 'left' | 'right'
  priority: number
  text: string
  tooltip?: string
  command?: string
  color?: string
  backgroundColor?: string
  name?: string
  visible: boolean
}

// ---------- webview ----------

export type WebviewPresentationDto = 'sidebar' | 'overlay' | 'floating'
export type WebviewAnchorDto = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
/** 面板状态:标题栏上的小圆点。idle = 绿点,busy = 蓝点脉冲 */
export type WebviewPanelStatusDto = 'idle' | 'busy'

export interface WebviewPanelCreateRequest {
  viewType: string
  title: string
  html: string
  presentation: WebviewPresentationDto
  width?: number
  height?: number
  transparent?: boolean
  anchor?: WebviewAnchorDto
  retainContextWhenHidden?: boolean
  enableScripts?: boolean
  /** 绝对路径;资源请求必须落在这些目录里 */
  localResourceRoots: string[]
  state?: unknown
  /**
   * 宿主在 create 请求里同步生成的面板 token。
   *
   * 之所以由宿主生成: `createWebviewPanel()` 必须同步返回,扩展紧接着就会调用
   * `webview.asWebviewUri()`;如果 token 要等 main 的响应才拿到,那时拼出的 URL
   * 还没有 token。main 会校验格式与唯一性,并在任何资源请求上再校验。
   */
  token?: string
}

export interface WebviewPanelCreateResult {
  panelId: string
  /** 每次创建随机生成;宿主用它拼 `asWebviewUri`。主进程与 renderer 都会校验 */
  token: string
  /** `imark-webview://<extensionId>` */
  baseUri: string
  /** CSP 里的 `{{cspSource}}` */
  cspSource: string
  webviewRoot: string
}

export interface WebviewPanelStateDto {
  panelId: string
  title: string
  status: WebviewPanelStatusDto
  presentation: WebviewPresentationDto
  width: number
  height: number
  transparent: boolean
  anchor: WebviewAnchorDto
  visible: boolean
  active: boolean
}

// ---------- 宿主 → main ----------

export interface HostReadyMessage {
  kind: 'ready'
  hostId: number
  /** process = 监听已就绪;initialized = init 已处理完(此时才会接受 activate) */
  phase: 'process' | 'initialized'
  error?: HostErrorDto
}

export interface HostLogMessage {
  kind: 'log'
  extensionId: string
  level: HostLogLevel
  message: string
}

export interface HostStatusMessage {
  kind: 'status'
  extensionId: string
  status: string
  message: string
  detail?: string
  targetResults?: Record<string, 'ok' | 'error'>
  lastRunAt?: number
}

export interface HostActivatedMessage {
  kind: 'activated'
  extensionId: string
  ok: boolean
  error?: HostErrorDto
}

export interface HostDeactivatedMessage {
  kind: 'deactivated'
  extensionId: string
}

export interface HostCommandRegisteredMessage {
  kind: 'command.registered'
  extensionId: string
  command: string
  title?: string
}

export interface HostCommandUnregisteredMessage {
  kind: 'command.unregistered'
  extensionId: string
  command: string
}

export interface HostStateSetMessage {
  kind: 'state.set'
  extensionId: string
  scope: 'global' | 'workspace'
  key: string
  value: unknown
}

export interface HostOutputAppendMessage {
  kind: 'output.append'
  extensionId: string
  channel: string
  text: string
  /** 输出通道方法自带的级别;append/appendLine 不传时为 info */
  level?: 'debug' | 'info' | 'warn' | 'error'
}

export type HostStatusBarMessage =
  | {
      kind: 'statusbar'
      extensionId: string
      action: 'create' | 'update'
      item: StatusBarItemDto
    }
  | {
      kind: 'statusbar'
      extensionId: string
      action: 'dispose'
      itemId: string
    }

export interface HostSecretsChangedMessage {
  kind: 'secrets.changed'
  extensionId: string
  key: string
}

/**
 * 宿主发给 main 的请求。
 *
 * 用 `kind` 而不是 `type`,是为了和 renderer 的消息(用 `type`)区分开:
 * 两者都会经过 main,日志里一眼能看出是哪条链路。
 */
export type HostRequestMessage =
  | {
      kind: 'command.execute'
      requestId: string
      extensionId: string
      command: string
      args: unknown[]
    }
  | {
      kind: 'commands.list'
      requestId: string
      extensionId: string
    }
  | {
      kind: 'extension.activate'
      requestId: string
      extensionId: string
      targetExtensionId: string
    }
  | {
      kind: 'document.flush'
      requestId: string
      extensionId: string
      uri: string
    }
  | {
      kind: 'message.show'
      requestId: string
      extensionId: string
      level: 'info' | 'warning' | 'error'
      message: string
      detail?: string
      items: string[]
      modal: boolean
    }
  | {
      kind: 'inputBox.show'
      requestId: string
      extensionId: string
      options: {
        title?: string
        prompt?: string
        placeHolder?: string
        value?: string
        password?: boolean
        ignoreFocusOut?: boolean
        validateInput?: boolean
      }
    }
  | {
      kind: 'quickPick.show'
      requestId: string
      extensionId: string
      items: {
        label: string
        description?: string
        detail?: string
        picked?: boolean
      }[]
      options: {
        title?: string
        placeHolder?: string
        canPickMany?: boolean
        ignoreFocusOut?: boolean
        matchOnDescription?: boolean
        matchOnDetail?: boolean
      }
    }
  | {
      kind: 'configuration.update'
      requestId: string
      extensionId: string
      key: string
      value: unknown
      /**
       * VS Code 的 `ConfigurationTarget`(1 = Global,2 = Workspace,
       * 3 = WorkspaceFolder);省略时按字段清单里声明的 `imark.scope` 决定。
       */
      target?: number
    }
  | {
      kind: 'secret.get'
      requestId: string
      extensionId: string
      key: string
    }
  | {
      kind: 'secret.store'
      requestId: string
      extensionId: string
      key: string
      value: string
    }
  | {
      kind: 'secret.delete'
      requestId: string
      extensionId: string
      key: string
    }
  | {
      kind: 'editor.applyEdits'
      requestId: string
      extensionId: string
      uri: string
      edits: TextChangeDto[]
      expectedVersion?: number
    }
  | {
      kind: 'editor.setSelections'
      requestId: string
      extensionId: string
      uri: string
      selections: EditorSelectionDto[]
    }
  | {
      kind: 'editor.reveal'
      requestId: string
      extensionId: string
      uri: string
      range: RangeDto
      revealType: 'default' | 'center' | 'top' | 'bottom'
    }
  | {
      kind: 'editor.setDecorations'
      extensionId: string
      uri: string
      typeId: string
      options: DecorationRenderOptionsDto
      ranges: DecorationRangeDto[]
    }
  | {
      kind: 'editor.showDocument'
      requestId: string
      extensionId: string
      uri: string
      options: { viewColumn?: number; preserveFocus?: boolean; selection?: RangeDto }
    }
  | {
      kind: 'documents.open'
      requestId: string
      extensionId: string
      uri: string
    }
  | {
      /** 宿主发现版本不连续,请求 main 发回整篇文档 */
      kind: 'documents.resync'
      requestId: string
      extensionId: string
      uri: string
    }
  | {
      kind: 'workspace.saveAll'
      requestId: string
      extensionId: string
      includeUntitled: boolean
    }
  | {
      kind: 'markdown.render'
      requestId: string
      extensionId: string
      text: string
    }
  | {
      kind: 'webview.create'
      requestId: string
      extensionId: string
      options: WebviewPanelCreateRequest
    }
  | {
      kind: 'webview.setHtml'
      extensionId: string
      panelId: string
      html: string
    }
  | {
      kind: 'webview.postMessage'
      extensionId: string
      panelId: string
      message: unknown
    }
  | {
      kind: 'webview.setTitle'
      extensionId: string
      panelId: string
      title: string
    }
  | {
      kind: 'webview.setStatus'
      extensionId: string
      panelId: string
      status: WebviewPanelStatusDto
    }
  | {
      kind: 'webview.setPresentation'
      extensionId: string
      panelId: string
      presentation: WebviewPresentationDto
      width?: number
      height?: number
      transparent?: boolean
      anchor?: WebviewAnchorDto
    }
  | {
      kind: 'webview.setState'
      extensionId: string
      panelId: string
      state: unknown
    }
  | {
      kind: 'webview.dispose'
      extensionId: string
      panelId: string
    }
  | {
      kind: 'webview.serializer.registered'
      extensionId: string
      viewType: string
    }
  | {
      kind: 'webview.serializer.unregistered'
      extensionId: string
      viewType: string
    }

export type HostToMainMessage =
  | HostReadyMessage
  | HostLogMessage
  | HostStatusMessage
  | HostActivatedMessage
  | HostDeactivatedMessage
  | HostCommandRegisteredMessage
  | HostCommandUnregisteredMessage
  | HostStateSetMessage
  | HostOutputAppendMessage
  | HostStatusBarMessage
  | HostSecretsChangedMessage
  | HostRequestMessage
  | HostResponseMessage

// ---------- main → 宿主 ----------

export interface MainInitMessage {
  kind: 'init'
  payload: ExtensionHostInitPayload
}

export interface MainActivateMessage {
  kind: 'activate'
  extensionId: string
  reason: HostActivationReason
}

export interface MainDeactivateMessage {
  kind: 'deactivate'
  extensionId: string
  /** 卸载时丢掉该扩展在宿主内的全部数据;禁用/重载保留 */
  removeData: boolean
}

export interface MainCommandMessage {
  kind: 'command.execute'
  requestId: string
  command: string
  args: unknown[]
}

export interface MainConfigurationChangedMessage {
  kind: 'configuration.changed'
  extensionId: string
  /** 生效配置(合并后) */
  values: Record<string, unknown>
  /** 显式全局值;省略表示没有变化 */
  globalConfig?: Record<string, unknown>
  /** 当前仓库的显式覆盖值;省略表示没有变化 */
  workspaceConfig?: Record<string, unknown>
}

/**
 * 用户（或设置页）改了一条密钥。
 *
 * 扩展自己 `secrets.store()` 时宿主侧会立刻 fire；这条是给**外部改动**用的：
 * 设置页填了新的 API key，正在跑的扩展也要能收到 onDidChange，否则它得等到下次
 * 重启才用上新值。消息里只有 key，没有明文 —— 扩展要读值仍然走 secret.get。
 */
export interface MainSecretsChangedMessage {
  kind: 'secrets.changed'
  extensionId: string
  key: string
}

export interface MainDocumentOpenedMessage {
  kind: 'document.opened'
  document: DocumentStateDto
}

export interface MainDocumentChangedMessage {
  kind: 'document.changed'
  change: DocumentChangeDto
}

export interface MainDocumentClosedMessage {
  kind: 'document.closed'
  uri: string
}

export interface MainDocumentSavedMessage {
  kind: 'document.saved'
  uri: string
  version: number
}

export interface MainActiveEditorChangedMessage {
  kind: 'editor.activeChanged'
  uri: string | null
  visible: string[]
}

export interface MainSelectionChangedMessage {
  kind: 'editor.selectionChanged'
  uri: string
  selections: EditorSelectionDto[]
}

export interface MainThemeChangedMessage {
  kind: 'theme.changed'
  theme: ThemeDto
}

export interface MainWorkspaceFoldersChangedMessage {
  kind: 'workspaceFolders.changed'
  folders: WorkspaceFolderDto[]
}

export interface MainWebviewMessageMessage {
  kind: 'webview.message'
  panelId: string
  message: unknown
}

export interface MainWebviewViewStateMessage {
  kind: 'webview.viewState'
  panelId: string
  visible: boolean
  active: boolean
}

export interface MainWebviewDisposedMessage {
  kind: 'webview.disposed'
  panelId: string
}

export interface MainWebviewRestoreMessage {
  kind: 'webview.restore'
  panelId: string
  viewType: string
  state: unknown
  panel: WebviewPanelStateDto
  /** 恢复的面板沿用同一个 token,否则 asWebviewUri 拼出的地址会被拒绝 */
  token: string
}

export interface MainShutdownMessage {
  kind: 'shutdown'
}

export interface HostResponseMessage {
  kind: 'response'
  requestId: string
  ok: boolean
  value?: unknown
  error?: HostErrorDto
}

export type MainToHostMessage =
  | MainInitMessage
  | MainActivateMessage
  | MainDeactivateMessage
  | MainCommandMessage
  | MainConfigurationChangedMessage
  | MainSecretsChangedMessage
  | MainDocumentOpenedMessage
  | MainDocumentChangedMessage
  | MainDocumentClosedMessage
  | MainDocumentSavedMessage
  | MainActiveEditorChangedMessage
  | MainSelectionChangedMessage
  | MainThemeChangedMessage
  | MainWorkspaceFoldersChangedMessage
  | MainWebviewMessageMessage
  | MainWebviewViewStateMessage
  | MainWebviewDisposedMessage
  | MainWebviewRestoreMessage
  | MainShutdownMessage
  | HostResponseMessage

// ---------- renderer ↔ main ----------

export interface RendererEditorInitPayload {
  documents: DocumentStateDto[]
  activeDocumentUri: string | null
  visibleDocumentUris: string[]
  context: ExtensionContextKeys
  theme: ThemeDto
}

/** renderer 请求编辑器执行的动作 */
export type EditorRequestDto =
  | {
      op: 'applyEdits'
      uri: string
      edits: TextChangeDto[]
      expectedVersion?: number
    }
  | {
      op: 'setSelections'
      uri: string
      selections: EditorSelectionDto[]
    }
  | {
      op: 'reveal'
      uri: string
      range: RangeDto
      revealType: 'default' | 'center' | 'top' | 'bottom'
    }
  | {
      op: 'openDocument'
      uri: string
      options?: { viewColumn?: number; preserveFocus?: boolean; selection?: RangeDto }
    }
  | {
      op: 'saveAll'
      includeUntitled: boolean
    }
  | {
      /** 保存一份文档;文档不在编辑器里时返回 false(与 VS Code 的 save 语义一致) */
      op: 'saveDocument'
      uri: string
    }
  | {
      op: 'setDecorations'
      uri: string
      typeId: string
      options: DecorationRenderOptionsDto
      ranges: DecorationRangeDto[]
    }
  | {
      /**
       * 扩展的 `imark.renderMarkdown`：复用渲染层那份 markdown-it（KaTeX / Mermaid /
       * 链接校验），让 webview 预览与应用正文逐字一致。渲染层不替扩展做缓存。
       */
      op: 'renderMarkdown'
      text: string
      /** Mermaid 需要知道深浅色，否则深色主题下图会配白底 */
      theme: 'light' | 'dark'
    }

export interface RendererApplyEditsResult {
  ok: boolean
  version?: number
  reason?: 'not-open' | 'version-mismatch' | 'invalid-edit'
}

export interface UiMessageRequestDto {
  level: 'info' | 'warning' | 'error'
  message: string
  detail?: string
  items: string[]
  modal: boolean
}

export interface UiInputBoxRequestDto {
  title?: string
  prompt?: string
  placeHolder?: string
  value?: string
  password?: boolean
  ignoreFocusOut?: boolean
}

export interface UiQuickPickItemDto {
  label: string
  description?: string
  detail?: string
  picked?: boolean
}

export interface UiQuickPickRequestDto {
  title?: string
  placeHolder?: string
  canPickMany?: boolean
  ignoreFocusOut?: boolean
  matchOnDescription?: boolean
  matchOnDetail?: boolean
  items: UiQuickPickItemDto[]
}

export type RendererToMainMessage =
  | { type: 'editor.ready'; payload: RendererEditorInitPayload }
  | { type: 'editor.documentOpened'; document: DocumentStateDto }
  | { type: 'editor.documentChanged'; change: DocumentChangeDto }
  | { type: 'editor.documentClosed'; uri: string }
  | { type: 'editor.documentSaved'; uri: string; version: number }
  | { type: 'editor.activeChanged'; uri: string | null; visible: string[] }
  | {
      type: 'editor.selectionChanged'
      uri: string
      selections: EditorSelectionDto[]
    }
  | { type: 'editor.contextChanged'; context: ExtensionContextKeys }
  | { type: 'editor.themeChanged'; theme: ThemeDto }
  | {
      type: 'editor.response'
      requestId: string
      ok: boolean
      /** 按请求类型而定:applyEdits → RendererApplyEditsResult;saveAll 等 → boolean */
      value?: unknown
      error?: string
    }
  | {
      type: 'webview.message'
      panelId: string
      message: unknown
    }
  | {
      type: 'webview.viewState'
      panelId: string
      visible: boolean
      active: boolean
    }
  | { type: 'webview.disposed'; panelId: string }
  | {
      type: 'command.execute'
      command: string
      args?: unknown[]
      from: 'commandPalette' | 'keybinding' | 'lineMenu' | 'statusBar' | 'action' | 'code'
    }
  | {
      type: 'ui.response'
      requestId: string
      value: string | string[] | null
    }
  | { type: 'extensions.requestReload'; extensionId: string }
  | { type: 'extensions.setEnabled'; extensionId: string; enabled: boolean }

export type MainToRendererMessage =
  | {
      type: 'editor.request'
      requestId: string
      request: EditorRequestDto
    }
  | {
      type: 'extensions.contributions'
      /** 全量快照;渲染层不做增量合并,避免两边状态分叉 */
      snapshot: unknown
    }
  | {
      type: 'extensions.webviewPanels'
      panels: (WebviewPanelStateDto & {
        extensionId: string
        html: string
        token: string
        viewType: string
        retainContextWhenHidden: boolean
      })[]
    }
  | {
      /** 主进程的文档镜像与渲染层对不上(坏增量):渲染层回发整篇文档 */
      type: 'editor.resync'
      uri: string
    }
  | {
      type: 'webview.create'
      panel: WebviewPanelStateDto & {
        extensionId: string
        html: string
        token: string
        viewType: string
        retainContextWhenHidden: boolean
      }
    }
  | {
      type: 'webview.update'
      panel: WebviewPanelStateDto
    }
  | {
      type: 'webview.html'
      panelId: string
      html: string
    }
  | {
      type: 'webview.postMessage'
      panelId: string
      message: unknown
    }
  | {
      type: 'webview.dispose'
      panelId: string
    }
  | {
      type: 'webview.injectTheme'
      panelId: string
      colors: Record<string, string>
    }
  | {
      type: 'ui.showMessage'
      requestId: string
      /** 哪个扩展要求的；只为在界面上标出名字，不参与路由 */
      extensionId?: string
      options: UiMessageRequestDto
    }
  | {
      type: 'ui.showInputBox'
      requestId: string
      extensionId?: string
      options: UiInputBoxRequestDto
    }
  | {
      type: 'ui.showQuickPick'
      requestId: string
      extensionId?: string
      options: UiQuickPickRequestDto
    }
