/**
 * 会话持久化。
 *
 * 每个会话一个目录：meta.json + messages.jsonl + document.md + attachments/ + prepared/。
 * webview 只拿到 summary/view；绝对路径、附件磁盘名、docHash 都留在宿主。
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMode, ArtifactInfo, StagedAttachment } from './types'
import type {
  AttachmentMeta,
  SessionMessage,
  SessionSummary
} from './protocol'
import {
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_SESSION_MESSAGES,
  toAttachmentMeta
} from './protocol'

export interface SessionMeta {
  version: 1
  id: string
  documentKey: string
  documentName: string
  title: string
  provider: string
  providerSessionId?: string
  model?: string
  mode: AgentMode
  status: 'idle' | 'running' | 'error' | 'interrupted'
  createdAt: number
  updatedAt: number
  messageCount: number
  attachmentCount: number
  nextSeq: number
  attachments: StagedAttachment[]
}

/** messages.jsonl 的内部形状：多一个 docHash，只在宿主内使用 */
export interface StoredMessage extends SessionMessage {
  docHash?: string
}

export interface SessionOpen {
  meta: SessionMeta
  messages: StoredMessage[]
}

export interface CreateSessionInput {
  documentKey: string
  documentName: string
  provider: string
  model?: string
  mode: AgentMode
}

interface IndexDocument {
  documentKey: string
  documentName: string
  sessions: string[]
}

interface IndexFile {
  version: 1
  documents: Record<string, IndexDocument>
}

const DEFAULT_TITLE = '新会话'
const MAX_MESSAGE_BYTES = 1024 * 1024
const INCOMING_TTL_MS = 60 * 60 * 1000

function docIndexKey(documentKey: string): string {
  return createHash('sha256').update(documentKey).digest('hex').slice(0, 16)
}

function emptyIndex(): IndexFile {
  return { version: 1, documents: {} }
}

export function attachmentsOf(meta: SessionMeta): AttachmentMeta[] {
  return meta.attachments.map(toAttachmentMeta)
}

export function toViewMessage(message: StoredMessage): SessionMessage {
  const { docHash: _docHash, ...rest } = message
  return rest
}

export class SessionStore {
  private readonly root: string
  private index: IndexFile = emptyIndex()
  private indexQueue: Promise<void> = Promise.resolve()
  /**
   * meta.json 的读-改-写必须串行：附件 finish 与 turn 的 appendMessage 可能同时
   * 发生，否则后写的一份会用旧 meta 覆盖掉刚加进去的附件（丢文件的经典竞态）。
   */
  private metaQueue: Promise<unknown> = Promise.resolve()

  constructor(globalStoragePath: string) {
    this.root = join(globalStoragePath, 'sessions')
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    this.index = await this.loadIndex()
    await this.reconcile()
  }

  get rootPath(): string {
    return this.root
  }

  sessionDir(id: string): string {
    return join(this.root, id)
  }

  metaPath(id: string): string {
    return join(this.sessionDir(id), 'meta.json')
  }

  documentPath(id: string): string {
    return join(this.sessionDir(id), 'document.md')
  }

  attachmentsDir(id: string): string {
    return join(this.sessionDir(id), 'attachments')
  }

  incomingDir(id: string): string {
    return join(this.sessionDir(id), 'attachments', '.incoming')
  }

  preparedDir(id: string): string {
    return join(this.sessionDir(id), 'prepared')
  }

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const now = Date.now()
    const meta: SessionMeta = {
      version: 1,
      id: randomUUID(),
      documentKey: input.documentKey,
      documentName: input.documentName,
      title: DEFAULT_TITLE,
      provider: input.provider,
      model: input.model,
      mode: input.mode,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      attachmentCount: 0,
      nextSeq: 1,
      attachments: []
    }
    await mkdir(this.sessionDir(meta.id), { recursive: true })
    await mkdir(this.attachmentsDir(meta.id), { recursive: true })
    await mkdir(this.preparedDir(meta.id), { recursive: true })
    await this.saveMeta(meta)
    await this.enqueueIndex(() => {
      const key = docIndexKey(meta.documentKey)
      const doc = this.index.documents[key] ?? {
        documentKey: meta.documentKey,
        documentName: meta.documentName,
        sessions: []
      }
      doc.documentName = meta.documentName
      if (!doc.sessions.includes(meta.id)) doc.sessions.push(meta.id)
      this.index.documents[key] = doc
      return this.saveIndex()
    })
    return meta
  }

  async getMeta(id: string): Promise<SessionMeta | null> {
    try {
      const raw = JSON.parse(await readFile(this.metaPath(id), 'utf8')) as SessionMeta
      if (!raw || raw.version !== 1 || raw.id !== id) return null
      return raw
    } catch {
      return null
    }
  }

  async list(documentKey: string): Promise<SessionSummary[]> {
    const key = docIndexKey(documentKey)
    const ids = this.index.documents[key]?.sessions ?? []
    const out: SessionSummary[] = []
    for (const id of ids) {
      const meta = await this.getMeta(id)
      if (!meta) continue
      out.push(this.summaryOf(meta))
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return out
  }

  summaryOf(meta: SessionMeta, artifacts: readonly ArtifactInfo[] = []): SessionSummary {
    return {
      id: meta.id,
      title: meta.title,
      documentKey: meta.documentKey,
      documentName: meta.documentName,
      provider: meta.provider,
      model: meta.model,
      mode: meta.mode,
      status: meta.status,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
      attachmentCount: meta.attachmentCount,
      artifactCount: artifacts.length
    }
  }

  async update(id: string, patch: Partial<Omit<SessionMeta, 'version' | 'id' | 'createdAt'>>): Promise<SessionMeta> {
    return this.serialize(() => this.updateUnlocked(id, patch))
  }

  private async updateUnlocked(
    id: string,
    patch: Partial<Omit<SessionMeta, 'version' | 'id' | 'createdAt'>>
  ): Promise<SessionMeta> {
    const meta = await this.getMeta(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    Object.assign(meta, patch, { updatedAt: Date.now() })
    await this.saveMeta(meta)
    return meta
  }

  async delete(id: string): Promise<void> {
    return this.serialize(() => this.deleteUnlocked(id))
  }

  private async deleteUnlocked(id: string): Promise<void> {
    await rm(this.sessionDir(id), { recursive: true, force: true })
    await this.enqueueIndex(() => {
      for (const doc of Object.values(this.index.documents)) {
        doc.sessions = doc.sessions.filter(sessionId => sessionId !== id)
      }
      return this.saveIndex()
    })
  }

  /** 面板关闭/切换时清掉“打开了但没发过消息”的草稿会话 */
  async pruneEmptyDrafts(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const meta = await this.getMeta(entry.name)
      if (!meta) continue
      if (meta.messageCount === 0 && meta.attachments.length === 0) {
        await this.delete(meta.id)
      }
    }
  }

  async appendMessage(id: string, message: Omit<StoredMessage, 'seq' | 'createdAt'>): Promise<StoredMessage> {
    return this.serialize(() => this.appendMessageUnlocked(id, message))
  }

  private async appendMessageUnlocked(
    id: string,
    message: Omit<StoredMessage, 'seq' | 'createdAt'>
  ): Promise<StoredMessage> {
    const meta = await this.getMeta(id)
    if (!meta) throw new Error(`会话不存在：${id}`)
    const stored: StoredMessage = {
      ...message,
      seq: meta.nextSeq,
      createdAt: Date.now()
    }
    await appendFile(join(this.sessionDir(id), 'messages.jsonl'), `${JSON.stringify(stored)}\n`, 'utf8')

    meta.nextSeq += 1
    meta.messageCount += 1
    meta.updatedAt = stored.createdAt
    meta.status = message.status === 'running' ? 'running' : message.status === 'ok' ? 'idle' : 'error'
    if (message.role === 'user' && meta.title === DEFAULT_TITLE) {
      const candidate = message.text.trim().replace(/\s+/g, ' ').slice(0, 40)
      meta.title = candidate || message.attachmentIds[0] || DEFAULT_TITLE
    }
    await this.saveMeta(meta)
    return stored
  }

  async setStatus(id: string, status: SessionMeta['status']): Promise<void> {
    return this.serialize(async () => {
      const meta = await this.getMeta(id)
      if (!meta) return
      meta.status = status
      meta.updatedAt = Date.now()
      await this.saveMeta(meta)
    })
  }

  async setProviderSessionId(id: string, providerSessionId: string): Promise<void> {
    return this.serialize(async () => {
      const meta = await this.getMeta(id)
      if (!meta) return
      meta.providerSessionId = providerSessionId
      meta.updatedAt = Date.now()
      await this.saveMeta(meta)
    })
  }

  async addAttachment(id: string, attachment: StagedAttachment): Promise<SessionMeta> {
    return this.serialize(async () => {
      const meta = await this.getMeta(id)
      if (!meta) throw new Error(`会话不存在：${id}`)
      if (meta.attachments.some(item => item.id === attachment.id)) return meta
      if (meta.attachments.length >= MAX_ATTACHMENTS_PER_SESSION) {
        throw new Error(`每个会话最多 ${MAX_ATTACHMENTS_PER_SESSION} 个附件`)
      }
      meta.attachments.push(attachment)
      meta.attachmentCount = meta.attachments.length
      meta.updatedAt = Date.now()
      await this.saveMeta(meta)
      return meta
    })
  }

  async removeAttachment(id: string, attachmentId: string): Promise<StagedAttachment | null> {
    return this.serialize(async () => {
      const meta = await this.getMeta(id)
      if (!meta) return null
      const index = meta.attachments.findIndex(item => item.id === attachmentId)
      if (index < 0) return null
      const [removed] = meta.attachments.splice(index, 1)
      meta.attachmentCount = meta.attachments.length
      meta.updatedAt = Date.now()
      await this.saveMeta(meta)
      return removed ?? null
    })
  }

  async findAttachment(id: string, attachmentId: string): Promise<StagedAttachment | null> {
    const meta = await this.getMeta(id)
    return meta?.attachments.find(item => item.id === attachmentId) ?? null
  }

  async readMessages(id: string): Promise<StoredMessage[]> {
    let raw = ''
    try {
      raw = await readFile(join(this.sessionDir(id), 'messages.jsonl'), 'utf8')
    } catch {
      return []
    }
    const parsed: StoredMessage[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as StoredMessage
        if (item && typeof item.seq === 'number' && (item.role === 'user' || item.role === 'assistant')) {
          parsed.push(item)
        }
      } catch {
        // 单行损坏不应让整个会话打不开
      }
    }
    const capped = parsed.slice(-MAX_SESSION_MESSAGES)
    const out: StoredMessage[] = []
    let bytes = 0
    for (let i = capped.length - 1; i >= 0; i--) {
      const item = capped[i]
      const size = Buffer.byteLength(item.text ?? '', 'utf8')
      if (bytes + size > MAX_MESSAGE_BYTES && out.length > 0) break
      out.push(item)
      bytes += size
    }
    return out.reverse()
  }

  async open(id: string): Promise<SessionOpen | null> {
    const meta = await this.getMeta(id)
    if (!meta) return null
    return { meta, messages: await this.readMessages(id) }
  }

  async messageBySeq(id: string, seq: number): Promise<StoredMessage | null> {
    const messages = await this.readMessages(id)
    return messages.find(item => item.seq === seq) ?? null
  }

  async writeDocumentSnapshot(id: string, text: string): Promise<string> {
    const path = this.documentPath(id)
    await writeFile(path, text, 'utf8')
    return path
  }

  async reconcile(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const meta = await this.getMeta(entry.name)
      if (!meta) continue
      seen.add(meta.id)
      if (meta.status === 'running') {
        meta.status = 'interrupted'
        await this.saveMeta(meta)
      }
      await this.cleanupIncoming(meta.id)
      const key = docIndexKey(meta.documentKey)
      const doc = this.index.documents[key] ?? {
        documentKey: meta.documentKey,
        documentName: meta.documentName,
        sessions: []
      }
      doc.documentName = meta.documentName
      if (!doc.sessions.includes(meta.id)) doc.sessions.push(meta.id)
      this.index.documents[key] = doc
    }
    let changed = false
    for (const [key, doc] of Object.entries(this.index.documents)) {
      const before = doc.sessions.length
      doc.sessions = doc.sessions.filter(id => seen.has(id))
      if (doc.sessions.length !== before) changed = true
      if (doc.sessions.length === 0) {
        delete this.index.documents[key]
        changed = true
      }
    }
    if (changed) await this.saveIndex()
  }

  private async cleanupIncoming(id: string): Promise<void> {
    const dir = this.incomingDir(id)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(dir, entry.name)
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > INCOMING_TTL_MS) {
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  }

  private async saveMeta(meta: SessionMeta): Promise<void> {
    const path = this.metaPath(meta.id)
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  private async loadIndex(): Promise<IndexFile> {
    try {
      const raw = JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')) as IndexFile
      if (!raw || raw.version !== 1 || typeof raw.documents !== 'object') return emptyIndex()
      return raw
    } catch {
      return emptyIndex()
    }
  }

  private async saveIndex(): Promise<void> {
    const path = join(this.root, 'index.json')
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.index, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  private enqueueIndex(task: () => Promise<void>): Promise<void> {
    const next = this.indexQueue.then(task, task)
    this.indexQueue = next.catch(() => undefined)
    return next
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.metaQueue.then(task, task)
    this.metaQueue = next.catch(() => undefined)
    return next
  }
}
