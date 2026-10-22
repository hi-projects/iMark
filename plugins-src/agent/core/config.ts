/**
 * 读取 Agent Core 自己的设置。
 *
 * 设置键在清单里是 `imark.agent.*`；扩展宿主拿到的 WorkspaceConfiguration
 * 已经按扩展归属过滤，所以这里用相对 key（如 `mode`）。
 *
 * Claude Code 等后端的命令、模型、超时、密钥属于对应 provider 插件，Core
 * 不读取、不保存，也不在 UI 里展示。
 */

import * as imark from 'imark'
import type { AgentMode } from './types'
import type { SafeConfig } from './protocol'

export const SECTION = 'imark.agent'

export interface AgentConfig {
  mode: AgentMode
  attachmentMaxMB: number
}

export interface ConfigReadResult {
  config: AgentConfig
  warnings: string[]
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function readConfig(): ConfigReadResult {
  const config = imark.workspace.getConfiguration(SECTION)
  const rawMode = text(config.get<string>('mode', 'read+parse'), 'read+parse')
  const mode: AgentMode = rawMode === 'read-only' ? 'read-only' : 'read+parse'
  return {
    config: {
      mode,
      attachmentMaxMB: clampInt(config.get<number>('attachmentMaxMB', 32), 1, 100, 32)
    },
    warnings: []
  }
}

export function safeConfigView(config: AgentConfig): SafeConfig {
  return {
    mode: config.mode,
    attachmentMaxMB: config.attachmentMaxMB
  }
}
