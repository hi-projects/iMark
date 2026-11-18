/**
 * 「外观 → 样式」圆环的纯数据模型:七种块、每对块的两个方向、每个方向真正
 * 生效的间距字段。
 *
 * 这里不碰 Vue,也不碰 DOM —— 组件只负责画和转发,验收 harness 依赖的
 * data-* 属性也从这里的 SpaceRow 生成。间距引擎本身在 editor.css / rules.ts,
 * 这个文件只是把已有字段按「块对」重新编目。
 */
import type {
  BlockSpaceSide,
  HeadingSpaceSide,
  ImageSpaceSide
} from '@shared/editorSettings'

export type BlockKind = 'body' | 'heading' | 'code' | 'list' | 'quote' | 'image' | 'table'

/** 圆环上块的固定顺序,也是配对 key 的排序依据 */
export const BLOCK_KINDS: BlockKind[] = [
  'body',
  'heading',
  'code',
  'list',
  'quote',
  'image',
  'table'
]

export const BLOCK_LABELS: Record<BlockKind, string> = {
  body: '正文',
  heading: '标题',
  code: '代码块',
  list: '列表',
  quote: '引用',
  image: '图片',
  table: '表格'
}

/** 不生效的字段用灰色说明,不画滑块 */
export type SpaceNote =
  | 'blank-only'
  | 'max-on-blank'
  | 'tight-sum'
  | 'image-owned'
  | 'shared-field'
  | 'inert'

export type SpaceTarget =
  | { kind: 'heading'; side: HeadingSpaceSide }
  | { kind: 'block'; side: BlockSpaceSide }
  | { kind: 'image'; side: ImageSpaceSide }
  | { kind: 'line' }

/** appStore / settings.json 上的字段名 */
export type SpaceField =
  | 'lineSpace'
  | 'headingSpaceBefore'
  | 'headingSpaceAfter'
  | 'headingSpaceBetween'
  | 'bodySpaceBetween'
  | 'codeSpaceBefore'
  | 'codeSpaceAfter'
  | 'listSpaceBefore'
  | 'listSpaceAfter'
  | 'quoteSpaceBefore'
  | 'quoteSpaceAfter'
  | 'tableSpaceBefore'
  | 'tableSpaceAfter'
  | 'imageSpaceBeforeHeading'
  | 'imageSpaceBeforeBody'
  | 'imageSpaceAfterHeading'
  | 'imageSpaceAfterBody'

export interface SpaceRow {
  /** settings.json / appStore 字段 */
  field: SpaceField
  /** 写回时走哪个 preview/set 函数 */
  target: SpaceTarget
  label: string
  desc?: string
  /** 灰字补充:这一档的适用条件 */
  note?: { kind: SpaceNote; text: string }
}

export interface SpaceInert {
  field: SpaceField
  text: string
}

export interface SpaceGroup {
  /** 验收用:heading-above / code-above / self … */
  direction: string
  title: string
  desc?: string
  rows: SpaceRow[]
  inert?: SpaceInert[]
}

export interface PairView {
  /** 按 BLOCK_KINDS 顺序拼的稳定 key,与中心是谁无关 */
  key: string
  center: BlockKind
  target: BlockKind
  mode: 'self' | 'cross'
  title: string
  subtitle: string
  groups: SpaceGroup[]
  /** 没有可调项时的说明(例如图片自身) */
  empty?: string
}

const HEADING_FIELD = {
  before: 'headingSpaceBefore',
  after: 'headingSpaceAfter',
  between: 'headingSpaceBetween'
} as const

const BLOCK_FIELD = {
  bodyBetween: 'bodySpaceBetween',
  codeBefore: 'codeSpaceBefore',
  codeAfter: 'codeSpaceAfter',
  listBefore: 'listSpaceBefore',
  listAfter: 'listSpaceAfter',
  quoteBefore: 'quoteSpaceBefore',
  quoteAfter: 'quoteSpaceAfter',
  tableBefore: 'tableSpaceBefore',
  tableAfter: 'tableSpaceAfter'
} as const

const IMAGE_FIELD = {
  beforeHeading: 'imageSpaceBeforeHeading',
  beforeBody: 'imageSpaceBeforeBody',
  afterHeading: 'imageSpaceAfterHeading',
  afterBody: 'imageSpaceAfterBody'
} as const

const BLOCK_LABEL: Record<BlockSpaceSide, string> = {
  bodyBetween: '段间距',
  codeBefore: '代码块上方',
  codeAfter: '代码块下方',
  listBefore: '列表上方',
  listAfter: '列表下方',
  quoteBefore: '引用上方',
  quoteAfter: '引用下方',
  tableBefore: '表格上方',
  tableAfter: '表格下方'
}

const BLOCK_DESC: Record<BlockSpaceSide, string> = {
  bodyBetween: '两段正文之间（空一行）的留白。',
  codeBefore: '代码块前面的留白。',
  codeAfter: '代码块后面的留白。',
  listBefore: '列表前面的留白。',
  listAfter: '列表后面的留白。',
  quoteBefore: '引用前面的留白。',
  quoteAfter: '引用后面的留白。',
  tableBefore: '表格前面的留白。',
  tableAfter: '表格后面的留白。'
}

const IMAGE_LABEL: Record<ImageSpaceSide, string> = {
  beforeHeading: '图片上方与标题',
  beforeBody: '图片上方与正文',
  afterHeading: '图片下方与标题',
  afterBody: '图片下方与正文'
}

const IMAGE_DESC: Record<ImageSpaceSide, string> = {
  beforeHeading: '图片上方紧挨标题时的留白（也就是标题下方与图片）。',
  beforeBody: '图片上方紧挨正文时的留白（也就是正文下方与图片）。',
  afterHeading: '图片下方紧挨标题时的留白（也就是标题上方与图片）。',
  afterBody: '图片下方紧挨正文时的留白（也就是正文上方与图片）。'
}

function headingRow(side: HeadingSpaceSide): SpaceRow {
  return {
    field: HEADING_FIELD[side],
    target: { kind: 'heading', side },
    label: side === 'between' ? '标题之间' : side === 'before' ? '标题上方' : '标题下方',
    desc:
      side === 'between'
        ? '两个标题紧挨着（中间没有空行）时的留白。'
        : side === 'before'
          ? '标题前面是正文时的留白。'
          : '标题后面是正文时的留白。'
  }
}

function blockRow(side: BlockSpaceSide): SpaceRow {
  return {
    field: BLOCK_FIELD[side],
    target: { kind: 'block', side },
    label: BLOCK_LABEL[side],
    desc: BLOCK_DESC[side]
  }
}

function imageRow(side: ImageSpaceSide): SpaceRow {
  return {
    field: IMAGE_FIELD[side],
    target: { kind: 'image', side },
    label: IMAGE_LABEL[side],
    desc: IMAGE_DESC[side]
  }
}

function lineRow(): SpaceRow {
  return {
    field: 'lineSpace',
    target: { kind: 'line' },
    label: '行间距',
    desc: '同一段正文里行与行之间的额外留白（折行也按它算）。'
  }
}

function withNote(row: SpaceRow, kind: SpaceNote, text: string): SpaceRow {
  return { ...row, note: { kind, text } }
}

type BlockishKind = 'code' | 'list' | 'quote' | 'table'

const BLOCK_SIDES: Record<BlockishKind, { before: BlockSpaceSide; after: BlockSpaceSide }> = {
  code: { before: 'codeBefore', after: 'codeAfter' },
  list: { before: 'listBefore', after: 'listAfter' },
  quote: { before: 'quoteBefore', after: 'quoteAfter' },
  table: { before: 'tableBefore', after: 'tableAfter' }
}

function aboveTitle(kind: BlockKind): string {
  return `${BLOCK_LABELS[kind]}在上`
}

/** 正文与另一块:正文没有「上/下」档,由另一块的 before/after 表达 */
function bodyGroups(other: BlockKind): SpaceGroup[] {
  if (other === 'heading') {
    const desc = '中间留了空行时，空行本身仍占一整行；这一档是加在它之外的。'
    return [
      { direction: 'heading-above', title: '标题在上', rows: [headingRow('after')], desc },
      { direction: 'body-above', title: '正文在上', rows: [headingRow('before')], desc }
    ]
  }
  if (other === 'image') {
    const desc = '只在图片独占一行时生效。'
    return [
      { direction: 'image-above', title: '图片在上', rows: [imageRow('afterBody')], desc },
      { direction: 'body-above', title: '正文在上', rows: [imageRow('beforeBody')], desc }
    ]
  }
  const sides = BLOCK_SIDES[other as BlockishKind]
  return [
    { direction: `${other}-above`, title: aboveTitle(other), rows: [blockRow(sides.before)] },
    { direction: 'body-above', title: '正文在上', rows: [blockRow(sides.after)] }
  ]
}

/** 标题与另一块:标题那一侧的留白是权威值,块紧贴标题时块的下方档不生效 */
function headingGroups(other: BlockKind): SpaceGroup[] {
  if (other === 'image') {
    const desc = '只在图片独占一行时生效；图片那一侧是权威值，标题这一侧会清零。'
    return [
      { direction: 'heading-above', title: '标题在上', rows: [imageRow('beforeHeading')], desc },
      { direction: 'image-above', title: '图片在上', rows: [imageRow('afterHeading')], desc }
    ]
  }
  if (other === 'table') {
    return [
      {
        direction: 'heading-above',
        title: '标题在上',
        rows: [headingRow('after'), blockRow('tableBefore')],
        desc: '表格上方与标题下方同时生效；紧贴时表格让位给标题留白。'
      },
      {
        direction: 'table-above',
        title: '表格在上',
        rows: [blockRow('tableAfter'), headingRow('before')],
        desc: '表格下方与标题上方同时生效；紧贴时表格让位给标题留白。'
      }
    ]
  }
  const sides = BLOCK_SIDES[other as BlockishKind]
  return [
    {
      direction: 'heading-above',
      title: '标题在上',
      rows: [
        headingRow('after'),
        withNote(
          blockRow(sides.before),
          'blank-only',
          '只有中间留了空行时才另外加上；紧贴时以标题下方的留白为准。'
        )
      ]
    },
    {
      direction: `${other}-above`,
      title: aboveTitle(other),
      rows: [headingRow('before')],
      inert: [
        {
          field: BLOCK_FIELD[sides.after],
          text: `${BLOCK_LABELS[other]}下方这一档在这里不生效：中间有空行时空行占整行，紧贴时由标题上方的留白决定。`
        }
      ]
    }
  ]
}

/** 图片与另一块:图片没有专门档位的邻居(代码块 / 列表 / 引用 / 表格)由对方表达 */
function imageGroups(other: BlockKind): SpaceGroup[] {
  const sides = BLOCK_SIDES[other as BlockishKind]
  const desc = '只在图片独占一行时生效。'
  return [
    {
      direction: `${other}-above`,
      title: aboveTitle(other),
      rows: [blockRow(sides.after)],
      desc
    },
    { direction: 'image-above', title: '图片在上', rows: [blockRow(sides.before)], desc }
  ]
}

/** 代码块 / 列表 / 引用 / 表格两两配对:两个方向各由两档组成 */
function blockishGroups(a: BlockishKind, b: BlockishKind): SpaceGroup[] {
  const sa = BLOCK_SIDES[a]
  const sb = BLOCK_SIDES[b]
  const involvesTable = a === 'table' || b === 'table'
  const desc = involvesTable
    ? '中间有空行时取两档中较大的一个；紧贴表格时由表格那一侧的留白决定。'
    : '中间有空行时取两档中较大的一个；紧贴时两档相加。'
  return [
    {
      direction: `${a}-above`,
      title: aboveTitle(a),
      rows: [blockRow(sa.after), blockRow(sb.before)],
      desc
    },
    {
      direction: `${b}-above`,
      title: aboveTitle(b),
      rows: [blockRow(sb.after), blockRow(sa.before)],
      desc
    }
  ]
}

function crossGroups(center: BlockKind, target: BlockKind): SpaceGroup[] {
  if (center === 'body' || target === 'body') return bodyGroups(center === 'body' ? target : center)
  if (center === 'heading' || target === 'heading') {
    return headingGroups(center === 'heading' ? target : center)
  }
  if (center === 'image' || target === 'image') {
    return imageGroups(center === 'image' ? target : center)
  }
  return blockishGroups(center as BlockishKind, target as BlockishKind)
}

function selfView(kind: BlockKind): PairView {
  const base = {
    key: `${kind}-${kind}`,
    center: kind,
    target: kind,
    mode: 'self' as const,
    title: `${BLOCK_LABELS[kind]} · 自身`,
    subtitle: '同一个块类型之间的间距。'
  }
  if (kind === 'body') {
    return {
      ...base,
      groups: [
        {
          direction: 'self',
          title: '正文与正文',
          desc: '段间距管空行隔开的两段；行间距管同一段里的换行。',
          rows: [
            withNote(
              blockRow('bodyBetween'),
              'blank-only',
              '只在两段之间留了空行时生效；紧挨着的两行属于同一段。'
            ),
            lineRow()
          ]
        }
      ]
    }
  }
  if (kind === 'heading') {
    return {
      ...base,
      groups: [
        {
          direction: 'self',
          title: '标题与标题',
          desc: '只作用于两个紧挨着（中间没有空行）的标题；有空行时按标题上方 / 下方另算。',
          rows: [headingRow('between')]
        }
      ]
    }
  }
  if (kind === 'image') {
    return {
      ...base,
      groups: [],
      empty: '图片之间没有独立档位：沿用普通行距与空行。'
    }
  }
  const sides = BLOCK_SIDES[kind]
  return {
    ...base,
    groups: [
      {
        direction: 'self',
        title: `${BLOCK_LABELS[kind]}与${BLOCK_LABELS[kind]}`,
        rows: [blockRow(sides.before), blockRow(sides.after)]
      }
    ]
  }
}

/**
 * 圆环 + 配对面板要显示的内容。
 *
 * `mode === 'self'`(或 target 与 center 相同)走同类配对;没有选第二个块时返回
 * null —— 圆环只显示中心,面板不出现。
 */
export function pairView(
  center: BlockKind,
  target: BlockKind | null,
  mode: 'none' | 'self' | 'cross'
): PairView | null {
  if (mode === 'self' || (target !== null && target === center)) return selfView(center)
  if (!target) return null
  const ordered = [...[center, target]].sort(
    (a, b) => BLOCK_KINDS.indexOf(a) - BLOCK_KINDS.indexOf(b)
  ) as [BlockKind, BlockKind]
  return {
    key: `${ordered[0]}-${ordered[1]}`,
    center,
    target,
    mode: 'cross',
    title: `${BLOCK_LABELS[center]} ↔ ${BLOCK_LABELS[target]}`,
    subtitle: '两个方向分开调：谁在上，就由谁的留白管这一侧。',
    groups: crossGroups(center, target)
  }
}
