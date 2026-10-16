/**
 * 编辑器偏好(设置面板「编辑器」页)的取值范围与默认值。
 *
 * 三处要读同一组数:主进程写盘前夹取、渲染层输入框的约束、页面上的「恢复默认」。
 * 各写各的话,改了一处另两处就开始悄悄跑偏 —— 比如输入框放行 1 秒而定时器按 5 秒跑。
 */

/** 定时保存间隔(秒)。下限是 5 秒:再短就不是「定时」而是持续写盘了 */
export const AUTO_SAVE_INTERVAL_MIN = 5
export const AUTO_SAVE_INTERVAL_MAX = 3600

/** 正文字号(px)。正文一动,标题/代码块按 em 跟着缩 */
export const EDITOR_FONT_SIZE_MIN = 12
export const EDITOR_FONT_SIZE_MAX = 24

/** 「恢复默认」的落点,也是 settings.json 里缺字段时的兜底 */
export const EDITOR_DEFAULTS = {
  /** 默认不开:定时保存会真的往磁盘上写,得由用户自己点头 */
  autoSave: false,
  autoSaveInterval: 30,
  lineWrapping: true,
  editorFontSize: 16
} as const

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/** 夹到合法区间;非数字落回默认值(输入框被清空、settings.json 被手改成字符串都走这里) */
export function clampInterval(sec: unknown): number {
  return clampNum(sec, AUTO_SAVE_INTERVAL_MIN, AUTO_SAVE_INTERVAL_MAX, EDITOR_DEFAULTS.autoSaveInterval)
}

export function clampFontSize(px: unknown): number {
  return clampNum(px, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, EDITOR_DEFAULTS.editorFontSize)
}

/** 「每 30 秒」/「每 5 分钟」:整分钟就说分钟,别让人自己换算 300 */
export function intervalLabel(sec: number): string {
  if (sec % 60 === 0 && sec >= 60) return `每 ${sec / 60} 分钟`
  return `每 ${sec} 秒`
}
