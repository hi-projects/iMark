/**
 * 附件 staging：只搬字节，不做任何格式解析。
 *
 * webview 按 128 KiB 分块上传，宿主边写边算 sha256；结束校验总大小后原子
 * rename 到会话的 attachments/ 下。文件名只用于展示和落盘，不参与解析。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DocumentSnapshot, StagedAttachment } from './types'
import type { AttachmentMeta, UploadBeginResult } from './protocol'
import {
  CHUNK_BYTES,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_CHUNK_BASE64
} from './protocol'
import { attachmentsOf, type SessionStore } from './sessions'

interface UploadRecord {
  uploadId: string
  sessionId: string
  name: string
  mime: string
  size: number
  received: number
  nextIndex: number
  total: number
  hash: ReturnType<typeof createHash>
  handle: Awaited<ReturnType<typeof open>>
  partPath: string
}

export interface BeginInput {
  sessionId: string
  name: string
  size: number
  mime: string
  maxBytes: number
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function sanitizeFileName(raw: unknown): string {
  const value = text(raw, 'attachment').replace(/\\/g, '/')
  const base = value.split('/').pop() ?? 'attachment'
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
  return cleaned || 'attachment'
}

export function kindOf(name: string, mime: string): StagedAttachment['kind'] {
  const lower = name.toLowerCase()
  const type = mime.toLowerCase()
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/.test(lower)) return 'image'
  if (type === 'application/pdf' || /\.pdf$/.test(lower)) return 'pdf'
  if (
    type.startsWith('text/') ||
    /\.(md|markdown|txt|json|jsonl|csv|tsv|log|yaml|yml|toml|xml|html?|css|js|mjs|cjs|ts|tsx|py|sh|rs|go|java|c|cpp|h|hpp|sql|tex|bib)$/.test(
      lower
    )
  ) {
    return 'text'
  }
  return 'other'
}

function safeMime(raw: unknown): string {
  const value = text(raw, '').trim().toLowerCase()
  return value && value.length <= 100 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value)
    ? value
    : 'application/octet-stream'
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > MAX_CHUNK_BASE64 || value.length % 4 !== 0) {
    throw new Error('附件分块格式不正确')
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('附件分块不是合法 base64')
  return Buffer.from(value, 'base64')
}

export class AttachmentStager {
  private readonly uploads = new Map<string, UploadRecord>()
  /** 内容寻址的共享存储：同一份字节只存一次，各会话用硬链接引用 */
  private readonly blobsDir: string

  constructor(private readonly sessions: SessionStore) {
    this.blobsDir = resolve(sessions.rootPath, '..', 'blobs')
  }

  async begin(input: BeginInput): Promise<UploadBeginResult> {
    const meta = await this.sessions.getMeta(input.sessionId)
    if (!meta) throw new Error('会话不存在')
    if (!Number.isInteger(input.size) || input.size <= 0) throw new Error('附件大小无效')
    if (input.size > input.maxBytes) {
      throw new Error(`单个附件不能超过 ${Math.round(input.maxBytes / 1024 / 1024)} MB`)
    }
    if (meta.attachments.length >= MAX_ATTACHMENTS_PER_SESSION) {
      throw new Error(`每个会话最多 ${MAX_ATTACHMENTS_PER_SESSION} 个附件`)
    }
    const used = meta.attachments.reduce((sum, item) => sum + item.size, 0)
    if (used + input.size > input.maxBytes * 4) {
      throw new Error('本会话附件总大小超过上限，请先移除一些附件')
    }
    if (this.uploads.size >= 4) throw new Error('同时上传的附件太多，请稍后再试')

    const uploadId = randomUUID()
    const dir = this.sessions.incomingDir(input.sessionId)
    await mkdir(dir, { recursive: true })
    const partPath = join(dir, `${uploadId}.part`)
    const handle = await open(partPath, 'w')
    this.uploads.set(uploadId, {
      uploadId,
      sessionId: input.sessionId,
      name: sanitizeFileName(input.name),
      mime: safeMime(input.mime),
      size: input.size,
      received: 0,
      nextIndex: 0,
      total: 0,
      hash: createHash('sha256'),
      handle,
      partPath
    })
    return {
      sessionId: input.sessionId,
      uploadId,
      chunkBytes: CHUNK_BYTES,
      maxBytes: input.maxBytes
    }
  }

  async chunk(uploadId: string, index: number, total: number, data: string): Promise<{ received: number; total: number }> {
    const record = this.uploads.get(uploadId)
    if (!record) throw new Error('上传已失效，请重新选择文件')
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1) {
      throw new Error('附件分块参数无效')
    }
    if (record.total === 0) record.total = total
    if (record.total !== total) throw new Error('附件分块总数不一致')
    if (index !== record.nextIndex) throw new Error('附件分块顺序不正确')
    if (index >= total) throw new Error('附件分块索引越界')

    const buffer = decodeBase64(data)
    if (record.received + buffer.length > record.size) {
      throw new Error('附件内容超过声明大小')
    }
    await record.handle.write(buffer)
    record.hash.update(buffer)
    record.received += buffer.length
    record.nextIndex += 1
    return { received: record.received, total }
  }

  async finish(uploadId: string): Promise<{ sessionId: string; attachment: StagedAttachment }> {
    const record = this.uploads.get(uploadId)
    if (!record) throw new Error('上传已失效，请重新选择文件')
    if (record.total === 0 || record.nextIndex !== record.total || record.received !== record.size) {
      await this.cancel(uploadId)
      throw new Error('附件上传不完整，请重试')
    }
    await record.handle.close()

    const sha256 = record.hash.digest('hex')
    const meta = await this.sessions.getMeta(record.sessionId)
    if (!meta) {
      await rm(record.partPath, { force: true })
      this.uploads.delete(uploadId)
      throw new Error('会话不存在')
    }
    const duplicate = meta.attachments.find(item => item.sha256 === sha256 && item.size === record.size)
    if (duplicate) {
      await rm(record.partPath, { force: true })
      this.uploads.delete(uploadId)
      return { sessionId: record.sessionId, attachment: duplicate }
    }

    const ordinal = meta.attachments.length + 1
    const storedName = await this.uniqueStoredName(record.sessionId, ordinal, record.name)
    const finalPath = join(this.sessions.attachmentsDir(record.sessionId), storedName)
    await this.materialize(record.partPath, sha256, finalPath)
    this.uploads.delete(uploadId)

    const attachment: StagedAttachment = {
      id: `a${ordinal}`,
      name: record.name,
      storedName,
      size: record.size,
      mime: record.mime,
      sha256,
      kind: kindOf(record.name, record.mime),
      path: finalPath
    }
    await this.sessions.addAttachment(record.sessionId, attachment)
    return { sessionId: record.sessionId, attachment }
  }

  /**
   * 把当前打开的文档作为一条普通附件暂存。
   *
   * 会话本身不绑定文档；只有用户点「添加本文档」时才把内容快照写进
   * attachments/，之后和其它附件一样随某一条消息发出去。
   */
  async attachDocument(sessionId: string, snapshot: DocumentSnapshot): Promise<StagedAttachment> {
    const meta = await this.sessions.getMeta(sessionId)
    if (!meta) throw new Error('会话不存在')
    const name = sanitizeFileName(snapshot.fileName || 'document.md')
    const body = Buffer.from(snapshot.text, 'utf8')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const duplicate = meta.attachments.find(
      item => item.sha256 === sha256 && item.name === name
    )
    if (duplicate) return duplicate
    if (meta.attachments.length >= MAX_ATTACHMENTS_PER_SESSION) {
      throw new Error(`每个会话最多 ${MAX_ATTACHMENTS_PER_SESSION} 个附件`)
    }

    const used = new Set(meta.attachments.map(item => item.id))
    let ordinal = meta.attachments.length + 1
    while (used.has(`a${ordinal}`)) ordinal += 1
    const storedName = await this.uniqueStoredName(sessionId, ordinal, name)
    const finalPath = join(this.sessions.attachmentsDir(sessionId), storedName)
    const attachment: StagedAttachment = {
      id: `a${ordinal}`,
      name,
      storedName,
      size: body.byteLength,
      mime: 'text/markdown',
      sha256,
      kind: kindOf(name, 'text/markdown'),
      path: finalPath,
      source: 'document'
    }
    // 先写到临时文件，再走和普通附件相同的共享存储流程
    const tmp = join(this.sessions.incomingDir(sessionId), `${randomUUID()}.part`)
    await mkdir(this.sessions.incomingDir(sessionId), { recursive: true })
    await writeFile(tmp, body)
    await this.materialize(tmp, sha256, finalPath)
    await this.sessions.addAttachment(sessionId, attachment)
    return attachment
  }

  async cancel(uploadId: string): Promise<void> {
    const record = this.uploads.get(uploadId)
    if (!record) return
    this.uploads.delete(uploadId)
    await record.handle.close().catch(() => undefined)
    await rm(record.partPath, { force: true }).catch(() => undefined)
  }

  async remove(sessionId: string, attachmentId: string): Promise<AttachmentMeta[]> {
    const removed = await this.sessions.removeAttachment(sessionId, attachmentId)
    if (removed) {
      await rm(removed.path, { force: true }).catch(() => undefined)
      await this.releaseBlob(removed.sha256)
    }
    const meta = await this.sessions.getMeta(sessionId)
    return meta ? attachmentsOf(meta) : []
  }

  /** 会话删除后回收不再被任何硬链接引用的共享 blob */
  async gcAll(): Promise<void> {
    const names = await readdir(this.blobsDir).catch(() => [])
    for (const name of names) await this.releaseBlob(name)
  }

  /**
   * 把临时文件变成「blob + 会话内硬链接」。
   *
   * 同一份内容在多个会话里只占一份磁盘；不支持硬链接的文件系统
   * （FAT、部分网络盘等）退回到直接落一份副本。
   */
  private async materialize(source: string, sha256: string, finalPath: string): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true })
    const blob = join(this.blobsDir, sha256)
    try {
      await link(source, blob)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        await rename(source, finalPath)
        return
      }
    }
    await rm(source, { force: true }).catch(() => undefined)
    try {
      await link(blob, finalPath)
    } catch {
      await copyFile(blob, finalPath)
    }
  }

  private async releaseBlob(sha256: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) return
    const blob = join(this.blobsDir, sha256)
    const info = await lstat(blob).catch(() => null)
    if (!info?.isFile() || info.nlink > 1) return
    await rm(blob, { force: true }).catch(() => undefined)
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.uploads.keys()]
    await Promise.all(ids.map(id => this.cancel(id)))
  }

  private async uniqueStoredName(sessionId: string, ordinal: number, name: string): Promise<string> {
    const dir = this.sessions.attachmentsDir(sessionId)
    await mkdir(dir, { recursive: true })
    const existing = new Set(await readdir(dir).catch(() => []))
    const safe = sanitizeFileName(name)
    let candidate = `a${ordinal}-${safe}`
    let suffix = 2
    while (existing.has(candidate)) {
      candidate = `a${ordinal}-${suffix}-${safe}`
      suffix += 1
    }
    return candidate
  }
}
