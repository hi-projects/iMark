/**
 * Agent Core 面板 UI。
 *
 * 这个文件不知道任何具体后端（Claude Code 等）的细节，只消费归一化事件：
 * 会话、流式文本、工具时间线、附件、产物、错误。后端列表由宿主给出，
 * 没有可用后端时明确提示并禁用发送。
 */

import type {
  AgentEvent,
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
  ToolCallView
} from '../core/protocol'
import { announceReady, errorText, onPush, request } from './shared'

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

const NO_PROVIDER_MESSAGE = '未安装或未启用任何 Agent 后端扩展'

const state = {
  providers: [] as ProviderView[],
  config: {
    attachmentMaxMB: 32
  } as SafeConfig,
  doc: null as DocMeta | null,
  sessions: [] as SessionSummary[],
  session: null as SessionView | null,
  activeTurnId: null as string | null,
  providerId: '',
  uploads: new Map<string, { name: string; done: number; total: number }>()
}

let streaming: Streaming | null = null

document.body.innerHTML = `
<div class="agent">
  <header class="agent-head">
    <div class="agent-controls">
      <select id="provider" class="agent-select" title="Agent 后端"></select>
      <span id="model" class="agent-model-label"></span>
      <div id="session-group" class="agent-session-group">
        <button id="session" class="agent-session-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" title="切换会话">
          <span id="session-label" class="agent-session-label"></span>
          <span class="agent-session-caret" aria-hidden="true">▾</span>
        </button>
        <button id="new-session" class="agent-icon" title="新建会话">＋</button>
        <div id="session-menu" class="agent-session-menu hidden" role="listbox" aria-label="会话列表"></div>
      </div>
    </div>
  </header>
  <div id="banner" class="agent-banner hidden"><span id="banner-text"></span><button id="banner-close" class="agent-banner-close">×</button></div>
  <main id="messages" class="agent-messages"></main>
  <footer class="agent-composer">
    <div class="agent-composer-top">
      <button id="attach-doc" class="agent-attach agent-attach-doc" title="把当前打开的文档作为附件加入本轮">＋ 本文档</button>
      <section id="attachments" class="agent-attachments"></section>
      <button id="attach" class="agent-attach">＋ 附件</button>
      <input id="file-input" type="file" multiple hidden />
    </div>
    <textarea id="input" class="agent-input" rows="3" placeholder="问 Agent，或让它根据附件生成内容。附件只落盘，由 Agent 自己读取。"></textarea>
    <div class="agent-composer-bottom">
      <span id="hint" class="agent-hint"></span>
      <button id="stop" class="agent-stop hidden">停止</button>
      <button id="prompt-peek" class="agent-icon agent-peek-button" type="button" aria-label="查看本轮完整提示词">ⓘ</button>
      <button id="send" class="agent-send">发送</button>
    </div>
    <div id="prompt-peek-panel" class="agent-peek hidden" role="tooltip">
      <pre id="prompt-peek-text"></pre>
    </div>
  </footer>
  <div id="preview" class="agent-preview hidden">
    <div class="agent-preview-box">
      <div class="agent-preview-head"><b id="preview-title">产物预览</b><button id="preview-close" class="agent-icon">×</button></div>
      <div id="preview-body" class="agent-preview-body"></div>
    </div>
  </div>
  <div id="confirm" class="agent-confirm hidden">
    <div class="agent-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirm-message">
      <p id="confirm-message" class="agent-confirm-message"></p>
      <div class="agent-confirm-actions">
        <button id="confirm-cancel" class="agent-confirm-btn">取消</button>
        <button id="confirm-ok" class="agent-confirm-btn is-danger">确定</button>
      </div>
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
const modelEl = byId<HTMLElement>('model')
const sessionGroup = byId<HTMLElement>('session-group')
const sessionTrigger = byId<HTMLButtonElement>('session')
const sessionLabel = byId<HTMLElement>('session-label')
const sessionMenu = byId<HTMLElement>('session-menu')
const inputEl = byId<HTMLTextAreaElement>('input')
const hintEl = byId<HTMLElement>('hint')
const sendEl = byId<HTMLButtonElement>('send')
const stopEl = byId<HTMLButtonElement>('stop')
const attachEl = byId<HTMLButtonElement>('attach')
const attachDocEl = byId<HTMLButtonElement>('attach-doc')
const newSessionEl = byId<HTMLButtonElement>('new-session')
const peekBtn = byId<HTMLButtonElement>('prompt-peek')
const peekEl = byId<HTMLElement>('prompt-peek-panel')
const peekText = byId<HTMLElement>('prompt-peek-text')
const fileInput = byId<HTMLInputElement>('file-input')
const previewEl = byId<HTMLElement>('preview')
const previewTitle = byId<HTMLElement>('preview-title')
const previewBody = byId<HTMLElement>('preview-body')
const confirmEl = byId<HTMLElement>('confirm')
const confirmMessage = byId<HTMLElement>('confirm-message')
const confirmOk = byId<HTMLButtonElement>('confirm-ok')
const confirmCancel = byId<HTMLButtonElement>('confirm-cancel')

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

/**
 * 面板内的确认框。
 *
 * webview 是 `sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"`
 * 的跨源 iframe，没有 `allow-modals`——Chromium 会直接忽略 window.confirm()
 * 并返回 false。所以确认只能自己画，返回值走 Promise。
 */
let confirmResolve: ((ok: boolean) => void) | null = null

function askConfirm(
  message: string,
  confirmLabel = '确定',
  opts: { danger?: boolean; cancelLabel?: string } = {}
): Promise<boolean> {
  closeConfirm(false)
  confirmMessage.textContent = message
  confirmOk.textContent = confirmLabel
  confirmCancel.textContent = opts.cancelLabel ?? '取消'
  confirmOk.classList.toggle('is-danger', opts.danger !== false)
  confirmEl.classList.remove('hidden')
  confirmOk.focus()
  return new Promise(resolve => {
    confirmResolve = resolve
  })
}

function closeConfirm(ok: boolean): void {
  confirmEl.classList.add('hidden')
  const resolve = confirmResolve
  confirmResolve = null
  resolve?.(ok)
}

// ---------- 工具授权 ----------

interface PermissionEvent {
  requestId: string
  toolId?: string
  toolName: string
  inputSummary: string
}

const permissionQueue: PermissionEvent[] = []
let permissionRunning = false

/** 后端可能连着发来多个授权请求；一个一个问，避免确认框互相覆盖 */
function enqueuePermission(event: PermissionEvent): void {
  permissionQueue.push(event)
  void runPermissionQueue()
}

async function runPermissionQueue(): Promise<void> {
  if (permissionRunning) return
  permissionRunning = true
  try {
    while (permissionQueue.length > 0) {
      const event = permissionQueue.shift()!
      const turnId = state.activeTurnId
      if (!turnId) continue
      const allow = await askConfirm(
        `Claude Code 请求执行「${event.toolName}」：\n${event.inputSummary}`,
        '允许',
        { danger: false, cancelLabel: '拒绝' }
      )
      // 等待期间可能切了仓库/会话，或这一轮已经结束
      if (state.activeTurnId !== turnId) continue
      try {
        await request('permission.respond', {
          turnId,
          requestId: event.requestId,
          allow
        })
      } catch (err) {
        showBanner(errorText(err))
      }
    }
  } finally {
    permissionRunning = false
  }
}

/** 回合结束/切仓库时作废还没回答的授权请求（关框等于拒绝，但不再回传） */
function clearPermissions(): void {
  permissionQueue.length = 0
  closeConfirm(false)
}

function isConfirmOpen(): boolean {
  return confirmResolve !== null
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
  syncDocButton()
  newSessionEl.disabled = !ready
}

function setRunning(running: boolean): void {
  sendEl.disabled = running || !hasProvider()
  stopEl.classList.toggle('hidden', !running)
  setHint(running ? 'Agent 正在运行…' : '')
}

function scrollToBottom(force = false): void {
  const nearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
  if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight
}

/**
 * 定高滚动块(思考过程)自己的贴底跟随。
 *
 * 外层消息区贴底只保证「这一块」露在视口里,不代表块内的最新一行可见 ——
 * 思考过程是 220px 的独立滚动区,不跟着推就永远停在开头,用户只能自己
 * 把滚动条拖下来。规则:没主动上翻时追加内容后贴到底;上翻看历史时暂停,
 * 翻回底部自动恢复。
 */
const stickScroll = new WeakMap<HTMLElement, boolean>()

function trackStickScroll(box: HTMLElement): void {
  if (stickScroll.has(box)) return
  stickScroll.set(box, true)
  box.addEventListener('scroll', () => {
    stickScroll.set(box, box.scrollHeight - box.scrollTop - box.clientHeight < 40)
  })
}

function appendStreamingText(box: HTMLElement, text: string): void {
  trackStickScroll(box)
  const stick = stickScroll.get(box) !== false
  box.textContent = text
  // 折叠状态下没有布局,scrollTop 赋值会被丢掉;展开时由 toggle 补一次
  if (stick) box.scrollTop = box.scrollHeight
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
    renderModelLabel()
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
  renderModelLabel()
}

/** 模型选择完全交给后端配置文件；这里只显示它读到的默认模型名 */
function renderModelLabel(): void {
  const provider = state.providers.find(item => item.info.id === state.providerId)
  const model = provider?.detection?.defaultModel?.trim()
  modelEl.textContent = `模型：${model || '默认'}`
  modelEl.title = model
    ? `默认模型：${model}（来自 ${provider?.info.label ?? '后端'} 的配置）`
    : `${provider?.info.label ?? '后端'} 的配置文件没有指定默认模型，使用它自己的默认值`
}

function renderHeader(): void {
  renderProviders()
  syncDocButton()
}

const TRASH_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<path d="M3.5 4.5h9M5.6 4.5l.5 8.2h3.8l.5-8.2M6.3 4.5V3.1h3.4v1.4M6.7 6.8v3.9M9.3 6.8v3.9" ' +
  'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function sessionTitle(summary: SessionSummary): string {
  return summary.title || '新会话'
}

function isSessionMenuOpen(): boolean {
  return !sessionMenu.classList.contains('hidden')
}

function setSessionMenuOpen(open: boolean): void {
  if (open && sessionTrigger.disabled) return
  sessionMenu.classList.toggle('hidden', !open)
  sessionTrigger.setAttribute('aria-expanded', String(open))
  if (!open) return
  // 会话多的时候，让当前项落在可视范围内
  sessionMenu.querySelector('.agent-session-item.is-current')?.scrollIntoView({ block: 'nearest' })
}

function closeSessionMenu(): void {
  setSessionMenuOpen(false)
}

function chooseSession(id: string): void {
  if (guardRunning()) return
  closeSessionMenu()
  if (state.session?.summary.id === id) return
  void openSession(id)
}

async function deleteSession(summary: SessionSummary): Promise<void> {
  if (guardRunning() || isConfirmOpen()) return
  const ok = await askConfirm(`删除「${sessionTitle(summary)}」及其附件/产物？此操作不可撤销。`, '删除')
  if (!ok) return
  try {
    await request('session.delete', { sessionId: summary.id })
    // 主机已经推了 sessionDeleted/sessions；这里只是兜底，
    // 如果推送已经切到别的会话（甚至是新建的），不要把它清掉。
    if (state.session && state.session.summary.id !== summary.id) return
    state.session = null
    messagesEl.replaceChildren()
    attachmentsEl.replaceChildren()
    renderSessionList()
  } catch (err) {
    showBanner(errorText(err))
  }
}

function renderSessionList(): void {
  const currentId = state.session?.summary.id ?? ''
  sessionTrigger.disabled = state.sessions.length === 0
  sessionMenu.replaceChildren()

  for (const summary of state.sessions) {
    const current = summary.id === currentId
    const row = el('div', 'agent-session-item')
    row.dataset.id = summary.id
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(current))
    row.classList.toggle('is-current', current)

    const name = el('button', 'agent-session-name', sessionTitle(summary))
    name.type = 'button'
    name.title = sessionTitle(summary)
    name.addEventListener('click', () => chooseSession(summary.id))

    const remove = el('button', 'agent-session-delete')
    remove.type = 'button'
    remove.title = `删除会话「${sessionTitle(summary)}」`
    remove.setAttribute('aria-label', remove.title)
    remove.innerHTML = TRASH_ICON
    remove.addEventListener('click', event => {
      event.stopPropagation()
      void deleteSession(summary)
    })

    row.append(name, remove)
    sessionMenu.append(row)
  }

  if (state.sessions.length === 0) {
    sessionLabel.textContent = '（无会话）'
    sessionLabel.title = ''
    closeSessionMenu()
    return
  }

  const current = state.sessions.find(item => item.id === currentId)
  sessionLabel.textContent = current ? sessionTitle(current) : '选择会话'
  sessionLabel.title = current ? sessionTitle(current) : '未选择会话'
  if (!current) closeSessionMenu()
}

function toolRow(tool: ToolCallView): HTMLElement {
  const row = el('div', 'agent-tool')
  row.dataset.toolId = tool.toolId
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

/**
 * 就地更新工具活动块。
 *
 * 工具事件在流式途中很密集（每次 start/result 都要刷新，一轮可能几十次）。
 * 整块重建 <details> 会把用户点开的展开状态弹回折叠，而且每次都会丢滚动位置；
 * 所以保留同一个 <details>，只按 toolId 增改行。
 */
function renderTools(container: HTMLElement, tools: Map<string, ToolCallView>): void {
  if (tools.size === 0) {
    container.replaceChildren()
    return
  }
  let details = container.querySelector<HTMLDetailsElement>('details.agent-tools')
  if (!details) {
    details = el('details', 'agent-tools')
    details.append(el('summary'))
    container.replaceChildren(details)
  }
  const summary = details.querySelector('summary')
  if (summary) summary.textContent = `工具活动 · ${tools.size}`
  const rows = new Map<string, HTMLElement>()
  for (const row of details.querySelectorAll<HTMLElement>('.agent-tool')) {
    if (row.dataset.toolId) rows.set(row.dataset.toolId, row)
  }
  for (const tool of tools.values()) {
    const row = toolRow(tool)
    const old = rows.get(tool.toolId)
    if (old) {
      old.replaceWith(row)
      rows.delete(tool.toolId)
    } else {
      details.append(row)
    }
  }
  for (const stale of rows.values()) stale.remove()
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
    const replace = el('button', 'agent-small', '替换')
    replace.addEventListener('click', () => void applyArtifact(artifact))
    row.append(preview, replace)
    details.append(row)
  }
  container.append(details)
}

function renderToolCalls(container: HTMLElement, message: SessionMessage): void {
  const map = new Map<string, ToolCallView>()
  for (const tool of message.toolCalls) map.set(tool.toolId, tool)
  renderTools(container, map)
}

/**
 * 复制纯文本。
 *
 * webview 是自定义协议，`navigator.clipboard` 会因安全上下文/权限被拒；而且
 * 它在某些情况下会「resolve 了但没写进系统剪贴板」。这里优先用不依赖权限的
 * 临时 textarea + execCommand，失败再退回异步剪贴板 API。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (ok) return true
  } catch {
    /* 走异步 API */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 两条路都失败 */
  }
  return false
}

function messageActions(message: SessionMessage): HTMLElement | null {
  if (message.role !== 'assistant' || !message.text.trim()) return null
  const row = el('div', 'agent-actions')
  const copy = el('button', 'agent-small', '复制')
  copy.addEventListener('click', () => {
    void copyText(message.text).then(ok => showBanner(ok ? '已复制' : '复制失败', ok ? 'info' : 'error'))
  })
  row.append(copy)
  const replace = el('button', 'agent-small', '替换整篇')
  replace.addEventListener('click', () => void applyMessage(message))
  row.append(replace)
  return row
}

function thinkingBlock(text: string): { details: HTMLDetailsElement; text: HTMLElement } {
  const details = el('details', 'agent-thinking') as HTMLDetailsElement
  details.append(el('summary', undefined, '思考过程'))
  const body = el('div', 'agent-thinking-text', text)
  details.append(body)
  return { details, text: body }
}

function renderMessage(message: SessionMessage): HTMLElement {
  const root = el('article', `agent-msg ${message.role}`)
  const role = el('div', 'agent-role', message.role === 'user' ? '你' : 'Agent')
  root.append(role)
  const body = el('div', 'agent-body')
  root.append(body)

  // 按实际出现顺序排：思考过程通常先于工具活动，历史里没有交错信息，
  // 就固定成「思考过程 → 工具活动 → 回答」，与流式观感一致
  if (message.role === 'assistant' && message.thinking?.trim()) {
    body.append(thinkingBlock(message.thinking).details)
  }

  // 工具活动放在回答上方：先看 Agent 做了什么，再看它说了什么
  if (message.toolCalls.length > 0) {
    const tools = el('div', 'agent-tools-wrap')
    renderToolCalls(tools, message)
    body.append(tools)
  }

  if (message.role === 'user') {
    if (message.text) body.append(el('div', 'agent-user-text', message.text))
    const sent = message.attachments ?? []
    if (sent.length > 0) {
      const wrap = el('div', 'agent-msg-attachments')
      for (const item of sent) {
        const chip = el('span', 'agent-msg-attachment', item.name)
        chip.title = `${item.name}（${formatBytes(item.size)}）`
        wrap.append(chip)
      }
      body.append(wrap)
    }
  } else {
    const text = el('div', 'agent-text', message.text)
    body.append(text)
    if (message.status === 'ok' && message.text.trim()) {
      void request<{ html: string }>('markdown.render', {
        text: message.text,
        sessionId: state.session?.summary.id
      })
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

/** 左侧文档按钮：没文档时是「＋ 本文档」，有文档时直接显示文档名 */
function syncDocButton(): void {
  const name = state.doc?.fileName ?? ''
  const added = Boolean(
    name &&
      state.session?.attachments.some(
        item => item.source === 'document' && item.name === name
      )
  )
  attachDocEl.textContent = name || '＋ 本文档'
  attachDocEl.classList.toggle('is-added', added)
  attachDocEl.disabled = !hasProvider() || !name
  attachDocEl.title = !name
    ? '当前没有打开的文档'
    : added
      ? '当前文档已在附件中，点击移除'
      : '把当前文档作为附件加入本轮'
}

function renderAttachments(): void {
  attachmentsEl.replaceChildren()
  const currentDoc = state.doc?.fileName
  if (state.session) {
    for (const attachment of state.session.attachments) {
      // 当前文档的快照由左侧按钮承担，不在附件条里重复
      if (attachment.source === 'document' && attachment.name === currentDoc) continue
      const chip = el('div', 'agent-attach-chip')
      chip.append(el('span', 'agent-attach-name', attachment.name))
      chip.append(el('span', 'agent-attach-size', formatBytes(attachment.size)))
      const remove = el('button', 'agent-attach-remove', '×')
      remove.title = '移除附件'
      remove.addEventListener('click', () => void removeAttachment(attachment))
      chip.append(remove)
      attachmentsEl.append(chip)
    }
  }
  renderUploads()
  syncDocButton()
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
    provider: state.providerId
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
    // 上传期间可能切了仓库/会话：附件属于发起上传的那个会话，不能挂到当前的上面
    if (state.session?.summary.id === finished.sessionId) {
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

async function applyMessage(message: SessionMessage): Promise<void> {
  if (!state.session) return
  try {
    await request('doc.apply', {
      sessionId: state.session.summary.id,
      seq: message.seq
    })
    showBanner('已写入文档', 'info')
  } catch (err) {
    showBanner(errorText(err))
  }
}

async function applyArtifact(artifact: ArtifactInfo): Promise<void> {
  if (!state.session) return
  try {
    await request('doc.applyArtifact', {
      sessionId: state.session.summary.id,
      path: artifact.path
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

// ---------- 提示词预览 ----------

let peekSeq = 0
let peekHideTimer = 0

/**
 * 悬停发送按钮左边的图标：显示本轮真正发给 Agent 的完整提示词。
 *
 * 内容由主进程用与 `turn.start` 相同的拼装逻辑生成（系统规则 + 附件路径 +
 * 已有产物 + 命令探测），但不写会话状态。每次悬停都重新取，输入或附件变了
 * 立刻反映出来。
 */
async function showPromptPeek(): Promise<void> {
  window.clearTimeout(peekHideTimer)
  peekEl.classList.remove('hidden')
  peekText.textContent = '正在生成提示词…'
  const seq = ++peekSeq
  try {
    const result = await request<{ prompt: string }>('prompt.preview', {
      sessionId: state.session?.summary.id ?? '',
      text: inputEl.value,
      attachmentIds: (state.session?.attachments ?? []).map(item => item.id)
    })
    if (seq !== peekSeq) return
    peekText.textContent = result.prompt
  } catch (err) {
    if (seq !== peekSeq) return
    peekText.textContent = errorText(err)
  }
}

function hidePromptPeek(): void {
  peekSeq += 1
  window.clearTimeout(peekHideTimer)
  peekEl.classList.add('hidden')
}

/** 留一点时间把鼠标从图标移进面板（面板在上方，可滚动看全文） */
function scheduleHidePromptPeek(): void {
  window.clearTimeout(peekHideTimer)
  peekHideTimer = window.setTimeout(hidePromptPeek, 260)
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
  if (!text && attachments.length === 0) return
  try {
    const sessionId = await ensureSession()
    const result = await request<{ turnId: string }>('turn.start', {
      sessionId,
      text,
      attachmentIds: attachments.map(item => item.id)
    })
    state.activeTurnId = result.turnId
    inputEl.value = ''
    // 附件只属于刚发出的这条消息：清空待发区，历史里由消息自己带附件
    if (state.session) {
      state.session.attachments = []
      state.session.summary.attachmentCount = 0
      renderAttachments()
    }
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
  // 工具活动块不预先挂到 body：等第一次出现工具调用时才插入到回答前面，
  // 这样它和思考过程块谁先到谁在前，不会凭空冒到已有的块上面
  const toolsEl = el('div', 'agent-tools-wrap')
  // 长任务/工具间歇期也要能看出「还在跑」：一直显示到本轮结束
  const loading = el('div', 'agent-loading')
  loading.append(el('span', 'agent-spinner'), el('span', undefined, '正在执行…'))
  body.append(textEl, loading)
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
  const { details, text } = thinkingBlock('')
  trackStickScroll(text)
  // 流式途中才展开:折叠期间追加的内容没有布局,展开这一刻补到底部
  details.addEventListener('toggle', () => {
    if (details.open && stickScroll.get(text)) text.scrollTop = text.scrollHeight
  })
  // 插在回答前面，也就是排在所有先到的块（如工具活动）之后
  streaming.textEl.before(details)
  streaming.thinkingContainer = details
  streaming.thinkingText = text
  return { container: details, text }
}

function handleStreamEvent(event: AgentEvent): void {
  if (event.type === 'permission') {
    enqueuePermission(event)
    return
  }
  if (!streaming) startStreaming()
  if (!streaming) return
  if (event.type === 'text') {
    streaming.text += event.delta
    streaming.textEl.textContent = streaming.text
    scrollToBottom()
  } else if (event.type === 'thinking') {
    const target = ensureThinking()
    streaming.thinking += event.delta
    appendStreamingText(target.text, streaming.thinking)
    scrollToBottom()
  } else if (event.type === 'tool' && event.phase === 'start') {
    streaming.tools.set(event.toolId, {
      toolId: event.toolId,
      name: event.name,
      kind: event.kind,
      inputSummary: event.inputSummary
    })
    // 第一次出现工具调用时才占位：谁先出现谁在前
    if (!streaming.toolsEl.isConnected) streaming.textEl.before(streaming.toolsEl)
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
    if (!streaming.toolsEl.isConnected) streaming.textEl.before(streaming.toolsEl)
    renderTools(streaming.toolsEl, streaming.tools)
  } else if (event.type === 'notice') {
    const notice = el('div', 'agent-notice', event.message)
    streaming.el.querySelector('.agent-body')?.append(notice)
  }
}

function finishStreaming(message: SessionMessage): void {
  // 轮末要换成正式消息节点；沿用流式期间用户已经展开的工具活动，
  // 否则「看着看着自己收起来」会在这一下再出现一次
  let toolsOpen = false
  if (streaming) {
    toolsOpen =
      streaming.toolsEl.querySelector<HTMLDetailsElement>('details.agent-tools')?.open ?? false
    streaming.el.remove()
    streaming = null
  }
  if (state.session) {
    state.session.messages.push(message)
    state.session.summary.messageCount = state.session.messages.length
    state.session.summary.status = message.status === 'ok' ? 'idle' : 'error'
  }
  const node = renderMessage(message)
  if (toolsOpen) {
    const details = node.querySelector<HTMLDetailsElement>('details.agent-tools')
    if (details) details.open = true
  }
  messagesEl.append(node)
  scrollToBottom(true)
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
    if (config) state.config = config
    return
  }
  if (push.kind === 'doc') {
    state.doc = (value as { doc: DocMeta | null }).doc
    renderAttachments()
    syncProviderControls()
    return
  }
  if (push.kind === 'sessions') {
    const data = value as { sessions: SessionSummary[] }
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
  if (push.kind === 'workspace') {
    const data = value as { sessions: SessionSummary[] }
    state.sessions = data.sessions ?? []
    state.session = null
    state.activeTurnId = null
    clearPermissions()
    // 旧仓库的上传/流式内容不能跟着进入新仓库的界面
    state.uploads.clear()
    streaming = null
    setRunning(false)
    messagesEl.replaceChildren()
    attachmentsEl.replaceChildren()
    renderMessages()
    renderSessionList()
    syncProviderControls()
    if (state.sessions[0]) void openSession(state.sessions[0].id)
    else renderAttachments()
    return
  }
  if (push.kind === 'session') {
    const view = (value as { session: SessionView }).session
    if (state.activeTurnId && state.session?.summary.id !== view.summary.id) return
    state.session = view
    state.providerId = view.summary.provider
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
    clearPermissions()
    setRunning(false)
    finishStreaming(data.message)
    if (state.session) {
      state.session.artifacts = data.message.artifacts ?? state.session.artifacts
      renderAttachments()
    }
    return
  }
  if (push.kind === 'refresh') {
    void refreshDetection()
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

sessionTrigger.addEventListener('click', () => {
  setSessionMenuOpen(!isSessionMenuOpen())
})

// 点面板其它地方收起会话菜单；点菜单内部（选会话 / 删除）由各自处理器负责
document.addEventListener('click', event => {
  if (!isSessionMenuOpen()) return
  if (event.target instanceof Node && sessionGroup.contains(event.target)) return
  closeSessionMenu()
})

newSessionEl.addEventListener('click', () => {
  if (guardRunning()) return
  if (!hasProvider()) {
    showBanner(NO_PROVIDER_MESSAGE)
    return
  }
  closeSessionMenu()
  void createSession().catch(err => showBanner(errorText(err)))
})

/**
 * 「添加本文档」：把当前打开的文档快照成一条普通附件。
 *
 * 会话不绑定文档，文档只在用户主动点击时才作为本轮参数传进去。
 */
async function attachCurrentDocument(): Promise<void> {
  if (!state.doc) {
    showBanner('请先打开一个文档')
    return
  }
  const name = state.doc.fileName
  const existing = state.session?.attachments.find(
    item => item.source === 'document' && item.name === name
  )
  // 按钮本身代表当前文档：已加入时再点就是移除
  if (existing) {
    await removeAttachment(existing)
    return
  }
  if (!hasProvider()) {
    showBanner(NO_PROVIDER_MESSAGE)
    return
  }
  if (state.uploads.size > 0) {
    showBanner('附件还在上传，请稍等')
    return
  }
  try {
    const sessionId = await ensureSession()
    const result = await request<{ attachment: AttachmentMeta }>('doc.attach', { sessionId })
    if (!state.session) return
    if (!state.session.attachments.some(item => item.id === result.attachment.id)) {
      state.session.attachments.push(result.attachment)
    }
    state.session.summary.attachmentCount = state.session.attachments.length
    renderAttachments()
  } catch (err) {
    showBanner(errorText(err))
  }
}

attachDocEl.addEventListener('click', () => void attachCurrentDocument())
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

peekBtn.addEventListener('mouseenter', () => void showPromptPeek())
peekBtn.addEventListener('mouseleave', scheduleHidePromptPeek)
peekBtn.addEventListener('focus', () => void showPromptPeek())
peekBtn.addEventListener('blur', scheduleHidePromptPeek)
peekEl.addEventListener('mouseenter', () => window.clearTimeout(peekHideTimer))
peekEl.addEventListener('mouseleave', hidePromptPeek)

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

confirmOk.addEventListener('click', () => closeConfirm(true))
confirmCancel.addEventListener('click', () => closeConfirm(false))
confirmEl.addEventListener('click', event => {
  // 点遮罩等于取消；点对话框内部不关
  if (event.target === confirmEl) closeConfirm(false)
})

window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  if (isConfirmOpen()) {
    closeConfirm(false)
    return
  }
  if (isSessionMenuOpen()) {
    closeSessionMenu()
    return
  }
  previewEl.classList.add('hidden')
  hidePromptPeek()
})

renderHeader()
renderMessages()
announceReady()
