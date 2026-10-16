/**
 * 光标行行首「+」菜单的状态与执行。
 *
 * 这一层是插件贡献点(`descriptor.lineMenu`)的落点:插件只声明「菜单里有什么、要问用户什么」,
 * 按钮与菜单由 editor/lineMenu.ts 画,对话框由 LineActionDialog.vue 画,文档由这里改。
 * 插件代码从头到尾碰不到编辑器。
 *
 * 刷新用**版本号 + StateEffect**驱动(见 lineMenuRefreshEffect):
 * CodeMirror 只在有事务时才会重算装饰,而「插件装好了」这件事本身不产生事务 ——
 * 不推它一把,光标不动就永远看不到按钮出现。
 */

import { StateEffect } from '@codemirror/state'
import { reactive, watch } from 'vue'
import type { PluginActionPayload, PluginLineMenuItem } from '@shared/plugins'
import { appStore, editorHolder } from '../stores/app'
import { insertBlockBelow } from '../editor/commands'
import { pluginStore, runPluginAction } from './pluginService'
import { pushNotice } from './notice'

/** 菜单里的一条 = 某个插件声明的某个条目 */
export interface LineMenuEntry {
  pluginId: string
  item: PluginLineMenuItem
}

/** 每一项的稳定标识:条目 id 只保证在**插件内部**唯一,多个插件会往同一个菜单里塞东西 */
export function lineMenuKey(entry: LineMenuEntry): string {
  return `${entry.pluginId}:${entry.item.id}`
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
 * 当前可用的菜单条目:已启用、没被熔断、也没加载失败的插件说了算。
 * 没有任何条目时,编辑器里连「+」都不画 —— 插件没装就什么都不显示。
 */
export function lineMenuEntries(): LineMenuEntry[] {
  const out: LineMenuEntry[] = []
  for (const plugin of pluginStore.list) {
    if (!plugin.state.enabled || plugin.disabledByHost || plugin.loadError) continue
    for (const item of plugin.descriptor.lineMenu ?? []) {
      out.push({ pluginId: plugin.descriptor.id, item })
    }
  }
  return out
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
  const item = entry.item
  if (item.dialog) {
    // 菜单收起、对话框接管:两个浮层同时开着,点哪个都说不清
    closeLineMenu()
    lineMenuStore.dialog = entry
    return
  }
  closeLineMenu()
  if (item.template !== undefined) {
    // 纯模板条目不过插件:没有要问的参数,也没有要算的东西
    const view = editorHolder.view
    if (view) insertBlockBelow(view, currentLine().line, item.template)
    return
  }
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

/** 按钮那一行现在的样子。文档在此期间变过也没关系,行号由 insertBlockBelow 夹取 */
function currentLine(): { line: number; text: string } {
  const view = editorHolder.view
  if (!view) return { line: lineMenuStore.line, text: '' }
  const number = Math.min(Math.max(lineMenuStore.line, 1), view.state.doc.lines)
  return { line: number, text: view.state.doc.line(number).text }
}

/**
 * 走一趟插件:把对话框里填的值与这一行的快照交给它,拿回要插入的文本。
 *
 * 插入由宿主执行 —— 插件返回的只是文本。失败(含被熔断)时宿主不会带上 `editor`,
 * 于是文档一个字符都不会变,这里再补一句提示,免得点了「表格」什么都没发生还没人吭声。
 */
async function executeAction(entry: LineMenuEntry, values?: Record<string, unknown>): Promise<void> {
  const action = entry.item.action
  if (!action) return
  const view = editorHolder.view
  if (!view) return

  const { line, text } = currentLine()
  const payload: PluginActionPayload = {
    ...(values ? { values } : {}),
    editor: { line, lineText: text, filePath: appStore.filePath }
  }

  const result = await runPluginAction(entry.pluginId, action, undefined, payload)
  if (!result) return
  if (!result.ok) {
    pushNotice(`${entry.item.label}失败:${result.message}`, { level: 'warn' })
    return
  }
  if (!result.editor) return
  insertBlockBelow(view, line, result.editor.text, result.editor.cursorOffset)
}

/**
 * 贡献点变了(装/卸/启停插件):让编辑器重算一次装饰。
 *
 * 监听的是 `pluginStore.list` 这个**引用** —— 主进程每次广播都是整份列表换掉,
 * 引用变化即代表内容变化,不必开 deep。
 */
export function initLineMenu(): () => void {
  return watch(
    () => pluginStore.list,
    () => {
      const entries = lineMenuEntries()
      // 菜单开着的时候插件被关掉/卸载:菜单里的条目已经不成立了,直接收起
      if (lineMenuStore.open && entries.length === 0) closeLineMenu()
      const view = editorHolder.view
      if (view) view.dispatch({ effects: lineMenuRefreshEffect.of(++refreshVersion) })
    }
  )
}
