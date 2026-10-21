/**
 * 扩展宿主进程入口。
 *
 * 一个进程装 1..N 个扩展（由 main 的 HostPlanner 分组）。这个文件本身不做任何
 * 扩展管理：它建立 `process.parentPort` 传输、通知 main “进程已就绪”、把运行时
 * 抛出的错误送到扩展日志，然后等 main 发 `init`。
 *
 * 注意：这里**没有**全局扩展表，也不代理跨宿主请求。共享宿主里的扩展共享
 * `globalThis` / `process` / 事件循环，这是 shared 模式的明确取舍；isolated 模式
 * 下进程里只有一个扩展。
 */

import { format } from 'node:util'
import {
  ExtensionHostRuntime,
  currentExtensionId,
  type RuntimeTransport
} from './hostRuntime'
import type { HostToMainMessage } from '@shared/extensionProtocol'

const parentPort = process.parentPort

if (!parentPort) {
  // 只能由 utilityProcess.fork 启动；直接 node 跑这个文件没有 parentPort
  process.stderr.write('[iMark] 扩展宿主必须以 utilityProcess 启动\n')
  process.exit(1)
}

const hostId = (() => {
  for (const arg of process.argv.slice(1)) {
    if (/^\d+$/.test(arg)) return Number(arg)
  }
  return 0
})()

const transport: RuntimeTransport = {
  send(message: HostToMainMessage): void {
    try {
      parentPort.postMessage(message)
    } catch {
      /* 父进程正在退出 */
    }
  },
  onMessage(handler): void {
    parentPort.on('message', event => handler(event.data))
  },
  onShutdown(): void {
    // 给 pending 的响应一点点时间落进 IPC 队列，然后退出
    const timer = setTimeout(() => process.exit(0), 10)
    timer.unref?.()
  }
}

const activeRuntime = new ExtensionHostRuntime(transport)

/**
 * 扩展里的 console.* 带扩展归属地送到 main 的扩展日志。
 *
 * 不再原样写 stdout：main 的 stdout 管道拿到的是无归属的一团文本，共享宿主里
 * 分不清是哪个扩展打的。`util.format` 保留对象展开/占位符语义。
 */
function installConsoleBridge(): void {
  const levels = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug'],
    ['trace', 'debug']
  ] as const
  for (const [method, level] of levels) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      const text = format(...args)
      const extensionId = currentExtensionId()
      if (extensionId) {
        activeRuntime.log(extensionId, level, text)
      } else {
        // 宿主自身（初始化前/退出时）的日志仍然走 stderr，避免静默丢失
        original(text)
      }
    }
  }
}

installConsoleBridge()

process.on('uncaughtException', err => {
  activeRuntime.log('', 'error', `宿主未捕获异常：${err?.stack ?? String(err)}`)
})

process.on('unhandledRejection', reason => {
  activeRuntime.log('', 'error', `宿主未处理的 Promise 拒绝：${String(reason)}`)
})

parentPort.postMessage({
  kind: 'ready',
  hostId,
  phase: 'process'
} satisfies HostToMainMessage)
