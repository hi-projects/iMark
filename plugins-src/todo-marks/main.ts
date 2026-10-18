/**
 * 待办标记 —— **render-only** 样板。
 *
 * 它直接拿到宿主的 EditorView 与共享 CM6 kit:
 *   - 用 StateField + StateEffect 管理装饰(不需要宿主代渲染);
 *   - 自己创建右侧面板与 <style>,停用时自己收走;
 *   - 没有 main 层,也不申请任何系统能力。
 */

const { view: cmView, state: cmState } = imk.editor.kit

interface Todo {
  text: string
  from: number
  to: number
}

let todos: Todo[] = []
let panel: HTMLDivElement | null = null
let styleEl: HTMLStyleElement | null = null
let rescanTimer: number | null = null
let disposeExtension: (() => void) | null = null

const setMarks = cmState.StateEffect.define<{ from: number; to: number; className: string }[]>()

const markField = cmState.StateField.define({
  create: () => cmView.Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setMarks)) continue
      const builder = new cmState.RangeSetBuilder<ReturnType<typeof cmView.Decoration.mark>>()
      for (const spec of effect.value) {
        builder.add(spec.from, spec.to, cmView.Decoration.mark({ class: spec.className }))
      }
      next = builder.finish()
    }
    return next
  },
  provide: field => cmView.EditorView.decorations.from(field)
})

function keywords(): string[] {
  return String(imk.plugin.getConfig().keywords ?? 'TODO')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function markClass(): string {
  return imk.plugin.getConfig().highlightColor === 'warn' ? 'imk-todo-warn' : 'imk-todo'
}

function panelHtml(): string {
  return `
    <div class="imk-todo-head">
      <b>待办</b>
      <button class="imk-todo-refresh" type="button">重新扫描</button>
    </div>
    <ul class="imk-todo-list"></ul>
    <div class="imk-todo-empty">没有待办</div>
  `
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel
  panel = document.createElement('div')
  panel.dataset.imkPlugin = 'todo-marks'
  panel.className = 'imk-todo-panel'
  panel.innerHTML = panelHtml()
  panel.querySelector('.imk-todo-refresh')?.addEventListener('click', () => void scan())
  document.body.append(panel)
  return panel
}

function renderPanel(): void {
  const host = ensurePanel()
  const list = host.querySelector<HTMLUListElement>('.imk-todo-list')
  const empty = host.querySelector<HTMLElement>('.imk-todo-empty')
  if (!list || !empty) return
  list.replaceChildren()
  empty.hidden = todos.length > 0
  for (const todo of todos) {
    const item = document.createElement('li')
    item.textContent = todo.text
    item.addEventListener('click', () => {
      const view = imk.editor.getView()
      if (!view) return
      view.dispatch({ selection: { anchor: todo.from }, scrollIntoView: true })
      view.focus()
    })
    list.append(item)
  }
}

function setStatus(message: string): void {
  imk.plugin.setState({ status: 'ok', lastMessage: message })
}

function ensureStyle(): void {
  if (styleEl) return
  styleEl = document.createElement('style')
  styleEl.dataset.imkPlugin = 'todo-marks'
  styleEl.textContent = `
    .imk-todo { background: color-mix(in srgb, var(--accent) 18%, transparent); border-bottom: 1px solid var(--accent); }
    .imk-todo-warn { background: color-mix(in srgb, var(--danger) 18%, transparent); border-bottom: 1px solid var(--danger); }
    .imk-todo-panel { position: fixed; right: 16px; top: 76px; width: 280px; max-height: 55vh; overflow: auto;
      z-index: 40; padding: 10px 12px; border-radius: 10px; background: var(--panel, #161b22); color: var(--text, #e6edf3);
      border: 1px solid var(--border, #30363d); box-shadow: 0 8px 28px rgba(0,0,0,.28); font-size: 12px; }
    .imk-todo-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .imk-todo-refresh { cursor: pointer; border: 1px solid var(--border, #30363d); background: transparent;
      color: inherit; border-radius: 6px; padding: 2px 8px; font-size: 12px; }
    .imk-todo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .imk-todo-list li { cursor: pointer; padding: 4px 6px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .imk-todo-list li:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
    .imk-todo-empty { opacity: .6; }
  `
  document.head.append(styleEl)
}

function scan(): number {
  const view = imk.editor.getView()
  if (!view) {
    todos = []
    renderPanel()
    setStatus('还没有打开的文档')
    return 0
  }
  const words = keywords()
  const cls = markClass()
  const text = view.state.doc.toString()
  const specs: { from: number; to: number; className: string }[] = []
  todos = []
  let offset = 0
  for (const line of text.split('\n')) {
    if (words.some(word => line.includes(word))) {
      specs.push({ from: offset, to: offset + line.length, className: cls })
      todos.push({ text: line.trim().slice(0, 120), from: offset, to: offset + line.length })
    }
    offset += line.length + 1
  }
  view.dispatch({ effects: setMarks.of(specs) })
  renderPanel()
  setStatus(todos.length === 0 ? '没有待办' : `${todos.length} 条待办`)
  return todos.length
}

function scheduleScan(): void {
  if (rescanTimer !== null) window.clearTimeout(rescanTimer)
  rescanTimer = window.setTimeout(() => {
    rescanTimer = null
    scan()
  }, 500)
}

imk.plugin.handle({
  onEnable() {
    ensureStyle()
    ensurePanel()
    disposeExtension = imk.editor.registerExtension(markField)
    imk.editor.onDocChanged(scheduleScan)
    scan()
  },

  onDisable() {
    if (rescanTimer !== null) {
      window.clearTimeout(rescanTimer)
      rescanTimer = null
    }
    disposeExtension?.()
    disposeExtension = null
    panel?.remove()
    panel = null
    styleEl?.remove()
    styleEl = null
    todos = []
  },

  onConfigChange() {
    scan()
  },

  runAction(actionId) {
    if (actionId !== 'refresh') return { ok: false, message: `未知动作:${actionId}` }
    const found = scan()
    return { ok: true, message: found === 0 ? '没有找到待办' : `找到 ${found} 条待办` }
  }
})

export {}
