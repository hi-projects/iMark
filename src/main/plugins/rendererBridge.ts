/**
 * 宿主 ↔ 渲染层的请求/回执通道。
 *
 * 编辑器扩展点(读/改/装饰)与界面注入都落在这条通道上:它们要做的事**只能**在
 * 渲染层发生(文档在 CodeMirror 手里、主界面在那儿),而发起方可能是主进程里的
 * 脚本插件、也可能是自己页面里的沙箱插件。
 *
 * 三条纪律:
 *
 * 1. **渲染层不在就明确失败**,不静默等待。没有主窗口(比如应用刚起来、或者用户
 *    已经关掉了)时,插件会收到一句"主界面还没就绪",而不是干等 5 秒超时。
 * 2. **每一个请求都要有归宿**:回执按序号对上号,超时也会把挂起的那条清掉 ——
 *    不然这条表会随着插件的每次调用慢慢长大。
 * 3. **回执永远来自渲染层**,主进程不猜结果。文档改没改、界面挂没挂上,
 *    以渲染层做完之后说的为准。
 */

import { ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { RendererOpName, RendererOpReply, RendererOpRequest } from '@shared/plugins'
import { getMainWindow } from '../window'

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<number, Pending>()
let nextId = 1
let installed = false

/** 渲染层的一次请求能在多久内回话(比 op 自己的超时略短,让错误更贴近原因) */
const REPLY_TIMEOUT = 12_000

export function installRendererBridge(): void {
  if (installed) return
  installed = true
  // 渲染层的"我准备好了"。页面重载时会再报一次 —— 于是重载之后界面能自己接上
  ipcMain.on(IPC.PluginUiReady, () => {
    markRendererReady()
  })
  ipcMain.on(IPC.PluginHostReply, (_e, reply: RendererOpReply) => {
    if (!reply || typeof reply.id !== 'number') return
    const call = pending.get(reply.id)
    if (!call) return
    pending.delete(reply.id)
    clearTimeout(call.timer)
    if (reply.ok) call.resolve(reply.value)
    else call.reject(new Error(reply.message))
  })
}

/** 主窗口的 webContents(没有就是"界面还没就绪") */
function mainWebContents(): WebContents | null {
  const win = getMainWindow()
  if (!win || win.webContents.isDestroyed()) return null
  return win.webContents
}

/**
 * 渲染层报到过没有。
 *
 * **必须有这条握手**,不能只看"窗口对象建好了" —— 中间隔着整个页面加载:
 * `createMainWindow()` 返回时页面还没跑起来,那时候 `send()` 出去的消息**会被静默丢掉**
 * (没有监听器),而插件那边只看到一句超时。实测踩过:插件在 onEnable 里挂界面,
 * 报的是 `render.prepare 超时`,而界面其实一个字节都没发出去。
 */
let rendererReady = false

/** 渲染层每次报到(含页面重载后的再报到)都会通知这些回调 */
type ReadyListener = () => void
const readyListeners = new Set<ReadyListener>()

/**
 * 渲染层就绪 / **重新就绪**时做什么。
 *
 * 页面重载后渲染层里的插件会话全部消失,所以 render 层需要重新注入 ——
 * 这条回调就是那个时机(见 main/plugins/renderLayer.ts)。
 */
export function onRendererReady(cb: ReadyListener): () => void {
  readyListeners.add(cb)
  return () => readyListeners.delete(cb)
}

export function isRendererReady(): boolean {
  return rendererReady
}

export function markRendererReady(): void {
  rendererReady = true
  for (const cb of [...readyListeners]) {
    try {
      cb()
    } catch (err) {
      console.error('[iMark] 渲染层就绪回调出错:', err)
    }
  }
}

/** 主窗口关了/重载了:下一次还要重新等它报到 */
export function markRendererGone(reason: string): void {
  rendererReady = false
  failPendingRendererOps(reason)
}

/**
 * 等渲染层报到。
 *
 * 还会等一小会儿"窗口出现"是因为启动顺序是「插件宿主就绪 → 再建主窗口」
 * (宿主握着 settings 与 safeStorage,必须在建窗之前起来):插件在 onEnable 里挂界面时,
 * 窗口可能**还没建出来**。只等一小会儿 —— 真的没有窗口(用户已经关掉了)时该如实报错。
 */
async function waitForRenderer(ms = 3000): Promise<WebContents | null> {
  const until = Date.now() + ms
  for (;;) {
    const wc = mainWebContents()
    if (wc && rendererReady) return wc
    if (Date.now() >= until) return null
    await new Promise(resolve => setTimeout(resolve, 60))
  }
}

/** 请渲染层替某个插件做一件事。失败一律抛成异常,由能力表那边归一成错误码 */
export async function askRenderer(
  op: RendererOpName,
  pluginId: string,
  args: unknown,
  timeoutMs = REPLY_TIMEOUT
): Promise<unknown> {
  const wc = await waitForRenderer()
  if (!wc) throw new Error('主界面还没就绪(窗口未创建、未加载完,或已关闭)')
  const id = nextId++
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${op} 超时:界面没有回执(可能正忙或已重载)`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    wc.send(IPC.PluginHostRequest, { id, pluginId, op, args } satisfies RendererOpRequest)
  })
}

/** 主窗口重载/关闭时,把还在等的那批全部结束掉 —— 它们永远等不到回执了 */
export function failPendingRendererOps(reason: string): void {
  for (const call of pending.values()) {
    clearTimeout(call.timer)
    call.reject(new Error(reason))
  }
  pending.clear()
}
