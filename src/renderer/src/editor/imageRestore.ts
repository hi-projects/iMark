import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { managedImageRefs } from '@shared/imageAssets'
import { activeTab, appStore } from '../stores/app'
import { api } from '../services/api'

/**
 * 撤销删除图片时把文件也恢复回来。
 *
 * 保存时扩展会把正文里已经不再引用的图片移进应用回收区;用户随后 Ctrl+Z 把
 * 图片引用撤回来,正文恢复了,但文件还躺在回收区里 —— 这里在文档变动时比较
 * 前后引用,新增的受管图片名交给主进程搬回 `.assets/`。
 *
 * 只在插入内容里出现 `assets/` 时才做全量比对:普通打字不付正则扫描的代价。
 */
export function imageRestore(): Extension {
  return EditorView.updateListener.of(update => {
    if (!update.docChanged) return
    const docPath = activeTab()?.filePath
    if (!docPath) return

    let touched = false
    update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (!touched && inserted.toString().includes('assets/')) touched = true
    })
    if (!touched) return

    const before = managedImageRefs(update.startState.doc.toString())
    const restored = [...managedImageRefs(update.state.doc.toString())].filter(
      name => !before.has(name)
    )
    if (restored.length === 0) return
    void api.restoreImageAssets(docPath, appStore.vaultPath, restored).catch(err => {
      console.error('[iMark] 恢复图片失败', err)
    })
  })
}
