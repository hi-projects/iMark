/**
 * Agent Core：对话面板与会话宿主，不认识任何具体 Agent 后端。
 *
 * 设计边界（用户明确要求）：
 * - 扩展不解析附件：只把 webview 传来的字节落盘，给 Agent 绝对路径；
 * - 怎么读文件（Read / Bash / 写脚本 / 调本地工具）由 Agent 自行决定；
 * - 后端通过 `imark.agentProviders` 贡献点接入；Claude Code 是独立扩展；
 * - 文档只有用户主动「添加本文档」时才作为普通附件进入会话；结果通过 TextEditor.edit 写回，不直接改 vault。
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import * as imark from 'imark'
import type {
  AgentError,
  AgentErrorCode,
  AgentSession,
  AgentUsage,
  DocMeta,
  StagedAttachment
} from './core/types'
import type {
  ApplyResult,
  ArtifactPreview,
  HostPush,
  InitPayload,
  SessionMessage,
  SessionSummary,
  SessionView,
  ToolCallView
} from './core/protocol'
import { MAX_TURN_TEXT, toAttachmentMeta } from './core/protocol'
import { readConfig, safeConfigView, type AgentConfig } from './core/config'
import { AttachmentStager } from './core/attachments'
import { ArtifactStore } from './core/artifacts'
import { DocumentApplyError, DocumentBridge } from './core/document'
import { Inventory } from './core/inventory'
import { inlineImageSources } from './core/markdown'
import { buildReplay, buildTurnPrompt } from './core/prompt'
import { attachmentsOf, SessionStore, workspaceKey, type SessionMeta } from './core/sessions'
import { ProviderRegistry } from './core/providers'

const VIEW_TYPE = 'imark.agent.chat'
const CMD_OPEN = 'imark.agent.openChat'
const CMD_STOP = 'imark.agent.stop'

const DOC_PUSH_DEBOUNCE_MS = 80
const AGENT_ERROR_CODES = new Set<AgentErrorCode>([
  'provider-unavailable',
  'auth-required',
  'permission-denied',
  'timeout',
  'turn-limit',
  'cancelled',
  'provider-error',
  'protocol-error',
  'config-invalid',
  'attachment-too-large',
  'attachment-missing',
  'no-editor',
  'edit-rejected',
  'not-found'
])

interface TurnRuntime {
  turnId: string
  sessionId: string
  controller: AbortController
  providerSession: AgentSession | null
  cancelled: boolean
}

interface TurnOutcome {
  status: 'ok' | 'error' | 'cancelled'
  text: string
  thinking?: string
  toolCalls: ToolCallView[]
  usage?: AgentUsage
  costUsd?: number
  error?: AgentError
}

interface TurnInput {
  turnId: string
  sessionId: string
  meta: SessionMeta
  text: string
  attachments: StagedAttachment[]
  history: SessionMessage[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function errorOf(err: unknown): AgentError {
  if (err instanceof DocumentApplyError) {
    return { code: err.code, message: err.message }
  }
  if (err && typeof err === 'object') {
    const raw = err as { code?: unknown; message?: unknown; detail?: unknown; retryable?: unknown }
    if (typeof raw.code === 'string' && AGENT_ERROR_CODES.has(raw.code as AgentErrorCode)) {
      return {
        code: raw.code as AgentErrorCode,
        message: str(raw.message, String(err)),
        detail: typeof raw.detail === 'string' ? raw.detail : undefined,
        retryable: raw.retryable === true
      }
    }
  }
  return { code: 'provider-error', message: err instanceof Error ? err.message : String(err) }
}

function codedError(code: AgentErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

class AgentHost {
  private readonly sessions: SessionStore
  private readonly attachments: AttachmentStager
  private readonly artifacts: ArtifactStore
  private readonly documents = new DocumentBridge()
  private readonly inventory = new Inventory()
  private readonly providers: ProviderRegistry
  private readonly output: imark.OutputChannel
  private readonly activeTurns = new Map<string, TurnRuntime>()
  private readonly turnBySession = new Map<string, string>()
  private panel: imark.WebviewPanel | null = null
  private statusItem: imark.StatusBarItem | null = null
  private config: AgentConfig | null = null
  private docTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly context: imark.ExtensionContext) {
    this.sessions = new SessionStore(context.globalStoragePath)
    this.attachments = new AttachmentStager(this.sessions)
    this.artifacts = new ArtifactStore(sessionId => this.sessions.preparedDir(sessionId))
    this.providers = new ProviderRegistry(context)
    this.output = imark.window.createOutputChannel('Agent Core')
  }

  async start(): Promise<void> {
    await this.sessions.init()
    this.refreshConfig()

    this.context.subscriptions.push(
      imark.commands.registerCommand(CMD_OPEN, () => this.openChat()),
      imark.commands.registerCommand(CMD_STOP, () => this.cancelAllTurns()),
      imark.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async panel => this.adoptPanel(panel)
      }),
      imark.window.onDidChangeActiveTextEditor(() => this.scheduleDoc(true)),
      imark.window.onDidChangeTextEditorSelection(() => this.scheduleDoc()),
      imark.workspace.onDidChangeTextDocument(event => {
        const active = imark.window.activeTextEditor
        if (active && event.document.uri.toString() === active.document.uri.toString()) {
          this.scheduleDoc()
        }
      }),
      imark.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('imark.agent')) void this.onConfigChanged()
      }),
      imark.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceChanged())
    )

    this.statusItem = imark.window.createStatusBarItem(imark.StatusBarAlignment.Right, 95)
    this.statusItem.text = '$(hubot) Agent Core'
    this.statusItem.tooltip = '打开 Agent Core 对话'
    this.statusItem.command = CMD_OPEN
    this.statusItem.show()
    this.context.subscriptions.push(this.statusItem)

    void this.inventory.detect()
    this.updateStatusBar()
  }

  stop(): void {
    this.disposed = true
    if (this.docTimer) {
      clearTimeout(this.docTimer)
      this.docTimer = null
    }
    this.cancelAllTurns()
    this.panel?.dispose()
    this.panel = null
    this.statusItem?.dispose()
    this.statusItem = null
    this.output.dispose()
    void this.attachments.disposeAll()
  }

  // ---------- 配置 ----------

  /** provider 就绪门闩；由入口在 start() 结束后打开 */
  markProvidersReady(): void {
    this.providers.markReady()
  }

  /** 当前仓库根目录；会话按它隔离，面板只列出当前仓库的会话 */
  private currentWorkspace(): string | null {
    return workspaceKey(imark.workspace.workspaceFolders?.[0]?.uri.fsPath)
  }

  private refreshConfig(): AgentConfig {
    this.config = readConfig().config
    return this.config
  }

  private async onConfigChanged(): Promise<void> {
    if (this.disposed) return
    const config = this.refreshConfig()
    this.push({
      type: 'push',
      kind: 'config',
      value: { config: safeConfigView(config) }
    })
  }

  /**
   * 切换仓库：运行中的回合属于旧仓库，面板里已经没有它的位置，先停掉；
   * 然后让界面整体切换到新仓库的会话列表（没有会话时回到空状态）。
   */
  private async onWorkspaceChanged(): Promise<void> {
    if (this.disposed) return
    this.cancelAllTurns()
    if (!this.panel) return
    const workspace = this.currentWorkspace()
    const sessions = await this.sessions.listAll(workspace)
    // 连续切换仓库时，先发出的那次读盘可能后完成；只推当前仓库的结果
    if (this.disposed || workspace !== this.currentWorkspace()) return
    this.push({ type: 'push', kind: 'workspace', value: { sessions } })
  }

  private currentDocMeta(): DocMeta | null {
    return this.documents.meta(this.documents.current())
  }

  private async listSessions(): Promise<SessionSummary[]> {
    return this.sessions.listAll(this.currentWorkspace())
  }

  private async summaryOf(meta: SessionMeta, withArtifacts = false): Promise<SessionSummary> {
    const artifacts = withArtifacts ? await this.artifacts.scan(meta.id) : []
    return this.sessions.summaryOf(meta, artifacts)
  }

  // ---------- 面板 ----------

  private openChat(): void {
    if (this.disposed) return
    if (this.panel) {
      this.panel.reveal()
      // 重新显示时再探测一次后端：默认模型等只读信息可能已在设置里改过
      this.push({ type: 'push', kind: 'refresh' })
      return
    }
    const panel = imark.window.createWebviewPanel(
      VIEW_TYPE,
      'Agent Core',
      { viewColumn: imark.ViewColumn.One },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
        imark: { presentation: 'sidebar', width: 460 }
      }
    )
    this.adoptPanel(panel)
  }

  private adoptPanel(panel: imark.WebviewPanel): void {
    if (this.disposed) {
      panel.dispose()
      return
    }
    if (this.panel && this.panel !== panel) this.panel.dispose()
    this.panel = panel
    this.updateStatusBar()
    this.context.subscriptions.push(
      panel.webview.onDidReceiveMessage(message => {
        void this.onMessage(message).catch(err => {
          this.output.warn(`处理界面消息失败：${err instanceof Error ? err.message : String(err)}`)
        })
      }),
      panel.onDidDispose(() => {
        if (this.panel !== panel) return
        this.panel = null
        this.cancelAllTurns()
        void this.attachments.disposeAll()
        void this.sessions.pruneEmptyDrafts()
      })
    )
    panel.webview.html = this.panelHtml(panel)
    void this.pushInitialState().catch(err => {
      this.output.warn(`推送初始化状态失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private panelHtml(panel: imark.WebviewPanel): string {
    const nonce = randomUUID().replace(/-/g, '')
    const csp = panel.webview.cspSource
    const scriptUri = panel.webview.asWebviewUri(
      imark.Uri.joinPath(this.context.extensionUri, 'webview', 'chat.js')
    )
    const styleUri = panel.webview.asWebviewUri(
      imark.Uri.joinPath(this.context.extensionUri, 'webview', 'styles.css')
    )
    // 公式样式与字体随扩展包分发（构建时从 katex 复制），见 scripts/build-plugins.mjs
    const katexUri = panel.webview.asWebviewUri(
      imark.Uri.joinPath(this.context.extensionUri, 'webview', 'katex', 'katex.min.css')
    )
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob:; font-src ${csp}; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}' ${csp}; connect-src 'none'; frame-src 'none'; worker-src 'none';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Core</title>
<link rel="stylesheet" href="${escapeAttr(styleUri.toString())}" />
<link rel="stylesheet" href="${escapeAttr(katexUri.toString())}" />
</head>
<body>
<script nonce="${nonce}" src="${escapeAttr(scriptUri.toString())}"></script>
</body>
</html>`
  }

  private async pushInitialState(): Promise<void> {
    const doc = this.currentDocMeta()
    const sessions = await this.listSessions()
    const { providers, errors } = await this.providers.list()
    const payload: InitPayload = {
      providers: providers.map(provider => ({ info: provider.info })),
      config: safeConfigView(this.config ?? this.refreshConfig()),
      doc,
      sessions,
      activeSessionId: sessions[0]?.id ?? null
    }
    this.push({ type: 'push', kind: 'init', value: payload })
    for (const error of errors) this.pushError('provider', error)
  }

  private push(push: HostPush): void {
    if (!this.panel) return
    void this.panel.webview.postMessage(push)
  }

  private pushError(scope: string, error: AgentError): void {
    this.push({ type: 'push', kind: 'error', value: { scope, error } })
  }

  private scheduleDoc(immediate = false): void {
    if (!this.panel) return
    if (immediate) {
      if (this.docTimer) {
        clearTimeout(this.docTimer)
        this.docTimer = null
      }
      void this.pushDocState()
      return
    }
    if (this.docTimer) return
    this.docTimer = setTimeout(() => {
      this.docTimer = null
      void this.pushDocState()
    }, DOC_PUSH_DEBOUNCE_MS)
  }

  /**
   * 只更新当前文档信息，不动会话列表。
   *
   * 会话与会话列表都是全局的：切换文档时面板保持原样，新会话与文档无关。
   */
  private async pushDocState(): Promise<void> {
    const doc = this.currentDocMeta()
    this.push({ type: 'push', kind: 'doc', value: { doc } })
  }

  private updateStatusBar(): void {
    const running = this.activeTurns.size > 0
    // 标题栏的小圆点由宿主绘制（它在 webview 沙箱之外），扩展只报告忙闲
    this.panel?.imark.setStatus(running ? 'busy' : 'idle')
    if (!this.statusItem) return
    this.statusItem.text = running ? '$(sync~spin) Agent Core' : '$(hubot) Agent Core'
    this.statusItem.tooltip = running ? 'Agent Core 正在运行' : '打开 Agent Core 对话'
  }

  // ---------- 消息入口 ----------

  private async onMessage(message: unknown): Promise<void> {
    const raw = asRecord(message)
    if (str(raw.type) !== 'request') return
    const id = str(raw.id)
    if (!id) return
    const kind = str(raw.kind)
    try {
      const value = await this.handleRequest(kind, raw.payload)
      await this.panel?.webview.postMessage({ type: 'response', id, ok: true, value })
    } catch (err) {
      const error = errorOf(err)
      await this.panel?.webview.postMessage({
        type: 'response',
        id,
        ok: false,
        error: { code: error.code, message: error.message, detail: error.detail }
      })
    }
  }

  private async handleRequest(kind: string, payload: unknown): Promise<unknown> {
    switch (kind) {
      case 'provider.detect':
        return this.detectProviders()
      case 'session.create':
        return this.createSession(asRecord(payload))
      case 'session.open':
        return { session: await this.viewOf(str(asRecord(payload).sessionId)) }
      case 'session.delete':
        return this.deleteSession(str(asRecord(payload).sessionId))
      case 'attach.begin':
        return this.beginUpload(asRecord(payload))
      case 'attach.chunk': {
        const data = asRecord(payload)
        return this.attachments.chunk(
          str(data.uploadId),
          Number(data.index),
          Number(data.total),
          str(data.data)
        )
      }
      case 'attach.finish': {
        const data = asRecord(payload)
        const result = await this.attachments.finish(str(data.uploadId))
        const meta = await this.sessions.getMeta(result.sessionId)
        if (meta) {
          this.push({
            type: 'push',
            kind: 'sessionSummary',
            value: { summary: await this.summaryOf(meta) }
          })
        }
        return { sessionId: result.sessionId, attachment: toAttachmentMeta(result.attachment) }
      }
      case 'attach.cancel':
        await this.attachments.cancel(str(asRecord(payload).uploadId))
        return { cancelled: true }
      case 'attach.remove': {
        const data = asRecord(payload)
        const attachments = await this.attachments.remove(
          str(data.sessionId),
          str(data.attachmentId)
        )
        return { attachments }
      }
      case 'turn.start':
        return this.startTurn(asRecord(payload))
      case 'prompt.preview':
        return this.previewPrompt(asRecord(payload))
      case 'turn.cancel':
        return { cancelled: this.cancelTurn(str(asRecord(payload).turnId)) }
      case 'permission.respond':
        return this.respondPermission(asRecord(payload))
      case 'artifact.preview':
        return this.previewArtifact(asRecord(payload))
      case 'doc.attach':
        return this.attachDocument(asRecord(payload))
      case 'doc.apply':
        return this.applyMessage(asRecord(payload))
      case 'doc.applyArtifact':
        return this.applyArtifact(asRecord(payload))
      case 'markdown.render': {
        const record = asRecord(payload)
        const text = str(record.text)
        if (text.length > 1024 * 1024) throw new Error('Markdown 文本过大')
        const html = await imark.imark.renderMarkdown(text)
        // 面板的 CSP 不放行 file:/http:，把会话目录内的图片内联成 data URI
        const sessionId = str(record.sessionId)
        const meta = sessionId ? await this.sessions.getMeta(sessionId) : null
        return {
          html: await inlineImageSources(
            html,
            meta ? this.sessions.sessionDir(meta.id) : undefined
          )
        }
      }
      default:
        throw new Error(`未知请求：${kind}`)
    }
  }

  // ---------- provider ----------

  private async detectProviders(): Promise<unknown> {
    const { providers, errors } = await this.providers.list()
    for (const error of errors) this.pushError('provider', error)
    const views = await Promise.all(
      providers.map(async provider => ({
        info: provider.info,
        detection: await provider.detect()
      }))
    )
    return { providers: views }
  }

  // ---------- 会话 ----------

  private async createSession(input: Record<string, unknown>): Promise<unknown> {
    const { providers } = await this.providers.list()
    const requested = str(input.provider)
    const providerId = requested || providers[0]?.info.id
    if (!providerId) {
      throw codedError('provider-unavailable', '未安装或未启用任何 Agent 后端扩展')
    }
    if (!providers.some(provider => provider.info.id === providerId)) {
      throw codedError('config-invalid', `未知 provider：${providerId}`)
    }
    // 会话绑定当前仓库但不绑定文档：文档只作为每一轮的可选上下文
    const meta = await this.sessions.create({
      provider: providerId,
      workspace: this.currentWorkspace()
    })
    // 不在这里 push sessions：webview 的 createSession 请求会拿到同一份 view；
    // 额外 push 会让列表处理器在 state.session 还没赋值时自动 open，造成重复打开
    // 和“附件刚 finish 就被旧 view 覆盖”的竞态。
    return { session: await this.viewOf(meta.id) }
  }

  private async deleteSession(sessionId: string): Promise<unknown> {
    const turnId = this.turnBySession.get(sessionId)
    if (turnId) this.cancelTurn(turnId)
    const meta = await this.sessions.getMeta(sessionId)
    await this.sessions.delete(sessionId)
    // 会话目录里的硬链接没了，回收不再被引用的共享 blob
    await this.attachments.gcAll()
    this.push({ type: 'push', kind: 'sessionDeleted', value: { sessionId } })
    if (meta) {
      this.push({ type: 'push', kind: 'sessions', value: { sessions: await this.listSessions() } })
    }
    return { deleted: true }
  }

  private async viewOf(sessionId: string): Promise<SessionView> {
    const open = await this.sessions.open(sessionId)
    if (!open) throw new Error('会话不存在')
    const artifacts = await this.artifacts.scan(sessionId)
    return {
      summary: this.sessions.summaryOf(open.meta, artifacts),
      messages: open.messages,
      attachments: attachmentsOf(open.meta),
      artifacts
    }
  }

  // ---------- 附件 ----------

  private async beginUpload(input: Record<string, unknown>): Promise<unknown> {
    const config = this.config ?? this.refreshConfig()
    let sessionId = str(input.sessionId)
    if (!sessionId) {
      const { providers } = await this.providers.list()
      const provider = providers[0]
      if (!provider) {
        throw codedError('provider-unavailable', '未安装或未启用任何 Agent 后端扩展')
      }
      const created = await this.sessions.create({
        provider: provider.info.id,
        workspace: this.currentWorkspace()
      })
      sessionId = created.id
      this.push({ type: 'push', kind: 'sessions', value: { sessions: await this.listSessions() } })
      this.push({ type: 'push', kind: 'session', value: { session: await this.viewOf(sessionId) } })
    }
    const maxBytes = (config.attachmentMaxMB || 32) * 1024 * 1024
    const begun = await this.attachments.begin({
      sessionId,
      name: str(input.name, 'attachment'),
      size: Number(input.size),
      mime: str(input.mime, 'application/octet-stream'),
      maxBytes
    })
    return begun
  }

  // ---------- turn ----------

  /**
   * 提示词预览（不改会话状态）。
   *
   * 用与 `startTurn` 完全相同的拼装逻辑生成这一轮会发给 Agent 的文本（系统规则
   * 在 `buildTurnPrompt` 里一起拼上），但不写会话状态。会话还没创建时只预览文本
   * 部分，目录用占位说明。
   */
  private async previewPrompt(input: Record<string, unknown>): Promise<{ prompt: string }> {
    const sessionId = str(input.sessionId)
    const meta = sessionId ? await this.sessions.getMeta(sessionId) : null
    const text = str(input.text).trim()
    const ids = Array.isArray(input.attachmentIds)
      ? [...new Set(input.attachmentIds.filter((item): item is string => typeof item === 'string'))]
      : []
    const attachments: StagedAttachment[] = []
    if (meta) {
      for (const id of ids) {
        const attachment = await this.sessions.findAttachment(meta.id, id)
        if (attachment) attachments.push(attachment)
      }
    }

    const inventory = await this.inventory.detect()
    const config = this.config ?? this.refreshConfig()
    return {
      prompt: buildTurnPrompt({
        userText: text,
        attachments,
        artifacts: meta ? await this.artifacts.scan(meta.id) : [],
        preparedDir: meta ? this.sessions.preparedDir(meta.id) : '（会话会在发送时创建）',
        inventoryLine: this.inventory.promptLine(inventory),
        systemPrompt: config.systemPrompt
      })
    }
  }

  private async startTurn(input: Record<string, unknown>): Promise<unknown> {
    const sessionId = str(input.sessionId)
    const meta = await this.sessions.getMeta(sessionId)
    if (!meta) throw new Error('会话不存在')
    if (this.turnBySession.has(sessionId)) throw new Error('这个会话正在运行，请先停止或等待完成')

    const text = str(input.text).trim()
    if (text.length > MAX_TURN_TEXT) throw new Error(`单条消息最多 ${MAX_TURN_TEXT} 字符`)

    const ids = Array.isArray(input.attachmentIds)
      ? [...new Set(input.attachmentIds.filter((item): item is string => typeof item === 'string'))]
      : []
    const attachments: StagedAttachment[] = []
    for (const id of ids) {
      const attachment = await this.sessions.findAttachment(sessionId, id)
      if (!attachment) throw new Error('附件已失效，请重新上传')
      attachments.push(attachment)
    }
    if (!text && attachments.length === 0) {
      throw new Error('请输入内容或添加附件')
    }

    const history = await this.sessions.readMessages(sessionId)
    const userMessage = await this.sessions.appendMessage(sessionId, {
      role: 'user',
      text,
      status: 'ok',
      attachmentIds: attachments.map(item => item.id),
      attachments: attachments.map(toAttachmentMeta),
      toolCalls: []
    })
    // 附件只属于这一条消息：从待发区移除（文件留在会话目录里供 Agent 读取）
    await this.sessions.removeAttachments(sessionId, attachments.map(item => item.id))
    if (attachments.length > 0) {
      const sent = new Set(attachments.map(item => item.id))
      meta.attachments = meta.attachments.filter(item => !sent.has(item.id))
      meta.attachmentCount = meta.attachments.length
    }
    await this.sessions.setStatus(sessionId, 'running')
    meta.status = 'running'

    const turnId = randomUUID()
    const turn: TurnRuntime = {
      turnId,
      sessionId,
      controller: new AbortController(),
      providerSession: null,
      cancelled: false
    }
    this.activeTurns.set(turnId, turn)
    this.turnBySession.set(sessionId, turnId)
    this.updateStatusBar()

    this.push({
      type: 'push',
      kind: 'turnStarted',
      value: { turnId, sessionId, message: userMessage }
    })
    this.push({
      type: 'push',
      kind: 'sessionSummary',
      value: { summary: await this.summaryOf(meta) }
    })

    void this.runTurn({
      turnId,
      sessionId,
      meta,
      text,
      attachments,
      history
    })

    return { turnId }
  }

  private async runTurn(input: TurnInput): Promise<void> {
    const turn = this.activeTurns.get(input.turnId)
    if (!turn) return
    let meta = input.meta
    let replay = ''
    let attempt = 0
    let outcome: TurnOutcome = {
      status: 'error',
      text: '',
      toolCalls: [],
      error: { code: 'provider-error', message: 'Agent 未返回结果' }
    }

    try {
      for (;;) {
        if (turn.cancelled || turn.controller.signal.aborted) {
          outcome = {
            status: 'cancelled',
            text: '',
            toolCalls: [],
            error: { code: 'cancelled', message: '已停止' }
          }
          break
        }
        const { providers } = await this.providers.list()
        const provider = providers.find(item => item.info.id === meta.provider)
        if (!provider) {
          outcome = {
            status: 'error',
            text: '',
            toolCalls: [],
            error: {
              code: 'config-invalid',
              message: `未知 provider：${meta.provider}，请安装或启用对应的 Agent 后端扩展`
            }
          }
          break
        }

        const inventory = await this.inventory.detect()
        let session: AgentSession
        try {
          session = await provider.createSession({
            hostSessionId: attempt === 0 ? meta.id : randomUUID(),
            providerSessionId: meta.providerSessionId,
            cwd: this.sessions.sessionDir(meta.id),
            signal: turn.controller.signal
          })
        } catch (err) {
          outcome = {
            status: 'error',
            text: '',
            toolCalls: [],
            error: errorOf(err)
          }
          break
        }

        turn.providerSession = session
        if (turn.cancelled || turn.controller.signal.aborted) {
          session.cancel('user')
        }
        const config = this.config ?? this.refreshConfig()
        const prompt = buildTurnPrompt({
          userText: input.text,
          attachments: input.attachments,
          artifacts: await this.artifacts.scan(meta.id),
          preparedDir: this.sessions.preparedDir(meta.id),
          inventoryLine: this.inventory.promptLine(inventory),
          replay,
          systemPrompt: config.systemPrompt
        })

        outcome = await this.runAttempt(input, session, prompt)
        const providerSessionId = session.providerSessionId
        if (providerSessionId && providerSessionId !== meta.providerSessionId) {
          await this.sessions.setProviderSessionId(meta.id, providerSessionId)
          meta.providerSessionId = providerSessionId
        }
        await session.dispose()
        turn.providerSession = null

        const retryable =
          !turn.cancelled &&
          attempt === 0 &&
          outcome.status === 'error' &&
          outcome.error?.code === 'provider-error' &&
          outcome.error.retryable === true &&
          Boolean(meta.providerSessionId)
        if (retryable) {
          await this.sessions.update(meta.id, { providerSessionId: undefined })
          meta.providerSessionId = undefined
          replay = buildReplay(input.history)
          attempt += 1
          continue
        }
        break
      }

      await this.completeTurn(input, outcome)
    } catch (err) {
      const error = errorOf(err)
      await this.completeTurn(input, {
        status: error.code === 'cancelled' ? 'cancelled' : 'error',
        text: '',
        toolCalls: [],
        error
      }).catch(() => undefined)
    } finally {
      if (turn.providerSession) {
        void turn.providerSession.dispose().catch(() => undefined)
      }
      turn.providerSession = null
      this.activeTurns.delete(input.turnId)
      this.turnBySession.delete(input.sessionId)
      this.updateStatusBar()
    }
  }

  private async runAttempt(
    input: TurnInput,
    session: AgentSession,
    prompt: string
  ): Promise<TurnOutcome> {
    const turn = this.activeTurns.get(input.turnId)
    const toolCalls = new Map<string, ToolCallView>()
    let text = ''
    let thinking = ''
    let usage: AgentUsage | undefined
    let costUsd: number | undefined
    let error: AgentError | undefined
    let terminal = false

    try {
      for await (const event of session.send({ turnId: input.turnId, prompt })) {
        this.push({
          type: 'push',
          kind: 'turnEvent',
          value: { turnId: input.turnId, sessionId: input.sessionId, event }
        })
        if (event.type === 'text') {
          text += event.delta
        } else if (event.type === 'thinking') {
          thinking += event.delta
        } else if (event.type === 'tool' && event.phase === 'start') {
          toolCalls.set(event.toolId, {
            toolId: event.toolId,
            name: event.name,
            kind: event.kind,
            inputSummary: event.inputSummary
          })
        } else if (event.type === 'tool' && event.phase === 'result') {
          const existing = toolCalls.get(event.toolId)
          toolCalls.set(event.toolId, {
            toolId: event.toolId,
            name: event.name ?? existing?.name ?? 'Tool',
            kind: existing?.kind ?? 'other',
            inputSummary: existing?.inputSummary ?? '',
            ok: event.ok,
            summary: event.summary
          })
        } else if (event.type === 'result') {
          text = event.text || text
          usage = event.usage
          costUsd = event.costUsd
          if (event.isError) {
            error = event.error ?? {
              code: 'provider-error',
              message: event.text || 'Agent 返回了错误'
            }
          }
          terminal = true
          break
        } else if (event.type === 'error') {
          error = event.error
          terminal = true
          break
        }
      }
    } catch (err) {
      error = errorOf(err)
      terminal = true
    }

    if (!terminal && !turn?.cancelled && !turn?.controller.signal.aborted) {
      error = { code: 'protocol-error', message: 'Agent 没有返回结果' }
    }
    if (!error && (turn?.cancelled || turn?.controller.signal.aborted)) {
      error = { code: 'cancelled', message: '已停止' }
    }
    const status: TurnOutcome['status'] = error
      ? error.code === 'cancelled'
        ? 'cancelled'
        : 'error'
      : 'ok'
    return {
      status,
      text,
      thinking: thinking || undefined,
      toolCalls: [...toolCalls.values()],
      usage,
      costUsd,
      error
    }
  }

  private async completeTurn(input: TurnInput, outcome: TurnOutcome): Promise<void> {
    const artifacts = await this.artifacts.scan(input.sessionId)
    const message: Omit<SessionMessage, 'seq' | 'createdAt'> = {
      role: 'assistant',
      text: outcome.text || outcome.error?.message || '',
      thinking: outcome.thinking,
      status: outcome.status,
      attachmentIds: [],
      toolCalls: outcome.toolCalls,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      error: outcome.error,
      artifacts
    }
    const stored = await this.sessions.appendMessage(input.sessionId, message)
    await this.sessions.setStatus(
      input.sessionId,
      outcome.status === 'ok' ? 'idle' : outcome.status === 'cancelled' ? 'interrupted' : 'error'
    )
    this.push({
      type: 'push',
      kind: 'turnFinished',
      value: {
        turnId: input.turnId,
        sessionId: input.sessionId,
        status: outcome.status,
        message: stored
      }
    })
    const meta = await this.sessions.getMeta(input.sessionId)
    if (meta) {
      this.push({
        type: 'push',
        kind: 'sessionSummary',
        value: { summary: await this.summaryOf(meta) }
      })
    }
    if (outcome.error && outcome.error.code !== 'cancelled') {
      this.output.error(`${outcome.error.code}: ${outcome.error.message}`)
    }
  }

  /**
   * 用户在面板里对「需要授权」的操作做出决定。
   *
   * 回合可能刚好结束（取消/超时）：这时静默返回，界面不用为此弹错误。
   */
  private respondPermission(input: Record<string, unknown>): { responded: boolean } {
    const turn = this.activeTurns.get(str(input.turnId))
    const requestId = str(input.requestId)
    if (!turn?.providerSession || !requestId) return { responded: false }
    turn.providerSession.respondPermission(
      requestId,
      input.allow === true ? 'allow' : 'deny'
    )
    return { responded: true }
  }

  private cancelTurn(turnId: string): boolean {
    const turn = this.activeTurns.get(turnId)
    if (!turn) return false
    turn.cancelled = true
    turn.providerSession?.cancel('user')
    turn.controller.abort()
    return true
  }

  private cancelAllTurns(): void {
    for (const turnId of [...this.activeTurns.keys()]) this.cancelTurn(turnId)
  }

  // ---------- 产物 / 写回 ----------

  private async previewArtifact(input: Record<string, unknown>): Promise<ArtifactPreview> {
    const sessionId = str(input.sessionId)
    const artifactPath = str(input.path)
    const preview = await this.artifacts.preview(sessionId, artifactPath)
    if (preview.kind === 'markdown' && preview.text) {
      try {
        const html = await imark.imark.renderMarkdown(preview.text)
        // 产物里的图片通常相对产物文件本身（如 summary/figures/a.png）
        preview.html = await inlineImageSources(
          html,
          this.sessions.sessionDir(sessionId),
          dirname(join(this.sessions.preparedDir(sessionId), artifactPath))
        )
      } catch {
        // 渲染失败时退回纯文本
      }
    }
    return preview
  }

  /**
   * 把当前打开的文档快照成一条普通附件，放进会话的待发区。
   *
   * 文档环境和会话环境是分开的：只有用户主动点「添加本文档」时才这样做。
   */
  private async attachDocument(input: Record<string, unknown>): Promise<unknown> {
    const sessionId = str(input.sessionId)
    if (!(await this.sessions.getMeta(sessionId))) throw new Error('会话不存在')
    const snapshot = this.documents.current()
    if (!snapshot) throw new Error('当前没有打开的文档')
    const config = this.config ?? this.refreshConfig()
    const maxBytes = (config.attachmentMaxMB || 32) * 1024 * 1024
    if (Buffer.byteLength(snapshot.text, 'utf8') > maxBytes) {
      throw new Error(`文档超过附件上限（${config.attachmentMaxMB} MB）`)
    }
    const attachment = await this.attachments.attachDocument(sessionId, snapshot)
    return { attachment: toAttachmentMeta(attachment) }
  }

  private async applyMessage(input: Record<string, unknown>): Promise<ApplyResult> {
    const sessionId = str(input.sessionId)
    const seq = Number(input.seq)
    if (!Number.isInteger(seq)) throw new Error('消息序号无效')
    const meta = await this.sessions.getMeta(sessionId)
    if (!meta) throw new Error('会话不存在')
    const message = await this.sessions.messageBySeq(sessionId, seq)
    if (!message) throw new Error('找不到这条消息')
    if (message.role !== 'assistant') throw new Error('只能写回 Agent 的回复')
    return this.documents.apply(message.text)
  }

  private async applyArtifact(input: Record<string, unknown>): Promise<ApplyResult> {
    const sessionId = str(input.sessionId)
    const text = await this.artifacts.readText(sessionId, str(input.path))
    return this.documents.apply(text)
  }

}

// ---------- 激活 ----------

let instance: AgentHost | null = null

export function activate(context: imark.ExtensionContext): void {
  const host = new AgentHost(context)
  instance = host
  void host
    .start()
    .catch(err => {
      const message = err instanceof Error ? err.message : String(err)
      void imark.window.showErrorMessage(`Agent Core 启动失败：${message}`)
    })
    .finally(() => host.markProvidersReady())
}

export function deactivate(): void {
  instance?.stop()
  instance = null
}
