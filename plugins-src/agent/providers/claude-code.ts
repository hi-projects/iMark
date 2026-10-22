/**
 * Claude Code provider。
 *
 * 每次 send 启动一个 `claude -p --output-format stream-json` 子进程；首轮传
 * `--session-id`，后续传 `--resume`。插件只负责把会话目录和 prompt 交给它，
 * 附件怎么读由 Agent 自己决定。
 */

import type {
  AgentDetection,
  AgentEvent,
  AgentProvider,
  AgentProviderInfo,
  AgentSession,
  AgentSessionOptions
} from '../core/types'
import { buildClaudeArgs } from './claudeArgs'
import { ClaudeEventMapper, classifyClaudeFailure } from './claudeStream'
import {
  claudeEnv,
  resolveClaudeCommand,
  runVersion,
  spawnClaude,
  type ResolvedCommand,
  type SpawnHandle
} from './spawn'

const MAX_STDERR = 16 * 1024
const MAX_LINE = 16 * 1024 * 1024

const INFO: AgentProviderInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  description: '使用本机安装并登录的 Claude Code CLI；附件路径由插件提供，Agent 自行读取/解析。',
  capabilities: {
    roles: ['agent'],
    inputs: { image: 'path', pdf: 'path', file: 'path' },
    tools: { read: true, bash: true, write: true },
    streaming: true,
    thinking: true,
    resume: true,
    systemPrompt: true
  },
  models: [
    { id: '', label: 'CLI 默认' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' }
  ]
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

  constructor(
    private readonly options: AgentSessionOptions,
    private readonly command: ResolvedCommand
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
      mode: this.options.mode,
      isolation: this.options.isolation,
      cwd: this.options.cwd,
      sessionId: this.currentProviderSessionId ? undefined : this.options.hostSessionId,
      resumeId: this.currentProviderSessionId,
      model: this.options.model,
      extraArgs: this.options.extraArgs,
      availableCommands: this.options.availableCommands
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
              ? { code: 'turn-limit', message: `超过单轮工具轮数上限（${this.options.maxTurns}）` }
              : { code: 'cancelled', message: reason === 'dispose' ? '插件已停用' : '已停止' }
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
        env: claudeEnv(this.options.apiKey),
        signal: this.options.signal,
        onStdoutLine: line => {
          if (terminal) return
          if (line.length > MAX_LINE) {
            void handle?.killTree()
            finish({ type: 'error', error: { code: 'protocol-error', message: 'Claude Code 单行输出过大' } })
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
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
          if (mapper.assistantCount > this.options.maxTurns) {
            void handle?.killTree()
            finish({
              type: 'error',
              error: {
                code: 'turn-limit',
                message: `超过单轮工具轮数上限（${this.options.maxTurns}）`
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
        }, this.options.timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      }

      if (handle.child.stdin) {
        handle.child.stdin.on('error', () => undefined)
        handle.child.stdin.end(turn.prompt, 'utf8')
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
          code: 'cli-missing',
          message: err instanceof Error ? err.message : String(err)
        }
      })
    }

    try {
      for await (const event of queue) {
        yield event
        if (terminal) break
      }
    } finally {
      this.options.signal.removeEventListener('abort', onAbort)
      this.activeTurn = null
      if (!terminal) {
        void handle?.killTree()
        queue.end()
      }
    }
  }

  cancel(reason: 'user' | 'timeout' | 'turn-limit' | 'dispose' = 'user'): void {
    this.activeTurn?.cancel(reason)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancel('dispose')
  }
}

let cachedDetection: { key: string; at: number; result: AgentDetection } | null = null

export const claudeCodeProvider: AgentProvider = {
  info: INFO,

  async detect(ctx): Promise<AgentDetection> {
    const key = ctx.commandPath ?? ''
    if (cachedDetection && cachedDetection.key === key && Date.now() - cachedDetection.at < 60_000) {
      return cachedDetection.result
    }
    let command: ResolvedCommand
    try {
      command = await resolveClaudeCommand(ctx.commandPath ?? '')
    } catch (err) {
      const result: AgentDetection = {
        available: false,
        error: {
          code: 'cli-missing',
          message: err instanceof Error ? err.message : String(err)
        }
      }
      cachedDetection = { key, at: Date.now(), result }
      return result
    }
    const version = await runVersion(command, ctx.timeoutMs ?? 5000)
    const result: AgentDetection = version.ok
      ? { available: true, version: version.version, executable: command.command }
      : {
          available: false,
          executable: command.command,
          error: {
            code: 'provider-error',
            message: version.detail || 'Claude Code 版本探测失败'
          }
        }
    cachedDetection = { key, at: Date.now(), result }
    return result
  },

  async createSession(options): Promise<AgentSession> {
    const command = await resolveClaudeCommand(options.commandPath ?? '')
    return new ClaudeSession(options, command)
  }
}
