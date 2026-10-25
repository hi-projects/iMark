import { reactive } from 'vue'
import type { PluginNoticeLevel } from '@shared/plugins'

/**
 * 右下角气泡 + 通知中心。扩展发来的通知和宿主自己要说的话都走这里。
 *
 * 失败信息不用模态框:它会**掐断用户正在做的事**(正在打字、正在拖文件),
 * 而绝大多数失败根本不需要用户当场做决定 —— 它只需要被看见。所以这里的原则是:
 *   - 不打断输入焦点(纯 DOM 元素,不抢焦点、不挡鼠标,除非鼠标正停在它上面);
 *   - 自己会消失(error 停久一点,因为它更可能要看第二眼);
 *   - 一个扩展连着报同一件事时合并计数,而不是堆成一摞。
 *
 * 气泡会消失,但**通知本身不该跟着消失**:用户去泡了杯茶回来,右下角已经空了,
 * 刚才那条报错却还想再看一眼。所以这里同时留一份历史(noticeHistory),
 * 状态栏右侧的铃铛打开的就是它。历史只活在本次会话里 —— 通知不是日志。
 *
 * 真正需要用户**做决定**的事仍然用原生对话框(丢弃未保存的改动、删除文件),
 * 那些不是"通知",不该挪到这里来。
 */

/** 通知从哪来。界面上的小标签靠它区分「扩展说的」和「应用自己说的」 */
export type NoticeSource = 'app' | 'plugin' | 'browser'

export interface NoticeRecord {
  id: number
  title: string
  message: string
  level: PluginNoticeLevel
  source: NoticeSource
  at: number
  read: boolean
}

export interface Notice {
  id: number
  /** 显示在气泡上的来源(扩展名 / iMark) */
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

/**
 * 历史保留多少条。
 *
 * 上限存在的理由和气泡不同:气泡怕糊住界面,历史怕的是「一个扩展每分钟报十条」
 * 把内存吃成一个日志文件。通知中心是让人回看"刚才错过了什么",不是审计系统;
 * 一百多条之后,更早的那些已经没人会翻了。
 */
const MAX_HISTORY = 120

export const noticeStore = reactive<{ list: Notice[] }>({ list: [] })

/** 通知中心里看到的历史(新的在前)。气泡消失不等于这条通知没发生过 */
export const noticeHistory = reactive<{ list: NoticeRecord[] }>({ list: [] })

/** 铃铛按钮与那个小框的共享状态 */
export const noticeCenter = reactive<{ open: boolean; unread: number }>({
  open: false,
  unread: 0
})

let seq = 0
let historySeq = 0

/**
 * 记一条历史。
 *
 * 小框正开着时直接算已读:用户眼前就是那张列表,再在铃铛上冒一个红点,
 * 只会让他以为"打开之后又来了新的"。关着的时候才累计未读。
 */
function remember(
  title: string,
  message: string,
  level: PluginNoticeLevel,
  source: NoticeSource
): void {
  const record: NoticeRecord = {
    id: ++historySeq,
    title,
    message,
    level,
    source,
    at: Date.now(),
    read: noticeCenter.open
  }
  noticeHistory.list.unshift(record)
  while (noticeHistory.list.length > MAX_HISTORY) noticeHistory.list.pop()
  if (!record.read) noticeCenter.unread += 1
}

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
  o: { title?: string; level?: PluginNoticeLevel; source?: NoticeSource } = {}
): void {
  const text = String(message ?? '').trim()
  if (!text) return
  const title = o.title ?? 'iMark'
  const level = o.level ?? 'info'
  const source = o.source ?? 'app'

  // 先记历史,再决定气泡怎么画:历史是"发生过",合并不该把发生过的事也吞掉
  remember(title, text, level, source)

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
  const text = (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, '')
  pushNotice(`${action}失败：${text}`, { level: 'error' })
}

/**
 * 浏览器通知（HTML5 `new Notification(...)`）也收进历史。
 *
 * 这类通知不经过 `pushNotice`:它由渲染进程里的页面脚本直接交给 Chromium。
 * 包装只在 `notificationCapture.ts` 里做一次，这里只负责记下来 ——
 * **不再额外弹一个应用内气泡**:系统通知已经弹过了,再叠一层只会变成两条。
 */
export function recordBrowserNotice(title: string, body: string): void {
  const head = String(title ?? '').trim()
  const text = String(body ?? '').trim()
  if (!head && !text) return
  remember(head || '浏览器通知', text, 'info', 'browser')
}

export function openNoticeCenter(): void {
  noticeCenter.open = true
  // 打开即已读:铃铛上的数字回答的是"还有多少条没看过"
  for (const item of noticeHistory.list) item.read = true
  noticeCenter.unread = 0
}

export function closeNoticeCenter(): void {
  noticeCenter.open = false
}

export function toggleNoticeCenter(): void {
  if (noticeCenter.open) closeNoticeCenter()
  else openNoticeCenter()
}

export function clearNotices(): void {
  noticeHistory.list.length = 0
  noticeCenter.unread = 0
}
