/**
 * 读取 Agent Core 自己的设置。
 *
 * 设置键在清单里是 `imark.agent.*`；扩展宿主拿到的 WorkspaceConfiguration
 * 已经按扩展归属过滤，所以这里用相对 key（如 `attachmentMaxMB`）。
 *
 * Claude Code 等后端的命令、模型、超时、密钥属于对应 provider 扩展，Core
 * 不读取、不保存，也不在 UI 里展示。
 */

import * as imark from 'imark'
import type { SafeConfig } from './protocol'
import { SYSTEM_PROMPT } from './prompt'

export const SECTION = 'imark.agent'

export interface AgentConfig {
  attachmentMaxMB: number
  /** 生效的系统提示词：设置里的自定义值，为空时回落到内置 SYSTEM_PROMPT */
  systemPrompt: string
}

export interface ConfigReadResult {
  config: AgentConfig
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export function readConfig(): ConfigReadResult {
  const config = imark.workspace.getConfiguration(SECTION)
  return {
    config: {
      attachmentMaxMB: clampInt(config.get<number>('attachmentMaxMB', 32), 1, 100, 32),
      // 清单里这一项的默认值由打包脚本从 SYSTEM_PROMPT 注入；这里再兜一次，
      // 保证设置被清空时也永远有可用的系统提示词。
      systemPrompt: String(config.get<string>('systemPrompt', '') ?? '').trim() || SYSTEM_PROMPT
    }
  }
}

export function safeConfigView(config: AgentConfig): SafeConfig {
  return {
    attachmentMaxMB: config.attachmentMaxMB
  }
}
