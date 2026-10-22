/**
 * 快速编辑 —— 行首「+」菜单里的表格插入。
 *
 * 这是一个刻意保持很小的扩展:清单声明菜单条目与对话框,命令处理器只把行数/列数
 * 变成一段 Markdown 文本,再通过 `TextEditor.edit` 写进当前文档。
 *
 * 插入点规则:
 * - 默认落在光标所在行的下一行;
 * - 光标停在表格里时,落到整张表的下方(在表格中间插内容会把表写坏);
 * - 下一行本来就是空行时,不再补第二个空行;
 * - 光标放进第一个表头单元格。
 */

import * as imark from 'imark'

const COMMAND = 'imark.quick-edit.insertTable'

const ROWS_MIN = 1
const ROWS_MAX = 50
const ROWS_DEFAULT = 3
const COLS_MIN = 1
const COLS_MAX = 20
const COLS_DEFAULT = 3

/** 单元格宽度:让表头、内容行与分隔行在源码里对齐(与 ` :---: ` 等宽) */
const CELL = '       '
const SEPARATOR_CELL = ' :---: '

interface LineMenuArgs {
  values?: Record<string, unknown>
  /** 点「+」时的那一行(1 基);宿主会传,缺失时退回当前光标行 */
  line?: number
  source?: 'lineMenu'
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * 生成一张空表。
 *
 * `rows` **含表头**:第一行是表头,第二行是 Markdown 表格必需的分隔行,之后才是内容行。
 * 分隔行写 `:---:` —— GFM 的列对齐标记,表头与正文默认居中。
 */
function buildTable(rows: number, cols: number): { text: string; cursorOffset: number } {
  const blank = `|${`${CELL}|`.repeat(cols)}`
  const lines = [blank, `|${`${SEPARATOR_CELL}|`.repeat(cols)}`]
  for (let i = 1; i < rows; i++) lines.push(blank)
  return { text: lines.join('\n'), cursorOffset: 2 }
}

/** 分隔线/Setext 下划线这种行后面需要空行 */
function eatsLineAbove(text: string): boolean {
  return /^[-=]+\s*$/.test(text.split('\n', 1)[0] ?? '')
}

/** 该行是否属于一张表;是则返回这张表最后一行的 0 基行号 */
function tableEndLine(document: imark.TextDocument, lineNumber: number): number | null {
  const line = document.lineAt(lineNumber)
  if (line.text.trim().length === 0) return null
  const isTableRow = (text: string): boolean => /^\s*\|/.test(text)
  if (!isTableRow(line.text)) return null
  let end = lineNumber
  for (let i = lineNumber + 1; i < document.lineCount; i++) {
    if (!isTableRow(document.lineAt(i).text)) break
    end = i
  }
  return end
}

async function insertTable(args: LineMenuArgs | undefined): Promise<void> {
  const editor = imark.window.activeTextEditor
  if (!editor) {
    await imark.window.showWarningMessage('请先打开一个 Markdown 文档')
    return
  }
  const values = args?.values ?? {}
  const rows = clampInt(values.rows, ROWS_MIN, ROWS_MAX, ROWS_DEFAULT)
  const cols = clampInt(values.cols, COLS_MIN, COLS_MAX, COLS_DEFAULT)
  const { text, cursorOffset } = buildTable(rows, cols)

  const document = editor.document
  const requested = args?.line ?? editor.selection.active.line + 1
  const lineIndex = Math.min(Math.max(Math.trunc(requested) - 1, 0), document.lineCount - 1)
  const tableEnd = tableEndLine(document, lineIndex)
  const at = document.lineAt(tableEnd === null ? lineIndex : tableEnd)
  const atOffset = document.offsetAt(at.range.end)

  const lead = tableEnd === null && !eatsLineAbove(text) ? '\n' : '\n\n'
  // 下一行本来就是空行时不再补:补了表格与正文之间会多出一条空行
  const next = at.lineNumber + 1 < document.lineCount ? document.lineAt(at.lineNumber + 1) : null
  const tail = next && next.text === '' ? '' : '\n'
  const insert = `${lead}${text}${tail}`

  const ok = await editor.edit(edit => {
    edit.insert(document.positionAt(atOffset), insert)
  })
  if (!ok) {
    await imark.window.showErrorMessage('插入表格失败:文档拒绝修改')
    return
  }

  const cursor = document.positionAt(atOffset + lead.length + Math.min(cursorOffset, text.length))
  editor.setSelection(cursor)
  editor.revealRange(new imark.Range(cursor, cursor), imark.TextEditorRevealType.InCenterIfOutsideViewport)
}

export function activate(context: imark.ExtensionContext): void {
  context.subscriptions.push(
    imark.commands.registerCommand(COMMAND, (args?: LineMenuArgs) => insertTable(args))
  )
}

export function deactivate(): void {
  // 命令由 subscriptions 统一释放;这里没有需要额外收尾的定时器或网络请求
}
