import type { EditorView } from '@codemirror/view'
import { appStore, editorHolder } from '../stores/app'
import { loadDocument } from '../editor/setup'
import { updateOutline } from '../editor/outline'
import { basename, computeStats, stripMarkdownExt, toEol } from '../utils/text'
import { renderHtml } from './exportHtml'

function requireView(): EditorView | null {
  const view = editorHolder.view
  if (!view) console.error('[iMark] 编辑器实例未就绪')
  return view
}

/** 打开/新建前确认脏文档;返回 false 表示用户取消,中止流程 */
async function confirmLoseChanges(): Promise<boolean> {
  if (!appStore.dirty) return true
  const choice = await window.api.confirmDiscard(appStore.fileName)
  if (choice === 'cancel') return false
  if (choice === 'save') return saveCurrentFile()
  return true
}

/** 将新内容装载进编辑器并重置文件状态 */
function applyDocument(view: EditorView, content: string, path: string | null, eol: 'LF' | 'CRLF'): void {
  loadDocument(view, content, v => editorHolder.onDocChange?.(v))
  appStore.filePath = path
  appStore.fileName = path ? basename(path) : '未命名'
  appStore.eol = eol
  appStore.savedContent = content
  appStore.dirty = false
  Object.assign(appStore, computeStats(content))
  updateOutline(view)
}

export async function newFile(): Promise<void> {
  const view = requireView()
  if (!view || !(await confirmLoseChanges())) return
  applyDocument(view, '', null, 'LF')
}

/** 无条件清空为未命名(仓库切换等已由调用方确认过脏状态的场景) */
export async function resetToEmpty(): Promise<void> {
  const view = requireView()
  if (!view) return
  applyDocument(view, '', null, 'LF')
}

export async function openFileByPath(
  path: string,
  opts?: { silent?: boolean; force?: boolean }
): Promise<void> {
  const view = requireView()
  if (!view) return
  if (!opts?.force && !(await confirmLoseChanges())) return
  try {
    const { content, eol } = await window.api.readFile(path)
    applyDocument(view, content, path, eol)
  } catch (err) {
    if (!opts?.silent) {
      alert(`无法打开文件:${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function openFileViaDialog(): Promise<void> {
  const path = await window.api.openFileDialog()
  if (path) await openFileByPath(path)
}

export async function saveCurrentFile(): Promise<boolean> {
  const view = requireView()
  if (!view) return false
  if (!appStore.filePath) return saveFileAs()
  const text = view.state.doc.toString()
  try {
    await window.api.writeFile(appStore.filePath, toEol(text, appStore.eol))
  } catch (err) {
    alert(`保存失败:${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  appStore.savedContent = text
  appStore.dirty = false
  return true
}

export async function saveFileAs(): Promise<boolean> {
  const view = requireView()
  if (!view) return false
  const target = await window.api.saveFileDialog({
    defaultPath: appStore.filePath ?? undefined,
    defaultName: appStore.fileName.endsWith('.md') ? appStore.fileName : `${stripMarkdownExt(appStore.fileName)}.md`,
    kind: 'md'
  })
  if (!target) return false
  const text = view.state.doc.toString()
  try {
    await window.api.writeFile(target, toEol(text, 'LF'))
  } catch (err) {
    alert(`保存失败:${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  appStore.filePath = target
  appStore.fileName = basename(target)
  appStore.eol = 'LF'
  appStore.savedContent = text
  appStore.dirty = false
  return true
}

/** 关闭窗口前由主进程触发的保存流程,完成后必须通知主进程 */
export async function saveBeforeClose(): Promise<void> {
  // 仓库选择界面下没有编辑器实例,无需保存,直接放行关闭
  if (!editorHolder.view) {
    window.api.notifySaveDone(true)
    return
  }
  const ok = await saveCurrentFile()
  window.api.notifySaveDone(ok)
}

export async function exportHtmlFile(): Promise<void> {
  const view = requireView()
  if (!view) return
  const html = renderHtml(view.state.doc.toString(), appStore.fileName)
  const target = await window.api.saveFileDialog({
    defaultName: `${stripMarkdownExt(appStore.fileName)}.html`,
    kind: 'html'
  })
  if (!target) return
  try {
    await window.api.writeFile(target, html)
  } catch (err) {
    alert(`导出失败:${err instanceof Error ? err.message : String(err)}`)
  }
}
