/**
 * 读取扩展设置。
 *
 * 设置键在清单里是 `imark.agent.*`；扩展宿主拿到的 WorkspaceConfiguration
 * 已经按扩展归属过滤，所以这里用相对 key（如 `claudeCode.command`）。
 */

import * as imark from 'imark'
import type { AgentIsolation, AgentMode } from './types'
import type { SafeConfig } from './protocol'

export const SECTION = 'imark.agent'

export interface AgentConfig {
  provider: string
  mode: AgentMode
  model: string
  isolation: AgentIsolation
  timeoutSec: number
  maxTurns: number
  extraArgs: string[]
  apiKey?: string
  commandPath: string
  attachmentMaxMB: number
}

export interface ConfigReadResult {
  config: AgentConfig
  warnings: string[]
}

/** 会改变 CLI 协议、权限或会话归属的参数：不允许通过 extraArgs 注入 */
const DENIED_EXTRA_ARGS = [
  '-p',
  '--print',
  '--output-format',
  '--input-format',
  '--session-id',
  '--resume',
  '--continue',
  '-c',
  '--fork-session',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--permission-mode',
  '--permission-prompts',
  '--dangerously',
  '--add-dir',
  '--model',
  '--restricted',
  '--safe-mode',
  '--verbose',
  '--include-partial-messages',
  '--max-budget-usd',
  '--mcp-config',
  '--plugin-dir',
  '--plugin-url',
  '--agents',
  '--system-prompt',
  '--append-system-prompt',
  '--settings',
  '--setting-sources',
  '--bare',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--file',
  '--json-schema',
  '--replay-user-messages'
]

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function deniedArg(arg: string): boolean {
  if (/bypassPermissions/i.test(arg)) return true
  return DENIED_EXTRA_ARGS.some(prefix => {
    if (arg === prefix) return true
    // --model=sonnet / --permission-mode=... 也一样拒绝
    return prefix.startsWith('--') && arg.startsWith(`${prefix}=`)
  })
}

export function parseExtraArgs(raw: unknown): { args: string[]; warnings: string[] } {
  if (typeof raw !== 'string' || !raw.trim()) return { args: [], warnings: [] }
  const args: string[] = []
  const warnings: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const arg = line.trim()
    if (!arg) continue
    if (deniedArg(arg)) {
      warnings.push(`已忽略不允许的额外参数：${arg}`)
      continue
    }
    args.push(arg)
  }
  return { args, warnings }
}

export async function readConfig(context: imark.ExtensionContext): Promise<ConfigReadResult> {
  const config = imark.workspace.getConfiguration(SECTION)
  const provider = text(config.get<string>('provider', 'claude-code'), 'claude-code')
  const rawMode = text(config.get<string>('mode', 'read+parse'), 'read+parse')
  const mode: AgentMode = rawMode === 'read-only' ? 'read-only' : 'read+parse'
  const rawIsolation = text(config.get<string>('claudeCode.isolation', 'safe'), 'safe')
  const isolation: AgentIsolation =
    rawIsolation === 'restricted' || rawIsolation === 'off' ? rawIsolation : 'safe'
  const parsedExtra = parseExtraArgs(config.get<string>('claudeCode.extraArgs', ''))
  const apiKeyRaw = await context.secrets.get('claudeCode.apiKey')

  return {
    config: {
      provider,
      mode,
      model: text(config.get<string>('claudeCode.model', '')),
      isolation,
      timeoutSec: clampInt(config.get<number>('claudeCode.timeoutSec', 300), 10, 1800, 300),
      maxTurns: clampInt(config.get<number>('claudeCode.maxTurns', 24), 1, 100, 24),
      extraArgs: parsedExtra.args,
      apiKey: apiKeyRaw && apiKeyRaw.trim() ? apiKeyRaw : undefined,
      commandPath: text(config.get<string>('claudeCode.command', '')),
      attachmentMaxMB: clampInt(config.get<number>('attachmentMaxMB', 32), 1, 100, 32)
    },
    warnings: parsedExtra.warnings
  }
}

export function safeConfigView(config: AgentConfig): SafeConfig {
  return {
    provider: config.provider,
    mode: config.mode,
    model: config.model,
    isolation: config.isolation,
    timeoutSec: config.timeoutSec,
    maxTurns: config.maxTurns,
    attachmentMaxMB: config.attachmentMaxMB,
    commandConfigured: config.commandPath.length > 0,
    apiKeyConfigured: Boolean(config.apiKey)
  }
}
