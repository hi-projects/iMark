/**
 * 沙箱插件的**通道**:页面 ↔ 主进程(阶段三 §3.3)。
 *
 * 两个方向各有一条道,职责完全不同:
 *
 *   - **插件 → 宿主**(`plugin:rpc`):一次能力调用。走 `gate.invokeOp`,永远 resolve。
 *   - **宿主 → 插件**(`plugin:bridge`):请插件做一件事。这条就是沙箱版的
 *     `PluginRuntime` —— `onEnable` / `onDisable` / `onConfigChange` / `runAction`
 *     一一对应,于是 host.ts 的 `safeCall`(超时、失败计数、熔断、回滚)
 *     在沙箱插件上一行都不用改。
 *
 * 还有一条单向的 `plugin:event`:hello / 配置 / 主题 / 仓库 / 文档保存 / tick。
 * 页面晚订阅也能立刻拿到最后一份 payload(preload 缓存),这是刻意的 ——
 * "我订阅的时候宿主已经发过了"在插件里是常态,不该变成偶发的空转。
 *
 * ## 身份
 *
 * **绝不接受页面传来的 pluginId。** 通道里根本没有这个字段:主进程用
 * `event.sender.id`(webContents id)在自己的注册表里反查"这是谁"。
 * 页面能伪造的只有自己的参数,伪造不了身份。`additionalArguments` 里那份 id
 * 只给页面自己打日志用 —— Linux 上 `/proc/<pid>/cmdline` 能读到进程参数,
 * 所以那里**不能**放任何密钥。
 */

import { ipcMain, type WebContents } from 'electron'
import type { PluginActionResult } from '@shared/plugins'
import type { PluginRuntime } from '@shared/pluginApi'
import type { PluginUiSpec } from '@shared/pluginPackage'
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
import { closePluginWindow, openPluginWindow, pluginWindowOf } from './windows'

/** 宿主给沙箱层提供的东西 */
export interface SandboxDeps {
  /** 造一次能力调用的现场(host.ts 才知道权限、配置、贡献点)。返回 null = 这个插件不该被受理 */
  opContext(pluginId: string): OpContext | null
  /** 页面第一次报「就绪」时叫一声(host 用它把 onEnable 接上) */
  onReady?(pluginId: string): void
  /** 页面没了(崩了 / 被导航走) */
  onGone?(pluginId: string, reason: string): void
}

let deps: SandboxDeps | null = null
let ipcInstalled = false

/** 一次宿主 → 插件的调用(等页面回话) */
interface PendingCall {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** 一个沙箱插件的运行时状态 */
export class SandboxRuntime {
  readonly pluginId: string
  readonly name: string
  readonly dir: string
  readonly main: string
  readonly ui: PluginUiSpec | null
  /** 已生效的权限 —— 只用于塑形 preload 里的 window.imark(判定在主进程闸门里) */
  readonly permissions: string[]
  /** 页面报告就绪后兑现 */
  readonly ready: Promise<void>
  private readyResolve: (() => void) | null = null
  private isReady = false
  private gone = false
  private nextCallId = 1
  private pending = new Map<number, PendingCall>()
  /** 下一次允许重建窗口的时刻(崩了之后带退避,别疯狂重试) */
  private rebuildAfter = 0
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private lastEvents = new Map<PluginHostEventType, unknown>()

  constructor(init: {
    pluginId: string
    name: string
    dir: string
    main: string
    ui: PluginUiSpec | null
    permissions: readonly string[]
  }) {
    this.pluginId = init.pluginId
    this.name = init.name
    this.dir = init.dir
    this.main = init.main
    this.ui = init.ui
    this.permissions = [...init.permissions]
    this.ready = new Promise<void>(resolve => {
      this.readyResolve = resolve
    })
  }

  /** 建窗并等页面就绪。超时不算失败 —— 页面慢的时候插件照样能被调用(只是可能还没注册处理函数) */
  async start(timeoutMs = 8000): Promise<void> {
    await this.ensureWindow()
    const timeout = new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
    await Promise.race([this.ready, timeout])
  }

  private async ensureWindow(): Promise<void> {
    const existing = pluginWindowOf(this.pluginId)
    if (existing) {
      // 窗口还在,但运行时换了一个(宿主重建、插件重载)。**必须重绑**:回执是按
      // webContents 反查运行时投递的,不重绑的话页面回的话会交给上一个已经作废的
      // 运行时,新运行时永远等不到回执(表现是每个调用都超时,而页面明明回了)
      bindWebContents(existing.webContents, this)
      return
    }
    if (Date.now() < this.rebuildAfter) return
    this.rebuildAfter = Date.now() + 5000
    await openPluginWindow({
      pluginId: this.pluginId,
      name: this.name,
      dir: this.dir,
      main: this.main,
      ui: this.ui,
      permissions: this.permissions,
      // **身份绑定在建窗这一刻完成**,不依赖页面自报:主进程知道这个 webContents
      // 是自己为哪个插件建的。页面能伪造的是参数,伪造不了这个。
      // 必须早于 loadURL —— 页面一跑起来就可能开口(见 windows.ts 的 onCreated)
      onCreated: win => bindWebContents(win.webContents, this),
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
    const win = pluginWindowOf(this.pluginId)
    if (!win || this.gone) {
      return Promise.reject(new Error('插件的页面不在(可能已崩溃)'))
    }
    const id = this.nextCallId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时(超过 ${Math.round(timeoutMs / 1000)} 秒)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      win.webContents.send(RPC_BRIDGE, { id, method, args } satisfies PluginBridgeCall)
    })
  }

  /** 页面回的执 */
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
    const win = pluginWindowOf(this.pluginId)
    if (!win) return
    win.webContents.send(RPC_EVENT, { type, payload } satisfies PluginHostEvent)
  }

  /** 让页面重新加载(开发模式热重载用) */
  reload(): void {
    const win = pluginWindowOf(this.pluginId)
    this.isReady = false
    win?.webContents.reload()
  }

  windowOpen(): void {
    if (this.ui === null) return
    const win = pluginWindowOf(this.pluginId)
    if (win) win.show()
    else void this.ensureWindow().then(() => pluginWindowOf(this.pluginId)?.show())
  }

  windowShow(): void {
    const win = pluginWindowOf(this.pluginId)
    if (win) win.show()
    else if (this.ui !== null) this.windowOpen()
  }

  windowHide(): void {
    if (this.ui !== null) pluginWindowOf(this.pluginId)?.hide()
  }

  windowClose(): void {
    void closePluginWindow(this.pluginId, 'plugin-request')
  }

  windowSetTitle(title: string): void {
    const win = pluginWindowOf(this.pluginId)
    if (win) win.setTitle(`${title} — iMark 插件`)
  }

  /**
   * 宿主调度器(§3.5)。**主进程的 Node 定时器不受渲染层节流影响**,
   * 这是隐藏页面唯一可靠的时间来源;作者自己写的 setInterval 在隐藏超过 5 分钟后
   * 会被降到 60 秒一次,而这件事在文档里写着"尽力而为"。
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
      void this.ensureWindow().then(() => {
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
  }
}

/** pluginId → 运行时 */
const runtimes = new Map<string, SandboxRuntime>()
/** webContents id → 运行时。**身份的唯一来源**(建窗时登记,见 ensureWindow) */
const byWebContents = new Map<number, SandboxRuntime>()

export function hasSandboxRuntime(pluginId: string): boolean {
  return runtimes.has(pluginId)
}

export function createSandboxRuntime(init: {
  pluginId: string
  name: string
  dir: string
  main: string
  ui: PluginUiSpec | null
  permissions: readonly string[]
}): SandboxRuntime {
  const runtime = new SandboxRuntime(init)
  runtimes.set(init.pluginId, runtime)
  return runtime
}

/** 停用:清掉定时器与挂起的调用。**不注销运行时** —— 再启用时还要用它 */
export function disposeSandboxRuntime(pluginId: string): void {
  runtimes.get(pluginId)?.dispose()
}

/** 卸载/移除:连注册一起清掉,此后这个插件不该再收到任何东西 */
export function unregisterSandboxRuntime(pluginId: string): void {
  const runtime = runtimes.get(pluginId)
  if (!runtime) return
  runtime.dispose()
  runtimes.delete(pluginId)
  for (const [wcId, rt] of byWebContents) {
    if (rt === runtime) byWebContents.delete(wcId)
  }
}

/**
 * 把 webContents 绑到运行时(见 ensureWindow 的说明)。
 *
 * 同一个插件只允许有一条绑定:换运行时的时候旧的必须让位,否则回执会投给
 * 一个已经作废的运行时(它的挂起表早就清空了,消息石沉大海)。
 */
function bindWebContents(wc: WebContents, runtime: SandboxRuntime): void {
  // 已经绑好了就直接返回。这一句不是优化:scheduler 每秒都会走一遍 ensureWindow,
  // 每次都挂一个 once('destroyed') 监听器的话,一小时就是三千多个 ——
  // 会先收到 Electron 的 MaxListenersExceededWarning,再变成一处真实的泄漏
  if (byWebContents.get(wc.id) === runtime) return
  for (const [wcId, rt] of byWebContents) {
    if (rt.pluginId === runtime.pluginId && wcId !== wc.id) byWebContents.delete(wcId)
  }
  byWebContents.set(wc.id, runtime)
  wc.once('destroyed', () => {
    if (byWebContents.get(wc.id) === runtime) byWebContents.delete(wc.id)
  })
}

function runtimeFor(sender: WebContents): SandboxRuntime | null {
  return byWebContents.get(sender.id) ?? null
}

/** 装 IPC 处理器(整个应用一次)。必须在建第一个插件窗口之前调用 */
export function installSandboxIpc(hostDeps: SandboxDeps): void {
  deps = hostDeps
  if (ipcInstalled) return
  ipcInstalled = true

  ipcMain.handle(RPC_INVOKE, async (event, raw: unknown): Promise<PluginRpcResult> => {
    const runtime = runtimeFor(event.sender)
    const request = raw as PluginRpcRequest
    if (!runtime) {
      // 页面不在注册表里:要么是旧页面(窗口已重建),要么根本不是插件页
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
    // 页面脚本跑起来的第一件事就是它(见 preload 的 plugin.handle)。
    if (request?.op === 'plugin.ready') {
      runtime.markReady()
      return { ok: true, value: null }
    }
    const ctx = sandboxDeps().opContext(runtime.pluginId)
    if (!ctx) {
      return { ok: false, error: { code: 'E_FAILED', message: '插件已停用' } }
    }
    return invokeOp(ctx, request?.op, request?.args, {
      source: 'sandbox',
      audit: line => ctx.log('warn', line.replace(/^\[warn\]\s*/, ''))
    })
  })

  ipcMain.on(RPC_ABORT, (event, payload: unknown) => {
    const runtime = runtimeFor(event.sender)
    if (!runtime) return
    void payload
    // 中止只影响**页面的等待**:宿主侧的 op 多半已经跑起来了,让它跑完
    // (真正的取消语义留到有 op 需要它时再做,那时才有具体的中断点可写)
  })

  ipcMain.on(RPC_BRIDGE, (event, raw: unknown) => {
    const runtime = runtimeFor(event.sender)
    if (!runtime) return
    const reply = raw as { id: number; reply: PluginBridgeReply }
    if (typeof reply?.id !== 'number') return
    runtime.settle(reply.id, reply.reply)
  })
}

function sandboxDeps(): SandboxDeps {
  if (!deps) throw new Error('沙箱层尚未初始化')
  return deps
}

/**
 * 给 host 的 `safeCall` 用的 `PluginRuntime` 适配器。
 *
 * 就是"沙箱版的 PluginRuntime":四个方法与 trusted 插件一一对应,
 * 于是超时、失败计数、熔断、升级回滚在两种插件上是同一段代码。
 * `onEnable` 的实现在页面那边(作者写),这边只负责把调用送过去、把拒绝变成异常。
 */
export function sandboxPluginRuntime(runtime: SandboxRuntime, timeoutMs: number): PluginRuntime {
  /**
   * 生命周期三件套都是**可选**的(trusted 那边也是 `runtime.onEnable?.()`)。
   * 页面没实现不该算失败 —— 否则一个只写 runAction 的插件会因为"没实现 onDisable"
   * 被记三次失败然后熔断,而它什么都没做错。
   * `runAction` 不在此列:宿主明确在调一个它声明过的动作,查无此人才是错。
   */
  const optional = (method: 'onEnable' | 'onDisable', args: unknown[]): Promise<void> =>
    runtime.call(method, args, timeoutMs).then(
      () => undefined,
      (err: Error) => {
        if (/没有实现/.test(err.message)) return undefined
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
      (await runtime.call('runAction', [actionId, targetId ?? null, payload ?? null], timeoutMs)) as PluginActionResult
  }
}

