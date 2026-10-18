/**
 * 笔记引用面板 —— render 层。
 *
 * 它直接操作 DOM 与真实 EditorView;仓库读取全部通过 `imk.main.send` 请求。
 */

let panel: HTMLDivElement | null = null
let styleEl: HTMLStyleElement | null = null
let filterEl: HTMLInputElement | null = null
let listEl: HTMLUListElement | null = null
let previewEl: HTMLPreElement | null = null
let insertEl: HTMLButtonElement | null = null
let statusEl: HTMLDivElement | null = null

let notes: string[] = []
let selected: string | null = null
let previewText = ''
let insertBuffer: { path: string; total: number; chunks: string[] } | null = null

function ensureStyle(): void {
  if (styleEl) return
  styleEl = document.createElement('style')
  styleEl.dataset.imkPlugin = 'note-embed'
  styleEl.textContent = `
    .imk-note-panel { position: fixed; right: 16px; top: 76px; bottom: 48px; width: 360px; z-index: 40;
      display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 10px;
      background: var(--panel, #161b22); color: var(--text, #e6edf3); border: 1px solid var(--border, #30363d);
      box-shadow: 0 8px 28px rgba(0,0,0,.28); font-size: 12px; }
    .imk-note-panel[hidden] { display: none; }
    .imk-note-head { display: flex; align-items: center; gap: 8px; }
    .imk-note-head b { flex: 1; }
    .imk-note-head input { flex: 1; min-width: 0; }
    .imk-note-list { flex: 0 0 38%; overflow: auto; list-style: none; margin: 0; padding: 0; }
    .imk-note-list li { cursor: pointer; padding: 3px 6px; border-radius: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .imk-note-list li.active, .imk-note-list li:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .imk-note-preview { flex: 1; overflow: auto; white-space: pre-wrap; margin: 0; padding: 6px; border-radius: 6px;
      background: color-mix(in srgb, var(--text) 5%, transparent); font-family: inherit; }
    .imk-note-foot { display: flex; align-items: center; gap: 8px; }
    .imk-note-foot button { cursor: pointer; }
    .imk-note-status { flex: 1; opacity: .7; }
  `
  document.head.append(styleEl)
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel
  panel = document.createElement('div')
  panel.dataset.imkPlugin = 'note-embed'
  panel.className = 'imk-note-panel'
  panel.innerHTML = `
    <div class="imk-note-head">
      <b>笔记引用</b>
      <input class="imk-note-filter" type="search" placeholder="筛选文件…" />
      <button class="imk-note-refresh" type="button">刷新</button>
    </div>
    <ul class="imk-note-list"></ul>
    <pre class="imk-note-preview"></pre>
    <div class="imk-note-foot">
      <span class="imk-note-status"></span>
      <button class="imk-note-insert" type="button" disabled>插入到光标处</button>
    </div>
  `
  filterEl = panel.querySelector<HTMLInputElement>('.imk-note-filter')
  listEl = panel.querySelector<HTMLUListElement>('.imk-note-list')
  previewEl = panel.querySelector<HTMLPreElement>('.imk-note-preview')
  insertEl = panel.querySelector<HTMLButtonElement>('.imk-note-insert')
  statusEl = panel.querySelector<HTMLDivElement>('.imk-note-status')

  filterEl?.addEventListener('input', renderList)
  panel.querySelector('.imk-note-refresh')?.addEventListener('click', () => sendList())
  insertEl?.addEventListener('click', () => {
    if (!selected) return
    insertBuffer = { path: selected, total: 0, chunks: [] }
    void imk.main.send('read', { path: selected, mode: 'full' })
    setStatus(`正在读取「${selected}」…`)
  })
  document.body.append(panel)
  return panel
}

function setStatus(message: string): void {
  if (statusEl) statusEl.textContent = message
}

function sendList(): void {
  setStatus('正在读取仓库…')
  void imk.main.send('list', null)
}

function renderList(): void {
  if (!listEl) return
  const keyword = filterEl?.value.trim().toLowerCase() ?? ''
  const shown = keyword === '' ? notes : notes.filter(n => n.toLowerCase().includes(keyword))
  listEl.replaceChildren()
  for (const path of shown) {
    const li = document.createElement('li')
    li.textContent = path
    if (path === selected) li.className = 'active'
    li.addEventListener('click', () => {
      selected = path
      previewText = '读取中…'
      renderList()
      renderPreview()
      void imk.main.send('read', { path, mode: 'preview' })
    })
    listEl.append(li)
  }
  if (shown.length === 0) {
    const li = document.createElement('li')
    li.textContent = notes.length === 0 ? '(仓库里还没有 Markdown 文件)' : '(没有匹配的文件)'
    listEl.append(li)
  }
}

function renderPreview(): void {
  if (!previewEl) return
  previewEl.textContent = previewText
  if (insertEl) insertEl.disabled = selected === null
}

function insertAtCursor(text: string): void {
  const view = imk.editor.getView()
  if (!view) {
    setStatus('当前没有打开的文档')
    return
  }
  const at = view.state.selection.main.head
  view.dispatch({ changes: { from: at, insert: text } })
  view.focus()
  setStatus(`已插入 ${text.length} 个字符`)
}

function onMainMessage(channel: string, data: unknown): void {
  const payload = (data ?? {}) as Record<string, unknown>
  if (channel === 'notes') {
    notes = Array.isArray(payload) ? (payload as string[]) : []
    setStatus(`共 ${notes.length} 篇笔记`)
    renderList()
    return
  }
  if (channel === 'preview') {
    if (String(payload.path ?? '') !== selected) return
    previewText = String(payload.text ?? '')
    renderPreview()
    return
  }
  if (channel === 'note.start') {
    if (String(payload.path ?? '') !== insertBuffer?.path) return
    insertBuffer.total = Number(payload.total ?? 0)
    insertBuffer.chunks = []
    return
  }
  if (channel === 'note.chunk') {
    if (!insertBuffer || String(payload.path ?? '') !== insertBuffer.path) return
    insertBuffer.chunks[Number(payload.index ?? 0)] = String(payload.text ?? '')
    return
  }
  if (channel === 'note.end') {
    if (!insertBuffer || String(payload.path ?? '') !== insertBuffer.path) return
    const text = insertBuffer.chunks.join('')
    insertBuffer = null
    insertAtCursor(text)
    return
  }
  if (channel === 'toggle') {
    if (panel) panel.hidden = !panel.hidden
    return
  }
  if (channel === 'error') {
    setStatus(`失败:${String(payload.message ?? '未知错误')}`)
  }
}

imk.plugin.handle({
  onEnable() {
    ensureStyle()
    ensurePanel()
    imk.main.onMessage(onMainMessage)
    sendList()
  },

  onDisable() {
    panel?.remove()
    panel = null
    styleEl?.remove()
    styleEl = null
    notes = []
    selected = null
    previewText = ''
    insertBuffer = null
  },

  onConfigChange() {
    sendList()
  }
})

export {}
