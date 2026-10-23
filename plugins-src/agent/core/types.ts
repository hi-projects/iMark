/**
 * Agent Core 的类型层。
 *
 * provider 契约在 `@shared/agentProvider`（Core 与 provider 扩展共用）；这里只
 * 保留 Core 自己的任务模式与附件/文档/产物形状，并把共享类型重新导出，避免
 * Core 内部每个文件都要认识两个 import 路径。
 *
 * 本文件不 import `imark` / Electron / DOM：webview 也会打包它。
 */

export type {
  AgentCapabilities,
  AgentDetection,
  AgentError,
  AgentErrorCode,
  AgentEvent,
  AgentInputMode,
  AgentMode,
  AgentModel,
  AgentProvider,
  AgentProviderInfo,
  AgentProviderModule,
  AgentRole,
  AgentSession,
  AgentSessionOptions,
  AgentTurn,
  AgentUsage,
  ToolKind
} from '@shared/agentProvider'

/** 任务模式：这一次用户想让 Agent 做什么 */
export type AgentTaskMode = 'ask' | 'generate' | 'beautify'

/** 宿主内部使用的附件元数据；`path` 绝不下发给 webview */
export interface StagedAttachment {
  id: string
  /** 用户看到的原始名字（已做安全清洗） */
  name: string
  /** 磁盘上的文件名（带 aN- 前缀，保证唯一） */
  storedName: string
  size: number
  mime: string
  sha256: string
  kind: 'image' | 'pdf' | 'text' | 'other'
  path: string
}

export interface DocumentSnapshot {
  key: string
  fileName: string
  text: string
  version: number
  isDirty: boolean
  selection: { line: number; character: number; offset: number }
}

/** 推给 webview 的文档元数据：不带正文与真实路径 */
export interface DocMeta {
  key: string
  fileName: string
  version: number
  isDirty: boolean
  selection: { line: number; character: number; offset: number }
}

export interface ArtifactInfo {
  /** 相对 prepared/ 的路径，使用 / 分隔 */
  path: string
  name: string
  size: number
  kind: 'markdown' | 'text' | 'image' | 'other'
}
