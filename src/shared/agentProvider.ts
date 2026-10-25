/**
 * Agent Core 与 Agent 后端扩展（provider）之间的唯一契约。
 *
 * Core 只依赖这里的事件/会话形状，不认识任何具体 CLI：
 *
 * - provider 在 `activate()` 里返回 `AgentProviderModule`；
 * - Core 通过 `imark.extensions.getExtension(id).exports` 读取同一宿主内的导出对象；
 * - provider 自己读取自己的配置与密钥，Core 不转发任何后端专属字段。
 *
 * 这里只放纯类型与常量，不 import Node / Electron / DOM 运行时 —— Core 的
 * webview 也会打包它。provider 扩展必须通过 `extensionDependencies` 依赖 Core，
 * 既保证同宿主，也保证 Core 先激活。
 */

import formatData from './extensionFormat.json'

/** Agent Core 的扩展 ID；provider 清单里的 extensionDependencies 必须包含它 */
export const AGENT_CORE_EXTENSION_ID: string = formatData.agentCoreExtensionId

/** provider 在清单里声明支持哪些 ID 的贡献点 */
export const AGENT_PROVIDERS_CONTRIBUTION: string = formatData.agentProvidersContribution

/**
 * 导出对象的协议版本。
 *
 * Core 只接受版本号相同的 provider：升级时旧进程里可能还留着上一版导出对象，
 * 直接按新字段读会得到 undefined；显式版本让这种不匹配变成一条诊断，而不是
 * 运行到一半才炸。
 */
export const AGENT_PROVIDER_API_VERSION = 2 as const

export type AgentInputMode = 'native' | 'path' | 'none'
export type ToolKind = 'read' | 'search' | 'edit' | 'shell' | 'network' | 'other'
export type AgentPermissionDecision = 'allow' | 'deny'

export type AgentErrorCode =
  | 'provider-unavailable'
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
  | 'no-editor'
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
  /** 后端在执行工具前要求用户授权；宿主收集决定后调用 respondPermission */
  | {
      type: 'permission'
      requestId: string
      toolId?: string
      toolName: string
      inputSummary: string
    }
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

export interface AgentProviderInfo {
  id: string
  label: string
  description?: string
  capabilities: AgentCapabilities
}

export interface AgentDetection {
  available: boolean
  version?: string
  executable?: string
  /**
   * 后端配置文件里的默认模型名，只用于界面展示。
   *
   * 模型选择由后端自己的配置决定（例如 Claude Code 的 `~/.claude/settings.json`），
   * Core 不传也不保存模型；没配置时留空，由后端使用自己的默认值。
   */
  defaultModel?: string
  error?: AgentError
}

export interface AgentTurn {
  turnId: string
  prompt: string
}

/**
 * Core → provider 的通用会话参数。
 *
 * 超时、额外参数、密钥、CLI 路径都不在这里：它们是 provider 自己的配置，由
 * provider 在 `createSession()` 里读取。Core 每轮（含重试）都会重新调用
 * `createSession()`，因此设置改动下一轮即生效。
 */
export interface AgentSessionOptions {
  hostSessionId: string
  providerSessionId?: string
  cwd: string
  signal: AbortSignal
}

export interface AgentSession {
  readonly providerSessionId: string | undefined
  send(turn: AgentTurn): AsyncIterable<AgentEvent>
  /** 回应 `permission` 事件；回合已结束时应当静默忽略 */
  respondPermission(requestId: string, decision: AgentPermissionDecision): void
  cancel(reason?: 'user' | 'timeout' | 'turn-limit' | 'dispose'): void
  dispose(): Promise<void>
}

export interface AgentProvider {
  readonly info: AgentProviderInfo
  detect(options?: { signal?: AbortSignal }): Promise<AgentDetection>
  createSession(options: AgentSessionOptions): Promise<AgentSession>
}

/** provider 扩展从 `activate()` 返回的对象 */
export interface AgentProviderModule {
  readonly apiVersion: typeof AGENT_PROVIDER_API_VERSION
  readonly providers: readonly AgentProvider[]
}
