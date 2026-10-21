/**
 * 扩展的模态请求：消息框、输入框、快速选择。
 *
 * 这些请求由主进程代扩展发出，**必须回一个值**：宿主进程里的 Promise 在等它，
 * 不回就是三百秒超时。界面这边排成队列逐个显示 —— 同时弹三个模态框，用户只看得到
 * 最上面那个，另外两个在背后吞点击。
 *
 * 没有按钮、非模态的 `showInformationMessage` 不进队列：它不需要用户做决定，
 * 走右下角气泡即可，然后立刻回 null（扩展拿到的语义与 VS Code 一致）。
 */

import { reactive } from 'vue'
import type { MainToRendererMessage } from '@shared/extensionProtocol'
import { api } from './api'
import { extensionById } from './extensionService'
import { pushNotice } from './notice'

export interface ExtensionUiMessageRequest {
  id: string
  kind: 'message'
  title: string
  level: 'info' | 'warning' | 'error'
  message: string
  detail?: string
  items: string[]
}

export interface ExtensionUiInputRequest {
  id: string
  kind: 'input'
  title: string
  prompt?: string
  placeHolder?: string
  value: string
  password: boolean
}

export interface ExtensionUiPickItem {
  label: string
  description?: string
  detail?: string
  picked?: boolean
}

export interface ExtensionUiPickRequest {
  id: string
  kind: 'pick'
  title: string
  placeHolder?: string
  canPickMany: boolean
  items: ExtensionUiPickItem[]
}

export type ExtensionUiRequest =
  | ExtensionUiMessageRequest
  | ExtensionUiInputRequest
  | ExtensionUiPickRequest

export const extensionUiStore = reactive<{ queue: ExtensionUiRequest[] }>({ queue: [] })

/** 请求本身不带显示名（主进程只传 ID）；查不到就退回一个中性称呼 */
function titleFor(extensionId: string | undefined): string {
  return (extensionId && extensionById(extensionId)?.descriptor.displayName) || '扩展'
}

function respond(requestId: string, value: string | string[] | null): void {
  try {
    api.sendExtensionMessage({ type: 'ui.response', requestId, value })
  } catch (err) {
    // 窗口正在关闭：主进程收不到应答，随它超时即可
    console.error('[iMark] 扩展界面请求应答失败', err)
  }
}

/**
 * 关闭队列最前面的请求，把结果回给主进程。
 *
 * `value` 为 null 表示用户取消 / 直接关掉。快速选择单选的返回值是标签字符串，
 * 多选是标签数组；主进程会按标签映射回扩展传进来的原始对象。
 */
export function resolveExtensionUi(value: string | string[] | null): void {
  const request = extensionUiStore.queue.shift()
  if (!request) return
  respond(request.id, value)
}

function noticeLevel(level: 'info' | 'warning' | 'error'): 'info' | 'warn' | 'error' {
  return level === 'warning' ? 'warn' : level
}

export function handleExtensionUiMessage(message: MainToRendererMessage): boolean {
  switch (message.type) {
    case 'ui.showMessage': {
      const title = titleFor(message.extensionId)
      // 纯通知：不打断用户，也不占队列
      if (!message.options.modal && message.options.items.length === 0) {
        pushNotice(message.options.message, {
          title,
          level: noticeLevel(message.options.level)
        })
        respond(message.requestId, null)
        return true
      }
      extensionUiStore.queue.push({
        id: message.requestId,
        kind: 'message',
        title,
        level: message.options.level,
        message: message.options.message,
        ...(message.options.detail !== undefined ? { detail: message.options.detail } : {}),
        items: [...message.options.items]
      })
      return true
    }
    case 'ui.showInputBox': {
      extensionUiStore.queue.push({
        id: message.requestId,
        kind: 'input',
        title: message.options.title || titleFor(message.extensionId),
        ...(message.options.prompt !== undefined ? { prompt: message.options.prompt } : {}),
        ...(message.options.placeHolder !== undefined
          ? { placeHolder: message.options.placeHolder }
          : {}),
        value: message.options.value ?? '',
        password: message.options.password === true
      })
      return true
    }
    case 'ui.showQuickPick': {
      extensionUiStore.queue.push({
        id: message.requestId,
        kind: 'pick',
        title: message.options.title || titleFor(message.extensionId),
        ...(message.options.placeHolder !== undefined
          ? { placeHolder: message.options.placeHolder }
          : {}),
        canPickMany: message.options.canPickMany === true,
        items: message.options.items.map(item => ({
          label: item.label,
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...(item.detail !== undefined ? { detail: item.detail } : {}),
          ...(item.picked !== undefined ? { picked: item.picked } : {})
        }))
      })
      return true
    }
    default:
      return false
  }
}

/** 由 main.ts 在挂载后调用；返回取消订阅函数 */
export function initExtensionUiHost(): () => void {
  return api.onExtensionMessage(message => {
    handleExtensionUiMessage(message)
  })
}
