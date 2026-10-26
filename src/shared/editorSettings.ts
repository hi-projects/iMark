/**
 * 编辑器偏好(设置面板「编辑器」页)的取值范围与默认值。
 *
 * 三处要读同一组数:主进程写盘前夹取、渲染层输入框的约束、页面上的「恢复默认」。
 * 各写各的话,改了一处另两处就开始悄悄跑偏 —— 比如输入框放行 1 秒而定时器按 30 秒跑。
 */

/**
 * 定时保存的延迟(秒):停止输入这么久之后才写盘。
 *
 * 只有下限 1 秒:连续输入会在停下来后归并成一次写。上限刻意不设:
 * 用户想设多久都行,计时器由 services/autoSave 分段续约,不会被 setTimeout 的溢出截断。
 */
export const AUTO_SAVE_DELAY_MIN = 1

/**
 * 字号基准(px)。设置值不再等于实际正文字号:正文与 H4–H6 同档,渲染为
 * 基准 × 1.375(见 tokens.css 的 --editor-body-size);标题/代码块按 em 跟着缩。
 */
export const EDITOR_FONT_SIZE_MIN = 12
export const EDITOR_FONT_SIZE_MAX = 24

/**
 * 代码块内按 Tab 插入的空格数。
 *
 * 只提供 2 / 4 两档(与 Obsidian 的 Tab size 一致):这个值只影响代码块里的
 * 手写缩进,不是可自由编排的排版参数,档位越少越不用纠结。
 */
export const CODE_INDENT_OPTIONS = [2, 4] as const
export type CodeIndentSize = (typeof CODE_INDENT_OPTIONS)[number]

/** 「恢复默认」的落点,也是 settings.json 里缺字段时的兜底 */
export const EDITOR_DEFAULTS = {
  /** 默认不自动写盘:那会真的动磁盘,得由用户自己点头 */
  autoSaveMode: 'off',
  /**
   * 默认 1 秒:用户选中「定时保存」时,先得到接近实时保存的行为 ——
   * 想少写几次盘的人再自己调长。
   */
  autoSaveDelay: 1,
  lineWrapping: true,
  /** 与 Obsidian 的正文设置一致(13px) */
  editorFontSize: 13,
  /** 与 Obsidian 的 Tab size 默认档一致 */
  codeIndentSize: 4
} as const

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

/** 只防「秒 × 1000」溢出,不是业务上限(约 28.5 万年) */
const DELAY_TECHNICAL_MAX = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

/**
 * 夹到合法区间;非数字落回默认值(输入框被清空、settings.json 被手改成字符串都走这里)。
 * 不设上限:延迟按秒存,计时器自己会分段等待,不需要为了 setTimeout 去限制用户。
 */
export function clampAutoSaveDelay(sec: unknown, fallback: number = EDITOR_DEFAULTS.autoSaveDelay): number {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return fallback
  return Math.min(DELAY_TECHNICAL_MAX, Math.max(AUTO_SAVE_DELAY_MIN, Math.round(sec)))
}

export function clampFontSize(px: unknown): number {
  return clampNum(px, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, EDITOR_DEFAULTS.editorFontSize)
}

/** 只接受 2 / 4;被手改成别的数值(或字符串)就落回默认档 */
export function clampCodeIndentSize(size: unknown): CodeIndentSize {
  return size === 2 || size === 4 ? size : EDITOR_DEFAULTS.codeIndentSize
}

/** 「1 秒」/「5 分钟」/「2 小时」:能整除就说大单位,别让人自己换算 300 */
export function delayLabel(sec: number): string {
  if (sec % 86400 === 0 && sec >= 86400) return `${sec / 86400} 天`
  if (sec % 3600 === 0 && sec >= 3600) return `${sec / 3600} 小时`
  if (sec % 60 === 0 && sec >= 60) return `${sec / 60} 分钟`
  return `${sec} 秒`
}
