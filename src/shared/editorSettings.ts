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
 * 正文字号(px):滑块值就是实际渲染大小,所见即所得。
 * 标题/代码块用 em,跟着它按比例缩放。
 */
export const EDITOR_FONT_SIZE_MIN = 12
export const EDITOR_FONT_SIZE_MAX = 24

/**
 * 字号设置的语义版本。
 *
 * 1(字段缺失)= 旧版的「基准」,实际正文 = 基准 × 1.375;
 * 2 = 设置值本身就是实际正文字号。
 * 旧 settings.json 没有这个字段,读盘时按 1 处理并换算一次(见 main/settings.ts)。
 */
export const EDITOR_FONT_SIZE_VERSION = 2

/**
 * 行间距(档):同一段里行与行之间**额外**留出的空白(折行也按它算)。
 *
 * 和标题 / 段 / 块间距用同一把尺子:1 档 = 1 个正文字号,默认 1 档。
 * 实际行高 = 1 个字号(文字自身的高度) + 这档空白,所以默认是 2em;
 * 0 档时行贴在一起(行高 = 字号),不会重叠。档位跟着正文字号缩放,
 * 调字号时行距同比例变化。标题有自己的 1.4 倍行高(见 editor.css),
 * 不受这根滑块影响。
 */
export const LINE_SPACE_MIN = 0
export const LINE_SPACE_MAX = 3
export const LINE_SPACE_STEP = 0.1
export const LINE_SPACE_DEFAULT = 1

/** 夹到 [0, 3],按 0.1 取整;非数字(输入被清空、settings.json 被手改)落回默认值 */
export function clampLineSpace(value: unknown, fallback: number = LINE_SPACE_DEFAULT): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.min(LINE_SPACE_MAX, Math.max(LINE_SPACE_MIN, value))
  return Math.round(clamped * 10) / 10
}

/**
 * 标题上下的留白(设置面板「外观」页),单位是「档」:1 档 = 正文字号。
 *
 *   · before  —— 标题前面是正文时,标题上方留的空白;
 *   · after   —— 标题后面是正文时,标题下方留的空白;
 *   · between —— 两个标题紧挨着(中间没有空行)时,两者之间的空白。
 *
 * 用倍数而不是 px:改正文字号时整组间距同比例缩放,和标题字号一样。
 * 默认各 1 档,与 Obsidian 的 --p-spacing 一致。
 */
export const HEADING_SPACE_MIN = 0
export const HEADING_SPACE_MAX = 3
export const HEADING_SPACE_STEP = 0.1
export const HEADING_SPACE_DEFAULTS = { before: 1, after: 1, between: 1 } as const
export type HeadingSpaceSide = keyof typeof HEADING_SPACE_DEFAULTS

/** 夹到 [0, 3],按 0.1 档取整;非数字(输入被清空、settings.json 被手改)落回默认值 */
export function clampHeadingSpace(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.min(HEADING_SPACE_MAX, Math.max(HEADING_SPACE_MIN, value))
  return Math.round(clamped * 10) / 10
}

/**
 * 块与正文之间、以及两段正文之间的留白(设置面板「外观 → 块间距」),
 * 单位同样是「档」。
 *
 *   · bodyBetween —— 两段正文之间那条空行的留白(设置里的「段间距」);
 *   · codeBefore / codeAfter —— 代码块前面 / 后面是正文时的留白;
 *   · listBefore / listAfter —— 列表前面 / 后面是正文时的留白;
 *   · quoteBefore / quoteAfter —— 引用前面 / 后面是正文时的留白。
 *
 * 默认 1 档(一个正文字号):与标题间距、正文行距用同一把尺子,块与正文
 * 之间的留白和段落之间看起来一致。刻度与标题间距相同(0–3 档,0.1 一档)。
 */
export const BLOCK_SPACE_MIN = HEADING_SPACE_MIN
export const BLOCK_SPACE_MAX = HEADING_SPACE_MAX
export const BLOCK_SPACE_STEP = HEADING_SPACE_STEP
export const BLOCK_SPACE_DEFAULTS = {
  bodyBetween: 1,
  codeBefore: 1,
  codeAfter: 1,
  listBefore: 1,
  listAfter: 1,
  quoteBefore: 1,
  quoteAfter: 1
} as const
export type BlockSpaceSide = keyof typeof BLOCK_SPACE_DEFAULTS

export function clampBlockSpace(value: unknown, fallback: number): number {
  return clampHeadingSpace(value, fallback)
}

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
  /** 与旧版默认(基准 13px × 1.375 ≈ 17.9px)在视觉上一致 */
  editorFontSize: 18,
  /** 见 EDITOR_FONT_SIZE_VERSION:2 = 设置值即实际正文字号 */
  editorFontSizeVersion: EDITOR_FONT_SIZE_VERSION,
  /** 行间距(档,× 正文字号);行高 = 1 + 这一档 */
  lineSpace: LINE_SPACE_DEFAULT,
  /** 与 Obsidian 的 Tab size 默认档一致 */
  codeIndentSize: 4,
  /** 标题上方留白(档,× 正文字号) */
  headingSpaceBefore: HEADING_SPACE_DEFAULTS.before,
  /** 标题下方留白(档,× 正文字号) */
  headingSpaceAfter: HEADING_SPACE_DEFAULTS.after,
  /** 两个紧挨着的标题之间的留白(档,× 正文字号) */
  headingSpaceBetween: HEADING_SPACE_DEFAULTS.between,
  /** 两段正文之间的留白(档,× 正文字号) */
  bodySpaceBetween: BLOCK_SPACE_DEFAULTS.bodyBetween,
  /** 代码块上方留白(档,× 正文字号) */
  codeSpaceBefore: BLOCK_SPACE_DEFAULTS.codeBefore,
  /** 代码块下方留白(档,× 正文字号) */
  codeSpaceAfter: BLOCK_SPACE_DEFAULTS.codeAfter,
  /** 列表上方留白(档,× 正文字号) */
  listSpaceBefore: BLOCK_SPACE_DEFAULTS.listBefore,
  /** 列表下方留白(档,× 正文字号) */
  listSpaceAfter: BLOCK_SPACE_DEFAULTS.listAfter,
  /** 引用上方留白(档,× 正文字号) */
  quoteSpaceBefore: BLOCK_SPACE_DEFAULTS.quoteBefore,
  /** 引用下方留白(档,× 正文字号) */
  quoteSpaceAfter: BLOCK_SPACE_DEFAULTS.quoteAfter
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
