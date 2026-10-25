/**
 * Claude Code provider。
 *
 * 每次 send 启动一个 `claude -p --output-format stream-json` 子进程；首轮传
 * `--session-id`，后续传 `--resume`。provider 自己读取命令路径、超时、轮数
 * 与额外参数；Agent Core 只传通用会话参数。
 */

import type {
  AgentDetection,
  AgentEvent,
  AgentPermissionDecision,
  AgentProvider,
  AgentProviderInfo,
  AgentSession,
  AgentSessionOptions
} from '@shared/agentProvider'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import * as imark from 'imark'
import { buildClaudeArgs } from './claudeArgs'
import { ClaudeEventMapper, classifyClaudeFailure, describeToolInput } from './claudeStream'
import { readConfig, type ClaudeConfig } from './config'
import {
  claudeEnv,
  resolveClaudeCommand,
  runVersion,
  spawnClaude,
  type ResolvedCommand,
  type SpawnHandle
} from './spawn'

const MAX_STDERR = 16 * 1024
const VERSION_TIMEOUT_MS = 5000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const INFO: AgentProviderInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  description: '使用本机安装并登录的 Claude Code CLI；附件路径由扩展提供，Agent 自行读取/解析。',
  capabilities: {
    inputs: { image: 'path', pdf: 'path', file: 'path' },
    tools: { read: true, bash: true, write: true },
    streaming: true,
    thinking: true,
    resume: true,
    systemPrompt: true
  }
}

/**
 * Claude Code 自己的默认模型（settings.json 里的 env.ANTHROPIC_MODEL）。
 *
 * 只用于在对话面板里展示；真正用哪个模型由 CLI 每次启动时读配置文件决定，
 * provider 不传 `--model`，Core 也不保存模型。
 */
async function readDefaultModel(): Promise<string | undefined> {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim()
  const file = dir ? join(dir, 'settings.json') : join(homedir(), '.claude', 'settings.json')
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return undefined
    const env = (raw as { env?: unknown }).env
    if (!env || typeof env !== 'object') return undefined
    const model = (env as Record<string, unknown>).ANTHROPIC_MODEL
    return typeof model === 'string' && model.trim() ? model.trim() : undefined
  } catch {
    return undefined
  }
}

function unavailable(message: string): Error & { code: 'provider-unavailable' } {
  return Object.assign(new Error(message), { code: 'provider-unavailable' as const })
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve))
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end()
        return Promise.resolve({ value: undefined as never, done: true })
      }
    }
  }
}

interface TurnControl {
  cancel(reason: 'user' | 'timeout' | 'turn-limit' | 'dispose'): void
}

class ClaudeSession implements AgentSession {
  private currentProviderSessionId: string | undefined
  private activeTurn: TurnControl | null = null
  private disposed = false
  /** stream-json 输入要保持打开，才能把权限决定写回去 */
  private activeStdin: Writable | null = null
  private readonly pendingPermissions = new Map<
    string,
    { input: Record<string, unknown>; complete: boolean }
  >()

  constructor(
    private readonly options: AgentSessionOptions,
    private readonly command: ResolvedCommand,
    private readonly config: ClaudeConfig,
    private readonly onDispose: () => void
  ) {
    this.currentProviderSessionId = options.providerSessionId
  }

  get providerSessionId(): string | undefined {
    return this.currentProviderSessionId
  }

  async *send(turn: { turnId: string; prompt: string }): AsyncIterable<AgentEvent> {
    if (this.disposed) {
      yield { type: 'error', error: { code: 'cancelled', message: '会话已关闭' } }
      return
    }
    if (this.options.signal.aborted) {
      yield { type: 'error', error: { code: 'cancelled', message: '已停止' } }
      return
    }

    const queue = new AsyncQueue<AgentEvent>()
    const mapper = new ClaudeEventMapper()
    const args = buildClaudeArgs({
      sessionId: this.currentProviderSessionId ? undefined : this.options.hostSessionId,
      resumeId: this.currentProviderSessionId,
      extraArgs: this.config.extraArgs
    })

    let terminal = false
    let timedOut = false
    let cancelled = false
    let turnLimit = false
    let spawnError: Error | undefined
    let stderr = ''
    let handle: SpawnHandle | null = null
    let timer: NodeJS.Timeout | null = null

    const finish = (event: AgentEvent): void => {
      if (terminal) return
      terminal = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // input-format=stream-json 下 CLI 会一直等 stdin；结束这一轮就关掉它
      try {
        handle?.child.stdin?.end()
      } catch {
        /* 进程可能已经退出 */
      }
      this.activeStdin = null
      this.pendingPermissions.clear()
      queue.push(event)
      queue.end()
    }

    const cancel = (reason: 'user' | 'timeout' | 'turn-limit' | 'dispose'): void => {
      if (terminal) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'turn-limit') turnLimit = true
      if (reason === 'user' || reason === 'dispose') cancelled = true
      void handle?.killTree()
      finish({
        type: 'error',
        error:
          reason === 'timeout'
            ? { code: 'timeout', message: 'Agent 运行超时' }
            : reason === 'turn-limit'
              ? { code: 'turn-limit', message: `超过单轮工具轮数上限（${this.config.maxTurns}）` }
              : { code: 'cancelled', message: reason === 'dispose' ? '扩展已停用' : '已停止' }
      })
    }

    this.activeTurn = { cancel }
    const onAbort = (): void => cancel('user')
    if (this.options.signal.aborted) {
      cancel('user')
    } else {
      this.options.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      handle = spawnClaude(this.command, args, {
        cwd: this.options.cwd,
        env: claudeEnv(),
        signal: this.options.signal,
        onStdoutLine: (line, info) => {
          if (terminal) return
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          const record = asRecord(parsed)
          if (record && textOf(record.type) === 'control_request') {
            const request = asRecord(record.request)
            const requestId = textOf(record.request_id)
            if (request && requestId && textOf(request.subtype) === 'can_use_tool') {
              const input = asRecord(request.input) ?? {}
              const toolName = textOf(request.tool_name) || 'Tool'
              // 输入被流式截断时不再回写 updatedInput：allow 的 updatedInput 是可选的，
              // CLI 会沿用模型给的原始输入，不能拿半份内容去覆盖它。
              this.pendingPermissions.set(requestId, { input, complete: !info.truncated })
              queue.push({
                type: 'permission',
                requestId,
                toolId: textOf(request.tool_use_id) || undefined,
                toolName,
                inputSummary: describeToolInput(toolName, input)
              })
            } else if (requestId) {
              // hooks / MCP 等控制请求这层不支持；回错误让 CLI 继续，而不是一直等
              this.writeControlResponse({
                subtype: 'error',
                request_id: requestId,
                error: 'iMark 暂不支持该控制请求'
              })
            }
            return
          }
          let events: AgentEvent[]
          try {
            events = mapper.handle(parsed)
          } catch (err) {
            finish({
              type: 'error',
              error: {
                code: 'protocol-error',
                message: '无法解析 Claude Code 输出',
                detail: err instanceof Error ? err.message : String(err)
              }
            })
            return
          }
          for (const event of events) {
            if (event.type === 'session') {
              this.currentProviderSessionId = event.providerSessionId
              queue.push(event)
              continue
            }
            if (event.type === 'result') {
              if (event.providerSessionId) this.currentProviderSessionId = event.providerSessionId
              finish(event)
              return
            }
            if (event.type === 'error') {
              finish(event)
              return
            }
            queue.push(event)
          }
          if (mapper.assistantCount > this.config.maxTurns) {
            void handle?.killTree()
            finish({
              type: 'error',
              error: {
                code: 'turn-limit',
                message: `超过单轮工具轮数上限（${this.config.maxTurns}）`
              }
            })
          }
        },
        onStderr: chunk => {
          stderr = `${stderr}${chunk}`
          if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR)
        }
      })

      if (terminal) {
        void handle.killTree()
      } else {
        timer = setTimeout(() => {
          cancel('timeout')
        }, this.config.timeoutSec * 1000)
        if (typeof timer.unref === 'function') timer.unref()
      }

      if (!terminal && handle.child.stdin) {
        this.activeStdin = handle.child.stdin
        handle.child.stdin.on('error', () => undefined)
        // --input-format stream-json：用户输入也是一行 JSON；stdin 保持打开，
        // 以便在 CLI 发来 can_use_tool 时把决定写回去。
        const message = {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: turn.prompt }]
          },
          parent_tool_use_id: null,
          session_id: this.currentProviderSessionId ?? ''
        }
        handle.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8')
      }

      void handle.done.then(result => {
        if (terminal) return
        if (result.error) spawnError = result.error
        if (cancelled || timedOut || turnLimit) return
        const error = classifyClaudeFailure({
          stderr: spawnError ? `${stderr}\n${spawnError.message}` : stderr,
          exitCode: result.code,
          timedOut,
          aborted: this.options.signal.aborted
        })
        finish({ type: 'error', error })
      })
    } catch (err) {
      finish({
        type: 'error',
        error: {
          code: 'provider-unavailable',
          message: err instanceof Error ? err.message : String(err)
        }
      })
    }

    try {
      // 不能在这里用 `if (terminal) break` 提前退出：终止事件可能排在已产生但尚未
      // yield 的事件后面（例如 result 紧跟 text delta、turn-limit 紧跟 tool 事件），
      // 提前 break 会把它丢掉，上层只能看到空的迭代，判成“Agent 没有返回结果”。
      // finish() 推入终止事件后立即 end()，所以排空队列自然会在这里结束。
      for await (const event of queue) {
        yield event
      }
    } finally {
      this.options.signal.removeEventListener('abort', onAbort)
      this.activeTurn = null
      this.activeStdin = null
      this.pendingPermissions.clear()
      if (!terminal) {
        void handle?.killTree()
        queue.end()
      }
    }
  }

  respondPermission(requestId: string, decision: AgentPermissionDecision): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    this.pendingPermissions.delete(requestId)
    this.writeControlResponse({
      subtype: 'success',
      request_id: requestId,
      response:
        decision === 'allow'
          ? pending.complete
            ? { behavior: 'allow', updatedInput: pending.input }
            : { behavior: 'allow' }
          : { behavior: 'deny', message: '用户拒绝了此操作' }
    })
  }

  private writeControlResponse(response: Record<string, unknown>): void {
    const stdin = this.activeStdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) return
    stdin.write(`${JSON.stringify({ type: 'control_response', response })}\n`)
  }

  cancel(reason: 'user' | 'timeout' | 'turn-limit' | 'dispose' = 'user'): void {
    this.activeTurn?.cancel(reason)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.activeTurn?.cancel('dispose')
    this.onDispose()
  }
}

class ClaudeCodeProvider implements AgentProvider {
  readonly info = INFO
  private readonly sessions = new Set<ClaudeSession>()
  private readonly warned = new Set<string>()
  private cachedDetection: { key: string; at: number; result: AgentDetection } | null = null

  constructor(private readonly warn: (message: string) => void = () => undefined) {}

  /** 被拒绝的额外参数只提示一次；每轮 createSession 都会重读配置 */
  private reportWarnings(warnings: readonly string[]): void {
    for (const warning of warnings) {
      if (this.warned.has(warning)) continue
      this.warned.add(warning)
      this.warn(warning)
    }
  }

  async detect(): Promise<AgentDetection> {
    const { config, warnings } = readConfig()
    this.reportWarnings(warnings)
    // 默认模型也参与缓存键：改了 settings.json 后，下一次探测立即返回新模型名
    const defaultModel = await readDefaultModel()
    const key = `${config.command}|${config.timeoutSec}|${defaultModel ?? ''}`
    if (
      this.cachedDetection &&
      this.cachedDetection.key === key &&
      Date.now() - this.cachedDetection.at < 60_000
    ) {
      return this.cachedDetection.result
    }
    const modelInfo = defaultModel ? { defaultModel } : {}
    let command: ResolvedCommand
    try {
      command = await resolveClaudeCommand(config.command)
    } catch (err) {
      const result: AgentDetection = {
        available: false,
        ...modelInfo,
        error: {
          code: 'provider-unavailable',
          message: err instanceof Error ? err.message : String(err)
        }
      }
      this.cachedDetection = { key, at: Date.now(), result }
      return result
    }
    const version = await runVersion(command, Math.min(config.timeoutSec * 1000, VERSION_TIMEOUT_MS))
    const result: AgentDetection = version.ok
      ? { available: true, version: version.version, executable: command.command, ...modelInfo }
      : {
          available: false,
          executable: command.command,
          ...modelInfo,
          error: {
            code: 'provider-error',
            message: version.detail || 'Claude Code 版本探测失败'
          }
        }
    this.cachedDetection = { key, at: Date.now(), result }
    return result
  }

  async createSession(options: AgentSessionOptions): Promise<AgentSession> {
    const { config, warnings } = readConfig()
    this.reportWarnings(warnings)
    let command: ResolvedCommand
    try {
      command = await resolveClaudeCommand(config.command)
    } catch (err) {
      throw unavailable(err instanceof Error ? err.message : String(err))
    }
    let session: ClaudeSession
    session = new ClaudeSession(options, command, config, () => this.sessions.delete(session))
    this.sessions.add(session)
    return session
  }

  disposeAll(): void {
    for (const session of [...this.sessions]) {
      session.cancel('dispose')
      void session.dispose()
    }
    this.sessions.clear()
  }
}

export interface ClaudeCodeProviderHandle {
  provider: AgentProvider
  dispose(): void
}

export function createClaudeCodeProvider(): ClaudeCodeProviderHandle {
  const output = imark.window.createOutputChannel('Claude Code')
  const instance = new ClaudeCodeProvider(message => output.warn(message))
  return {
    provider: instance,
    dispose: () => {
      instance.disposeAll()
      output.dispose()
    }
  }
}
