/**
 * Claude Code provider。
 *
 * 每次 send 启动一个 `claude -p --output-format stream-json` 子进程；首轮传
 * `--session-id`，后续传 `--resume`。provider 自己读取命令路径、模型、超时、
 * 隔离、额外参数与 API 密钥；Agent Core 只传通用会话参数。
 */

import type {
  AgentDetection,
  AgentEvent,
  AgentProvider,
  AgentProviderInfo,
  AgentSession,
  AgentSessionOptions
} from '@shared/agentProvider'
import * as imark from 'imark'
import { buildClaudeArgs } from './claudeArgs'
import { ClaudeEventMapper, classifyClaudeFailure } from './claudeStream'
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
const MAX_LINE = 16 * 1024 * 1024
const VERSION_TIMEOUT_MS = 5000

const INFO: AgentProviderInfo = {
  id: 'claude-code',
  label: 'Claude Code',
  description: '使用本机安装并登录的 Claude Code CLI；附件路径由扩展提供，Agent 自行读取/解析。',
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
      mode: this.options.mode,
      isolation: this.config.isolation,
      cwd: this.options.cwd,
      sessionId: this.currentProviderSessionId ? undefined : this.options.hostSessionId,
      resumeId: this.currentProviderSessionId,
      model: this.options.model,
      extraArgs: this.config.extraArgs,
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
    const key = `${config.command}|${config.timeoutSec}`
    if (
      this.cachedDetection &&
      this.cachedDetection.key === key &&
      Date.now() - this.cachedDetection.at < 60_000
    ) {
      return this.cachedDetection.result
    }
    let command: ResolvedCommand
    try {
      command = await resolveClaudeCommand(config.command)
    } catch (err) {
      const result: AgentDetection = {
        available: false,
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
      ? { available: true, version: version.version, executable: command.command }
      : {
          available: false,
          executable: command.command,
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
