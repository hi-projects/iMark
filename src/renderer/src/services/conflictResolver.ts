/**
 * 「处理合并冲突」窗口的状态。
 *
 * 编辑器内联的冲突操作栏只覆盖**已经打开在编辑器里的 Markdown / txt**;
 * `.gitignore` 这类不在文件树里的文件没有内联入口。扩展发现冲突后调用
 * `window.showConflictResolver(files, { onlyUnopened: true })`,把没打开的冲突
 * 文件交给这个窗口统一处理。
 */

import { reactive } from 'vue'
import { appStore } from '../stores/app'

export interface ConflictResolverState {
  open: boolean
  /** 绝对路径 */
  files: string[]
  /** 每次打开递增,供组件判断是否要重新读盘 */
  revision: number
}

export const conflictResolver = reactive<ConflictResolverState>({
  open: false,
  files: [],
  revision: 0
})

function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 打开窗口。`onlyUnopened` 时跳过编辑器里已经打开的文档(那些有内联操作栏)。
 * 窗口已经开着时不再重置列表 —— 用户在窗口里做了一半的选择不能被后台同步刷掉。
 */
export function openConflictResolver(
  files: readonly string[],
  options?: { onlyUnopened?: boolean }
): boolean {
  if (conflictResolver.open) return true
  const opened = new Set(
    appStore.tabs
      .map(tab => (tab.filePath ? normPath(tab.filePath) : ''))
      .filter(Boolean)
  )
  const list = (options?.onlyUnopened ? files.filter(file => !opened.has(normPath(file))) : [...files])
    .filter(file => file.trim().length > 0)
  if (list.length === 0) return false
  conflictResolver.files = list
  conflictResolver.open = true
  conflictResolver.revision += 1
  return true
}

export function closeConflictResolver(): void {
  conflictResolver.open = false
}
