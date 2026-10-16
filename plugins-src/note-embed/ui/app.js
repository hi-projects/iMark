/**
 * 面板的界面逻辑。
 *
 * 注意这里的 `imark` 是 **preload 注入的 `window.imark`**,不是 import 进来的 ——
 * 沙箱里没有模块解析器能解析应用内部的模块,`import '@shared/…'` 会 404。
 */

/** @type {any} */
const imark = window.imark

const $ = id => document.getElementById(id)
const listEl = $('files')
const previewEl = $('preview')
const filterEl = $('filter')
const insertEl = $('insert')
const statusEl = $('status')

/** 当前仓库里的 .md 文件(相对路径) */
let notes = []
let selected = null

const escapeHtml = s =>
  String(s).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

/** 当前生效的配置(宿主按清单的字段表归一化后给的,含默认值) */
const maxPreview = () => Number(imark.getConfig().maxPreview ?? 2000)

async function loadNotes() {
  statusEl.textContent = '正在读取仓库…'
  try {
    notes = await collectNotes('')
    statusEl.textContent = `共 ${notes.length} 篇笔记`
  } catch (err) {
    // 失败要说清楚是**哪一类**失败:权限没给(E_PERMISSION)和没有仓库(E_FAILED)
    // 是两件事,前者让用户去重新确认权限,后者让他先打开仓库
    notes = []
    statusEl.textContent = `读取失败:${err.message}`
  }
  renderList()
}

/** 递归收集 .md(vault.list 只给一层,这里自己往下走) */
async function collectNotes(dir, depth = 0) {
  if (depth > 4) return []
  const entries = await imark.vault.list(dir === '' ? undefined : dir)
  const out = []
  for (const entry of entries) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.dir) out.push(...(await collectNotes(path, depth + 1)))
    else if (/\.(md|markdown)$/i.test(entry.name)) out.push(path)
  }
  return out.sort()
}

function renderList() {
  const keyword = filterEl.value.trim().toLowerCase()
  const shown = keyword === '' ? notes : notes.filter(n => n.toLowerCase().includes(keyword))
  listEl.innerHTML = ''
  for (const path of shown) {
    const li = document.createElement('li')
    li.textContent = path
    if (path === selected) li.className = 'active'
    li.addEventListener('click', () => void openNote(path))
    listEl.append(li)
  }
  if (shown.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = notes.length === 0 ? '(仓库里还没有 Markdown 文件)' : '(没有匹配的文件)'
    listEl.append(li)
  }
}

async function openNote(path) {
  selected = path
  renderList()
  previewEl.innerHTML = '<p class="hint">读取中…</p>'
  try {
    const { text } = await imark.vault.read(path)
    const limit = maxPreview()
    const clipped = text.length > limit ? `${text.slice(0, limit)}\n\n…(已截断)` : text
    previewEl.innerHTML = `<h2>${escapeHtml(path)}</h2><pre>${escapeHtml(clipped)}</pre>`
    insertEl.disabled = false
  } catch (err) {
    previewEl.innerHTML = `<p class="hint">读不了这一篇:${escapeHtml(err.message)}</p>`
    insertEl.disabled = true
  }
}

async function insertSelected() {
  if (!selected) return
  try {
    const { text } = await imark.vault.read(selected)
    // 文档**由宿主来改**:插件只交出文本,插到哪儿宿主说了算(见 ops 的 editor.insert)
    const ok = await imark.editor.insert(text)
    statusEl.textContent = ok ? `已插入「${selected}」` : '当前没有打开的文档'
  } catch (err) {
    statusEl.textContent = `插入失败:${err.message}`
  }
}

filterEl.addEventListener('input', renderList)
$('refresh').addEventListener('click', () => void loadNotes())
insertEl.addEventListener('click', () => void insertSelected())

/**
 * 主题:宿主会在 hello / theme 事件里带上当前主题,preload 已经把它写到
 * `<html data-theme>`,令牌里的 `:root[data-theme='dark']` 会自动生效 ——
 * 插件不需要为三档主题各写一套颜色,用 var(--…) 就够了。
 */
imark.on('theme', () => {
  /* 这里什么都不用做,写出来是为了说明"跟随主题不需要额外代码" */
})

void loadNotes()
