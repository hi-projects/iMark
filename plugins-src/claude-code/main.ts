/**
 * Claude Code provider 插件入口。
 *
 * 激活时只构造 provider 并返回给 Agent Core；真正的 CLI 探测与子进程启动
 * 都发生在 Core 调用 `detect()` / `createSession()` 时。插件不声明
 * activationEvents，由 Core 通过 `extensions.getExtension(id).activate()` 惰性激活。
 */

import type * as imark from 'imark'
import { AGENT_PROVIDER_API_VERSION, type AgentProviderModule } from '@shared/agentProvider'
import { createClaudeCodeProvider, type ClaudeCodeProviderHandle } from './provider'

let handle: ClaudeCodeProviderHandle | null = null

export function activate(context: imark.ExtensionContext): AgentProviderModule {
  handle = createClaudeCodeProvider(context)
  return {
    apiVersion: AGENT_PROVIDER_API_VERSION,
    providers: [handle.provider]
  }
}

export function deactivate(): void {
  handle?.dispose()
  handle = null
}
