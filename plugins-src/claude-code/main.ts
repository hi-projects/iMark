/**
 * Claude Code provider 扩展入口。
 *
 * 激活时构造 provider 并返回给 Agent Core；CLI 探测与子进程启动都由 provider
 * 自己完成。设置页的「检查 Claude Code」也直接调用 provider 的 `detect()`，
 * 结果写在扩展自己的状态卡里，不经过 Core。
 */

import * as imark from 'imark'
import {
  AGENT_PROVIDER_API_VERSION,
  type AgentProvider,
  type AgentProviderModule
} from '@shared/agentProvider'
import { createClaudeCodeProvider, type ClaudeCodeProviderHandle } from './provider'

const CMD_CHECK = 'imark.claude-code.check'

let handle: ClaudeCodeProviderHandle | null = null

export function activate(context: imark.ExtensionContext): AgentProviderModule {
  handle = createClaudeCodeProvider()
  const provider = handle.provider
  context.subscriptions.push(
    imark.commands.registerCommand(CMD_CHECK, () => checkBackend(provider))
  )
  return {
    apiVersion: AGENT_PROVIDER_API_VERSION,
    providers: [provider]
  }
}

/** 只探测自己的后端；成功与失败都写进本扩展自己的状态卡 */
async function checkBackend(provider: AgentProvider): Promise<void> {
  try {
    const result = await provider.detect()
    if (result.available) {
      imark.imark.reportStatus({
        status: 'ok',
        message: `可用：${provider.info.label}${result.version ? `（${result.version}）` : ''}`,
        ...(result.executable ? { detail: `可执行文件：${result.executable}` } : {}),
        lastRunAt: Date.now()
      })
      return
    }
    imark.imark.reportStatus({
      status: 'error',
      message: `${provider.info.label} 不可用：${result.error?.message ?? '探测失败'}`,
      ...(result.error?.detail ? { detail: result.error.detail } : {}),
      lastRunAt: Date.now()
    })
  } catch (err) {
    imark.imark.reportStatus({
      status: 'error',
      message: `${provider.info.label} 检查失败：${err instanceof Error ? err.message : String(err)}`,
      lastRunAt: Date.now()
    })
  }
}

export function deactivate(): void {
  handle?.dispose()
  handle = null
}
