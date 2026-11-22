/**
 * 输入法组合状态的统一来源。
 *
 * CodeMirror 的 `view.composing` 在 keydown 时不一定已经置位;各命令自己判断
 * 容易漏。这里在 window 捕获阶段记录 composition 与 isComposing/keyCode 229,
 * 所有「按键类」交互统一问 `isImeComposing()`。
 */
let composing = false
let changedAt = 0
let installed = false

function mark(on: boolean): void {
  composing = on
  changedAt = performance.now()
}

/** 组合中(或刚刚结束的一小段时间:回车上屏的 keydown 可能早于 compositionend) */
export function isImeComposing(viewComposing = false): boolean {
  return viewComposing || composing || performance.now() - changedAt < 30
}

/** 全局安装一次;返回清理函数主要给测试/热重载用 */
export function installImeTracking(): () => void {
  if (installed) return () => {}
  installed = true
  const start = (): void => mark(true)
  const end = (): void => mark(false)
  const down = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229) mark(true)
  }
  window.addEventListener('compositionstart', start, true)
  window.addEventListener('compositionend', end, true)
  window.addEventListener('keydown', down, true)
  return () => {
    installed = false
    window.removeEventListener('compositionstart', start, true)
    window.removeEventListener('compositionend', end, true)
    window.removeEventListener('keydown', down, true)
  }
}
