/**
 * Provider 注册表。
 *
 * 加一个新 Agent = 新写一个 `AgentProvider` 并加到这里；核心、UI、会话、附件
 * 都不需要改。首版只有一个 Claude Code。
 */

import type { AgentProvider } from '../core/types'
import { claudeCodeProvider } from './claude-code'

export const PROVIDERS: readonly AgentProvider[] = [claudeCodeProvider]

export function providerById(id: string): AgentProvider | undefined {
  return PROVIDERS.find(provider => provider.info.id === id)
}

export function providerInfos(): AgentProvider['info'][] {
  return PROVIDERS.map(provider => provider.info)
}
