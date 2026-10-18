import { EditorSelection, type Extension, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { appStore } from '../stores/app'
import { api } from '../services/api'
import { notifyError, pushNotice } from '../services/notice'

/**
 * 剪贴板图片粘贴:截图/复制的图片 → 存进文档旁 `assets/` → 在光标处写 Markdown。
 *
 * CodeMirror 自带的 paste 只读 `text/plain` / `text/uri-list`;剪贴板里只有图片时,
 * 它会执行一次空替换(有选区时还会把选区删掉),所以必须在扩展 handler 里先拦下来。
 * 扩展注册的 handler 排在内置 handler 之前(见 @codemirror/view 的 computeHandlers),
 * 返回 true 即可阻止内置行为。
 */

interface PendingPaste {
  view: EditorView
  docPath: string
  /**
   * 发起粘贴那一刻的文档。普通编辑靠 updateListener + mapPos 跟着走;
   * `view.setState()`(打开/新建文件)不产生 ViewUpdate,所以完成时它仍是旧文档 ——
   * 正好用来识别「用户已经切走了,别再插进新文档」。
   */
  doc: Text
  from: number
  to: number
  files: File[]
}

const pending = new Set<PendingPaste>()

/**
 * 剪贴板里的图片文件。
 *
 * `getAsFile()` 必须在 paste 事件派发期间同步调用 —— 事件结束后 DataTransfer 可能
 * 已经被清空,拿到的会是 null。所以这里只取 File 对象,真正的字节读取放在异步里。
 */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length) return files
  // 少数平台只把文件放进 files,没有对应的 item
  return Array.from(data.files ?? []).filter(file => file.type.startsWith('image/'))
}

async function completePaste(item: PendingPaste): Promise<void> {
  const relPaths: string[] = []
  for (const file of item.files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      relPaths.push(await api.saveImageAsset(item.docPath, file.type, bytes))
    } catch (err) {
      notifyError('粘贴图片', err)
    }
  }
  pending.delete(item)

  if (!relPaths.length) return
  // 文档被整体换掉(打开/新建/切仓库),或者保存期间另存到了别处:
  // 这次粘贴已经不属于眼前这份文档(或它所在的目录)了
  if (item.doc !== item.view.state.doc || appStore.filePath !== item.docPath) return

  const insert = relPaths.map(rel => `![图片](${rel})`).join('\n') + ' '
  const docLength = item.view.state.doc.length
  const from = Math.min(item.from, docLength)
  const to = Math.min(Math.max(item.to, from), docLength)
  item.view.dispatch({
    changes: { from, to, insert },
    // 末尾留一个空格,光标落在空格后:否则光标贴着 Image 节点的闭区间末尾,
    // 所见即所得层会一直显示源码而不是刚粘进来的图
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: 'input.paste'
  })
}

export function imagePaste(): Extension {
  return [
    EditorView.domEventHandlers({
      paste(event, view) {
        if (view.state.readOnly) return false
        const files = imageFiles(event.clipboardData)
        if (!files.length) return false

        // 同步阻止内置粘贴:handler 里不能先 await,否则事件已经按文本处理完了。
        // 剪贴板同时带文本和图片时(例如从 Word 复制图文)按图片处理。
        event.preventDefault()

        const docPath = appStore.filePath
        if (!docPath) {
          // 没有落盘位置就没有 assets/ 目录;提示比静默失败好
          pushNotice('请先保存文档，再粘贴图片', { level: 'warn' })
          return true
        }

        const sel = view.state.selection.main
        const item: PendingPaste = {
          view,
          docPath,
          doc: view.state.doc,
          from: sel.from,
          to: sel.to,
          files
        }
        pending.add(item)
        void completePaste(item)
        return true
      }
    }),
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return
      for (const item of pending) {
        if (item.doc !== update.startState.doc) continue
        item.from = update.changes.mapPos(item.from, 1)
        item.to = update.changes.mapPos(item.to, -1)
        item.doc = update.state.doc
      }
    })
  ]
}
