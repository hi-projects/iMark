/**
 * AI for Edit —— 扩展宿主侧。
 *
 * 它负责配置、密钥、网络、提示词与文档编辑；界面全部在 webview 里
 * （`webview/chat.ts` 与 `webview/character.ts`）。扩展不把密钥、提示词以外的
 * 请求细节交给 webview，也不让 webview 直接碰编辑器 —— 所有编辑都经
 * `TextEditor.edit` 回到 renderer 的同一个 CM6 transaction。
 *
 * 与 webview 的协议（`webview/shim.ts` 那一侧）：
 *   config（扩展 → 页面）   配置快照；密钥不在其中
 *   doc（扩展 → 页面）      活动文档快照：key/文件名/版本/正文/光标
 *   renderApi（页面 → 扩展） 页面的单向通道：ai.chat / ai.beautify / …
 *   request/response        markdown.render 与 doc.applyEdits 的请求/应答
 *   chat.open / close       小人点击打开对话 / 对话面板要求关闭
 *
 * 正文只在用户确认后写入：AI 结果先回到面板预览，`view.dispatch` 在 shim 里
 * 被翻译成一次 `TextEditor.edit`。扩展从不主动改文档。
 */

import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import * as imark from 'imark'
import {
  AiError,
  callAi,
  modelSummary,
  readAiConfig,
  requestChat,
  type AiConfigSource,
  type AiResult,
  type ChatImage,
  type ChatMessage
} from './aiClient'
import {
  hasTextAttachments,
  imageNoteForAttachments,
  joinDocument,
  normalizeAiOutput,
  normalizeChatText,
  splitFrontMatter,
  systemPromptForBeautify,
  systemPromptForChat,
  systemPromptForGenerate,
  userPromptForBeautify,
  userPromptForGenerate
} from './prompts'
import type { AttachmentImageUploadRef, ChatHistoryItem } from './protocol'

const SECTION = 'imark.ai-for-edit'
const CHAT_VIEW_TYPE = 'imark.ai-for-edit.chat'
const CHARACTER_VIEW_TYPE = 'imark.ai-for-edit.character'

const CMD_OPEN_CHAT = 'imark.ai-for-edit.openChat'
const CMD_GENERATE = 'imark.ai-for-edit.generate'
const CMD_TEST_CONNECTION = 'imark.ai-for-edit.testConnection'
const CMD_TEST_TARGET = 'imark.ai-for-edit.testTarget'

/** 发给 AI 的正文上限；webview 也用这个值拒绝过大的文档 */
const MAX_INPUT_CHARS = 120_000
/** AI 返回内容的字符上限 */
const MAX_OUTPUT_CHARS = 180_000
/** 行首菜单对话框里那句话 / 对话输入的长度上限 */
const MAX_PROMPT_CHARS = 4_000
const MAX_CHAT_CHARS = 4_000
/** 设置页里的自定义 system 提示词上限 */
const MAX_SYSTEM_PROMPT_CHARS = 20_000
/** 对话历史只带最近若干轮；每条也截断 */
const MAX_HISTORY_ITEMS = 12
const MAX_HISTORY_TEXT = 2_000
/** 参考文件二次校验（webview 已经截断过一次） */
const MAX_ATTACHMENTS = 6
const MAX_ATTACHMENT_CHARS = 24_000
const MAX_ATTACHMENTS_TOTAL = 40_000
/** 与 webview 的消息上限对齐，并留出 JSON 转义余量 */
const MAX_MESSAGE_CHARS = 240 * 1024
/** 扫描页图片的二次校验 */
const MAX_SCAN_IMAGES = 16
const MAX_SCAN_IMAGE_CHARS = 200_000
const MAX_SCAN_IMAGE_TOTAL_CHARS = 2_800_000
/** 等齐一组图片的上限 */
const IMAGE_UPLOAD_WAIT_MS = 5_000
/** 没有被任何请求取走的图片最多留这么久 */
const IMAGE_UPLOAD_TTL_MS = 2 * 60_000
const MAX_IMAGE_UPLOADS = 32
const IMAGE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/
/** 文档快照的防抖：连续输入时不必每个按键都往 webview 送一遍全文 */
const DOC_PUSH_DEBOUNCE_MS = 80

interface AiTextResult {
  text: string
  model: string
  /** 只有对话回答会带：达到输出上限时仍展示，但标注可能不完整 */
  truncated?: boolean
}

/** main 层内部使用的图片：已经从 `attach.image` 上传里解析出来 */
interface ResolvedImage {
  page: number
  mediaType: 'image/jpeg' | 'image/png'
  data: string
  width: number
  height: number
}

/** 参考文件 + 它的扫描页图片 */
interface ResolvedAttachment {
  name: string
  text: string
  images: ResolvedImage[]
}

/** 一组正在分条上传的扫描页图片 */
interface ImageUpload {
  id: string
  total: number
  name: string
  images: Map<number, ResolvedImage>
  chars: number
  at: number
}

/** 行首「+」菜单传进来的参数 */
interface LineMenuArgs {
  values?: Record<string, unknown>
  /** 点「+」时的那一行（1 基）；缺失时用当前光标行 */
  line?: number
  source?: string
}

interface TargetActionArgs {
  targetId?: string
  source?: string
}

interface DocSnapshot {
  key: string
  fileName: string
  filePath: string | null
  version: number
  text: string
  selectionHead: number
  editable: boolean
}

class AiForEditExtension {
  private readonly aborts = new Set<AbortController>()
  /** 面板发起的 AI 请求：request id → 可取消的 controller */
  private readonly aiJobs = new Map<string, AbortController>()
  /** 正在分条上传的扫描页图片：upload id → 已到的图片 */
  private readonly imageUploads = new Map<string, ImageUpload>()
  private readonly output: imark.OutputChannel
  private chatPanel: imark.WebviewPanel | null = null
  private characterPanel: imark.WebviewPanel | null = null
  private statusItem: imark.StatusBarItem | null = null
  private docTimer: NodeJS.Timeout | null = null
  private busy = false
  private disposed = false

  constructor(private readonly context: imark.ExtensionContext) {
    this.output = imark.window.createOutputChannel('AI for Edit')
  }

  // ---------- 生命周期 ----------

  start(): void {
    this.context.subscriptions.push(
      imark.commands.registerCommand(CMD_OPEN_CHAT, () => this.openChat()),
      imark.commands.registerCommand(CMD_GENERATE, (args?: LineMenuArgs) =>
        this.generate(args)
      ),
      imark.commands.registerCommand(CMD_TEST_CONNECTION, () => this.testConnection()),
      imark.commands.registerCommand(CMD_TEST_TARGET, (args?: TargetActionArgs) =>
        this.testConnection(args?.targetId)
      )
    )

    this.statusItem = imark.window.createStatusBarItem(imark.StatusBarAlignment.Right, 100)
    this.statusItem.text = '$(sparkles) AI'
    this.statusItem.tooltip = '打开 AI 对话'
    this.statusItem.command = CMD_OPEN_CHAT
    this.statusItem.show()
    this.context.subscriptions.push(this.statusItem)

    // 只有 chat 有序列化器；character 每次启动按配置重建，不跨启动恢复
    this.context.subscriptions.push(
      imark.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
        deserializeWebviewPanel: async panel => {
          this.adoptChatPanel(panel)
        }
      })
    )

    this.context.subscriptions.push(
      imark.window.onDidChangeActiveTextEditor(() => this.scheduleDoc(true)),
      imark.window.onDidChangeTextEditorSelection(() => this.scheduleDoc()),
      imark.workspace.onDidChangeTextDocument(event => {
        const active = imark.window.activeTextEditor
        if (!active) return
        if (event.document.uri.toString() === active.document.uri.toString()) {
          this.scheduleDoc()
        }
      }),
      imark.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(SECTION)) this.onConfigChanged()
      })
    )

    this.syncCharacterPanel()
  }

  stop(): void {
    this.disposed = true
    if (this.docTimer) {
      clearTimeout(this.docTimer)
      this.docTimer = null
    }
    this.cancelInFlight()
    this.chatPanel?.dispose()
    this.chatPanel = null
    this.characterPanel?.dispose()
    this.characterPanel = null
    this.statusItem?.dispose()
    this.statusItem = null
    this.output.dispose()
  }

  private onConfigChanged(): void {
    // 地址/密钥可能刚变：不要把在途请求继续发向旧地址
    this.cancelInFlight()
    this.syncCharacterPanel()
    const config = this.configSnapshot()
    this.postToChat({ type: 'config', config })
    this.characterPanel?.webview.postMessage({ type: 'config', config })
  }

  // ---------- 配置与密钥 ----------

  private getConfig(): imark.WorkspaceConfiguration {
    return imark.workspace.getConfiguration(SECTION)
  }

  private configGet<T>(key: string, fallback: T): T {
    return this.getConfig().get<T>(key, fallback)
  }

  private configSnapshot(): Record<string, unknown> {
    return {
      endpoints: this.configGet<unknown>('endpoints', []),
      generatePrompt: this.configGet<string>('generatePrompt', ''),
      beautifyPrompt: this.configGet<string>('beautifyPrompt', ''),
      timeoutSec: this.configGet<number>('timeoutSec', 60),
      scannedPdfImages: this.configGet<boolean>('scannedPdfImages', true),
      characterEnabled: this.configGet<boolean>('characterEnabled', true),
      characterStyle: this.configGet<string>('characterStyle', 'cat')
    }
  }

  private configSource(): AiConfigSource {
    return {
      get: key => this.getConfig().get(key),
      getSecret: key => this.context.secrets.get(key)
    }
  }

  // ---------- 面板 ----------

  private openChat(): void {
    if (this.disposed) return
    if (this.chatPanel) return
    const panel = imark.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      'AI 对话',
      { viewColumn: imark.ViewColumn.One },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
        imark: { presentation: 'sidebar', width: 420 }
      }
    )
    this.adoptChatPanel(panel)
  }

  private adoptChatPanel(panel: imark.WebviewPanel): void {
    if (this.disposed) {
      panel.dispose()
      return
    }
    if (this.chatPanel && this.chatPanel !== panel) this.chatPanel.dispose()
    this.chatPanel = panel

    this.context.subscriptions.push(
      panel.webview.onDidReceiveMessage(message => {
        void this.onChatMessage(message).catch(err => {
          this.log('warn', `处理界面消息失败：${errorText(err)}`)
        })
      }),
      panel.onDidDispose(() => {
        if (this.chatPanel !== panel) return
        this.chatPanel = null
        // 面板关掉后，在途请求的回复已经没有去处；一并取消，避免占着 busy
        this.cancelInFlight()
      })
    )

    panel.webview.html = this.panelHtml(panel, 'chat')
    this.pushDoc()
  }

  private syncCharacterPanel(): void {
    if (this.disposed) return
    const enabled = this.configGet<boolean>('characterEnabled', true) !== false
    if (!enabled) {
      this.characterPanel?.dispose()
      this.characterPanel = null
      return
    }
    if (this.characterPanel) return

    const panel = imark.window.createWebviewPanel(
      CHARACTER_VIEW_TYPE,
      'AI 助手',
      { viewColumn: imark.ViewColumn.One },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
        imark: {
          presentation: 'floating',
          transparent: true,
          anchor: 'bottom-right',
          width: 108,
          height: 128
        }
      }
    )
    this.characterPanel = panel
    this.context.subscriptions.push(
      panel.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return
        const type = (message as { type?: unknown }).type
        if (type === 'chat.open') this.openChat()
      }),
      panel.onDidDispose(() => {
        if (this.characterPanel === panel) this.characterPanel = null
      })
    )
    panel.webview.html = this.panelHtml(panel, 'character')
  }

  private panelHtml(panel: imark.WebviewPanel, mode: 'chat' | 'character'): string {
    const nonce = randomBytes(16).toString('base64')
    const csp = panel.webview.cspSource
    const entry = mode === 'chat' ? 'chat.js' : 'character.js'
    const scriptUri = panel.webview.asWebviewUri(
      imark.Uri.joinPath(this.context.extensionUri, 'webview', entry)
    )
    const bootstrap = JSON.stringify({
      mode,
      panelId: '',
      extensionId: this.context.extension.id,
      config: this.configSnapshot()
    }).replace(/</g, '\\u003c')

    const title = mode === 'chat' ? 'AI 对话' : 'AI 助手'
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob:; font-src ${csp}; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}' ${csp}; connect-src https: http: ws: wss:; frame-src 'none'; worker-src blob: ${csp};" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
</head>
<body>
<script type="application/json" id="imark-bootstrap">${bootstrap}</script>
<script nonce="${nonce}" src="${escapeAttr(scriptUri.toString())}"></script>
</body>
</html>`
  }

  // ---------- 文档快照 ----------

  private scheduleDoc(immediate = false): void {
    if (!this.chatPanel) return
    if (immediate) {
      if (this.docTimer) {
        clearTimeout(this.docTimer)
        this.docTimer = null
      }
      this.pushDoc()
      return
    }
    if (this.docTimer) return
    this.docTimer = setTimeout(() => {
      this.docTimer = null
      this.pushDoc()
    }, DOC_PUSH_DEBOUNCE_MS)
  }

  private pushDoc(): void {
    if (!this.chatPanel) return
    void this.chatPanel.webview.postMessage({ type: 'doc', doc: this.docSnapshot() })
  }

  private docSnapshot(): DocSnapshot {
    const editor = imark.window.activeTextEditor
    if (!editor) {
      return {
        key: 'no-document',
        fileName: '未关联文档',
        filePath: null,
        version: 0,
        text: '',
        selectionHead: 0,
        editable: false
      }
    }
    const document = editor.document
    const text = document.getText()
    const fsPath = document.uri.scheme === 'file' ? document.uri.fsPath : ''
    const name = fsPath ? basename(fsPath) : document.uri.path.replace(/^\/+/, '') || '未命名'
    return {
      key: document.uri.toString(),
      fileName: name,
      filePath: fsPath || null,
      version: document.version,
      text,
      selectionHead: document.offsetAt(editor.selection.active),
      editable: true
    }
  }

  private postToChat(message: unknown): void {
    if (!this.chatPanel) return
    void this.chatPanel.webview.postMessage(message)
  }

  private postRenderMessage(channel: string, data: unknown): void {
    this.postToChat({ type: 'renderApi', channel, data })
  }

  // ---------- webview 消息 ----------

  private async onChatMessage(raw: unknown): Promise<void> {
    if (this.disposed || !raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    const type = message.type

    if (type === 'renderApi') {
      const channel = typeof message.channel === 'string' ? message.channel : ''
      if (!channel) return
      await this.onRenderMessage(channel, message.data)
      return
    }
    if (type === 'request') {
      await this.onRequest(message)
      return
    }
    if (type === 'close') {
      this.chatPanel?.dispose()
    }
  }

  private async onRequest(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : ''
    if (!id) return
    const kind = typeof message.kind === 'string' ? message.kind : ''

    try {
      if (kind === 'markdown.render') {
        const text = typeof message.text === 'string' ? message.text : ''
        const html = await imark.imark.renderMarkdown(text)
        this.replyRequest(id, true, html)
        return
      }
      if (kind === 'doc.applyEdits') {
        const result = await this.applyEdits(message)
        this.replyRequest(id, true, result)
        return
      }
      throw new AiError(`未知的界面请求：${kind || '(空)'}`)
    } catch (err) {
      this.replyRequest(id, false, undefined, errorText(err))
    }
  }

  private replyRequest(id: string, ok: boolean, value?: unknown, error?: string): void {
    this.postToChat({
      type: 'response',
      id,
      ok,
      ...(ok ? { value } : { error: error || '请求失败' })
    })
  }

  /**
   * webview 里的伪 `view.dispatch`。
   *
   * 只接受与页面当前文档一致的编辑：聊天面板的文档快照可能落后于一次快速切换，
   * 把编辑打到另一篇文档上比失败更糟。CM6 的偏移与 JS 字符串下标一致，
   * `positionAt` 按 UTF-16 计算，不需要额外换算。
   */
  private async applyEdits(message: Record<string, unknown>): Promise<{ version: number }> {
    const editor = imark.window.activeTextEditor
    if (!editor) throw new AiError('当前没有打开的文档，无法写入')
    const key = typeof message.key === 'string' ? message.key : ''
    const document = editor.document
    if (key && document.uri.toString() !== key) {
      throw new AiError('文档已经切换，请重新确认')
    }

    const rawEdits = Array.isArray(message.edits) ? message.edits : []
    const edits: { from: number; to: number; insert: string }[] = []
    const text = document.getText()
    for (const item of rawEdits) {
      if (!item || typeof item !== 'object') continue
      const edit = item as Record<string, unknown>
      const from = clampOffset(Number(edit.from), text.length)
      const to = clampOffset(Number(edit.to), text.length)
      const insert = typeof edit.insert === 'string' ? edit.insert : ''
      edits.push({ from: Math.min(from, to), to: Math.max(from, to), insert })
    }
    if (edits.length === 0) return { version: document.version }

    const ok = await editor.edit(edit => {
      for (const change of edits) {
        edit.replace(
          new imark.Range(document.positionAt(change.from), document.positionAt(change.to)),
          change.insert
        )
      }
    })
    if (!ok) throw new AiError('文档拒绝修改')

    if (typeof message.selection === 'number') {
      const offset = clampOffset(message.selection, text.length)
      editor.setSelection(document.positionAt(offset))
    }
    return { version: document.version }
  }

  /** webview 的单向消息通道 */
  private async onRenderMessage(channel: string, data: unknown): Promise<void> {
    const payload = (data ?? {}) as Record<string, unknown>
    const id = typeof payload.id === 'string' ? payload.id : ''

    if (channel === 'attach.image') {
      this.acceptImageUpload(payload)
      return
    }

    if (channel === 'ai.beautify') {
      if (!id) return
      const text = typeof payload.text === 'string' ? payload.text : ''
      const instruction = typeof payload.instruction === 'string' ? payload.instruction : ''
      if (!text) {
        await this.replyAi(id, { ok: false, message: '没有收到文档内容' })
        return
      }
      let attachments: ResolvedAttachment[]
      try {
        attachments = await this.readAttachments(payload.attachments)
      } catch (err) {
        await this.replyAi(id, { ok: false, ...this.toFailure(err) })
        return
      }
      void this.handlePanelAi(
        id,
        controller => this.runBeautify(text, instruction, attachments, controller),
        '美化结果已生成，等待确认'
      )
      return
    }

    if (channel === 'ai.generate') {
      if (!id) return
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
      let attachments: ResolvedAttachment[]
      try {
        attachments = await this.readAttachments(payload.attachments)
      } catch (err) {
        await this.replyAi(id, { ok: false, ...this.toFailure(err) })
        return
      }
      void this.handlePanelAi(
        id,
        controller => this.runGenerate(prompt, attachments, controller),
        '生成结果已生成，等待确认'
      )
      return
    }

    if (channel === 'ai.chat') {
      await this.startChat(payload)
      return
    }

    if (channel === 'ai.cancel') {
      if (id) this.cancelAi(id)
      return
    }
  }

  private async startChat(payload: Record<string, unknown>): Promise<void> {
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!id) return
    const message = typeof payload.message === 'string' ? payload.message : ''
    const text = typeof payload.text === 'string' ? payload.text : ''

    const history: ChatMessage[] = []
    const raw = Array.isArray(payload.history) ? payload.history : []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const entry = item as ChatHistoryItem
      const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null
      const content = typeof entry.content === 'string' ? entry.content.trim() : ''
      if (!role || !content) continue
      history.push({ role, content: content.slice(0, MAX_HISTORY_TEXT) })
    }

    let attachments: ResolvedAttachment[]
    try {
      attachments = await this.readAttachments(payload.attachments)
    } catch (err) {
      await this.replyAi(id, { ok: false, ...this.toFailure(err) })
      return
    }
    void this.handlePanelAi(
      id,
      controller =>
        this.runChat(
          text,
          message,
          history.slice(-MAX_HISTORY_ITEMS),
          attachments,
          controller
        ),
      '对话回复已生成'
    )
  }

  // ---------- 命令 ----------

  /**
   * 行首「+」菜单的生成动作。
   *
   * 空文档：打开对话面板，由用户在预览里确认后整篇写入。
   * 非空文档：直接生成并插入到光标行 / 菜单行下方，不进预览 —— 这时写入是
   * 用户点「AI 生成内容」时就已经预期的事，而且只追加、不覆盖原文。
   */
  private async generate(args?: LineMenuArgs): Promise<void> {
    const prompt =
      typeof args?.values?.prompt === 'string' ? args.values.prompt.trim() : ''
    if (!prompt) {
      await imark.window.showWarningMessage('请填写想生成的内容')
      return
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      await imark.window.showWarningMessage(
        `生成要求太长（${prompt.length} 字符），最多 ${MAX_PROMPT_CHARS} 字符`
      )
      return
    }
    if (this.busy) {
      await imark.window.showWarningMessage('AI 正在处理上一个请求，请稍候')
      return
    }

    const editor = imark.window.activeTextEditor
    if (!editor) {
      await imark.window.showWarningMessage('请先打开一个 Markdown 文档')
      return
    }

    if (editor.document.getText().trim() === '') {
      this.openChat()
      this.postRenderMessage('preview.open', { mode: 'generate', prompt, auto: true })
      this.report({ status: 'idle', message: '已打开生成对话，确认后才会写入文档' })
      return
    }

    this.busy = true
    const controller = this.newAbort()
    const key = editor.document.uri.toString()
    try {
      this.report({ status: 'running', message: '正在生成内容…' })
      const result = await this.runGenerate(prompt, [], controller)
      if (this.disposed) return

      // 生成期间用户可能切换了文档；写入原文档比写到当前文档更符合预期，
      // 但文档已经关闭时宁可失败也不重新打开它。
      if (editor.document.isClosed) throw new AiError('文档已关闭，生成结果没有写入')
      if (imark.window.activeTextEditor?.document.uri.toString() !== key) {
        throw new AiError('生成期间切换了文档，结果没有写入', '请回到原文档后重试')
      }

      await insertBlockBelow(editor, args?.line, result.text)
      this.report({
        status: 'ok',
        lastRunAt: Date.now(),
        message: `已生成 ${result.text.length} 个字符`
      })
    } catch (err) {
      const failure = this.toFailure(err)
      this.report({
        status: 'idle',
        lastRunAt: Date.now(),
        message: `上次失败：${failure.message}`
      })
      await imark.window.showErrorMessage(
        failure.detail ? `${failure.message}（${failure.detail}）` : failure.message
      )
    } finally {
      this.aborts.delete(controller)
      this.busy = false
    }
  }

  /**
   * 测试连接。
   *
   * 不传 targetId 时逐个测试所有地址（设置页顶部的按钮），传入时只测那一行
   * （地址卡片上的按钮）。每个地址的结果单独写进 targetResults，卡片边框因此
   * 能分别变绿/变红。
   */
  private async testConnection(targetId?: string): Promise<void> {
    if (this.busy) {
      await imark.window.showWarningMessage('AI 正在处理上一个请求，请稍候')
      return
    }
    this.busy = true
    const controller = this.newAbort()
    try {
      const cfg = await readAiConfig(this.configSource(), 20_000)
      const targets = targetId
        ? cfg.endpoints.filter(endpoint => endpoint.id === targetId)
        : cfg.endpoints
      if (targets.length === 0) {
        await imark.window.showWarningMessage(
          targetId ? '该地址已不存在（可能刚被删除）' : '请先在插件设置里填写 AI 服务地址'
        )
        return
      }

      this.report({
        status: 'running',
        message: targets.length === 1 ? '正在测试连接…' : '正在逐个测试地址…',
        detail: ''
      })

      const lines: string[] = []
      const details: string[] = []
      const results: Record<string, 'ok' | 'error'> = {}
      let okCount = 0

      for (const target of targets) {
        const index = cfg.endpoints.findIndex(endpoint => endpoint.id === target.id)
        const name = targets.length > 1 ? `第 ${index + 1} 个地址` : ''
        const started = Date.now()
        try {
          const result = await callAi(
            { ...cfg, endpoints: [target] },
            '你是连通性测试助手。',
            '请只回复 OK。',
            controller.signal
          )
          this.logCall(result)
          okCount += 1
          results[target.id] = 'ok'
          const elapsed = Date.now() - started
          const summary = `连接成功 · ${result.provider} · ${result.model} · ${elapsed}ms`
          lines.push(name ? `${name}：${summary}` : summary)
        } catch (err) {
          if (controller.signal.aborted) break
          results[target.id] = 'error'
          const failure = this.toFailure(err)
          lines.push(name ? `${name}：连接失败` : '连接失败')
          details.push(
            `${name ? `${name}：` : ''}${failure.message}${failure.detail ? `（${failure.detail}）` : ''}`
          )
        }
      }

      if (lines.length === 0) {
        this.report({ status: 'idle', lastRunAt: Date.now(), message: '请求已取消' })
        return
      }

      const allOk = okCount === targets.length
      const message = lines.join('\n')
      this.report({
        status: allOk ? 'ok' : okCount > 0 ? 'partial' : 'error',
        lastRunAt: Date.now(),
        message,
        detail: details.length > 0 ? details.join('\n') : undefined,
        targetResults: results
      })

      const summary =
        targets.length === 1
          ? message
          : allOk
            ? `全部 ${targets.length} 个地址连接成功`
            : `${targets.length - okCount}/${targets.length} 个地址连接失败`
      if (allOk) await imark.window.showInformationMessage(summary)
      else await imark.window.showWarningMessage(summary, { detail: details.join('\n') })
    } catch (err) {
      const failure = this.toFailure(err)
      this.report({
        status: 'error',
        lastRunAt: Date.now(),
        message: failure.message
      })
      await imark.window.showErrorMessage(
        failure.detail ? `${failure.message}（${failure.detail}）` : failure.message
      )
    } finally {
      this.aborts.delete(controller)
      this.busy = false
    }
  }

  // ---------- AI 调用（命令与面板共用） ----------

  /** 校验设置页里的 system 提示词 */
  private systemPrompt(value: string, label: string): string {
    if (!value) {
      throw new AiError(`${label}为空，请在插件设置里填写，或点标题旁的恢复图标`)
    }
    if (value.length > MAX_SYSTEM_PROMPT_CHARS) {
      throw new AiError(
        `${label}太长（${value.length} 字符），最多 ${MAX_SYSTEM_PROMPT_CHARS} 字符`
      )
    }
    return value
  }

  private async runBeautify(
    text: string,
    instruction: string,
    attachments: ResolvedAttachment[],
    controller: AbortController
  ): Promise<AiTextResult> {
    const cfg = await readAiConfig(this.configSource())
    const parts = splitFrontMatter(text)
    const body = parts.body

    if (body.trim() === '') {
      throw new AiError(
        parts.frontMatter ? '文档只有元信息，没有可美化的正文' : '当前文档是空的'
      )
    }
    if (body.length > MAX_INPUT_CHARS) {
      throw new AiError(`文档太长（${body.length} 字符），目前最多支持 ${MAX_INPUT_CHARS} 字符`)
    }

    const prompt = this.systemPrompt(cfg.beautifyPrompt, '美化提示词')
    this.report({
      status: 'running',
      message: `正在请求 AI 美化（${modelSummary(cfg.endpoints)}）…`
    })

    const images = chatImages(attachments)
    const result = await requestChat(
      cfg,
      systemPromptForBeautify(prompt, instruction, hasTextAttachments(attachments)),
      [
        {
          role: 'user',
          content: userPromptForBeautify(body, attachments),
          ...(images.length > 0 ? { images } : {})
        }
      ],
      controller.signal
    )
    this.logCall(result)

    if (result.truncated) {
      throw new AiError(
        'AI 输出被截断，为避免丢失内容，已放弃本次结果',
        '可以换用输出上限更高的模型，或先把长文档拆成几段再分别美化。'
      )
    }

    const beautified = normalizeAiOutput(result.text, body.endsWith('\n'))
    if (!beautified.trim()) throw new AiError('AI 返回了空内容')
    if (beautified.length > MAX_OUTPUT_CHARS) {
      throw new AiError(`AI 返回的内容太长（${beautified.length} 字符），超过插件上限`)
    }

    return { text: joinDocument(parts, beautified), model: result.model }
  }

  private async runGenerate(
    prompt: string,
    attachments: ResolvedAttachment[],
    controller: AbortController
  ): Promise<AiTextResult> {
    const trimmed = prompt.trim()
    if (!trimmed) throw new AiError('请填写想生成的内容')
    if (trimmed.length > MAX_PROMPT_CHARS) {
      throw new AiError(`生成要求太长（${trimmed.length} 字符），最多 ${MAX_PROMPT_CHARS} 字符`)
    }

    const cfg = await readAiConfig(this.configSource())
    const systemPrompt = this.systemPrompt(cfg.generatePrompt, '生成提示词')
    this.report({
      status: 'running',
      message: `正在生成（${modelSummary(cfg.endpoints)}）…`
    })

    const images = chatImages(attachments)
    const result = await requestChat(
      cfg,
      systemPromptForGenerate(systemPrompt),
      [
        {
          role: 'user',
          content: userPromptForGenerate(trimmed, attachments),
          ...(images.length > 0 ? { images } : {})
        }
      ],
      controller.signal
    )
    this.logCall(result)

    if (result.truncated) {
      throw new AiError('AI 输出被截断，为避免写入不完整的内容，已放弃本次结果')
    }

    const text = normalizeAiOutput(result.text, false)
    if (!text.trim()) throw new AiError('AI 没有生成内容')
    if (text.length > MAX_OUTPUT_CHARS) {
      throw new AiError(`生成的内容太长（${text.length} 字符），超过插件上限`)
    }
    return { text, model: result.model }
  }

  /** 多轮对话：文档作为 system 上下文，历史只带最近几轮 */
  private async runChat(
    documentText: string,
    message: string,
    history: ChatMessage[],
    attachments: ResolvedAttachment[],
    controller: AbortController
  ): Promise<AiTextResult> {
    const question = message.trim()
    if (!question) throw new AiError('请输入问题')
    if (question.length > MAX_CHAT_CHARS) {
      throw new AiError(`问题太长（${question.length} 字符），最多 ${MAX_CHAT_CHARS} 字符`)
    }

    const cfg = await readAiConfig(this.configSource())
    this.report({
      status: 'running',
      message: `正在回答（${modelSummary(cfg.endpoints)}）…`
    })

    const doc =
      documentText.length > MAX_INPUT_CHARS
        ? `${documentText.slice(0, MAX_INPUT_CHARS)}\n\n…（文档过长，已截断）`
        : documentText
    const images = chatImages(attachments)
    const result = await requestChat(
      cfg,
      systemPromptForChat(doc, attachments),
      [
        ...history,
        {
          role: 'user',
          content: `${question}${imageNoteForAttachments(attachments)}`,
          ...(images.length > 0 ? { images } : {})
        }
      ],
      controller.signal,
      // 对话里文档 + 参考文件是跨轮次稳定的 system 前缀，值得标缓存断点
      { cacheSystem: true }
    )
    this.logCall(result)

    const answer = normalizeChatText(result.text)
    if (!answer.trim()) throw new AiError('AI 没有返回内容')
    if (answer.length > MAX_OUTPUT_CHARS) {
      throw new AiError(`AI 回答太长（${answer.length} 字符），超过插件上限`)
    }
    return { text: answer, model: result.model, truncated: result.truncated }
  }

  private async handlePanelAi(
    id: string,
    run: (controller: AbortController) => Promise<AiTextResult>,
    successMessage: string
  ): Promise<void> {
    if (this.busy) {
      await this.replyAi(id, { ok: false, message: 'AI 正在处理上一个请求，请稍候' })
      return
    }
    this.busy = true
    const controller = this.newAbort()
    this.aiJobs.set(id, controller)

    try {
      const result = await run(controller)
      if (this.disposed) return
      this.report({ status: 'ok', lastRunAt: Date.now(), message: successMessage })
      await this.replyAi(id, {
        ok: true,
        text: result.text,
        model: result.model,
        ...(result.truncated ? { truncated: true } : {})
      })
    } catch (err) {
      if (controller.signal.aborted) {
        // 面板主动取消 / 插件停用：不把一次取消记成失败
        if (!this.disposed) {
          this.report({
            status: 'idle',
            lastRunAt: Date.now(),
            message: 'AI 请求已取消'
          })
        }
        await this.replyAi(id, { ok: false, message: '请求已取消' })
        return
      }
      const failure = this.toFailure(err)
      if (!this.disposed) {
        // 面板仍开着，错误会显示在里面；状态卡保持可用
        this.report({
          status: 'idle',
          lastRunAt: Date.now(),
          message: `上次失败：${failure.message}`
        })
      }
      await this.replyAi(id, { ok: false, ...failure })
    } finally {
      this.aiJobs.delete(id)
      this.aborts.delete(controller)
      this.busy = false
    }
  }

  private async replyAi(
    id: string,
    payload: { ok: boolean; text?: string; message?: string; detail?: string; model?: string; truncated?: boolean }
  ): Promise<void> {
    if (!this.chatPanel) return
    const data = { id, ...payload }
    if (jsonLength(data) > MAX_MESSAGE_CHARS) {
      this.postRenderMessage('ai.reply', {
        id,
        ok: false,
        message: '结果太大，无法在预览窗口中显示'
      })
      return
    }
    this.postRenderMessage('ai.reply', data)
  }

  private cancelAi(id: string): void {
    const controller = this.aiJobs.get(id)
    if (!controller) return
    controller.abort()
    this.aiJobs.delete(id)
  }

  // ---------- 扫描页图片上传 ----------

  /**
   * 收下一条 `attach.image`。
   *
   * 不信任消息里的任何字段：id / 序号 / base64 都按上限校验；坏数据直接丢弃。
   * 图片本身不写日志、不落盘，取走或过期后从内存里删掉。
   */
  private acceptImageUpload(payload: Record<string, unknown>): void {
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!IMAGE_ID_RE.test(id)) return
    const total = Number(payload.total)
    const index = Number(payload.index)
    if (!Number.isInteger(total) || !Number.isInteger(index)) return
    if (total < 1 || total > MAX_SCAN_IMAGES || index < 0 || index >= total) return

    const mediaType =
      payload.mediaType === 'image/jpeg'
        ? 'image/jpeg'
        : payload.mediaType === 'image/png'
          ? 'image/png'
          : ''
    if (!mediaType) return
    const data = typeof payload.data === 'string' ? payload.data : ''
    if (!data || data.length > MAX_SCAN_IMAGE_CHARS || data.length % 4 !== 0) return
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return

    const page = Number(payload.page)
    const width = Number(payload.width)
    const height = Number(payload.height)
    if (!Number.isInteger(page) || page < 1 || page > 100_000) return
    if (!Number.isFinite(width) || width <= 0 || width > 20_000) return
    if (!Number.isFinite(height) || height <= 0 || height > 20_000) return

    const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
    const name = (rawName || '参考文件').slice(0, 200)

    this.sweepImageUploads()
    let upload = this.imageUploads.get(id)
    if (!upload) {
      while (this.imageUploads.size >= MAX_IMAGE_UPLOADS) {
        const oldest = [...this.imageUploads.values()].sort((a, b) => a.at - b.at)[0]
        if (!oldest) break
        this.imageUploads.delete(oldest.id)
      }
      upload = { id, total, name, images: new Map(), chars: 0, at: Date.now() }
      this.imageUploads.set(id, upload)
    }
    if (upload.total !== total || upload.images.has(index)) return
    if (upload.chars + data.length > MAX_SCAN_IMAGE_TOTAL_CHARS) return

    upload.images.set(index, {
      page: Math.round(page),
      mediaType,
      data,
      width: Math.round(width),
      height: Math.round(height)
    })
    upload.chars += data.length
    upload.at = Date.now()
  }

  /** 删掉长时间没被请求取走的图片 */
  private sweepImageUploads(): void {
    const now = Date.now()
    for (const [id, upload] of this.imageUploads) {
      if (now - upload.at > IMAGE_UPLOAD_TTL_MS) this.imageUploads.delete(id)
    }
  }

  /** 等一组图片到齐再返回 */
  private async takeImageUpload(id: string, count: number): Promise<ResolvedImage[]> {
    const upload = this.imageUploads.get(id)
    if (!upload || upload.total !== count) {
      this.imageUploads.delete(id)
      throw new AiError(
        '扫描页图片没有传完，请重试',
        '这通常是面板刚刚重新加载导致的；重新添加这个 PDF 即可。'
      )
    }

    const deadline = Date.now() + IMAGE_UPLOAD_WAIT_MS
    while (upload.images.size < upload.total && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    this.imageUploads.delete(id)
    if (upload.images.size < upload.total) {
      throw new AiError(
        '扫描页图片没有传完，请重试',
        '这通常是面板刚刚重新加载导致的；重新添加这个 PDF 即可。'
      )
    }
    return [...upload.images.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, image]) => image)
  }

  /** 读取 webview 送来的参考文件；字段全部按上限校验 */
  private async readAttachments(value: unknown): Promise<ResolvedAttachment[]> {
    if (!Array.isArray(value)) return []
    const out: ResolvedAttachment[] = []
    let textTotal = 0
    let imageCount = 0
    let imageChars = 0

    for (const item of value) {
      if (out.length >= MAX_ATTACHMENTS) break
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const rawText = typeof entry.text === 'string' ? entry.text : ''
      const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
      const name = (rawName || '参考文件').slice(0, 200)

      let images: ResolvedImage[] = []
      const ref = entry.imageUpload
      if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        const upload = ref as AttachmentImageUploadRef
        const uploadId = typeof upload.id === 'string' ? upload.id : ''
        const count = Number(upload.count)
        if (
          IMAGE_ID_RE.test(uploadId) &&
          Number.isInteger(count) &&
          count >= 1 &&
          count <= MAX_SCAN_IMAGES
        ) {
          images = await this.takeImageUpload(uploadId, count)
        }
      }

      if (!rawText && images.length === 0) continue

      let clipped = rawText
      if (clipped.length > MAX_ATTACHMENT_CHARS) {
        clipped = `${clipped.slice(0, MAX_ATTACHMENT_CHARS)}\n…（已截断）`
      }
      if (textTotal + clipped.length > MAX_ATTACHMENTS_TOTAL) {
        const room = MAX_ATTACHMENTS_TOTAL - textTotal
        clipped = room >= 200 ? `${clipped.slice(0, room)}\n…（已截断）` : ''
      }

      const roomCount = Math.max(0, MAX_SCAN_IMAGES - imageCount)
      if (images.length > roomCount) images = images.slice(0, roomCount)
      const keptImages: ResolvedImage[] = []
      for (const image of images) {
        if (imageChars + image.data.length > MAX_SCAN_IMAGE_TOTAL_CHARS) continue
        keptImages.push(image)
        imageChars += image.data.length
      }
      images = keptImages

      if (!clipped && images.length === 0) continue
      out.push({ name, text: clipped, images })
      imageCount += images.length
      textTotal += clipped.length
    }
    return out
  }

  // ---------- 内部 ----------

  private report(update: imark.ImarkStatusUpdate): void {
    imark.imark.reportStatus(update)
  }

  private log(level: string, message: string): void {
    if (level === 'error') this.output.error(message)
    else if (level === 'warn') this.output.warn(message)
    else if (level === 'info') this.output.info(message)
    else this.output.debug(message)
  }

  private logCall(result: AiResult): void {
    const cache = result.cache
    const cacheNote = cache
      ? [
          cache.read > 0 ? `缓存命中 ${cache.read} tokens` : '',
          cache.write > 0 ? `缓存写入 ${cache.write} tokens` : ''
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
    this.log(
      'debug',
      `AI 请求完成：${result.provider} · ${result.endpointDisplay} · ${result.elapsedMs}ms${
        cacheNote ? ` · ${cacheNote}` : ''
      }`
    )
  }

  private toFailure(err: unknown): { message: string; detail?: string } {
    if (err instanceof AiError) {
      return {
        message: err.message,
        ...(err.detail ? { detail: err.detail } : {})
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { message: message || 'AI 操作失败' }
  }

  private newAbort(): AbortController {
    const controller = new AbortController()
    this.aborts.add(controller)
    return controller
  }

  private cancelInFlight(): void {
    for (const controller of this.aborts) controller.abort()
    this.aborts.clear()
    this.aiJobs.clear()
    this.imageUploads.clear()
  }
}

// ---------- 插入 ----------

/**
 * 在指定行的下方插入一个块级内容：
 *
 * - 默认落在光标所在行的下一行；
 * - 光标停在表格里时，落到整张表的下方（在表格中间插内容会把表写坏）；
 * - 下一行本来就是空行时，不再补第二个空行；
 * - 光标放进插入内容里的 `cursorOffset`。
 */
async function insertBlockBelow(
  editor: imark.TextEditor,
  requestedLine: number | undefined,
  text: string,
  cursorOffset = text.length
): Promise<void> {
  const document = editor.document
  // 光标所在行（1 基）的下方；行号在异步生成结束后可能已经越界，下面仍会夹取
  const requested =
    requestedLine ?? Math.min(editor.selection.active.line + 1, document.lineCount)
  const lineNumber = Math.min(Math.max(Math.trunc(requested), 1), document.lineCount)
  const lineIndex = lineNumber - 1

  const tableEnd = tableEndLine(document, lineIndex)
  const at = document.lineAt(tableEnd === null ? lineIndex : tableEnd)
  const atOffset = document.offsetAt(at.range.end)

  const lead = tableEnd !== null || eatsLineAbove(text) ? '\n\n' : '\n'
  const next =
    at.lineNumber + 1 < document.lineCount ? document.lineAt(at.lineNumber + 1) : null
  const tail = next && next.text === '' ? '' : '\n'
  const insert = `${lead}${text}${tail}`

  const ok = await editor.edit(edit => {
    edit.insert(document.positionAt(atOffset), insert)
  })
  if (!ok) throw new AiError('插入失败：文档拒绝修改')

  const offset = Math.min(Math.max(cursorOffset, 0), text.length)
  const cursor = document.positionAt(atOffset + lead.length + offset)
  editor.setSelection(cursor)
  editor.revealRange(
    new imark.Range(cursor, cursor),
    imark.TextEditorRevealType.InCenterIfOutsideViewport
  )
}

/** 分隔线 / Setext 下划线这种行后面需要空行 */
function eatsLineAbove(text: string): boolean {
  return /^[-=]+\s*$/.test(text.split('\n', 1)[0] ?? '')
}

/** 该行是否属于一张表；是则返回这张表最后一行的 0 基行号 */
function tableEndLine(document: imark.TextDocument, lineNumber: number): number | null {
  const line = document.lineAt(lineNumber)
  if (line.text.trim().length === 0) return null
  const isTableRow = (value: string): boolean => /^\s*\|/.test(value)
  if (!isTableRow(line.text)) return null
  let end = lineNumber
  for (let i = lineNumber + 1; i < document.lineCount; i++) {
    if (!isTableRow(document.lineAt(i).text)) break
    end = i
  }
  return end
}

// ---------- 工具 ----------

function chatImages(attachments: ResolvedAttachment[]): ChatImage[] {
  const out: ChatImage[] = []
  for (const item of attachments) {
    const name = item.name.replace(/["\r\n]/g, ' ').trim() || '参考文件'
    for (const image of item.images) {
      out.push({
        mediaType: image.mediaType,
        data: image.data,
        caption: `参考文件「${name}」第 ${image.page} 页（扫描图片）：`
      })
    }
  }
  return out
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), length)
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ---------- 激活 ----------

let instance: AiForEditExtension | null = null

export function activate(context: imark.ExtensionContext): void {
  instance = new AiForEditExtension(context)
  instance.start()
}

export function deactivate(): void {
  instance?.stop()
  instance = null
}
