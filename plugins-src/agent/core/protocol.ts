/**
 * 扩展宿主 ↔ webview 的线协议。
 *
 * 约束：
 * - webview 只拿得到相对路径/元数据，拿不到会话目录绝对路径、附件真实路径或密钥；
 * - 宿主不信任 webview 回传的正文，应用文档时只使用宿主自己存下的消息/产物；
 * - 附件分块 128 KiB（base64 约 175k 字符），低于扩展侧自设的 240 KiB 上限。
 */

import type {
  AgentDetection,
  AgentError,
  AgentEvent,
  AgentMode,
  AgentProviderInfo,
  AgentTaskMode,
  AgentUsage,
  ArtifactInfo,
  DocMeta,
  StagedAttachment,
  ToolKind
} from './types'

export const CHUNK_BYTES = 128 * 1024
export const MAX_CHUNK_BASE64 = 200_000
export const MAX_ATTACHMENTS_PER_SESSION = 20
export const MAX_TURN_TEXT = 16_000
export const MAX_SESSION_MESSAGES = 200
export const MAX_PREVIEW_TEXT = 512 * 1024
export const MAX_PREVIEW_IMAGE = 8 * 1024 * 1024
export const MAX_DOCUMENT_SNAPSHOT = 2 * 1024 * 1024

export interface SafeConfig {
  mode: AgentMode
  attachmentMaxMB: number
}

export interface ProviderView {
  info: AgentProviderInfo
  detection?: AgentDetection
}

export interface AttachmentMeta {
  id: string
  name: string
  size: number
  mime: string
  sha256: string
  kind: StagedAttachment['kind']
}

export interface ToolCallView {
  toolId: string
  name: string
  kind: ToolKind
  inputSummary: string
  ok?: boolean
  summary?: string
}

export interface SessionMessage {
  seq: number
  role: 'user' | 'assistant'
  text: string
  status: 'ok' | 'error' | 'cancelled' | 'running'
  mode: AgentTaskMode
  attachmentIds: string[]
  toolCalls: ToolCallView[]
  usage?: AgentUsage
  costUsd?: number
  error?: AgentError
  artifacts?: ArtifactInfo[]
  createdAt: number
}

export interface SessionSummary {
  id: string
  title: string
  documentKey: string
  documentName: string
  provider: string
  model?: string
  mode: AgentMode
  status: 'idle' | 'running' | 'error' | 'interrupted'
  createdAt: number
  updatedAt: number
  messageCount: number
  attachmentCount: number
  artifactCount: number
}

export interface SessionView {
  summary: SessionSummary
  messages: SessionMessage[]
  attachments: AttachmentMeta[]
  artifacts: ArtifactInfo[]
}

export type TurnTarget =
  | { kind: 'replace-all' }
  | { kind: 'insert-below-line'; line: number }
  | { kind: 'insert-at-cursor' }

export interface ArtifactPreview {
  kind: 'markdown' | 'text' | 'image' | 'other'
  text?: string
  html?: string
  dataBase64?: string
  mime?: string
  truncated?: boolean
}

export interface ApplyResult {
  applied: boolean
  version?: number
  warnings?: string[]
}

// ---------- webview → host ----------

export interface InitPayload {
  providers: readonly ProviderView[]
  config: SafeConfig
  doc: DocMeta | null
  sessions: readonly SessionSummary[]
  activeSessionId: string | null
}

export interface UiIntent {
  mode: AgentTaskMode
  auto?: boolean
}

// ---------- host → webview ----------

export type HostPush =
  | { type: 'push'; kind: 'init'; value: InitPayload }
  | { type: 'push'; kind: 'config'; value: { config: SafeConfig } }
  | { type: 'push'; kind: 'doc'; value: { doc: DocMeta | null } }
  | { type: 'push'; kind: 'sessions'; value: { documentKey: string; sessions: readonly SessionSummary[] } }
  | { type: 'push'; kind: 'session'; value: { session: SessionView } }
  | { type: 'push'; kind: 'sessionSummary'; value: { summary: SessionSummary } }
  | { type: 'push'; kind: 'sessionDeleted'; value: { sessionId: string } }
  | { type: 'push'; kind: 'turnStarted'; value: { turnId: string; sessionId: string; message: SessionMessage } }
  | {
      type: 'push'
      kind: 'turnEvent'
      value: { turnId: string; sessionId: string; event: AgentEvent }
    }
  | {
      type: 'push'
      kind: 'turnFinished'
      value: {
        turnId: string
        sessionId: string
        status: 'ok' | 'error' | 'cancelled'
        message: SessionMessage
      }
    }
  | { type: 'push'; kind: 'uiIntent'; value: UiIntent }
  | { type: 'push'; kind: 'error'; value: { scope: string; error: AgentError } }

// ---------- 上传 ----------

export interface UploadBeginResult {
  sessionId: string
  uploadId: string
  chunkBytes: number
  maxBytes: number
}

export function toAttachmentMeta(attachment: StagedAttachment): AttachmentMeta {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    mime: attachment.mime,
    sha256: attachment.sha256,
    kind: attachment.kind
  }
}
