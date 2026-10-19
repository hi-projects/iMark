import { watch } from 'vue'
import { appStore, editorHolder } from '../stores/app'
import { saveAllFileTabsSilently, writeTabInPlace } from './fileService'
import { activeTab, tabById } from './tabs'

/**
 * 自动保存:把文档的改动写回它自己的文件。四种方式(与 VS Code 的 files.autoSave 对齐):
 *
 * - **定时保存**:每次输入后等 `autoSaveDelay` 秒,期间没有新输入就写盘。
 *   1 秒档就是通常说的「实时保存」—— 它本来只是延迟很短的定时保存,
 *   所以不再单列一种模式。连续输入只会在停下来后写一次。
 * - **切换焦点时**:编辑器失去焦点时写盘。
 * - **切换窗口时**:整个窗口失去焦点时写盘。
 * - **关闭**:什么都不做。
 *
 * 多标签之后多了一条:**切走标签页也算焦点离开那份文档** ——
 * 定时保存和切换焦点模式会把旧标签先落盘,免得它的改动只能在关闭时被想起来。
 *
 * 几条「不做」比「做」更要紧:
 * - **没有落过盘的文件不保存**。否则会在某个没人注意的时刻弹出「另存为」,
 *   把正在打字的人打断在半句话上。未命名文档只在手动保存时才要用户选路径。
 * - **没改动不写盘**。写盘不是心跳包 —— 每 30 秒去动一次 mtime,文件同步工具
 *   和 Git 会一直以为文件在变。
 * - **上一轮没写完就跳过这一轮**。网络盘/大文件写起来可能比延迟还慢,不跳过的话
 *   排队的写会越积越多。定时模式遇到正在写的情况会稍后重试,因为它的下一次触发
 *   可能永远不会到来(用户已经停手了)。
 *
 * 失败不弹 alert:提示放状态栏,同样的原因不重复打断用户(错误只留在状态栏里,
 * 下一次成功自动清掉)。
 */

/** 状态栏提示的停留时长;失败留久一点,免得一眨眼就看不见了 */
const OK_FEEDBACK_MS = 3000
const ERROR_FEEDBACK_MS = 6000

/** 定时模式撞上「上一轮还在写」时的重试间隔:等前一次落完,别丢掉这轮改动 */
const BUSY_RETRY_MS = 250

/** 写盘失败后的重试间隔:别拿 1 秒的延迟档去反复砸一个写不进去的盘 */
const ERROR_RETRY_MS = 30_000

/** setTimeout 的单次上限:再大的值会被浏览器截断甚至当成 0,长延迟要分段续约 */
const MAX_TIMEOUT_MS = 2_147_483_647

type SaveOutcome = 'idle' | 'saved' | 'error'

let delayTimer: ReturnType<typeof setTimeout> | undefined
/** 这一拍定时保存属于哪个标签;切换标签后定时器会被取消/重排 */
let delayTabId: string | null = null
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let saving = false

function isAfterDelay(): boolean {
  return appStore.autoSaveMode === 'afterDelay'
}

/**
 * 等待 delayMs 后写盘。
 *
 * 延迟不设业务上限,但 setTimeout 一次最多只能等 2^31-1 毫秒(约 24.8 天),
 * 再大会溢出成「立刻触发」。所以超过上限时按上限分段续约,直到真正的截止时刻。
 */
function scheduleDelay(delayMs = appStore.autoSaveDelay * 1000, tabId = appStore.activeTabId): void {
  clearTimeout(delayTimer)
  delayTabId = tabId
  const remaining = Math.max(0, delayMs)
  const deadline = Date.now() + remaining
  delayTimer = setTimeout(() => {
    const left = deadline - Date.now()
    if (left > 0) {
      scheduleDelay(left, tabId)
      return
    }
    void delayTick()
  }, Math.min(remaining, MAX_TIMEOUT_MS))
}

/** 真正写盘的那一步;没开自动保存/标签不存在/没路径/没改动/正在写都直接跳过 */
async function saveIfNeeded(tabId: string | null = appStore.activeTabId): Promise<SaveOutcome> {
  const tab = tabId ? tabById(tabId) : null
  if (saving || !editorHolder.view || !tab || !tab.filePath || !tab.dirty) return 'idle'

  saving = true
  try {
    await writeTabInPlace(tab.id, tab.filePath)
    showOk()
    return 'saved'
  } catch (err) {
    // 不弹框:可能是磁盘满了、文件被外部删了,也可能只是临时抖动
    console.error('[iMark] 自动保存失败', err)
    showError(err instanceof Error ? err.message : String(err))
    return 'error'
  } finally {
    saving = false
  }
}

async function delayTick(): Promise<void> {
  delayTimer = undefined
  const tabId = delayTabId
  delayTabId = null
  // 关掉或切到别的保存方式后不再排下一拍;重新起步由 restartAutoSave() 负责
  if (!isAfterDelay()) return

  // 上一轮还没写完:这一轮不能丢,但也别和它抢同一个文件
  if (saving) {
    scheduleDelay(BUSY_RETRY_MS, tabId)
    return
  }

  const outcome = await saveIfNeeded(tabId)
  const tab = tabId ? tabById(tabId) : null
  // 失败后自己再试一次:用户这时可能已经停手,不能指望下一次输入来触发重试
  if (outcome === 'error' && isAfterDelay() && tab?.dirty) {
    scheduleDelay(ERROR_RETRY_MS, tabId)
  }
}

/**
 * 编辑器每次内容变化时调用。定时模式下重置延迟计时:连续输入只会在停下来后写一次。
 * 另外两种方式由焦点/窗口事件触发,这里不排队。
 */
export function noteDocChangeForAutoSave(): void {
  if (!isAfterDelay() || !appStore.filePath) return
  scheduleDelay()
}

/**
 * 切走一个标签时处理它的自动保存。
 *
 * 定时模式:它的延迟没必要再等 —— 人已经去看别的文档了,先落盘;
 * 切换焦点模式:焦点确实离开了那份文档,与失焦同义。
 * 「切换窗口时」不在这里触发:切标签并不等于切窗口。
 */
function onTabDeactivated(tabId: string): void {
  if (appStore.autoSaveMode !== 'afterDelay' && appStore.autoSaveMode !== 'onFocusChange') return
  const tab = tabById(tabId)
  if (!tab || !tab.filePath || !tab.dirty) {
    // 旧标签干净也把它的计时取消掉,别让这一拍稍后落到新标签头上
    clearTimeout(delayTimer)
    delayTimer = undefined
    if (isAfterDelay() && appStore.filePath) scheduleDelay()
    return
  }
  clearTimeout(delayTimer)
  delayTimer = undefined
  void saveIfNeeded(tabId).then(() => {
    // 新标签如果在切走前就有未保存改动(上次保存失败过),接着按它的节奏排一拍
    if (isAfterDelay() && activeTab()?.dirty) scheduleDelay()
  })
}

// 切标签 = 离开旧文档。放在这里而不是 tabs.ts 里,避免 tabs ←→ fileService 成环
watch(
  () => appStore.activeTabId,
  (next, prev) => {
    if (prev && prev !== next) onTabDeactivated(prev)
  }
)

/**
 * 编辑器失去焦点(onFocusChange)。由下面的 focusout 监听统一调用。
 *
 * 只在焦点确实离开编辑器时保存:CodeMirror 内部元素之间挪焦点也算 focusout,
 * 那种情况 relatedTarget 仍在编辑器里,应当忽略。
 */
function onEditorFocusOut(e: FocusEvent): void {
  if (appStore.autoSaveMode !== 'onFocusChange') return
  const view = editorHolder.view
  const target = e.target
  if (!view || !(target instanceof Node) || !view.dom.contains(target)) return
  const next = e.relatedTarget
  if (next instanceof Node && view.dom.contains(next)) return
  void saveIfNeeded()
}

document.addEventListener('focusout', onEditorFocusOut, true)

/**
 * 窗口失去焦点(onWindowChange)。切到别的应用/窗口时触发;
 * 「切换焦点时」也捎带处理 —— 窗口失焦必然意味着编辑器也失焦了。
 *
 * 多标签时把**所有有路径的脏标签**都落盘:用户离开的是整个应用,
 * 后台标签的改动同样该安全落地(未命名文档仍然跳过,不能弹「另存为」)。
 */
window.addEventListener('blur', () => {
  if (appStore.autoSaveMode === 'onWindowChange' || appStore.autoSaveMode === 'onFocusChange') {
    void saveAllFileTabsSilently()
  }
})

function showOk(): void {
  appStore.autoSaveError = null
  appStore.autoSavedAt = Date.now()
  clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => {
    appStore.autoSavedAt = null
  }, OK_FEEDBACK_MS)
}

function showError(message: string): void {
  appStore.autoSavedAt = null
  appStore.autoSaveError = message
  clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => {
    appStore.autoSaveError = null
  }, ERROR_FEEDBACK_MS)
}

export function stopAutoSave(): void {
  clearTimeout(delayTimer)
  delayTimer = undefined
  delayTabId = null
}

/** 设置面板改动保存方式或延迟后调用:从现在重新计时,别等上一拍的旧节奏走完 */
export function restartAutoSave(): void {
  stopAutoSave()
  // 切到定时模式时,已有的未保存改动也该在延迟后落盘,而不是等下一次输入。
  // 这里不看 appStore.dirty:它比实际输入晚 250ms 更新,刚敲完字就切模式会漏掉
  if (isAfterDelay() && appStore.filePath) scheduleDelay()
}
