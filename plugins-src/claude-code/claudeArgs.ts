/**
 * Claude Code 命令行参数（纯函数，方便单测）。
 *
 * 只负责非交互协议与会话续接；权限由 Claude Code 自己的设置决定。
 */

export interface ClaudeArgsInput {
  sessionId?: string
  resumeId?: string
  extraArgs?: readonly string[]
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages'
  ]

  if (input.resumeId) {
    args.push('--resume', input.resumeId)
  } else if (input.sessionId) {
    args.push('--session-id', input.sessionId)
  }

  if (input.extraArgs) {
    for (const arg of input.extraArgs) {
      if (arg) args.push(arg)
    }
  }

  return args
}
