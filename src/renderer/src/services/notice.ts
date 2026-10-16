import { reactive } from 'vue'
import type { PluginNoticeLevel } from '@shared/plugins'

/**
 * 右下角气泡。插件发来的通知和宿主自己要说的话都走这里。
 *
 * 之前全仓没有 toast,失败信息一律 `alert()`:模态框会**掐断用户正在做的事**
 * (正在打字、正在拖文件),而绝大多数失败根本不需要用户当场做决定 ——
 * 它只需要被看见。所以这里的原则是:
 *   - 不打断输入焦点(纯 DOM 元素,不抢焦点、不挡鼠标,除非鼠标正停在它上面);
 *   - 自己会消失(error 停久一点,因为它更可能要看第二眼);
 *   - 一个插件连着报同一件事时合并计数,而不是堆成一摞。
 *
 * 真正需要用户**做决定**的事仍然用原生对话框(丢弃未保存的改动、删除文件),
 * 那些不是"通知",不该挪到这里来。
 */

export interface Notice {
  id: number
  /** 显示在气泡上的来源(插件名 / iMark) */
  title: string
  message: string
  level: PluginNoticeLevel
  /** 同一条消息又来了几次(合并显示 ×N) */
  count: number
  /** 自动消失的定时器句柄 —— 合并计数时要重新计时 */
  timer: ReturnType<typeof setTimeout> | null
}

/** 各等级停留时长:越可能是坏消息,越要留够看第二眼的时间 */
const LIFETIME: Record<PluginNoticeLevel, number> = {
  info: 3200,
  success: 3200,
  warn: 6000,
  error: 9000
}

/** 同时最多显示几条。超了从最旧的开始丢 —— 气泡是流水席,不是收件箱 */
const MAX_VISIBLE = 4

export const noticeStore = reactive<{ list: Notice[] }>({ list: [] })

let seq = 0

function dismiss(id: number): void {
  const i = noticeStore.list.findIndex(n => n.id === id)
  if (i < 0) return
  const [gone] = noticeStore.list.splice(i, 1)
  if (gone?.timer) clearTimeout(gone.timer)
}

export function dismissNotice(id: number): void {
  dismiss(id)
}

export function pushNotice(
  message: string,
  o: { title?: string; level?: PluginNoticeLevel } = {}
): void {
  const text = String(message ?? '').trim()
  if (!text) return
  const title = o.title ?? 'iMark'
  const level = o.level ?? 'info'

  // 相同来源 + 相同内容正在屏幕上:合并计数,而不是再贴一张一样的
  const same = noticeStore.list.find(n => n.title === title && n.message === text && n.level === level)
  if (same) {
    same.count += 1
    if (same.timer) clearTimeout(same.timer)
    same.timer = setTimeout(() => dismiss(same.id), LIFETIME[level])
    return
  }

  const notice: Notice = { id: ++seq, title, message: text, level, count: 1, timer: null }
  noticeStore.list.push(notice)
  while (noticeStore.list.length > MAX_VISIBLE) {
    const oldest = noticeStore.list[0]
    if (oldest) dismiss(oldest.id)
    else break
  }
  notice.timer = setTimeout(() => dismiss(notice.id), LIFETIME[level])
}

/** 出错时的统一说法。替换 `alert('…失败:…')` 用 */
export function notifyError(action: string, err: unknown): void {
  pushNotice(`${action}失败:${err instanceof Error ? err.message : String(err)}`, { level: 'error' })
}
