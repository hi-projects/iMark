import type { EditorView } from '@codemirror/view'
import { appStore, editorHolder } from '../stores/app'
import { loadDocument } from '../editor/setup'
import { updateOutline } from '../editor/outline'
import { basename, computeStats, stripMarkdownExt, toEol } from '../utils/text'
import { renderHtml } from './exportHtml'
import { notifyError } from './notice'

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
      notifyError('打开文件', err)
    }
  }
}

export async function openFileViaDialog(): Promise<void> {
  const path = await window.api.openFileDialog()
  if (path) await openFileByPath(path)
}

/**
 * 把编辑器里的当前内容写回**指定路径**,失败时抛出。
 *
 * 单独抽出来是给定时保存用的:那条路径上没有人看着,不能像 saveCurrentFile 那样
 * 在没有路径时回落到「另存为」—— 那会凭空弹出一个对话框打断正在打字的人。
 * 内容在这里现取,不吃调用方的时间差。
 */
export async function writeCurrentFileInPlace(path: string): Promise<void> {
  const view = requireView()
  if (!view) throw new Error('编辑器未就绪')
  const text = view.state.doc.toString()
  await window.api.writeFile(path, toEol(text, appStore.eol))
  // 落盘成功就报一声(插件的 document:save 钩子挂在这条上)。带着**刚写的那份
  // 文档的路径**:下面那个早退分支说明用户已经切走了,不带路径的话插件会以为
  // 是刚打开的那份被保存了。
  window.api.notifyDocSaved(path)
  // 写盘这一小会儿里用户可能已经切换了文件(定时保存尤其如此,它是在背后发生的):
  // 只有当编辑器里还是刚才那份内容时,才轮到我们清脏标记 ——
  // 否则会把**刚打开的那份文档**标记成「已保存」,它真实的改动就再也不会被提醒保存了
  if (view.state.doc.toString() !== text) return
  appStore.savedContent = text
  appStore.dirty = false
}

export async function saveCurrentFile(): Promise<boolean> {
  const view = requireView()
  if (!view) return false
  const path = appStore.filePath
  if (!path) return saveFileAs()
  try {
    await writeCurrentFileInPlace(path)
  } catch (err) {
    notifyError('保存', err)
    return false
  }
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
    notifyError('保存', err)
    return false
  }
  // 另存为也是一次真的写盘,插件同样该收到 document:save(路径给的是新路径)
  window.api.notifyDocSaved(target)
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
    notifyError('导出', err)
  }
}
