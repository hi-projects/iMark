/**
 * main 侧的宿主进程句柄。
 *
 * 一个 `ExtensionHostProcess` 对应一个 `utilityProcess`，里面装 1..N 个扩展
 * （组大小由 HostPlanner 决定）。它只做四件事：
 *   - fork、握手（process ready → init → initialized）、发消息、收消息；
 *   - 把宿主发来的 request 交给 ExtensionService，把它的 response 送回去；
 *   - 收集 stdout/stderr 当日志；
 *   - 退出时通知 service（重启策略在 service 里，不在这里）。
 *
 * 不在这里加载扩展代码：main 进程永远不 `require` 扩展入口。
 */

import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type {
  HostErrorDto,
  HostRequestMessage,
  HostResponseMessage,
  HostToMainMessage,
  MainInitMessage,
  MainToHostMessage,
  ExtensionHostInitPayload
} from '@shared/extensionProtocol'

export type HostProcessState = 'stopped' | 'starting' | 'running' | 'crashed' | 'crash-loop'

/** 带 requestId 的那部分宿主消息;其余(装饰、webview 通知)是单向的 */
export type HostRequest = Extract<HostRequestMessage, { requestId: string }>

export interface HostProcessHooks {
  onMessage(host: ExtensionHostProcess, message: HostToMainMessage): void
  onExit(host: ExtensionHostProcess, code: number, killedByMain: boolean): void
  onStdio(host: ExtensionHostProcess, level: 'info' | 'error', line: string): void
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

type ReadyPhase = 'process' | 'initialized'

export class ExtensionHostProcess {
  hostId: number
  readonly extensionIds: string[]
  state: HostProcessState = 'stopped'
  pid: number | null = null
  lastError: string | null = null

  private child: UtilityProcess | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly readyWaiters = new Map<
    ReadyPhase,
    { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  private requestSeq = 0
  private killedByMain = false
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private exitNotified = false

  constructor(
    hostId: number,
    extensionIds: string[],
    private readonly hooks: HostProcessHooks
  ) {
    this.hostId = hostId
    this.extensionIds = [...extensionIds]
  }

  /** 入口文件与 main 输出目录同级 */
  private entryPath(): string {
    return join(__dirname, 'extensionHostProcess.js')
  }

  async start(payload: ExtensionHostInitPayload): Promise<void> {
    if (this.child) throw new Error(`宿主 #${this.hostId} 已经启动`)
    this.state = 'starting'
    this.lastError = null
    this.killedByMain = false
    this.exitNotified = false

    const child = utilityProcess.fork(this.entryPath(), [String(this.hostId)], {
      serviceName: `iMark Extension Host ${this.hostId}`,
      stdio: 'pipe'
    })
    this.child = child
    // Electron 的 UtilityProcess.pid 在 'spawn' 之前是 undefined —— fork() 返回时
    // 进程还没真正创建。不接这个事件，宿主会永远显示 pid:null，设置页的宿主组成
    // 与内存占用都拿不到值。
    this.pid = child.pid ?? null
    child.on('spawn', () => {
      this.pid = child.pid ?? this.pid
    })

    child.on('message', (message: unknown) => this.handleMessage(message))
    // UtilityProcess 没有 'error' 事件：spawn 失败会直接走 'exit'，由 service 按崩溃处理
    child.on('exit', (code: number) => this.handleExit(code))
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => this.pipeStdio('info', String(chunk)))
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => this.pipeStdio('error', String(chunk)))
    }

    try {
      await this.waitReady('process', 15000)
      const init: MainInitMessage = { kind: 'init', payload }
      this.send(init)
      await this.waitReady('initialized', 30000)
      this.state = 'running'
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.send({ kind: 'shutdown' })
      this.kill()
      throw err
    }
  }

  private pipeStdio(level: 'info' | 'error', text: string): void {
    if (level === 'info') this.stdoutBuffer += text
    else this.stderrBuffer += text
    const buffer = level === 'info' ? this.stdoutBuffer : this.stderrBuffer
    const lines = buffer.split(/\r?\n/)
    const rest = lines.pop() ?? ''
    if (level === 'info') this.stdoutBuffer = rest
    else this.stderrBuffer = rest
    for (const line of lines) {
      if (line.trim()) this.hooks.onStdio(this, level, line)
    }
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const message = raw as HostToMainMessage
    if (message.kind === 'ready') {
      const waiter = this.readyWaiters.get(message.phase)
      if (waiter) {
        this.readyWaiters.delete(message.phase)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve()
      }
      return
    }
    if (message.kind === 'response') {
      this.settleResponse(message)
      return
    }
    this.hooks.onMessage(this, message)
  }

  private settleResponse(message: HostResponseMessage): void {
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error?.message ?? '宿主请求失败'))
  }

  private handleExit(code: number): void {
    const wasRunning = this.state !== 'stopped'
    this.child = null
    this.pid = null
    this.rejectAll(new Error(`宿主进程已退出（code ${code}）`))
    for (const [phase, waiter] of this.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`宿主进程在 ${phase} 阶段退出（code ${code}）`))
      this.readyWaiters.delete(phase)
    }
    if (!wasRunning || this.exitNotified) return
    this.exitNotified = true
    const killed = this.killedByMain
    this.killedByMain = false
    this.state = killed ? 'stopped' : 'crashed'
    this.hooks.onExit(this, code, killed)
  }

  private waitReady(phase: ReadyPhase, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(phase)
        reject(new Error(`等待宿主 ${phase} 就绪超时`))
      }, timeoutMs)
      timer.unref?.()
      this.readyWaiters.set(phase, { resolve, reject, timer })
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  send(message: MainToHostMessage): void {
    if (!this.child) return
    try {
      this.child.postMessage(message)
    } catch (err) {
      this.hooks.onStdio(
        this,
        'error',
        `向宿主发消息失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  respond(requestId: string, ok: boolean, value?: unknown, error?: HostErrorDto): void {
    this.send({ kind: 'response', requestId, ok, value, error })
  }

  /** main → 宿主的一次请求（目前只有命令执行），等待宿主响应 */
  requestCommand(command: string, args: unknown[], timeoutMs = 20000): Promise<unknown> {
    const requestId = `main-${this.hostId}-${++this.requestSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`扩展命令「${command}」执行超时`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { resolve, reject, timer })
      this.send({ kind: 'command.execute', requestId, command, args })
    })
  }

  /** 宿主发来的需要 main 处理的请求 */
  isRequest(message: HostToMainMessage): message is HostRequest {
    return typeof (message as { requestId?: unknown }).requestId === 'string'
  }

  kill(): void {
    const child = this.child
    if (!child) return
    this.killedByMain = true
    this.send({ kind: 'shutdown' })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    }, 800)
    timer.unref?.()
  }

  /** 进程意外退出后由 service 重新 fork：清掉旧句柄状态 */
  resetForRestart(): void {
    this.child = null
    this.pid = null
    this.exitNotified = false
    this.killedByMain = false
    this.state = 'stopped'
    this.lastError = null
  }

  dispose(): void {
    this.kill()
    this.rejectAll(new Error('宿主已关闭'))
  }
}
