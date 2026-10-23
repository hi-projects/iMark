/**
 * 读取 Claude Code provider 自己的「调用参数」。
 *
 * 模型、端点、令牌等 CLI 配置不在这里：它们唯一的事实是 Claude Code 自己的
 * ~/.claude/settings.json，由设置页的外部字段直接读写。这里只负责扩展怎么启动
 * CLI（可执行文件、隔离、超时、轮数、额外参数）。
 */

import * as imark from 'imark'

export const SECTION = 'imark.claude-code'

export type ClaudeIsolation = 'safe' | 'restricted' | 'off'

export interface ClaudeConfig {
  command: string
  isolation: ClaudeIsolation
  timeoutSec: number
  maxTurns: number
  extraArgs: string[]
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

export function readConfig(): ClaudeConfigRead {
  const config = imark.workspace.getConfiguration(SECTION)
  const rawIsolation = text(config.get<string>('isolation', 'safe'), 'safe')
  const isolation: ClaudeIsolation =
    rawIsolation === 'restricted' || rawIsolation === 'off' ? rawIsolation : 'safe'
  const parsedExtra = parseExtraArgs(config.get<string>('extraArgs', ''))

  return {
    config: {
      command: text(config.get<string>('command', '')),
      isolation,
      timeoutSec: clampInt(config.get<number>('timeoutSec', 300), 10, 1800, 300),
      maxTurns: clampInt(config.get<number>('maxTurns', 24), 1, 100, 24),
      extraArgs: parsedExtra.args
    },
    warnings: parsedExtra.warnings
  }
}
