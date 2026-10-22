/**
 * 读取 Claude Code provider 自己的设置。
 *
 * 设置键在清单里是 `imark.claude-code.*`；扩展宿主拿到的 WorkspaceConfiguration
 * 已经按扩展归属过滤，所以这里用相对 key（如 `command`）。API 密钥不落配置，
 * 只从本扩展的 secret 槽位读取。
 */

import * as imark from 'imark'

export const SECTION = 'imark.claude-code'

export type ClaudeIsolation = 'safe' | 'restricted' | 'off'

export interface ClaudeConfig {
  command: string
  model: string
  isolation: ClaudeIsolation
  timeoutSec: number
  maxTurns: number
  extraArgs: string[]
  apiKey?: string
}

export interface ClaudeConfigRead {
  config: ClaudeConfig
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

export async function readConfig(context: imark.ExtensionContext): Promise<ClaudeConfigRead> {
  const config = imark.workspace.getConfiguration(SECTION)
  const rawIsolation = text(config.get<string>('isolation', 'safe'), 'safe')
  const isolation: ClaudeIsolation =
    rawIsolation === 'restricted' || rawIsolation === 'off' ? rawIsolation : 'safe'
  const parsedExtra = parseExtraArgs(config.get<string>('extraArgs', ''))
  const apiKeyRaw = await context.secrets.get('apiKey')

  return {
    config: {
      command: text(config.get<string>('command', '')),
      model: text(config.get<string>('model', '')),
      isolation,
      timeoutSec: clampInt(config.get<number>('timeoutSec', 300), 10, 1800, 300),
      maxTurns: clampInt(config.get<number>('maxTurns', 24), 1, 100, 24),
      extraArgs: parsedExtra.args,
      apiKey: apiKeyRaw && apiKeyRaw.trim() ? apiKeyRaw.trim() : undefined
    },
    warnings: parsedExtra.warnings
  }
}
