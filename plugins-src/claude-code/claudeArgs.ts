/**
 * Claude Code 命令行参数矩阵（纯函数，方便单测）。
 *
 * 只读模式硬隔离；read+parse 允许 shell/Write，但仍把 cwd 限在会话目录、
 * 只用白名单命令，且永远不传 bypassPermissions。
 */

import type { AgentMode } from '@shared/agentProvider'
import type { ClaudeIsolation } from './config'

export interface ClaudeArgsInput {
  mode: AgentMode
  isolation: ClaudeIsolation
  cwd: string
  sessionId?: string
  resumeId?: string
  model?: string
  extraArgs?: readonly string[]
  availableCommands?: readonly string[]
}

const READ_TOOLS = ['Read', 'Glob', 'Grep']
/**
 * Windows 上 CLI 的 shell 工具是 PowerShell；只有检测到 Git Bash
 * （CLAUDE_CODE_GIT_BASH_PATH）时才提供 Bash。两个都声明，让 CLI 取可用的那个，
 * 否则 read+parse 在 Windows 上会没有任何可执行工具。
 */
const PARSE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Bash',
  ...(process.platform === 'win32' ? ['PowerShell'] : [])
]

/** 只对探测到的命令放行；不会为缺失的工具生成规则 */
const BASH_RULES: ReadonlyArray<[command: string, rule: string]> = [
  ['pdftotext', 'Bash(pdftotext:*)'],
  ['pdfinfo', 'Bash(pdfinfo:*)'],
  ['pdfimages', 'Bash(pdfimages:*)'],
  ['pdftoppm', 'Bash(pdftoppm:*)'],
  ['mutool', 'Bash(mutool:*)'],
  ['tesseract', 'Bash(tesseract:*)'],
  ['python', 'Bash(python:*)'],
  ['python3', 'Bash(python3:*)'],
  ['node', 'Bash(node:*)'],
  ['mineru', 'Bash(mineru:*)'],
  ['marker_single', 'Bash(marker_single:*)'],
  ['docling', 'Bash(docling:*)'],
  ['pandoc', 'Bash(pandoc:*)'],
  ['libreoffice', 'Bash(libreoffice:*)'],
  ['soffice', 'Bash(soffice:*)'],
  ['gs', 'Bash(gs:*)'],
  ['magick', 'Bash(magick:*)'],
  ['ls', 'Bash(ls:*)'],
  ['cat', 'Bash(cat:*)'],
  ['head', 'Bash(head:*)'],
  ['tail', 'Bash(tail:*)'],
  ['wc', 'Bash(wc:*)'],
  ['mkdir', 'Bash(mkdir:*)'],
  ['cp', 'Bash(cp:*)'],
  ['mv', 'Bash(mv:*)'],
  ['echo', 'Bash(echo:*)'],
  ['grep', 'Bash(grep:*)'],
  ['sed', 'Bash(sed:*)'],
  ['file', 'Bash(file:*)'],
  ['where', 'Bash(where:*)'],
  ['which', 'Bash(which:*)']
]

export function shellAllowRules(available: readonly string[] | undefined): string[] {
  if (!available || available.length === 0) return []
  const set = new Set(available)
  const rules: string[] = []
  for (const [command, rule] of BASH_RULES) {
    if (!set.has(command)) continue
    rules.push(rule)
    // Windows 上没有 Git Bash 时 CLI 用的是 PowerShell 工具；同一条命令两种前缀都放行。
    if (process.platform === 'win32') rules.push(`PowerShell(${command}:*)`)
  }
  return rules
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages'
  ]

  if (input.mode === 'read-only' || input.isolation === 'restricted') {
    args.push('--restricted')
  }
  if (input.isolation !== 'off') args.push('--safe-mode')

  args.push('--permission-mode', 'dontAsk')
  args.push('--permission-prompts', 'none')

  if (input.model && input.model.trim()) args.push('--model', input.model.trim())

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

  args.push('--add-dir', input.cwd)

  if (input.mode === 'read-only') {
    args.push('--tools', READ_TOOLS.join(','))
    args.push('--allowedTools', READ_TOOLS.join(','))
  } else {
    args.push('--tools', PARSE_TOOLS.join(','))
    const allowed = [...READ_TOOLS, 'Write', ...shellAllowRules(input.availableCommands)]
    args.push('--allowedTools', allowed.join(','))
  }

  return args
}
