/**
 * 待办标记 —— **编辑器扩展点 + 停靠面板**的样板。
 *
 * 它做的事很小:扫一遍当前文档,把含关键词的行标出来,并把这些行列在侧栏里,
 * 点一条就跳过去。但每一件事都踩着这套扩展点的一个关键约定:
 *
 *   - `editor.read()` 拿到的是**快照**(正文 + 光标位置),不是文档句柄 ——
 *     插件从来没碰到过 CodeMirror;
 *   - 标记只给"范围 + 一个 class 名",颜色由自己注入的 CSS 决定(被 `@scope` 圈住);
 *   - 位置是**当时**的偏移。用户之后在标记前面打字时,宿主会替我们把它挪对,
 *     所以不必自己盯着文档变化;
 *   - 界面是自己的页面(`ui.dock` 让它长在右侧栏里),点列表项直接调 `editor.setSelection`。
 */

const imark = window.imark

/** 最近一次扫描的结果,面板与 runAction 都用它 */
let todos = []

imark.plugin.handle({
  onEnable() {
    // 文档可能还没打开:扫描是尽力而为的,失败不该影响插件跑起来
    void scan()
  },

  runAction(actionId) {
    if (actionId !== 'refresh') return { ok: false, message: `未知动作:${actionId}` }
    const found = scan()
    return { ok: true, message: found === 0 ? '没有找到待办' : `找到 ${found} 条待办` }
  }
})

/** 关键词与配色都来自配置(设置面板按清单的字段表自动生成那个表单) */
function keywords() {
  return String(imark.getConfig().keywords ?? 'TODO')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function markClass() {
  return imark.getConfig().highlightColor === 'warn' ? 'imk-todo-warn' : 'imk-todo'
}

/**
 * 扫一遍文档。
 *
 * `editor.read()` 给的是全文(超过 1 MiB 会截断并给 truncated=true)。这里按行找,
 * 而**偏移是自己数出来的** —— 宿主给的是绝对位置,插件要自己把它们算准,
 * 因为它比宿主更清楚"第几行算命中"。
 */
async function scan() {
  let doc
  try {
    doc = await imark.editor.read()
  } catch (err) {
    setStatus(`读取失败:${err.message}`)
    return 0
  }

  if (!doc.open) {
    todos = []
    render()
    setStatus('还没有打开的文档')
    return 0
  }

  const words = keywords()
  const specs = []
  todos = []
  let offset = 0
  for (const line of doc.text.split('\n')) {
    const hit = words.find(w => line.includes(w))
    if (hit) {
      specs.push({ from: offset, to: offset + line.length, class: markClass() })
      todos.push({ text: line.trim().slice(0, 120), from: offset, to: offset + line.length })
    }
    offset += line.length + 1 // +1 是那个被 split 掉的换行符
  }

  // 样式只需要注入一次;重复注入会替换掉旧的那份,所以放在这里最省心
  await imark.editor.styles(`
    .imk-todo { background: color-mix(in srgb, var(--accent) 18%, transparent); border-bottom: 1px solid var(--accent); }
    .imk-todo-warn { background: color-mix(in srgb, var(--danger) 18%, transparent); border-bottom: 1px solid var(--danger); }
  `)

  await imark.editor.decorate({ decorations: specs })
  render()
  setStatus(todos.length === 0 ? '没有待办' : `${todos.length} 条待办`)
  return todos.length
}

function setStatus(message) {
  imark.setState({ status: 'ok', lastMessage: message })
}

/** 把结果画到自己的面板里(这就是"插件自己的页面"那一半) */
function render() {
  const list = document.getElementById('list')
  if (!list) return
  list.replaceChildren()
  if (todos.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = '没有待办'
    list.append(empty)
    return
  }
  for (const todo of todos) {
    const item = document.createElement('li')
    item.textContent = todo.text
    item.addEventListener('click', () => {
      // 跳到那一行。移动光标属于"改编辑器",所以要 editor:write 权限
      void imark.editor.setSelection({ from: todo.from, to: todo.to })
    })
    list.append(item)
  }
}

document.getElementById('refresh')?.addEventListener('click', () => void scan())

/**
 * 换文档之后标记会随编辑器状态重建一起消失(那是宿主的保证:装饰属于某一篇文档),
 * 所以打开另一个文件时重扫一次。
 */
imark.on('file-open', () => void scan())

/**
 * 正文变了也重扫一次 —— 但**要自己压一压**。
 *
 * 宿主已经把 `doc-changed` 节流到最快约 400ms 一次,那对"用户在写字"来说刚好;
 * 而每 400ms 读一遍全文 + 重画所有标记,对一篇长文档是不划算的。
 * 这里再等 800ms 的静默期:停笔之后扫一次,而不是边写边扫。
 *
 * (旧标记的位置**不需要**修:宿主会替我们把它跟着文档一起挪,所以这里纯粹是
 * "新出现的待办要标上"这件事。)
 */
let rescanTimer = 0
imark.on('doc-changed', () => {
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = window.setTimeout(() => {
    rescanTimer = 0
    void scan()
  }, 800)
})
