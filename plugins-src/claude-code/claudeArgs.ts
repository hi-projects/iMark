/**
 * Claude Code 命令行参数（纯函数，方便单测）。
 *
 * 只负责非交互协议与会话续接；权限规则仍由 Claude Code 自己的设置决定，
 * 需要授权时 CLI 通过 stdio 询问宿主，宿主再把决定交回。
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
    '--input-format',
    'stream-json',
    // 让 CLI 把「需要授权」通过 can_use_tool 控制请求发到 stdio，而不是直接拒绝
    '--permission-prompt-tool=stdio',
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
