import { watch } from 'vue'
import { appStore } from '../stores/app'

/**
 * 把渲染层才知道的两件事告诉主进程:编辑器里有没有文档、文档内容变没变。
 *
 * 为什么要从渲染层发,而不是主进程自己看:文档内容与"编辑器开着"都是渲染层的事实。
 * 主进程手里只有文件路径,而**未保存的新文档没有路径** —— 它在主进程看来和
 * "什么都没开"一模一样,可插件要的答案恰恰相反。
 *
 * 为什么必须在这里节流:`document:change` 的触发源是 CodeMirror 的每次更新,
 * 也就是每敲一个键一次。一次 IPC 往返换来插件只是想知道"字变多了",
 * 这个代价不该由打字的人来付。
 */

/**
 * 内容变化的上报间隔。
 *
 * 400ms 是"人停下来喘口气"的量级:连续打字时一次都不发,停顿一下才发一次。
 * 插件拿到这个事件会去读文档、更新状态、甚至落盘 —— 让它们按打字节奏跑没有意义。
 */
const CHANGE_THROTTLE_MS = 400

let timer: ReturnType<typeof setTimeout> | null = null

function sendNow(): void {
  timer = null
  window.api.notifyDocChanged({
    dirty: appStore.dirty,
    words: appStore.words,
    chars: appStore.chars
  })
}

/**
 * 合并式节流(而不是"最多 400ms 一次"的限流)。
 *
 * 区别在于结尾:打字停下来之后一定要补发**最后**那一份状态,否则插件手里的
 * 字数会停在某个中间值上,而且再也不会更新 —— 直到用户下次动键盘。
 */
function scheduleSend(): void {
  if (timer) return
  timer = setTimeout(sendNow, CHANGE_THROTTLE_MS)
}

/** 由 main.ts 在挂载后调用 */
export function initDocEvents(): void {
  // 编辑器开着吗 —— 与"有文件路径"是两件事(未命名文档没有路径)
  watch(
    () => appStore.view,
    view => window.api.setEditorPresence(view === 'editor'),
    { immediate: true }
  )

  // 字数/字符数/脏标记任一变化都算"内容变了"
  watch([() => appStore.dirty, () => appStore.words, () => appStore.chars], scheduleSend)

  // 切仓库/开文件会整体换掉文档,这时攒着的那一次要立刻发出去:
  // 插件看到的下一个事件是 file:open,顺序反了会让人以为事件丢了
  watch(
    () => appStore.filePath,
    () => {
      if (timer) {
        clearTimeout(timer)
        sendNow()
      }
    }
  )
}
