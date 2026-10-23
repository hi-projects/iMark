/**
 * 读取 Claude Code provider 自己的「调用参数」。
 *
 * 模型、端点、令牌等 CLI 配置不在这里：它们唯一的事实是 Claude Code 自己的
 * ~/.claude/settings.json，由设置页的外部字段直接读写。这里只负责扩展怎么启动
 * CLI（可执行文件、超时、轮数、额外参数）。
 */

import * as imark from 'imark'

const SECTION = 'imark.claude-code'

export interface ClaudeConfig {
  command: string
  timeoutSec: number
  maxTurns: number
  extraArgs: string[]
}

export interface ClaudeConfigRead {
  config: ClaudeConfig
  warnings: string[]
}

/** 会改变 CLI 协议、配置或会话归属的参数：不允许通过 extraArgs 注入 */
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
  '--model',
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
  return DENIED_EXTRA_ARGS.some(prefix => {
    if (arg === prefix) return true
    // --model=sonnet / --session-id=... 也一样拒绝
    return prefix.startsWith('--') && arg.startsWith(`${prefix}=`)
  })
}

function parseExtraArgs(raw: unknown): { args: string[]; warnings: string[] } {
  const items = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : []
  const args: string[] = []
  const warnings: string[] = []
  for (const item of items) {
    const arg = item.trim()
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
  const parsedExtra = parseExtraArgs(config.get<unknown>('extraArgs', []))

  return {
    config: {
      // 自动检测时忽略手动路径，交给 spawn.ts 依次探测 CLI 与编辑器扩展自带的 binary
      command:
        config.get<string>('commandMode', 'auto') === 'manual'
          ? text(config.get<string>('command', ''))
          : '',
      timeoutSec: clampInt(config.get<number>('timeoutSec', 3600), 10, 7200, 3600),
      maxTurns: clampInt(config.get<number>('maxTurns', 300), 1, 1000, 300),
      extraArgs: parsedExtra.args
    },
    warnings: parsedExtra.warnings
  }
}
