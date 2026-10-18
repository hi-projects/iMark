/**
 * restricted main 层的**通道**:隐藏执行页 ↔ 主进程。
 *
 * 两个方向各有一条道,职责完全不同:
 *
 *   - **插件 → 宿主**(`plugin:rpc`):一次能力调用。走 `gate.invokeOp`,永远 resolve。
 *   - **宿主 → 插件**(`plugin:bridge`):请插件做一件事。这条就是
 *     restricted 版的 `PluginRuntime` —— `onEnable` / `onDisable` / `onConfigChange` /
 *     `runAction` 一一对应,于是 host.ts 的 `safeCall`(超时、失败计数、熔断、回滚)
 *     一行都不用改。
 *
 * 还有一条单向的 `plugin:event`:hello / 配置 / 主题 / 仓库 / 文档保存 / tick。
 * 页面晚订阅也能立刻拿到最后一份 payload(preload 缓存),这是刻意的。
 *
 * ## 身份
 *
 * **绝不接受页面传来的 pluginId。** 通道里根本没有这个字段:主进程用
 * `event.sender.id`(webContents id)在自己的注册表里反查"这是谁"。
 * 页面能伪造的只有自己的参数,伪造不了身份。
 */

import { ipcMain, type WebContents } from 'electron'
import type { PluginActionResult } from '@shared/plugins'
import type { PluginRuntime } from '@shared/pluginApi'
import {
  RPC_ABORT,
  RPC_BRIDGE,
  RPC_EVENT,
  RPC_INVOKE,
  type PluginBridgeCall,
  type PluginBridgeReply,
  type PluginHostEvent,
  type PluginHostEventType,
  type PluginRpcRequest,
  type PluginRpcResult
} from '@shared/pluginRpc'
import { invokeOp } from './gate'
import type { OpContext } from './ops'
import { openRestrictedPage, pluginWebContentsOf } from './restrictedPage'

/** 宿主给 restricted 层提供的东西 */
export interface RestrictedDeps {
  /** 造一次能力调用的现场(host.ts 才知道权限、配置、贡献点)。返回 null = 这个插件不该被受理 */
  opContext(pluginId: string): OpContext | null
  /** 页面第一次报「就绪」时叫一声(host 用它把 onEnable 接上) */
  onReady?(pluginId: string): void
  /** 页面没了(崩了 / 被导航走) */
  onGone?(pluginId: string, reason: string): void
}

let deps: RestrictedDeps | null = null
let ipcInstalled = false

/** 一次宿主 → 插件的调用(等页面回话) */
interface PendingCall {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** 一个 restricted main 插件的运行时状态 */
export class RestrictedRuntime {
  readonly pluginId: string
  readonly name: string
  readonly dir: string
  readonly entry: string
  readonly permissions: string[]
  readonly hasRender: boolean
  /** 页面报告就绪后兑现(dispose 之后会换成一个新的,用于重新启用) */
  ready: Promise<void>
  private readyResolve: (() => void) | null = null
  private isReady = false
  private gone = false
  private nextCallId = 1
  private pending = new Map<number, PendingCall>()
  /** 下一次允许重建页面的时刻(崩了之后带退避,别疯狂重试) */
  private rebuildAfter = 0
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private lastEvents = new Map<PluginHostEventType, unknown>()

  constructor(init: {
    pluginId: string
    name: string
    dir: string
    entry: string
    permissions: readonly string[]
    hasRender: boolean
  }) {
    this.pluginId = init.pluginId
    this.name = init.name
    this.dir = init.dir
    this.entry = init.entry
    this.permissions = [...init.permissions]
    this.hasRender = init.hasRender
    this.ready = new Promise<void>(resolve => {
      this.readyResolve = resolve
    })
  }

  /** 建页并等页面就绪。超时不算失败 —— 页面慢的时候插件照样能被调用 */
  async start(timeoutMs = 8000): Promise<void> {
    await this.ensurePage()
    const timeout = new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
    await Promise.race([this.ready, timeout])
  }

  private async ensurePage(): Promise<void> {
    const existing = pluginWebContentsOf(this.pluginId)
    if (existing) {
      // 载体还在,但运行时换了一个(宿主重建、插件重载)。**必须重绑**:
      // 回执是按 webContents 反查运行时投递的,不重绑的话页面回的话会交给上一个
      // 已经作废的运行时,新运行时永远等不到回执(表现是每个调用都超时,而页面明明回了)
      bindWebContents(existing, this)
      return
    }
    if (Date.now() < this.rebuildAfter) return
    this.rebuildAfter = Date.now() + 5000
    await openRestrictedPage({
      pluginId: this.pluginId,
      name: this.name,
      dir: this.dir,
      entry: this.entry,
      permissions: this.permissions,
      hasRender: this.hasRender,
      // **身份绑定在建页这一刻完成**,不依赖页面自报:主进程知道这个 webContents
      // 是自己为哪个插件建的。页面能伪造的是参数,伪造不了这个。
      // 必须早于 loadURL —— 页面一跑起来就可能开口
      onCreated: wc => bindWebContents(wc, this),
      onReady: () => this.markReady(),
      onGone: reason => {
        this.gone = true
        // 挂起的调用立刻失败:让 safeCall 去记账,而不是干等自己的超时
        this.failAll(new Error(`插件的页面已结束:${reason}`))
        deps?.onGone?.(this.pluginId, reason)
      }
    })
  }

  markReady(): void {
    if (this.isReady) return
    // 页面是**重新**加载起来的(崩溃重建):上一次的挂起调用永远不会有人应答了
    this.failAll(new Error('插件的页面重新加载了,这一次调用没有回执'))
    this.isReady = true
    this.gone = false
    this.readyResolve?.()
    // 补一次最后状态的 hello:重建出来的页面自己是不知道当前主题/配置的
    for (const [type, payload] of this.lastEvents) this.send(type, payload)
    deps?.onReady?.(this.pluginId)
  }

  private failAll(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(err)
    }
    this.pending.clear()
  }

  /** 宿主 → 插件。页面没注册对应方法时由 preload 回 E_UNKNOWN_OP */
  call(method: PluginBridgeCall['method'], args: unknown[], timeoutMs: number): Promise<unknown> {
    const wc = pluginWebContentsOf(this.pluginId)
    if (!wc || this.gone) {
      return Promise.reject(new Error('插件的页面不在(可能已崩溃)'))
    }
    const id = this.nextCallId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时(超过 ${Math.round(timeoutMs / 1000)} 秒)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      wc.send(RPC_BRIDGE, { id, method, args } satisfies PluginBridgeCall)
    })
  }

  /** 页面回的回执 */
  settle(id: number, reply: PluginBridgeReply): void {
    const call = this.pending.get(id)
    if (!call) return
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (reply?.ok) call.resolve(reply.value)
    else call.reject(new Error(reply?.error?.message ?? '插件没有给出结果'))
  }

  /** 主进程 → 页面的一次性通知(缓存最后一份,晚订阅也能拿到) */
  send(type: PluginHostEventType, payload: unknown): void {
    this.lastEvents.set(type, payload)
    const wc = pluginWebContentsOf(this.pluginId)
    if (!wc) return
    wc.send(RPC_EVENT, { type, payload } satisfies PluginHostEvent)
  }

  /** 让页面重新加载(开发模式热重载用) */
  reload(): void {
    this.isReady = false
    pluginWebContentsOf(this.pluginId)?.reload()
  }

  /**
   * 宿主调度器。**主进程的 Node 定时器不受渲染层节流影响**,
   * 这是隐藏页面唯一可靠的时间来源;作者自己写的 setInterval 在隐藏超过 5 分钟后
   * 会被降到 60 秒一次。
   */
  scheduleEvery(ms: number, name: string): void {
    const period = Math.max(1000, Math.round(Number(ms) || 0))
    if (this.timers.size >= 32 && !this.timers.has(name)) {
      throw new Error('一个插件最多注册 32 个定时器')
    }
    const existing = this.timers.get(name)
    if (existing) clearInterval(existing)
    let expected = Date.now() + period
    const timer = setInterval(() => {
      const lateMs = Math.max(0, Date.now() - expected)
      expected = Date.now() + period
      void this.ensurePage().then(() => {
        this.send('tick', { name, lateMs })
      })
    }, period)
    this.timers.set(name, timer)
  }

  scheduleClear(name: string): void {
    const timer = this.timers.get(name)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(name)
    }
  }

  /** 停掉定时器与挂起的调用(停用/卸载/退出) */
  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    this.failAll(new Error('插件已停用'))
    // 停用后同一个运行时还要能再次 start():页面会被宿主关掉,而 isReady / gone /
    // rebuildAfter 若不复位,5 秒内重新启用会以为"页面还在",新的 onEnable 直接打到
    // 空气上(实测症状:重新启用报「插件的页面不在」)。
    this.isReady = false
    this.gone = false
    this.rebuildAfter = 0
    this.ready = new Promise<void>(resolve => {
      this.readyResolve = resolve
    })
  }
}

/** pluginId → 运行时 */
const runtimes = new Map<string, RestrictedRuntime>()
/** webContents id → 运行时。**身份的唯一来源** */
const byWebContents = new Map<number, RestrictedRuntime>()

export function hasRestrictedRuntime(pluginId: string): boolean {
  return runtimes.has(pluginId)
}

export function createRestrictedRuntime(init: {
  pluginId: string
  name: string
  dir: string
  entry: string
  permissions: readonly string[]
  hasRender: boolean
}): RestrictedRuntime {
  const runtime = new RestrictedRuntime(init)
  runtimes.set(init.pluginId, runtime)
  return runtime
}

/** 停用:清掉定时器与挂起的调用。**不注销运行时** —— 再启用时还要用它 */
export function disposeRestrictedRuntime(pluginId: string): void {
  runtimes.get(pluginId)?.dispose()
}

/** 卸载/移除:连注册一起清掉,此后这个插件不该再收到任何东西 */
export function unregisterRestrictedRuntime(pluginId: string): void {
  const runtime = runtimes.get(pluginId)
  if (!runtime) return
  runtime.dispose()
  runtimes.delete(pluginId)
  for (const [wcId, rt] of byWebContents) {
    if (rt === runtime) byWebContents.delete(wcId)
  }
}

/**
 * 把 webContents 绑到运行时(见 ensurePage 的说明)。
 *
 * 同一个插件只允许有一条绑定:换运行时的时候旧的必须让位,否则回执会投给
 * 一个已经作废的运行时(它的挂起表早就清空了,消息石沉大海)。
 */
function bindWebContents(wc: WebContents, runtime: RestrictedRuntime): void {
  if (byWebContents.get(wc.id) === runtime) return
  for (const [wcId, rt] of byWebContents) {
    if (rt.pluginId === runtime.pluginId && wcId !== wc.id) byWebContents.delete(wcId)
  }
  byWebContents.set(wc.id, runtime)
  wc.once('destroyed', () => {
    if (byWebContents.get(wc.id) === runtime) byWebContents.delete(wc.id)
  })
}

function runtimeFor(sender: WebContents): RestrictedRuntime | null {
  return byWebContents.get(sender.id) ?? null
}

/** 装 IPC 处理器(整个应用一次)。必须在建第一个插件页面之前调用 */
export function installRestrictedIpc(hostDeps: RestrictedDeps): void {
  deps = hostDeps
  if (ipcInstalled) return
  ipcInstalled = true

  ipcMain.handle(RPC_INVOKE, async (event, raw: unknown): Promise<PluginRpcResult> => {
    const runtime = runtimeFor(event.sender)
    const request = raw as PluginRpcRequest
    if (!runtime) {
      return {
        ok: false,
        error: { code: 'E_INTERNAL', message: '这个页面没有绑定到任何插件,调用被忽略' }
      }
    }
    // 只接受**主框架**发来的请求(iframe 里不该能调宿主能力)
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
      return {
        ok: false,
        error: { code: 'E_PERMISSION', message: '只有插件的主页面可以调用宿主能力' }
      }
    }
    // 握手不是能力,不进能力表:它没有权限可言,也不该出现在作者文档的能力清单里。
    if (request?.op === 'plugin.ready') {
      runtime.markReady()
      return { ok: true, value: null }
    }
    const ctx = restrictedDeps().opContext(runtime.pluginId)
    if (!ctx) {
      return { ok: false, error: { code: 'E_FAILED', message: '插件已停用' } }
    }
    return invokeOp(ctx, request?.op, request?.args, {
      source: 'restricted',
      audit: line => ctx.log('warn', line.replace(/^\[warn\]\s*/, ''))
    })
  })

  ipcMain.on(RPC_ABORT, (event, payload: unknown) => {
    const runtime = runtimeFor(event.sender)
    if (!runtime) return
    void payload
    // 中止只影响**页面的等待**:宿主侧的 op 多半已经跑起来了,让它跑完
  })

  ipcMain.on(RPC_BRIDGE, (event, raw: unknown) => {
    const runtime = runtimeFor(event.sender)
    if (!runtime) return
    const reply = raw as { id: number; reply: PluginBridgeReply }
    if (typeof reply?.id !== 'number') return
    runtime.settle(reply.id, reply.reply)
  })
}

function restrictedDeps(): RestrictedDeps {
  if (!deps) throw new Error('restricted 层尚未初始化')
  return deps
}

/**
 * 给 host 的 `safeCall` 用的 `PluginRuntime` 适配器。
 *
 * 就是"restricted 版的 PluginRuntime":四个方法与 node main 一一对应,
 * 于是超时、失败计数、熔断、升级回滚在两种 main 层上是同一段代码。
 */
export function restrictedPluginRuntime(
  runtime: RestrictedRuntime,
  timeoutMs: number,
  actionTimeoutMs = timeoutMs
): PluginRuntime {
  /**
   * 生命周期三件套都是**可选**的(与 node main 一致)。
   * 页面没实现不该算失败 —— 否则一个只写 runAction 的插件会因为"没实现 onDisable"
   * 被记三次失败然后熔断,而它什么都没做错。
   * `runAction` 不在此列:宿主明确在调一个它声明过的动作,查无此人才是错。
   */
  const optional = (method: 'onEnable' | 'onDisable', args: unknown[]): Promise<void> =>
    runtime.call(method, args, timeoutMs).then(
      () => undefined,
      (err: Error) => {
        if (/没有实现/.test(err.message)) return undefined
        // 页面已经崩了/已被关闭(常见于退出流程):onDisable 只是收尾,
        // 没有对象可收,不该记为失败或触发熔断。
        if (
          method === 'onDisable' &&
          /页面不在|已崩溃|已停用|页面已结束/.test(err.message)
        ) {
          return undefined
        }
        throw err
      }
    )

  return {
    onEnable: () => optional('onEnable', []),
    onDisable: () => optional('onDisable', []),
    onConfigChange: config =>
      runtime.call('onConfigChange', [config], timeoutMs).then(
        () => undefined,
        (err: Error) => {
          if (/没有实现/.test(err.message)) return undefined
          throw err
        }
      ),
    runAction: async (actionId, _ctx, targetId, payload) =>
      (await runtime.call(
        'runAction',
        [actionId, targetId ?? null, payload ?? null],
        actionTimeoutMs
      )) as PluginActionResult
  }
}
