/**
 * 文档注册表（main 侧）。
 *
 * 文档的**真身在渲染层**（CodeMirror）；main 只保存一份用于回答宿主请求的镜像：
 *   - `editor.ready` 给出启动时打开的标签；
 *   - 之后每次内容变化都带 CM6 的增量 `{from,to,text}` 与新版本号；
 *   - `documents.open`（扩展主动打开一个没在编辑器里的文件）由 main 读盘补一份；
 *   - `documents.resync` 把整篇文档再发一次，给版本不连续的宿主兜底。
 *
 * 这里不解释 Markdown、不碰编辑器状态，只做“把增量正确套到文本上”这一件事。
 * 增量必须按**旧文档坐标**从后往前应用：CM6 的 iterChanges 给出的是升序、互不重叠
 * 的区间，倒序套用才不会被前一次修改挪动后面的偏移。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type {
  DocumentChangeDto,
  DocumentStateDto,
  TextChangeDto
} from '@shared/extensionProtocol'

function detectEol(text: string): 'lf' | 'crlf' {
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  return crlf > lf ? 'crlf' : 'lf'
}

/** 把一组“旧坐标”的修改套到文本上；任何越界都返回 null（由调用方要求全量重同步） */
function applyTextChanges(text: string, changes: readonly TextChangeDto[]): string | null {
  const sorted = [...changes].sort((a, b) => b.from - a.from)
  let out = text
  let upper = Number.POSITIVE_INFINITY
  for (const change of sorted) {
    if (
      !Number.isInteger(change.from) ||
      !Number.isInteger(change.to) ||
      change.from < 0 ||
      change.to < change.from ||
      change.to > upper ||
      change.to > out.length
    ) {
      return null
    }
    out = out.slice(0, change.from) + change.text + out.slice(change.to)
    upper = change.from
  }
  return out
}

export class DocumentRegistry {
  private readonly docs = new Map<string, DocumentStateDto>()
  /** 渲染层当前打开的标签（activeChanged 的 visible 列表） */
  private openUris = new Set<string>()
  private activeUri: string | null = null

  resetFromRenderer(
    documents: readonly DocumentStateDto[],
    active: string | null,
    visible: readonly string[]
  ): void {
    this.docs.clear()
    this.openUris = new Set(visible)
    for (const doc of documents) {
      this.docs.set(doc.uri, { ...doc })
    }
    this.activeUri = active
  }

  opened(state: DocumentStateDto): DocumentStateDto {
    this.docs.set(state.uri, { ...state })
    this.openUris.add(state.uri)
    return this.docs.get(state.uri)!
  }

  /**
   * 应用一次渲染层变更。
   *
   * 返回 `null` 表示没有这份文档（例如渲染层先发 changed 后发 opened）——
   * 调用方直接丢掉即可，下一次 opened 会带全文。
   */
  changed(change: DocumentChangeDto): DocumentStateDto | null {
    const current = this.docs.get(change.uri)
    if (!current) {
      if (typeof change.text !== 'string') return null
      const created: DocumentStateDto = {
        uri: change.uri,
        version: change.version,
        text: change.text,
        eol: change.eol ?? detectEol(change.text),
        isDirty: change.isDirty ?? true,
        languageId: 'markdown'
      }
      this.docs.set(change.uri, created)
      return created
    }
    let text = current.text
    if (typeof change.text === 'string') {
      text = change.text
    } else if (change.changes.length > 0) {
      const next = applyTextChanges(current.text, change.changes)
      if (next === null) {
        // 镜像不可信：保留现有内容，等 documents.resync 或下一次全量变化覆盖。
        // 这里不抛错：一次坏增量不该中断整条变更广播。
        return null
      }
      text = next
    }
    const next: DocumentStateDto = {
      ...current,
      version: change.version,
      text,
      eol: change.eol ?? (typeof change.text === 'string' ? detectEol(change.text) : current.eol),
      isDirty: change.isDirty ?? true
    }
    this.docs.set(change.uri, next)
    return next
  }

  /**
   * 标签关闭。镜像一起丢掉：下次打开必须重新读盘。
   *
   * 留着旧镜像看似省一次 IO，实际会让扩展看到**关闭前**的文本 —— 文件可能已经
   * 被别的程序改了，而 `ensureFromDisk` 又会因为镜像存在直接返回它。VS Code 里
   * 关闭最后一个引用后文档就是真的关了，这里保持一致。
   */
  closed(uri: string): void {
    this.openUris.delete(uri)
    this.docs.delete(uri)
    if (this.activeUri === uri) this.activeUri = null
  }

  saved(uri: string, version: number): DocumentStateDto | null {
    const doc = this.docs.get(uri)
    if (!doc) return null
    doc.version = version
    doc.isDirty = false
    return doc
  }

  setActive(uri: string | null, visible?: readonly string[]): void {
    this.activeUri = uri
    if (visible) this.openUris = new Set(visible)
    else if (uri) this.openUris.add(uri)
  }

  get(uri: string): DocumentStateDto | null {
    return this.docs.get(uri) ?? null
  }

  get active(): string | null {
    return this.activeUri
  }

  get visible(): string[] {
    return [...this.openUris]
  }

  list(): DocumentStateDto[] {
    return [...this.docs.values()]
  }

  /** 扩展请求打开一个不在编辑器里的文档：读盘并登记 */
  async ensureFromDisk(uri: string): Promise<DocumentStateDto> {
    const existing = this.docs.get(uri)
    if (existing) return existing
    if (!uri.startsWith('file:')) {
      throw new Error(`无法打开非 file 文档：${uri}`)
    }
    const path = fileURLToPath(uri)
    const text = await readFile(path, 'utf8')
    const state: DocumentStateDto = {
      uri,
      version: 1,
      text,
      eol: detectEol(text),
      isDirty: false,
      languageId: 'markdown'
    }
    this.docs.set(uri, state)
    return state
  }

  /** 版本兜底：优先镜像；没有就尝试读盘 */
  async resync(uri: string): Promise<DocumentStateDto> {
    return this.docs.get(uri) ?? (await this.ensureFromDisk(uri))
  }
}
