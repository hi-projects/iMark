import { appStore, editorHolder } from '../stores/app'
import { writeCurrentFileInPlace } from './fileService'

/**
 * 定时保存:每隔 N 秒,如果文档有改动就写回它自己的文件。
 *
 * 三条「不做」比「做」更要紧:
 * - **没有落过盘的文件不保存**。否则定时器会在某个没人注意的时刻弹出「另存为」,
 *   把正在打字的人打断在半句话上。未命名文档只在手动保存时才要用户选路径。
 * - **没改动不写盘**。定时器不是心跳包 —— 每 30 秒去动一次 mtime,文件同步工具
 *   和 Git 会一直以为文件在变。
 * - **上一轮没写完就跳过这一轮**。网络盘/大文件写起来可能比间隔还慢,不跳过的话
 *   排队的写会越积越多。
 *
 * 失败不弹 alert:提示放状态栏,同样的原因不重复打断用户(错误只留在状态栏里,
 * 下一次成功自动清掉)。
 */

/** 状态栏提示的停留时长;失败留久一点,免得一眨眼就看不见了 */
const OK_FEEDBACK_MS = 3000
const ERROR_FEEDBACK_MS = 6000

let timer: ReturnType<typeof setTimeout> | undefined
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let saving = false

function schedule(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void tick(), appStore.autoSaveInterval * 1000)
}

async function tick(): Promise<void> {
  timer = undefined
  // 关掉之后不再排下一拍;重新打开由 restartAutoSave() 负责重新起步
  if (!appStore.autoSave) return

  const path = appStore.filePath
  if (!saving && editorHolder.view && path && appStore.dirty) {
    saving = true
    try {
      await writeCurrentFileInPlace(path)
      showOk()
    } catch (err) {
      // 不弹框:可能是磁盘满了、文件被外部删了,也可能只是临时抖动
      console.error('[iMark] 自动保存失败', err)
      showError(err instanceof Error ? err.message : String(err))
    } finally {
      saving = false
    }
  }
  schedule()
}

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
  clearTimeout(timer)
  timer = undefined
}

/** 设置面板改动开关或间隔后调用:从现在重新计时,别等上一拍的旧间隔走完 */
export function restartAutoSave(): void {
  stopAutoSave()
  if (appStore.autoSave) schedule()
}
