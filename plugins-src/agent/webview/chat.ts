/**
 * Agent Core 面板 UI。
 *
 * 这个文件不知道任何具体后端（Claude Code 等）的细节，只消费归一化事件：
 * 会话、流式文本、工具时间线、附件、产物、错误。后端列表由宿主给出，
 * 没有可用后端时明确提示并禁用发送。
 */

import type {
  AgentEvent,
  AgentMode,
  AgentTaskMode,
  ArtifactInfo,
  DocMeta
} from '../core/types'
import type {
  ArtifactPreview,
  AttachmentMeta,
  ProviderView,
  SafeConfig,
  SessionMessage,
  SessionSummary,
  SessionView,
  ToolCallView,
  TurnTarget,
  UiIntent
} from '../core/protocol'
import { announceReady, errorText, onPush, readBootstrap, request } from './shared'

interface Streaming {
  el: HTMLElement
  textEl: HTMLElement
  thinkingContainer: HTMLElement | null
  thinkingText: HTMLElement | null
  toolsEl: HTMLElement
  tools: Map<string, ToolCallView>
  text: string
  thinking: string
}

const bootstrap = readBootstrap()
const NO_PROVIDER_MESSAGE = '未安装或未启用任何 Agent 后端扩展'

const state = {
  providers: [] as ProviderView[],
  config: {
    mode: 'read+parse' as AgentMode,
    attachmentMaxMB: 32
  } as SafeConfig,
  doc: null as DocMeta | null,
  sessions: [] as SessionSummary[],
  session: null as SessionView | null,
  activeTurnId: null as string | null,
  taskMode: 'ask' as AgentTaskMode,
  permissionMode: 'read+parse' as AgentMode,
  providerId: '',
  model: '',
  uploads: new Map<string, { name: string; done: number; total: number }>()
}

let streaming: Streaming | null = null

document.body.innerHTML = `
<div class="agent">
  <header class="agent-head">
    <div class="agent-brand"><span class="agent-dot" id="status-dot"></span><b>Agent Core</b></div>
    <div class="agent-controls">
      <select id="provider" class="agent-select" title="Agent 后端"></select>
      <select id="permission" class="agent-select" title="权限模式">
        <option value="read+parse">read+parse</option>
        <option value="read-only">read-only</option>
      </select>
      <input id="model" class="agent-model" placeholder="模型（默认）" spellcheck="false" />
      <select id="session" class="agent-select agent-session" title="会话"></select>
      <button id="new-session" class="agent-icon" title="新建会话">＋</button>
      <button id="delete-session" class="agent-icon" title="删除会话">×</button>
    </div>
  </header>
  <div id="banner" class="agent-banner hidden"><span id="banner-text"></span><button id="banner-close" class="agent-banner-close">×</button></div>
  <main id="messages" class="agent-messages"></main>
  <section id="attachments" class="agent-attachments"></section>
  <footer class="agent-composer">
    <div class="agent-composer-top">
      <select id="task-mode" class="agent-select" title="任务模式">
        <option value="ask">问答</option>
        <option value="generate">生成</option>
        <option value="beautify">美化</option>
      </select>
      <button id="attach" class="agent-attach">＋ 附件</button>
      <input id="file-input" type="file" multiple hidden />
      <span id="doc-name" class="agent-doc"></span>
    </div>
    <textarea id="input" class="agent-input" rows="3" placeholder="问 Agent，或让它根据附件生成内容。附件只落盘，由 Agent 自己读取。"></textarea>
    <div class="agent-composer-bottom">
      <span id="hint" class="agent-hint"></span>
      <button id="stop" class="agent-stop hidden">停止</button>
      <button id="send" class="agent-send">发送</button>
    </div>
  </footer>
  <div id="preview" class="agent-preview hidden">
    <div class="agent-preview-box">
      <div class="agent-preview-head"><b id="preview-title">产物预览</b><button id="preview-close" class="agent-icon">×</button></div>
      <div id="preview-body" class="agent-preview-body"></div>
    </div>
  </div>
</div>`

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺少元素 #${id}`)
  return el as T
}

const messagesEl = byId<HTMLElement>('messages')
const attachmentsEl = byId<HTMLElement>('attachments')
const bannerEl = byId<HTMLElement>('banner')
const bannerText = byId<HTMLElement>('banner-text')
const providerEl = byId<HTMLSelectElement>('provider')
const permissionEl = byId<HTMLSelectElement>('permission')
const modelEl = byId<HTMLInputElement>('model')
const sessionEl = byId<HTMLSelectElement>('session')
const taskModeEl = byId<HTMLSelectElement>('task-mode')
const inputEl = byId<HTMLTextAreaElement>('input')
const hintEl = byId<HTMLElement>('hint')
const docNameEl = byId<HTMLElement>('doc-name')
const sendEl = byId<HTMLButtonElement>('send')
const stopEl = byId<HTMLButtonElement>('stop')
const attachEl = byId<HTMLButtonElement>('attach')
const newSessionEl = byId<HTMLButtonElement>('new-session')
const statusDot = byId<HTMLElement>('status-dot')
const fileInput = byId<HTMLInputElement>('file-input')
const previewEl = byId<HTMLElement>('preview')
const previewTitle = byId<HTMLElement>('preview-title')
const previewBody = byId<HTMLElement>('preview-body')

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function showBanner(message: string, kind: 'error' | 'info' = 'error'): void {
  bannerText.textContent = message
  bannerEl.classList.toggle('is-info', kind === 'info')
  bannerEl.classList.remove('hidden')
}

function hideBanner(): void {
  bannerEl.classList.add('hidden')
}

function setHint(text: string): void {
  hintEl.textContent = text
}

function hasProvider(): boolean {
  return state.providers.length > 0
}

function syncProviderControls(): void {
  const ready = hasProvider()
  sendEl.disabled = Boolean(state.activeTurnId) || !ready
  attachEl.disabled = !ready
  newSessionEl.disabled = !ready
}

function setRunning(running: boolean): void {
  sendEl.disabled = running || !hasProvider()
  stopEl.classList.toggle('hidden', !running)
  statusDot.classList.toggle('is-running', running)
  setHint(running ? 'Agent 正在运行…' : '')
}

function scrollToBottom(force = false): void {
  const nearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
  if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight
}

function isTaskMode(value: string): value is AgentTaskMode {
  return value === 'ask' || value === 'generate' || value === 'beautify'
}

function isPermissionMode(value: string): value is AgentMode {
  return value === 'read-only' || value === 'read+parse'
}

function sessionDocumentKey(): string {
  return state.doc?.key ?? 'no-document'
}

function sessionDocumentName(): string {
  return state.doc?.fileName ?? '未关联文档'
}

// ---------- 渲染 ----------

function renderProviders(): void {
  const current = state.providerId
  providerEl.replaceChildren()
  if (state.providers.length === 0) {
    const option = el('option', undefined, '无可用后端')
    option.value = ''
    providerEl.append(option)
    providerEl.disabled = true
    providerEl.classList.remove('is-unavailable')
    syncProviderControls()
    return
  }
  providerEl.disabled = false
  for (const provider of state.providers) {
    const option = el('option', undefined, provider.info.label)
    option.value = provider.info.id
    providerEl.append(option)
  }
  if (state.providers.some(item => item.info.id === current)) providerEl.value = current
  const detection = state.providers.find(item => item.info.id === state.providerId)?.detection
  providerEl.classList.toggle('is-unavailable', detection ? !detection.available : false)
  syncProviderControls()
}

function renderHeader(): void {
  renderProviders()
  permissionEl.value = state.permissionMode
  modelEl.value = state.model
  taskModeEl.value = state.taskMode
  docNameEl.textContent = state.doc ? state.doc.fileName : '未关联文档'
  saveSessionSettingsSoon()
}

function renderSessionList(): void {
  sessionEl.replaceChildren()
  if (state.sessions.length === 0) {
    const option = el('option', undefined, '（无会话）')
    option.value = ''
    sessionEl.append(option)
    sessionEl.disabled = true
    return
  }
  sessionEl.disabled = false
  for (const summary of state.sessions) {
    const option = el('option', undefined, summary.title || '新会话')
    option.value = summary.id
    sessionEl.append(option)
  }
  if (state.session) sessionEl.value = state.session.summary.id
}

function toolRow(tool: ToolCallView): HTMLElement {
  const row = el('div', 'agent-tool')
  const head = el('div', 'agent-tool-head')
  head.append(el('span', 'agent-tool-name', tool.name))
  head.append(el('span', 'agent-tool-input', tool.inputSummary || ''))
  row.append(head)
  row.append(
    el(
      'div',
      `agent-tool-result${tool.ok === false ? ' is-error' : ''}`,
      tool.ok === undefined ? '运行中…' : tool.summary || (tool.ok ? '完成' : '失败')
    )
  )
  return row
}

function renderTools(container: HTMLElement, tools: Map<string, ToolCallView>): void {
  container.replaceChildren()
  if (tools.size === 0) return
  const details = el('details', 'agent-tools')
  const summary = el('summary', undefined, `工具活动 · ${tools.size}`)
  details.append(summary)
  for (const tool of tools.values()) details.append(toolRow(tool))
  container.append(details)
}

function renderArtifacts(container: HTMLElement, artifacts: readonly ArtifactInfo[]): void {
  container.replaceChildren()
  if (artifacts.length === 0) return
  const details = el('details', 'agent-artifacts')
  details.append(el('summary', undefined, `产物 · ${artifacts.length}`))
  for (const artifact of artifacts) {
    const row = el('div', 'agent-artifact')
    row.append(el('span', 'agent-artifact-name', artifact.path))
    row.append(el('span', 'agent-artifact-size', formatBytes(artifact.size)))
    const preview = el('button', 'agent-small', '预览')
    preview.addEventListener('click', () => void previewArtifact(artifact))
    const insert = el('button', 'agent-small', '插入')
    insert.addEventListener('click', () => void applyArtifact(artifact, { kind: 'insert-at-cursor' }))
    const replace = el('button', 'agent-small', '替换')
    replace.addEventListener('click', () => void applyArtifact(artifact, { kind: 'replace-all' }))
    row.append(preview, insert, replace)
    details.append(row)
  }
  container.append(details)
}

function renderToolCalls(container: HTMLElement, message: SessionMessage): void {
  const map = new Map<string, ToolCallView>()
  for (const tool of message.toolCalls) map.set(tool.toolId, tool)
  renderTools(container, map)
}

function messageActions(message: SessionMessage): HTMLElement | null {
  if (message.role !== 'assistant' || !message.text.trim()) return null
  const row = el('div', 'agent-actions')
  const add = (label: string, target: TurnTarget): void => {
    const button = el('button', 'agent-small', label)
    button.addEventListener('click', () => void applyMessage(message, target))
    row.append(button)
  }
  add('插入光标处', { kind: 'insert-at-cursor' })
  add('插入下一行', {
    kind: 'insert-below-line',
    line: state.doc?.selection.line ?? 0
  })
  add('替换整篇', { kind: 'replace-all' })
  const copy = el('button', 'agent-small', '复制')
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(message.text).then(
      () => showBanner('已复制', 'info'),
      () => showBanner('复制失败')
    )
  })
  row.append(copy)
  return row
}

function renderMessage(message: SessionMessage): HTMLElement {
  const root = el('article', `agent-msg ${message.role}`)
  const role = el('div', 'agent-role', message.role === 'user' ? '你' : 'Agent')
  root.append(role)
  const body = el('div', 'agent-body')
  root.append(body)

  if (message.role === 'user') {
    body.textContent = message.text
  } else {
    const text = el('div', 'agent-text', message.text)
    body.append(text)
    if (message.status === 'ok' && message.text.trim()) {
      void request<{ html: string }>('markdown.render', { text: message.text })
        .then(result => {
          if (text.isConnected) text.innerHTML = result.html
        })
        .catch(() => undefined)
    }
  }

  if (message.error && message.status !== 'ok') {
    const error = el('div', 'agent-error')
    error.append(el('b', undefined, `${message.error.code}：`))
    error.append(document.createTextNode(message.error.message))
    if (message.error.detail) error.append(el('div', 'agent-error-detail', message.error.detail))
    body.append(error)
  }

  if (message.toolCalls.length > 0) {
    const tools = el('div', 'agent-tools-wrap')
    renderToolCalls(tools, message)
    body.append(tools)
  }

  if (message.artifacts && message.artifacts.length > 0) {
    const artifacts = el('div', 'agent-artifacts-wrap')
    renderArtifacts(artifacts, message.artifacts)
    body.append(artifacts)
  }

  const meta: string[] = []
  if (message.usage?.inputTokens !== undefined || message.usage?.outputTokens !== undefined) {
    meta.push(`tokens ${message.usage?.inputTokens ?? '?'} / ${message.usage?.outputTokens ?? '?'}`)
  }
  if (message.costUsd !== undefined) meta.push(`$${message.costUsd.toFixed(4)}`)
  if (message.status === 'cancelled') meta.push('已停止')
  if (meta.length > 0) body.append(el('div', 'agent-meta', meta.join(' · ')))

  const actions = messageActions(message)
  if (actions) body.append(actions)
  return root
}

function renderMessages(): void {
  messagesEl.replaceChildren()
  if (!state.session) {
    const empty = el('div', 'agent-empty')
    empty.append(el('b', undefined, 'Agent Core'))
    empty.append(
      el(
        'p',
        undefined,
        '打开文档，添加附件，然后提问。扩展只把附件落盘并把路径交给 Agent，怎么读取由 Agent 自己决定。'
      )
    )
    empty.append(
      el(
        'p',
        'agent-empty-hint',
        'PDF 的解析质量取决于 Agent 选择的工具：可以在设置里切换 read+parse / read-only，或让它优先使用本机已装的解析器。'
      )
    )
    messagesEl.append(empty)
    return
  }
  for (const message of state.session.messages) messagesEl.append(renderMessage(message))
  scrollToBottom(true)
}

function renderUploads(): void {
  if (state.uploads.size === 0) return
  for (const [uploadId, upload] of state.uploads) {
    const chip = el('div', 'agent-attach-chip is-uploading')
    chip.dataset.uploadId = uploadId
    chip.append(el('span', 'agent-attach-name', upload.name))
    chip.append(el('span', 'agent-attach-progress', `${upload.done}/${upload.total}`))
    attachmentsEl.append(chip)
  }
}

function renderAttachments(): void {
  attachmentsEl.replaceChildren()
  if (!state.session) return
  for (const attachment of state.session.attachments) {
    const chip = el('div', 'agent-attach-chip')
    chip.append(el('span', 'agent-attach-name', attachment.name))
    chip.append(el('span', 'agent-attach-size', formatBytes(attachment.size)))
    const remove = el('button', 'agent-attach-remove', '×')
    remove.title = '移除附件'
    remove.addEventListener('click', () => void removeAttachment(attachment))
    chip.append(remove)
    attachmentsEl.append(chip)
  }
  renderUploads()
}

// ---------- 请求 ----------

async function refreshDetection(): Promise<void> {
  try {
    const result = await request<{ providers: ProviderView[] }>('provider.detect', {}, 20_000)
    state.providers = result.providers ?? []
    if (!state.session && !state.providerId) {
      state.providerId = state.providers[0]?.info.id ?? ''
    }
    renderProviders()
    if (state.providers.length === 0) {
      showBanner(NO_PROVIDER_MESSAGE)
      return
    }
    if (bannerText.textContent === NO_PROVIDER_MESSAGE) hideBanner()
    const current = state.providers.find(item => item.info.id === state.providerId)
    if (current?.detection && !current.detection.available) {
      showBanner(
        current.detection.error?.message ||
          `${current.info.label} 不可用；请在设置里配置可执行文件或先安装。`
      )
    }
  } catch (err) {
    showBanner(errorText(err))
  }
}

async function createSession(): Promise<SessionView> {
  const result = await request<{ session: SessionView }>('session.create', {
    documentKey: sessionDocumentKey(),
    documentName: sessionDocumentName(),
    provider: state.providerId,
    model: state.model,
    mode: state.permissionMode
  })
  state.session = result.session
  state.sessions = [result.session.summary, ...state.sessions.filter(s => s.id !== result.session.summary.id)]
  renderSessionList()
  renderMessages()
  renderAttachments()
  renderHeader()
  return result.session
}

async function openSession(id: string): Promise<void> {
  if (!id) return
  try {
    const result = await request<{ session: SessionView }>('session.open', { sessionId: id })
    state.session = result.session
    state.providerId = result.session.summary.provider
    state.permissionMode = result.session.summary.mode
    state.model = result.session.summary.model ?? ''
    renderHeader()
    renderSessionList()
    renderMessages()
    renderAttachments()
  } catch (err) {
    showBanner(errorText(err))
  }
}

async function ensureSession(): Promise<string> {
  const session = state.session ?? (await createSession())
  return session.summary.id
}

async function removeAttachment(attachment: AttachmentMeta): Promise<void> {
  if (!state.session) return
  try {
    const result = await request<{ attachments: AttachmentMeta[] }>('attach.remove', {
      sessionId: state.session.summary.id,
      attachmentId: attachment.id
    })
    if (state.session) state.session.attachments = result.attachments
    renderAttachments()
  } catch (err) {
    showBanner(errorText(err))
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function uploadFile(file: File, sessionId: string): Promise<void> {
  const maxBytes = state.config.attachmentMaxMB * 1024 * 1024
  if (file.size > maxBytes) {
    showBanner(`${file.name} 超过 ${state.config.attachmentMaxMB} MB 上限`)
    return
  }
  if (file.size <= 0) {
    showBanner(`${file.name} 是空文件`)
    return
  }
  const begun = await request<{
    uploadId: string
    chunkBytes: number
    maxBytes: number
  }>('attach.begin', {
    sessionId,
    documentKey: sessionDocumentKey(),
    documentName: sessionDocumentName(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream'
  })
  const total = Math.max(1, Math.ceil(file.size / begun.chunkBytes))
  state.uploads.set(begun.uploadId, { name: file.name, done: 0, total })
  renderAttachments()
  try {
    for (let index = 0; index < total; index++) {
      const start = index * begun.chunkBytes
      const buffer = await file.slice(start, start + begun.chunkBytes).arrayBuffer()
      const data = bytesToBase64(new Uint8Array(buffer))
      await request(
        'attach.chunk',
        { uploadId: begun.uploadId, index, total, data },
        60_000
      )
      const upload = state.uploads.get(begun.uploadId)
      if (upload) {
        upload.done = index + 1
        renderAttachments()
      }
    }
    const finished = await request<{ attachment: AttachmentMeta; sessionId: string }>(
      'attach.finish',
      { uploadId: begun.uploadId },
      30_000
    )
    state.uploads.delete(begun.uploadId)
    if (state.session) {
      if (!state.session.attachments.some(item => item.id === finished.attachment.id)) {
        state.session.attachments.push(finished.attachment)
      }
      state.session.summary.attachmentCount = state.session.attachments.length
    }
    renderAttachments()
  } catch (err) {
    state.uploads.delete(begun.uploadId)
    renderAttachments()
    showBanner(errorText(err))
    await request('attach.cancel', { uploadId: begun.uploadId }).catch(() => undefined)
  }
}

async function uploadFiles(files: FileList | File[]): Promise<void> {
  // 必须在第一个 await 之前快照：file input 的 change 处理器会在调用后立刻
  // 清空 input.value，live FileList 随之变空；先 Array.from 才不会丢文件。
  const list = Array.from(files)
  if (list.length === 0) return
  if (!hasProvider()) {
    showBanner(NO_PROVIDER_MESSAGE)
    return
  }
  const sessionId = await ensureSession()
  for (const file of list) {
    await uploadFile(file, sessionId)
  }
}

// ---------- 写回 ----------

async function applyMessage(message: SessionMessage, target: TurnTarget): Promise<void> {
  if (!state.session) return
  try {
    await request('doc.apply', {
      sessionId: state.session.summary.id,
      seq: message.seq,
      target
    })
    showBanner('已写入文档', 'info')
  } catch (err) {
    const candidate = err as Error & { code?: string }
    if (candidate.code === 'stale-document' && target.kind === 'replace-all') {
      if (window.confirm('文档在 Agent 运行期间发生了变化。仍要用 Agent 的结果覆盖整篇吗？')) {
        try {
          await request('doc.apply', {
            sessionId: state.session.summary.id,
            seq: message.seq,
            target,
            force: true
          })
          showBanner('已覆盖文档', 'info')
          return
        } catch (retryErr) {
          showBanner(errorText(retryErr))
          return
        }
      }
      return
    }
    showBanner(errorText(err))
  }
}

async function applyArtifact(artifact: ArtifactInfo, target: TurnTarget): Promise<void> {
  if (!state.session) return
  try {
    await request('doc.applyArtifact', {
      sessionId: state.session.summary.id,
      path: artifact.path,
      target
    })
    showBanner('已写入产物', 'info')
  } catch (err) {
    showBanner(errorText(err))
  }
}

async function previewArtifact(artifact: ArtifactInfo): Promise<void> {
  if (!state.session) return
  try {
    const preview = await request<ArtifactPreview>('artifact.preview', {
      sessionId: state.session.summary.id,
      path: artifact.path
    })
    previewTitle.textContent = artifact.path
    previewBody.replaceChildren()
    if (preview.kind === 'image' && preview.dataBase64) {
      const img = el('img', 'agent-preview-image')
      img.src = `data:${preview.mime ?? 'application/octet-stream'};base64,${preview.dataBase64}`
      previewBody.append(img)
    } else if (preview.kind === 'markdown' && preview.html) {
      const html = el('div', 'agent-markdown')
      html.innerHTML = preview.html
      previewBody.append(html)
    } else {
      previewBody.append(el('pre', 'agent-preview-text', preview.text ?? '（无法预览）'))
    }
    previewEl.classList.remove('hidden')
  } catch (err) {
    showBanner(errorText(err))
  }
}

// ---------- 发送/流式 ----------

async function sendTurn(): Promise<void> {
  if (state.activeTurnId) return
  if (!hasProvider()) {
    showBanner(NO_PROVIDER_MESSAGE)
    return
  }
  if (state.uploads.size > 0) {
    showBanner('附件还在上传，请稍等')
    return
  }
  const text = inputEl.value.trim()
  const attachments = state.session?.attachments ?? []
  // 美化不需要输入框内容：当前文档快照就是输入
  if (!text && attachments.length === 0 && state.taskMode !== 'beautify') return
  try {
    const sessionId = await ensureSession()
    const result = await request<{ turnId: string }>('turn.start', {
      sessionId,
      text,
      mode: state.taskMode,
      permissionMode: state.permissionMode,
      attachmentIds: attachments.map(item => item.id)
    })
    state.activeTurnId = result.turnId
    inputEl.value = ''
    setRunning(true)
  } catch (err) {
    showBanner(errorText(err))
  }
}

function startStreaming(): void {
  if (streaming) return
  const root = el('article', 'agent-msg assistant is-streaming')
  root.append(el('div', 'agent-role', 'Agent'))
  const body = el('div', 'agent-body')
  const textEl = el('div', 'agent-text')
  const toolsEl = el('div', 'agent-tools-wrap')
  body.append(textEl, toolsEl)
  root.append(body)
  messagesEl.append(root)
  streaming = {
    el: root,
    textEl,
    thinkingContainer: null,
    thinkingText: null,
    toolsEl,
    tools: new Map(),
    text: '',
    thinking: ''
  }
  scrollToBottom(true)
}

function ensureThinking(): { container: HTMLElement; text: HTMLElement } {
  if (!streaming) throw new Error('没有运行中的流')
  if (streaming.thinkingContainer && streaming.thinkingText) {
    return { container: streaming.thinkingContainer, text: streaming.thinkingText }
  }
  const details = el('details', 'agent-thinking')
  details.append(el('summary', undefined, '思考过程'))
  const text = el('div', 'agent-thinking-text')
  details.append(text)
  streaming.el.querySelector('.agent-body')?.append(details)
  streaming.thinkingContainer = details
  streaming.thinkingText = text
  return { container: details, text }
}

function handleStreamEvent(event: AgentEvent): void {
  if (!streaming) startStreaming()
  if (!streaming) return
  if (event.type === 'text') {
    streaming.text += event.delta
    streaming.textEl.textContent = streaming.text
    scrollToBottom()
  } else if (event.type === 'thinking') {
    const target = ensureThinking()
    streaming.thinking += event.delta
    target.text.textContent = streaming.thinking
    scrollToBottom()
  } else if (event.type === 'tool' && event.phase === 'start') {
    streaming.tools.set(event.toolId, {
      toolId: event.toolId,
      name: event.name,
      kind: event.kind,
      inputSummary: event.inputSummary
    })
    renderTools(streaming.toolsEl, streaming.tools)
    scrollToBottom()
  } else if (event.type === 'tool' && event.phase === 'result') {
    const existing = streaming.tools.get(event.toolId)
    streaming.tools.set(event.toolId, {
      toolId: event.toolId,
      name: event.name ?? existing?.name ?? 'Tool',
      kind: existing?.kind ?? 'other',
      inputSummary: existing?.inputSummary ?? '',
      ok: event.ok,
      summary: event.summary
    })
    renderTools(streaming.toolsEl, streaming.tools)
  } else if (event.type === 'notice') {
    const notice = el('div', 'agent-notice', event.message)
    streaming.el.querySelector('.agent-body')?.append(notice)
  }
}

function finishStreaming(message: SessionMessage): void {
  if (streaming) {
    streaming.el.remove()
    streaming = null
  }
  if (state.session) {
    state.session.messages.push(message)
    state.session.summary.messageCount = state.session.messages.length
    state.session.summary.status = message.status === 'ok' ? 'idle' : 'error'
  }
  messagesEl.append(renderMessage(message))
  scrollToBottom(true)
}

// ---------- 会话设置 ----------

let saveTimer: number | null = null

function saveSessionSettingsSoon(): void {
  if (!state.session) return
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    if (!state.session) return
    void request('session.update', {
      sessionId: state.session.summary.id,
      patch: { model: state.model, mode: state.permissionMode }
    })
      .then(() => undefined)
      .catch(err => showBanner(errorText(err)))
  }, 400)
}

// ---------- 事件 ----------

onPush(push => {
  const value = push.value as Record<string, unknown>
  if (push.kind === 'init') {
    const init = value as unknown as {
      providers: ProviderView[]
      config: SafeConfig
      doc: DocMeta | null
      sessions: SessionSummary[]
      activeSessionId: string | null
    }
    state.providers = init.providers ?? []
    state.config = init.config
    state.doc = init.doc
    state.sessions = init.sessions ?? []
    state.providerId = state.providers[0]?.info.id ?? ''
    state.permissionMode = state.config.mode
    state.model = ''
    renderHeader()
    renderSessionList()
    renderMessages()
    if (init.activeSessionId) void openSession(init.activeSessionId)
    else renderAttachments()
    void refreshDetection()
    return
  }
  if (push.kind === 'config') {
    const config = (value as { config: SafeConfig }).config
    if (config) {
      state.config = config
      if (!state.session) {
        state.permissionMode = config.mode
        renderHeader()
      }
    }
    return
  }
  if (push.kind === 'doc') {
    state.doc = (value as { doc: DocMeta | null }).doc
    docNameEl.textContent = state.doc ? state.doc.fileName : '未关联文档'
    return
  }
  if (push.kind === 'sessions') {
    const data = value as { documentKey: string; sessions: SessionSummary[] }
    if (data.documentKey !== sessionDocumentKey()) return
    state.sessions = data.sessions
    // 运行中不要因为列表刷新而清空/切换会话，否则流式消息会落到错误的会话里
    if (!state.activeTurnId) {
      if (state.session && !state.sessions.some(item => item.id === state.session?.summary.id)) {
        state.session = null
        messagesEl.replaceChildren()
        attachmentsEl.replaceChildren()
      }
      if (!state.session && state.sessions[0]) void openSession(state.sessions[0].id)
    }
    renderSessionList()
    return
  }
  if (push.kind === 'session') {
    const view = (value as { session: SessionView }).session
    if (state.activeTurnId && state.session?.summary.id !== view.summary.id) return
    state.session = view
    state.providerId = view.summary.provider
    state.permissionMode = view.summary.mode
    state.model = view.summary.model ?? ''
    renderHeader()
    renderSessionList()
    renderMessages()
    renderAttachments()
    return
  }
  if (push.kind === 'sessionSummary') {
    const summary = (value as { summary: SessionSummary }).summary
    state.sessions = state.sessions.map(item => (item.id === summary.id ? summary : item))
    if (state.session?.summary.id === summary.id) {
      state.session.summary = summary
    }
    renderSessionList()
    return
  }
  if (push.kind === 'sessionDeleted') {
    const sessionId = (value as { sessionId: string }).sessionId
    state.sessions = state.sessions.filter(item => item.id !== sessionId)
    if (state.session?.summary.id === sessionId) {
      state.session = null
      messagesEl.replaceChildren()
      attachmentsEl.replaceChildren()
    }
    renderSessionList()
    return
  }
  if (push.kind === 'turnStarted') {
    const data = value as { turnId: string; sessionId: string; message: SessionMessage }
    if (state.session?.summary.id !== data.sessionId) return
    state.activeTurnId = data.turnId
    setRunning(true)
    state.session.messages.push(data.message)
    messagesEl.append(renderMessage(data.message))
    startStreaming()
    scrollToBottom(true)
    return
  }
  if (push.kind === 'turnEvent') {
    const data = value as { turnId: string; sessionId: string; event: AgentEvent }
    if (state.session?.summary.id !== data.sessionId) return
    handleStreamEvent(data.event)
    return
  }
  if (push.kind === 'turnFinished') {
    const data = value as { status: string; sessionId: string; message: SessionMessage }
    if (state.session?.summary.id !== data.sessionId) return
    state.activeTurnId = null
    setRunning(false)
    finishStreaming(data.message)
    if (state.session) {
      state.session.artifacts = data.message.artifacts ?? state.session.artifacts
      renderAttachments()
    }
    return
  }
  if (push.kind === 'uiIntent') {
    const intent = value as unknown as UiIntent
    state.taskMode = intent.mode
    taskModeEl.value = intent.mode
    if (intent.auto) window.setTimeout(() => void sendTurn(), 60)
    return
  }
  if (push.kind === 'error') {
    const error = (value as { error: { message: string } }).error
    showBanner(error.message)
  }
})

// ---------- 控件 ----------

function guardRunning(): boolean {
  if (!state.activeTurnId) return false
  showBanner('当前回合还在运行，请先停止或等待完成')
  return true
}

providerEl.addEventListener('change', () => {
  if (guardRunning()) {
    providerEl.value = state.providerId
    return
  }
  if (!providerEl.value) {
    providerEl.value = state.providerId
    return
  }
  state.providerId = providerEl.value
  void createSession().catch(err => showBanner(errorText(err)))
})

permissionEl.addEventListener('change', () => {
  if (!isPermissionMode(permissionEl.value)) return
  state.permissionMode = permissionEl.value
  saveSessionSettingsSoon()
})

modelEl.addEventListener('input', () => {
  state.model = modelEl.value.trim()
  saveSessionSettingsSoon()
})

taskModeEl.addEventListener('change', () => {
  if (isTaskMode(taskModeEl.value)) state.taskMode = taskModeEl.value
})

sessionEl.addEventListener('change', () => {
  if (guardRunning()) {
    sessionEl.value = state.session?.summary.id ?? ''
    return
  }
  if (sessionEl.value) void openSession(sessionEl.value)
})

newSessionEl.addEventListener('click', () => {
  if (guardRunning()) return
  if (!hasProvider()) {
    showBanner(NO_PROVIDER_MESSAGE)
    return
  }
  void createSession().catch(err => showBanner(errorText(err)))
})

byId('delete-session').addEventListener('click', () => {
  if (guardRunning()) return
  if (!state.session) return
  if (!window.confirm('删除这个会话及其附件/产物？')) return
  const sessionId = state.session.summary.id
  void request('session.delete', { sessionId })
    .then(() => {
      state.session = null
      messagesEl.replaceChildren()
      attachmentsEl.replaceChildren()
    })
    .catch(err => showBanner(errorText(err)))
})

attachEl.addEventListener('click', () => {
  if (!hasProvider()) {
    showBanner(NO_PROVIDER_MESSAGE)
    return
  }
  fileInput.click()
})
fileInput.addEventListener('change', () => {
  if (fileInput.files) void uploadFiles(fileInput.files).catch(err => showBanner(errorText(err)))
  fileInput.value = ''
})

sendEl.addEventListener('click', () => void sendTurn())
stopEl.addEventListener('click', () => {
  if (!state.activeTurnId) return
  void request('turn.cancel', { turnId: state.activeTurnId })
    .then(() => undefined)
    .catch(err => showBanner(errorText(err)))
  setHint('正在停止…')
})

inputEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendTurn()
  }
})

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = `${Math.min(220, inputEl.scrollHeight)}px`
})

document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
})
document.addEventListener('drop', event => {
  if (!event.dataTransfer?.files.length) return
  event.preventDefault()
  void uploadFiles(event.dataTransfer.files).catch(err => showBanner(errorText(err)))
})

byId('banner-close').addEventListener('click', hideBanner)
byId('preview-close').addEventListener('click', () => previewEl.classList.add('hidden'))
previewEl.addEventListener('click', event => {
  if (event.target === previewEl) previewEl.classList.add('hidden')
})

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') previewEl.classList.add('hidden')
})

if (bootstrap.config && typeof bootstrap.config === 'object') {
  // 初始配置由 init push 覆盖；这里只用于首屏尽早显示正确的权限模式
  const config = bootstrap.config as Partial<SafeConfig>
  if (config.mode && isPermissionMode(config.mode)) state.permissionMode = config.mode
}

renderHeader()
renderMessages()
announceReady()
