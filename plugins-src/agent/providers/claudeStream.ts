/**
 * Claude Code `--output-format stream-json` 的纯归一化层。
 *
 * 不碰进程、不碰文件：输入一行 JSON，输出统一的 AgentEvent。这样协议变化可以
 * 用测试夹具覆盖，而不是靠读源码猜。
 */

import type { AgentError, AgentEvent, AgentUsage, ToolKind } from '../core/types'

interface RawRecord {
  type?: unknown
  subtype?: unknown
  session_id?: unknown
  model?: unknown
  tools?: unknown
  event?: unknown
  message?: unknown
  result?: unknown
  is_error?: unknown
  usage?: unknown
  total_cost_usd?: unknown
  permission_denials?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read':
      return 'read'
    case 'Glob':
    case 'Grep':
      return 'search'
    case 'Write':
    case 'Edit':
      return 'edit'
    case 'Bash':
      return 'shell'
    case 'WebFetch':
    case 'WebSearch':
      return 'network'
    default:
      return 'other'
  }
}

function inputOf(block: Record<string, unknown>): Record<string, unknown> {
  return isRecord(block.input) ? block.input : {}
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) || str(input.path)
  if (name === 'Read') return clip(path || '读取文件', 200)
  if (name === 'Write') {
    const content = str(input.content)
    return clip(`${path}${content ? ` (${content.length} 字符)` : ''}`, 200)
  }
  if (name === 'Edit') return clip(path || '编辑文件', 200)
  if (name === 'Bash') return clip(str(input.command) || '执行命令', 200)
  if (name === 'Glob') return clip(str(input.pattern) || path || '查找文件', 200)
  if (name === 'Grep') return clip(`${str(input.pattern)}${path ? ` @ ${path}` : ''}` || '搜索', 200)
  if (name === 'WebFetch') return clip(str(input.url) || '抓取网页', 200)
  if (name === 'WebSearch') return clip(str(input.query) || '搜索网页', 200)
  if (name === 'Task') return clip(str(input.description) || '子任务', 200)
  try {
    return clip(JSON.stringify(input), 200)
  } catch {
    return name
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (typeof item === 'string') parts.push(item)
      else if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      }
    }
    return parts.join('\n')
  }
  if (isRecord(content) && typeof content.text === 'string') return content.text
  return ''
}

function usageOf(raw: unknown): AgentUsage | undefined {
  if (!isRecord(raw)) return undefined
  const usage: AgentUsage = {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens)
  }
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined
}

export class ClaudeEventMapper {
  providerSessionId?: string
  model?: string
  tools?: readonly string[]
  assistantCount = 0
  terminal = false
  private sawTextDelta = false
  private sawThinkingDelta = false
  private accumulatedText = ''
  private readonly toolNames = new Map<string, string>()

  handle(raw: unknown): AgentEvent[] {
    if (!isRecord(raw)) return []
    const record = raw as RawRecord
    const type = str(record.type)

    if (type === 'system') {
      const sessionId = str(record.session_id)
      const tools = Array.isArray(record.tools)
        ? record.tools.filter((item): item is string => typeof item === 'string')
        : undefined
      if (sessionId) this.providerSessionId = sessionId
      if (typeof record.model === 'string') this.model = record.model
      if (tools) this.tools = tools
      if (!sessionId) return []
      return [
        {
          type: 'session',
          providerSessionId: sessionId,
          model: this.model,
          tools
        }
      ]
    }

    if (type === 'stream_event') {
      return this.handleStreamEvent(record.event)
    }

    if (type === 'assistant') {
      return this.handleAssistant(record.message)
    }

    if (type === 'user') {
      return this.handleUser(record.message)
    }

    if (type === 'result') {
      return this.handleResult(record)
    }

    return []
  }

  private handleStreamEvent(event: unknown): AgentEvent[] {
    if (!isRecord(event)) return []
    if (event.type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : null
      if (!delta) return []
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        this.sawTextDelta = true
        this.accumulatedText += delta.text
        return [{ type: 'text', delta: delta.text }]
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        this.sawThinkingDelta = true
        return [{ type: 'thinking', delta: delta.thinking }]
      }
    }
    return []
  }

  private handleAssistant(message: unknown): AgentEvent[] {
    if (!isRecord(message)) return []
    this.assistantCount += 1
    const content = Array.isArray(message.content) ? message.content : []
    const events: AgentEvent[] = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        if (!this.sawTextDelta) {
          this.accumulatedText += block.text
          events.push({ type: 'text', delta: block.text })
        }
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        if (!this.sawThinkingDelta) events.push({ type: 'thinking', delta: block.thinking })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = str(block.id) || `tool-${this.assistantCount}`
        const name = block.name
        this.toolNames.set(id, name)
        events.push({
          type: 'tool',
          phase: 'start',
          toolId: id,
          name,
          kind: toolKind(name),
          inputSummary: toolSummary(name, inputOf(block))
        })
      }
    }
    this.sawTextDelta = false
    this.sawThinkingDelta = false
    return events
  }

  private handleUser(message: unknown): AgentEvent[] {
    if (!isRecord(message)) return []
    const content = Array.isArray(message.content) ? message.content : []
    const events: AgentEvent[] = []
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const id = str(block.tool_use_id)
      if (!id) continue
      const ok = block.is_error !== true
      const summary = clip(extractContentText(block.content), 500) || (ok ? '完成' : '失败')
      events.push({
        type: 'tool',
        phase: 'result',
        toolId: id,
        name: this.toolNames.get(id),
        ok,
        summary
      })
    }
    return events
  }

  private handleResult(record: RawRecord): AgentEvent[] {
    this.terminal = true
    const events: AgentEvent[] = []
    const denials = Array.isArray(record.permission_denials) ? record.permission_denials : []
    if (denials.length > 0) {
      const names = denials
        .map(item => (isRecord(item) ? str(item.tool_name) || str(item.tool) : ''))
        .filter(Boolean)
      events.push({
        type: 'notice',
        level: 'warn',
        message: `Claude Code 拒绝了 ${denials.length} 个工具调用${names.length ? `：${names.join(', ')}` : ''}。可在设置里切换到 read+parse，或检查工具白名单。`
      })
    }

    const isError = record.is_error === true
    const text = str(record.result) || this.accumulatedText
    const sessionId = str(record.session_id) || this.providerSessionId
    if (sessionId) this.providerSessionId = sessionId
    const usage = usageOf(record.usage)
    const costUsd = num(record.total_cost_usd)

    let error: AgentError | undefined
    if (isError) {
      const subtype = str(record.subtype)
      const denied = denials.length > 0
      error = {
        code: denied ? 'permission-denied' : 'provider-error',
        message: text || subtype || 'Claude Code 返回了错误',
        detail: subtype || undefined,
        retryable: /resume|session/i.test(text) || /resume|session/i.test(subtype)
      }
    }

    events.push({
      type: 'result',
      text,
      providerSessionId: sessionId,
      isError,
      error,
      usage,
      costUsd
    })
    return events
  }
}

export function classifyClaudeFailure(input: {
  stderr: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}): AgentError {
  if (input.aborted) {
    return { code: 'cancelled', message: '已停止' }
  }
  if (input.timedOut) {
    return { code: 'timeout', message: 'Agent 运行超时' }
  }
  const stderr = input.stderr.trim()
  if (/\bENOENT\b|not recognized as an internal|command not found/i.test(stderr)) {
    return { code: 'cli-missing', message: '找不到 Claude Code 可执行文件', detail: clip(stderr, 500) }
  }
  if (/invalid api key|authentication|401|please run \/login|oauth|credential/i.test(stderr)) {
    return {
      code: 'auth-required',
      message: 'Claude Code 未登录或认证失败；请先在终端运行 claude 登录，或在设置里填写 API 密钥。',
      detail: clip(stderr, 500)
    }
  }
  if (/permission|denied|not allowed/i.test(stderr)) {
    return {
      code: 'permission-denied',
      message: 'Claude Code 被权限规则拒绝；可切换到 read+parse，或检查工具白名单。',
      detail: clip(stderr, 500)
    }
  }
  return {
    code: 'provider-error',
    message: `Claude Code 退出（code ${input.exitCode ?? 'null'}）`,
    detail: stderr ? clip(stderr, 800) : undefined
  }
}
