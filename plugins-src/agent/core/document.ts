/**
 * 当前文档桥。
 *
 * 插件只读取内存中的编辑器文本做快照；应用结果时用一次 TextEditor.edit 写回，
 * 保留撤销栈。Agent 永远拿不到 vault 的真实写权限。
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import * as imark from 'imark'
import type { DocumentSnapshot, DocMeta } from './types'
import type { ApplyResult, TurnTarget } from './protocol'

export class DocumentApplyError extends Error {
  constructor(
    readonly code: 'no-editor' | 'stale-document' | 'invalid-target' | 'edit-rejected',
    message: string
  ) {
    super(message)
  }
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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
      key: document.uri.toString(),
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
      key: snapshot.key,
      fileName: snapshot.fileName,
      version: snapshot.version,
      isDirty: snapshot.isDirty,
      editable: true,
      selection: snapshot.selection
    }
  }

  async apply(
    text: string,
    target: TurnTarget,
    options: { expectedKey?: string; expectedHash?: string; force?: boolean } = {}
  ): Promise<ApplyResult> {
    const editor = imark.window.activeTextEditor
    if (!editor) throw new DocumentApplyError('no-editor', '当前没有打开的文档')
    const document = editor.document
    const key = document.uri.toString()
    if (options.expectedKey && options.expectedKey !== key) {
      throw new DocumentApplyError('stale-document', '当前文档已经切换，结果未写入')
    }
    if (target.kind === 'replace-all' && options.expectedHash && !options.force) {
      const currentHash = hashText(document.getText())
      if (currentHash !== options.expectedHash) {
        throw new DocumentApplyError(
          'stale-document',
          '文档在 Agent 运行期间发生了变化；请确认后再覆盖'
        )
      }
    }

    let ok = false
    if (target.kind === 'replace-all') {
      const end = document.positionAt(document.getText().length)
      ok = await editor.edit(edit => {
        edit.replace(new imark.Range(document.positionAt(0), end), text)
      })
    } else if (target.kind === 'insert-at-cursor') {
      ok = await editor.edit(edit => {
        edit.insert(editor.selection.active, text)
      })
    } else {
      const line = Math.min(Math.max(Math.trunc(target.line), 0), Math.max(0, document.lineCount - 1))
      const at = document.lineAt(line)
      const next = line + 1 < document.lineCount ? document.lineAt(line + 1) : null
      const insert = next && next.text === '' ? `\n${text}` : `\n\n${text}`
      ok = await editor.edit(edit => {
        edit.insert(at.range.end, insert)
      })
    }

    if (!ok) throw new DocumentApplyError('edit-rejected', '文档拒绝了这次修改')
    return { applied: true, version: document.version }
  }
}
