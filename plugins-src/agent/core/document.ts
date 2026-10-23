/**
 * 当前文档桥。
 *
 * 扩展只读取内存中的编辑器文本做快照；应用结果时用一次 TextEditor.edit 写回，
 * 保留撤销栈。Agent 永远拿不到 vault 的真实写权限。
 */

import { basename } from 'node:path'
import * as imark from 'imark'
import type { DocumentSnapshot, DocMeta } from './types'
import type { ApplyResult } from './protocol'

export class DocumentApplyError extends Error {
  constructor(
    readonly code: 'no-editor' | 'edit-rejected',
    message: string
  ) {
    super(message)
  }
}

function fileNameOf(document: imark.TextDocument): string {
  if (document.uri.scheme === 'file') {
    const path = document.uri.fsPath
    return path ? basename(path) : '未命名'
  }
  const tail = document.uri.path.replace(/\/+$/, '').split('/').pop()
  return tail || '未命名'
}

export class DocumentBridge {
  current(): DocumentSnapshot | null {
    const editor = imark.window.activeTextEditor
    if (!editor) return null
    const document = editor.document
    const active = editor.selection.active
    return {
      fileName: fileNameOf(document),
      text: document.getText(),
      version: document.version,
      isDirty: document.isDirty,
      selection: {
        line: active.line,
        character: active.character,
        offset: document.offsetAt(active)
      }
    }
  }

  meta(snapshot: DocumentSnapshot | null): DocMeta | null {
    if (!snapshot) return null
    return {
      fileName: snapshot.fileName,
      version: snapshot.version,
      isDirty: snapshot.isDirty,
      selection: snapshot.selection
    }
  }

  /** 把文本替换进当前打开的文档。会话不绑定文档，写回只作用于当前编辑器。 */
  async apply(text: string): Promise<ApplyResult> {
    const editor = imark.window.activeTextEditor
    if (!editor) throw new DocumentApplyError('no-editor', '当前没有打开的文档')
    const document = editor.document
    const end = document.positionAt(document.getText().length)
    const ok = await editor.edit(edit => {
      edit.replace(new imark.Range(document.positionAt(0), end), text)
    })
    if (!ok) throw new DocumentApplyError('edit-rejected', '文档拒绝了这次修改')
    return { applied: true, version: document.version }
  }
}
