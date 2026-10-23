/**
 * 光标行行首「+」菜单的状态与执行。
 *
 * 条目的唯一来源是扩展清单的 `contributes['imark.lineMenu']`:主进程已经把
 * 「启用中的扩展声明了哪些条目」算成快照,这里只负责显示、收集对话框参数、
 * 调 `commands.executeCommand`。
 *
 * 宿主不替扩展插入文本:命令拿到
 * `{ values, source: 'lineMenu', line, lineText, filePath }`,要改文档就走
 * `window.activeTextEditor.edit` —— 插入位置和撤销栈由扩展自己负责。
 *
 * 刷新用**版本号 + StateEffect**驱动(见 lineMenuRefreshEffect):
 * CodeMirror 只在有事务时才会重算装饰,而「扩展装好了」这件事本身不产生事务 ——
 * 不推它一把,光标不动就永远看不到按钮出现。
 */

import { StateEffect } from '@codemirror/state'
import { reactive, watch } from 'vue'
import type { ExtensionLineMenuView } from '@shared/extensions'
import { activeTab, editorHolder } from '../stores/app'
import { extensionStore, runExtensionCommand } from './extensionService'

/** 菜单里的一条 = 某个扩展声明的某个条目 */
export interface LineMenuEntry {
  extensionId: string
  extensionName: string
  item: ExtensionLineMenuView
}

/** 条目 id 在快照里已经带上扩展 ID(`<extId>:<itemId>`),直接当 key */
export function lineMenuKey(entry: LineMenuEntry): string {
  return entry.item.id
}

export const lineMenuStore = reactive<{
  open: boolean
  /** 菜单左上角(视口坐标);组件挂载后会按窗口边界再夹一次 */
  x: number
  y: number
  /** 按钮所在的行号(菜单是「这一行」的,行变了它就该消失) */
  line: number
  /** 正在等参数的条目;非 null 时弹对话框 */
  dialog: LineMenuEntry | null
}>({ open: false, x: 0, y: 0, line: 1, dialog: null })

export const lineMenuRefreshEffect = StateEffect.define<number>()
let refreshVersion = 0

/**
 * 当前可用的菜单条目。
 *
 * 快照里只含启用中的扩展,这里不再判断启用态 —— 渲染层拿到的已经是
 * 「这一秒能执行什么」的结论。
 */
export function lineMenuEntries(): LineMenuEntry[] {
  const source = extensionStore.contribs?.lineMenu ?? []
  return source.map(item => ({
    extensionId: item.extensionId,
    extensionName: item.extensionName,
    item
  }))
}

/** 按钮被点了。再点一次同一个按钮是收起(开合) */
export function openLineMenu(line: number, rect: { left: number; bottom: number }): void {
  if (lineMenuStore.open && lineMenuStore.line === line) {
    closeLineMenu()
    return
  }
  lineMenuStore.line = line
  lineMenuStore.x = rect.left
  lineMenuStore.y = rect.bottom + 4
  lineMenuStore.open = true
}

export function closeLineMenu(): void {
  lineMenuStore.open = false
}

/** 用户点了菜单里的一条 */
export function runLineMenuItem(entry: LineMenuEntry): void {
  if (entry.item.dialog) {
    // 菜单收起、对话框接管:两个浮层同时开着,点哪个都说不清
    closeLineMenu()
    lineMenuStore.dialog = entry
    return
  }
  closeLineMenu()
  void executeAction(entry)
}

/** 对话框点了确定 */
export function confirmLineDialog(values: Record<string, unknown>): void {
  const entry = lineMenuStore.dialog
  if (!entry) return
  lineMenuStore.dialog = null
  void executeAction(entry, values)
}

export function cancelLineDialog(): void {
  lineMenuStore.dialog = null
}

/** 按钮那一行现在的样子(行号按当前文档夹取,文档在菜单开着时可能变短) */
function currentLine(): { line: number; text: string } {
  const view = editorHolder.view
  if (!view) return { line: lineMenuStore.line, text: '' }
  const number = Math.min(Math.max(lineMenuStore.line, 1), view.state.doc.lines)
  return { line: number, text: view.state.doc.line(number).text }
}

/**
 * 走一趟扩展命令。
 *
 * 不在这里碰文档:命令可以异步、可以询问用户、也可以根本不改文本。
 * 失败提示由 `runExtensionCommand` 统一弹 —— 用户点了「表格」却什么都没发生,
 * 比一句直白的错误更让人困惑。
 */
async function executeAction(
  entry: LineMenuEntry,
  values?: Record<string, unknown>
): Promise<void> {
  const { line, text } = currentLine()
  const args = {
    ...(values ? { values } : {}),
    source: 'lineMenu',
    line,
    lineText: text,
    filePath: activeTab()?.filePath ?? null
  }
  await runExtensionCommand(entry.item.command, [args], 'lineMenu')
}

/**
 * 贡献点变了(装/卸/启停扩展):让编辑器重算一次装饰。
 *
 * 监听的是 `extensionStore.contribs` 这个**引用** —— 主进程每次广播都是整份快照换掉,
 * 引用变化即代表内容变化,不必开 deep。
 */
export function initLineMenu(): () => void {
  return watch(
    () => extensionStore.contribs,
    snapshot => {
      const entries = snapshot?.lineMenu ?? []
      // 菜单开着的时候扩展被关掉/卸载:菜单里的条目已经不成立了,直接收起
      if (lineMenuStore.open && entries.length === 0) closeLineMenu()
      // 对话框对应的条目消失了(扩展被停用),不要留一个点了会报「未知命令」的表单
      if (lineMenuStore.dialog && !entries.some(item => item.id === lineMenuStore.dialog?.item.id)) {
        cancelLineDialog()
      }
      const view = editorHolder.view
      if (view) view.dispatch({ effects: lineMenuRefreshEffect.of(++refreshVersion) })
    }
  )
}
