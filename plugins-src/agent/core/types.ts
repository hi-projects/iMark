/**
 * Agent Host 的纯类型层。
 *
 * 这里刻意不 import `imark` / Electron / DOM：provider 适配器、宿主与 webview
 * 协议都共用这些形状，任何一端引入运行时依赖都会把边界弄脏。
 */

export type AgentRole = 'agent' | 'completion'
export type AgentInputMode = 'native' | 'path' | 'none'
/** 权限模式：是否允许 Agent 运行解析命令/写文件 */
export type AgentMode = 'read-only' | 'read+parse'
/** 任务模式：这一次用户想让 Agent 做什么 */
export type AgentTaskMode = 'ask' | 'generate' | 'beautify'
export type AgentIsolation = 'safe' | 'restricted' | 'off'
export type ToolKind = 'read' | 'search' | 'edit' | 'shell' | 'network' | 'other'

export type AgentErrorCode =
  | 'cli-missing'
  | 'auth-required'
  | 'permission-denied'
  | 'timeout'
  | 'turn-limit'
  | 'cancelled'
  | 'provider-error'
  | 'protocol-error'
  | 'config-invalid'
  | 'attachment-too-large'
  | 'attachment-missing'
  | 'stale-document'
  | 'no-editor'
  | 'invalid-target'
  | 'edit-rejected'
  | 'not-found'

export interface AgentError {
  code: AgentErrorCode
  message: string
  detail?: string
  retryable?: boolean
}

export interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type AgentEvent =
  | { type: 'session'; providerSessionId: string; model?: string; tools?: readonly string[] }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; phase: 'start'; toolId: string; name: string; kind: ToolKind; inputSummary: string }
  | { type: 'tool'; phase: 'result'; toolId: string; name?: string; ok: boolean; summary: string }
  | { type: 'status'; message: string }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | {
      type: 'result'
      text: string
      providerSessionId?: string
      isError: boolean
      error?: AgentError
      usage?: AgentUsage
      costUsd?: number
      durationMs?: number
    }
  | { type: 'error'; error: AgentError }

export interface AgentCapabilities {
  roles: readonly AgentRole[]
  inputs: {
    image: AgentInputMode
    pdf: AgentInputMode
    file: AgentInputMode
  }
  tools: { read: boolean; bash: boolean; write: boolean }
  streaming: boolean
  thinking: boolean
  resume: boolean
  systemPrompt: boolean
}

export interface AgentModel {
  id: string
  label: string
}

export interface AgentProviderInfo {
  id: string
  label: string
  description?: string
  capabilities: AgentCapabilities
  models: readonly AgentModel[]
}

export interface AgentDetection {
  available: boolean
  version?: string
  executable?: string
  error?: AgentError
}

export interface AgentTurn {
  turnId: string
  prompt: string
}

export interface AgentSessionOptions {
  hostSessionId: string
  providerSessionId?: string
  cwd: string
  mode: AgentMode
  isolation: AgentIsolation
  model?: string
  timeoutMs: number
  maxTurns: number
  extraArgs?: readonly string[]
  apiKey?: string
  commandPath?: string
  /** 本机探测到的命令名，用来生成 Bash 白名单（不用于解析） */
  availableCommands?: readonly string[]
  signal: AbortSignal
}

export interface AgentSession {
  readonly providerSessionId: string | undefined
  send(turn: AgentTurn): AsyncIterable<AgentEvent>
  cancel(reason?: 'user' | 'timeout' | 'turn-limit' | 'dispose'): void
  dispose(): Promise<void>
}

export interface AgentProvider {
  readonly info: AgentProviderInfo
  detect(ctx: {
    commandPath?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<AgentDetection>
  createSession(options: AgentSessionOptions): Promise<AgentSession>
}

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
  editable: boolean
  selection: { line: number; character: number; offset: number }
}

export interface ArtifactInfo {
  /** 相对 prepared/ 的路径，使用 / 分隔 */
  path: string
  name: string
  size: number
  kind: 'markdown' | 'text' | 'image' | 'other'
}
