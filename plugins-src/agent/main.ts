/**
 * 通用 Agent Host 扩展。
 *
 * 设计边界（用户明确要求）：
 * - 插件不解析附件：只把 webview 传来的字节落盘，给 Agent 绝对路径与工具权限；
 * - 怎么读文件（Read / Bash / 写脚本 / 调本地工具）由 Agent 自行决定；
 * - 插件不保留 Preprocessor/宿主解析器；Claude Code 只是第一个 provider；
 * - 当前文档只提供 document.md 快照，结果通过 TextEditor.edit 写回，不直接改 vault。
 */

import { randomUUID } from 'node:crypto'
import * as imark from 'imark'
import type {
  AgentError,
  AgentErrorCode,
  AgentMode,
  AgentSession,
  AgentTaskMode,
  AgentUsage,
  DocMeta,
  StagedAttachment
} from './core/types'
import type {
  ApplyResult,
  ArtifactPreview,
  HostPush,
  InitPayload,
  SessionSummary,
  SessionView,
  ToolCallView,
  TurnTarget,
  UiIntent
} from './core/protocol'
import { MAX_TURN_TEXT, toAttachmentMeta } from './core/protocol'
import { readConfig, safeConfigView, type AgentConfig } from './core/config'
import { AttachmentStager } from './core/attachments'
import { ArtifactStore } from './core/artifacts'
import { DocumentApplyError, DocumentBridge } from './core/document'
import { Inventory } from './core/inventory'
import { buildReplay, buildTurnPrompt, writeDocumentSnapshot } from './core/prompt'
import {
  attachmentsOf,
  SessionStore,
  toViewMessage,
  type SessionMeta,
  type StoredMessage
} from './core/sessions'
import { providerById, PROVIDERS } from './providers'

const VIEW_TYPE = 'imark.agent.chat'
const CMD_OPEN = 'imark.agent.openChat'
const CMD_GENERATE = 'imark.agent.generate'
const CMD_BEAUTIFY = 'imark.agent.beautify'
const CMD_CHECK = 'imark.agent.checkProvider'
const CMD_STOP = 'imark.agent.stop'

const DOC_PUSH_DEBOUNCE_MS = 80
const AGENT_ERROR_CODES = new Set<AgentErrorCode>([
  'cli-missing',
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
  'stale-document',
  'no-editor',
  'invalid-target',
  'edit-rejected',
  'not-found'
])

interface LineMenuArgs {
  values?: Record<string, unknown>
  line?: number
  source?: 'lineMenu'
}

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
  toolCalls: ToolCallView[]
  usage?: AgentUsage
  costUsd?: number
  error?: AgentError
}

interface TurnInput {
  turnId: string
  sessionId: string
  meta: SessionMeta
  taskMode: AgentTaskMode
  permissionMode: AgentMode
  text: string
  attachments: StagedAttachment[]
  documentPath?: string
  documentHash?: string
  documentTruncated?: boolean
  history: StoredMessage[]
  config: AgentConfig
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isTaskMode(value: unknown): value is AgentTaskMode {
  return value === 'ask' || value === 'generate' || value === 'beautify'
}

function isPermissionMode(value: unknown): value is AgentMode {
  return value === 'read-only' || value === 'read+parse'
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

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function parseTarget(value: unknown): TurnTarget {
  const raw = asRecord(value)
  const kind = str(raw.kind)
  if (kind === 'replace-all') return { kind: 'replace-all' }
  if (kind === 'insert-at-cursor') return { kind: 'insert-at-cursor' }
  if (kind === 'insert-below-line') {
    const line = Number(raw.line)
    return { kind: 'insert-below-line', line: Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0 }
  }
  throw new Error('未知的写入目标')
}

class AgentHost {
  private readonly sessions: SessionStore
  private readonly attachments: AttachmentStager
  private readonly artifacts: ArtifactStore
  private readonly documents = new DocumentBridge()
  private readonly inventory = new Inventory()
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
    this.output = imark.window.createOutputChannel('Agent')
  }

  async start(): Promise<void> {
    await this.sessions.init()
    await this.refreshConfig()

    this.context.subscriptions.push(
      imark.commands.registerCommand(CMD_OPEN, () => this.openChat()),
      imark.commands.registerCommand(CMD_GENERATE, (args?: LineMenuArgs) => this.generate(args)),
      imark.commands.registerCommand(CMD_BEAUTIFY, () => this.beautify()),
      imark.commands.registerCommand(CMD_CHECK, () => this.checkProvider()),
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
      })
    )

    this.statusItem = imark.window.createStatusBarItem(imark.StatusBarAlignment.Right, 95)
    this.statusItem.text = '$(hubot) Agent'
    this.statusItem.tooltip = '打开 Agent 对话'
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

  private async refreshConfig(): Promise<AgentConfig> {
    const { config, warnings } = await readConfig(this.context)
    this.config = config
    for (const warning of warnings) this.output.warn(warning)
    return config
  }

  private async onConfigChanged(): Promise<void> {
    if (this.disposed) return
    const config = await this.refreshConfig()
    this.push({
      type: 'push',
      kind: 'config',
      value: { config: safeConfigView(config) }
    })
  }

  private currentDocMeta(): DocMeta | null {
    return this.documents.meta(this.documents.current())
  }

  private async listSessions(documentKey: string): Promise<SessionSummary[]> {
    return this.sessions.list(documentKey)
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
      return
    }
    const panel = imark.window.createWebviewPanel(
      VIEW_TYPE,
      'Agent',
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
    void this.pushInitialState()
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
    const bootstrap = JSON.stringify({
      mode: 'chat',
      panelId: '',
      extensionId: this.context.extension.id,
      config: this.config ? safeConfigView(this.config) : {}
    }).replace(/</g, '\\u003c')
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob:; font-src ${csp}; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}' ${csp}; connect-src 'none'; frame-src 'none'; worker-src 'none';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent</title>
<link rel="stylesheet" href="${escapeAttr(styleUri.toString())}" />
</head>
<body>
<script type="application/json" id="imark-bootstrap">${bootstrap}</script>
<script nonce="${nonce}" src="${escapeAttr(scriptUri.toString())}"></script>
</body>
</html>`
  }

  private async pushInitialState(): Promise<void> {
    const doc = this.currentDocMeta()
    const sessions = doc ? await this.listSessions(doc.key) : []
    const payload: InitPayload = {
      providers: PROVIDERS.map(provider => ({ info: provider.info })),
      config: safeConfigView(this.config ?? (await this.refreshConfig())),
      doc,
      sessions,
      activeSessionId: sessions[0]?.id ?? null
    }
    this.push({ type: 'push', kind: 'init', value: payload })
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

  private async pushDocState(): Promise<void> {
    const doc = this.currentDocMeta()
    this.push({ type: 'push', kind: 'doc', value: { doc } })
    const sessions = doc ? await this.listSessions(doc.key) : []
    this.push({
      type: 'push',
      kind: 'sessions',
      value: { documentKey: doc?.key ?? 'no-document', sessions }
    })
  }

  private updateStatusBar(): void {
    if (!this.statusItem) return
    const running = this.activeTurns.size > 0
    this.statusItem.text = running ? '$(sync~spin) Agent' : '$(hubot) Agent'
    this.statusItem.tooltip = running ? 'Agent 正在运行' : '打开 Agent 对话'
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
      case 'session.update':
        return this.updateSession(asRecord(payload))
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
      case 'turn.cancel':
        return { cancelled: this.cancelTurn(str(asRecord(payload).turnId)) }
      case 'artifact.preview':
        return this.previewArtifact(asRecord(payload))
      case 'doc.apply':
        return this.applyMessage(asRecord(payload))
      case 'doc.applyArtifact':
        return this.applyArtifact(asRecord(payload))
      case 'markdown.render': {
        const text = str(asRecord(payload).text)
        if (text.length > 1024 * 1024) throw new Error('Markdown 文本过大')
        return { html: await imark.imark.renderMarkdown(text) }
      }
      default:
        throw new Error(`未知请求：${kind}`)
    }
  }

  // ---------- provider ----------

  private async detectProviders(): Promise<unknown> {
    const config = this.config ?? (await this.refreshConfig())
    const providers = await Promise.all(
      PROVIDERS.map(async provider => ({
        info: provider.info,
        detection: await provider.detect({ commandPath: config.commandPath })
      }))
    )
    return { providers }
  }

  private async checkProvider(): Promise<void> {
    const config = this.config ?? (await this.refreshConfig())
    const provider = providerById(config.provider) ?? PROVIDERS[0]
    const detection = await provider.detect({ commandPath: config.commandPath })
    if (detection.available) {
      await imark.window.showInformationMessage(
        `${provider.info.label} 可用${detection.version ? `（${detection.version}）` : ''}`
      )
      return
    }
    const message = detection.error?.message ?? 'Agent 不可用'
    this.pushError('provider', detection.error ?? { code: 'provider-error', message })
    await imark.window.showErrorMessage(message)
  }

  // ---------- 会话 ----------

  private async createSession(input: Record<string, unknown>): Promise<unknown> {
    const config = this.config ?? (await this.refreshConfig())
    const providerId = str(input.provider, config.provider)
    if (!providerById(providerId)) throw new Error(`未知 provider：${providerId}`)
    const mode = isPermissionMode(input.mode) ? input.mode : config.mode
    const documentKey = str(input.documentKey, 'no-document')
    const documentName = str(input.documentName, '未关联文档')
    const meta = await this.sessions.create({
      documentKey,
      documentName,
      provider: providerId,
      model: str(input.model, config.model) || undefined,
      mode
    })
    // 不在这里 push sessions：webview 的 createSession 请求会拿到同一份 view；
    // 额外 push 会让列表处理器在 state.session 还没赋值时自动 open，造成重复打开
    // 和“附件刚 finish 就被旧 view 覆盖”的竞态。
    return { session: await this.viewOf(meta.id) }
  }

  private async updateSession(input: Record<string, unknown>): Promise<unknown> {
    const sessionId = str(input.sessionId)
    const patch = asRecord(input.patch)
    const update: { model?: string; mode?: AgentMode } = {}
    if (typeof patch.model === 'string') update.model = patch.model.trim() || undefined
    if (isPermissionMode(patch.mode)) update.mode = patch.mode
    const meta = await this.sessions.update(sessionId, update)
    const summary = await this.summaryOf(meta)
    this.push({ type: 'push', kind: 'sessionSummary', value: { summary } })
    return { summary }
  }

  private async deleteSession(sessionId: string): Promise<unknown> {
    const turnId = this.turnBySession.get(sessionId)
    if (turnId) this.cancelTurn(turnId)
    const meta = await this.sessions.getMeta(sessionId)
    await this.sessions.delete(sessionId)
    this.push({ type: 'push', kind: 'sessionDeleted', value: { sessionId } })
    if (meta) {
      this.push({
        type: 'push',
        kind: 'sessions',
        value: { documentKey: meta.documentKey, sessions: await this.listSessions(meta.documentKey) }
      })
    }
    return { deleted: true }
  }

  private async viewOf(sessionId: string): Promise<SessionView> {
    const open = await this.sessions.open(sessionId)
    if (!open) throw new Error('会话不存在')
    const artifacts = await this.artifacts.scan(sessionId)
    return {
      summary: this.sessions.summaryOf(open.meta, artifacts),
      messages: open.messages.map(toViewMessage),
      attachments: attachmentsOf(open.meta),
      artifacts
    }
  }

  // ---------- 附件 ----------

  private async beginUpload(input: Record<string, unknown>): Promise<unknown> {
    const config = this.config ?? (await this.refreshConfig())
    let sessionId = str(input.sessionId)
    if (!sessionId) {
      const documentKey = str(input.documentKey, 'no-document')
      const documentName = str(input.documentName, '未关联文档')
      const created = await this.sessions.create({
        documentKey,
        documentName,
        provider: config.provider,
        model: config.model || undefined,
        mode: config.mode
      })
      sessionId = created.id
      this.push({
        type: 'push',
        kind: 'sessions',
        value: { documentKey, sessions: await this.listSessions(documentKey) }
      })
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

  private async startTurn(input: Record<string, unknown>): Promise<unknown> {
    const sessionId = str(input.sessionId)
    const meta = await this.sessions.getMeta(sessionId)
    if (!meta) throw new Error('会话不存在')
    if (this.turnBySession.has(sessionId)) throw new Error('这个会话正在运行，请先停止或等待完成')

    const taskMode = isTaskMode(input.mode) ? input.mode : 'ask'
    const permissionMode = isPermissionMode(input.permissionMode)
      ? input.permissionMode
      : meta.mode
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
    if (!text && attachments.length === 0 && taskMode !== 'beautify') {
      throw new Error('请输入内容或添加附件')
    }

    const snapshot = this.documents.current()
    if (taskMode === 'beautify' && !snapshot) throw new Error('请先打开要整理的文档')
    if (snapshot && meta.documentKey !== snapshot.key) {
      throw new Error('当前打开的文档与会话不一致，请新建会话')
    }

    let documentPath: string | undefined
    let documentHash: string | undefined
    let documentTruncated = false
    if (taskMode !== 'generate' && snapshot) {
      const written = await writeDocumentSnapshot(this.sessions, sessionId, snapshot)
      documentPath = written.path
      documentHash = written.hash
      documentTruncated = written.truncated
    }

    const history = await this.sessions.readMessages(sessionId)
    if (permissionMode !== meta.mode) {
      await this.sessions.update(sessionId, { mode: permissionMode })
      meta.mode = permissionMode
    }
    const userMessage = await this.sessions.appendMessage(sessionId, {
      role: 'user',
      text,
      status: 'ok',
      mode: taskMode,
      attachmentIds: attachments.map(item => item.id),
      toolCalls: []
    })
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
      value: { turnId, sessionId, message: toViewMessage(userMessage) }
    })
    this.push({
      type: 'push',
      kind: 'sessionSummary',
      value: { summary: await this.summaryOf(meta) }
    })

    const config = this.config ?? (await this.refreshConfig())
    void this.runTurn({
      turnId,
      sessionId,
      meta,
      taskMode,
      permissionMode,
      text,
      attachments,
      documentPath,
      documentHash,
      documentTruncated,
      history,
      config
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
        const provider = providerById(meta.provider)
        if (!provider) {
          outcome = {
            status: 'error',
            text: '',
            toolCalls: [],
            error: { code: 'config-invalid', message: `未知 provider：${meta.provider}` }
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
            mode: input.permissionMode,
            isolation: input.config.isolation,
            model: meta.model || input.config.model,
            timeoutMs: input.config.timeoutSec * 1000,
            maxTurns: input.config.maxTurns,
            extraArgs: input.config.extraArgs,
            apiKey: input.config.apiKey,
            commandPath: input.config.commandPath,
            availableCommands: inventory.available,
            signal: turn.controller.signal
          })
        } catch (err) {
          const error = errorOf(err)
          outcome = {
            status: 'error',
            text: '',
            toolCalls: [],
            error:
              error.code === 'provider-error' && /未找到|不存在|安装/i.test(error.message)
                ? { code: 'cli-missing', message: error.message }
                : error
          }
          break
        }

        turn.providerSession = session
        if (turn.cancelled || turn.controller.signal.aborted) {
          session.cancel('user')
        }
        const prompt = buildTurnPrompt({
          mode: input.taskMode,
          userText: input.text,
          documentPath: input.documentPath,
          documentTruncated: input.documentTruncated,
          attachments: input.attachments,
          artifacts: await this.artifacts.scan(meta.id),
          preparedDir: this.sessions.preparedDir(meta.id),
          inventoryLine: this.inventory.promptLine(inventory),
          isReadOnly: input.permissionMode === 'read-only',
          replay
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
    return { status, text, toolCalls: [...toolCalls.values()], usage, costUsd, error }
  }

  private async completeTurn(input: TurnInput, outcome: TurnOutcome): Promise<void> {
    const artifacts = await this.artifacts.scan(input.sessionId)
    const message: Omit<StoredMessage, 'seq' | 'createdAt'> = {
      role: 'assistant',
      text: outcome.text || outcome.error?.message || '',
      status: outcome.status,
      mode: input.taskMode,
      attachmentIds: [],
      toolCalls: outcome.toolCalls,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      error: outcome.error,
      artifacts,
      docHash: input.documentHash
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
        message: toViewMessage(stored),
        artifacts
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
    const preview = await this.artifacts.preview(sessionId, str(input.path))
    if (preview.kind === 'markdown' && preview.text) {
      try {
        preview.html = await imark.imark.renderMarkdown(preview.text)
      } catch {
        // 渲染失败时退回纯文本
      }
    }
    return preview
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
    const target = parseTarget(input.target)
    return this.documents.apply(message.text, target, {
      expectedKey: meta.documentKey === 'no-document' ? undefined : meta.documentKey,
      expectedHash: message.docHash,
      force: input.force === true
    })
  }

  private async applyArtifact(input: Record<string, unknown>): Promise<ApplyResult> {
    const sessionId = str(input.sessionId)
    const meta = await this.sessions.getMeta(sessionId)
    if (!meta) throw new Error('会话不存在')
    const text = await this.artifacts.readText(sessionId, str(input.path))
    const target = parseTarget(input.target)
    return this.documents.apply(text, target, {
      expectedKey: meta.documentKey === 'no-document' ? undefined : meta.documentKey,
      force: input.force === true
    })
  }

  // ---------- 命令入口 ----------

  private generate(args?: LineMenuArgs): void {
    const prompt = str(args?.values?.prompt)
    const line = Math.max(0, Math.trunc(Number(args?.line ?? 1)) - 1)
    void this.openIntent(
      'generate',
      prompt,
      { kind: 'insert-below-line', line },
      Boolean(prompt)
    )
  }

  private beautify(): void {
    if (!this.documents.current()) {
      void imark.window.showWarningMessage('请先打开一个 Markdown 文档')
      return
    }
    void this.openIntent('beautify', '', { kind: 'replace-all' }, true)
  }

  private async openIntent(
    taskMode: AgentTaskMode,
    prompt: string,
    target: TurnTarget,
    auto: boolean
  ): Promise<void> {
    this.openChat()
    const doc = this.currentDocMeta()
    const documentKey = doc?.key ?? 'no-document'
    const documentName = doc?.fileName ?? '未关联文档'
    const config = this.config ?? (await this.refreshConfig())
    const list = await this.listSessions(documentKey)
    let sessionId = list[0]?.id
    if (!sessionId) {
      const meta = await this.sessions.create({
        documentKey,
        documentName,
        provider: config.provider,
        model: config.model || undefined,
        mode: config.mode
      })
      sessionId = meta.id
      this.push({
        type: 'push',
        kind: 'sessions',
        value: { documentKey, sessions: await this.listSessions(documentKey) }
      })
    }
    this.push({ type: 'push', kind: 'session', value: { session: await this.viewOf(sessionId) } })
    const intent: UiIntent = { mode: taskMode, prompt: prompt || undefined, target, auto }
    this.push({ type: 'push', kind: 'uiIntent', value: intent })
  }
}

// ---------- 激活 ----------

let instance: AgentHost | null = null

export function activate(context: imark.ExtensionContext): void {
  instance = new AgentHost(context)
  void instance.start().catch(err => {
    const message = err instanceof Error ? err.message : String(err)
    void imark.window.showErrorMessage(`Agent 启动失败：${message}`)
  })
}

export function deactivate(): void {
  instance?.stop()
  instance = null
}
