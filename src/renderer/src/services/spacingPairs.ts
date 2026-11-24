/**
 * 「外观 → 间距」圆环的纯数据模型。
 *
 * 间距的唯一来源是**有序配对** `<上块>-<下块>`(共 9 × 9 条),例如
 * `body-heading`(正文在上、标题在下)、`heading-body`(反过来)。
 * 圆环选一对块,面板只给这一条边界的一根滑块;预览画的就是这条边界。
 *
 * 这里不碰 Vue,也不碰 DOM;真正的渲染在 rules.ts(配对类)与 editor.css
 * (配对规则 + padding-top)里。
 */
import { BLOCK_KINDS, PAIR_SPACE_DEFAULT, type BlockKind } from '@shared/editorSettings'

export { BLOCK_KINDS }
export type { BlockKind }

export const BLOCK_LABELS: Record<BlockKind, string> = {
  body: '正文',
  heading: '标题',
  code: '代码块',
  list: '列表',
  quote: '引用',
  image: '图片',
  table: '表格',
  math: '公式',
  mermaid: '图表'
}

export function pairKey(top: BlockKind, bottom: BlockKind): string {
  return `${top}-${bottom}`
}

/** 配对间距(档):没设置过的配对按 1 档 */
export function pairGapOf(gaps: Record<string, number>, top: BlockKind, bottom: BlockKind): number {
  return gaps[pairKey(top, bottom)] ?? PAIR_SPACE_DEFAULT
}

export interface SpaceRow {
  /** 配对 key(`body-heading`)或 `lineSpace` */
  field: string
  target: { kind: 'pair'; key: string } | { kind: 'line' }
  label: string
  desc?: string
}

export interface SpaceGroup {
  /** 验收用:方向名,如 `body-above`、`self` */
  direction: string
  title: string
  desc?: string
  rows: SpaceRow[]
}

export interface PairView {
  /** 按 BLOCK_KINDS 顺序拼的稳定 key,与先后顺序无关 */
  key: string
  /** 上面那个块(先点的) */
  top: BlockKind
  /** 下面那个块(后点的);同类配对时与 top 相同 */
  bottom: BlockKind
  mode: 'self' | 'cross'
  groups: SpaceGroup[]
}

function pairRow(top: BlockKind, bottom: BlockKind): SpaceRow {
  const topLabel = BLOCK_LABELS[top]
  const bottomLabel = BLOCK_LABELS[bottom]
  return {
    field: pairKey(top, bottom),
    target: { kind: 'pair', key: pairKey(top, bottom) },
    // 两块配对统一叫「xx 与 yy」；方向放在说明里,标题不再写「在上 / 在下」。
    label: `${topLabel}与${bottomLabel}`,
    desc:
      top === bottom
        ? `两个${topLabel}之间的留白(结构空行不占高度,间距由下面那一个承担)。`
        : `${topLabel}与${bottomLabel}间距离，其中${topLabel}在上，${bottomLabel}在下`
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

function selfView(kind: BlockKind): PairView {
  const base = {
    key: pairKey(kind, kind),
    top: kind,
    bottom: kind,
    mode: 'self' as const
  }
  if (kind === 'body') {
    // 正文自身这一组就是用户口中的「段间距」。两行说明保持一句话:
    // 段与段之间(空行隔开)看第一根,同一段里的换行看第二根。
    return {
      ...base,
      groups: [
        {
          direction: 'self',
          title: '段间距',
          rows: [
            { ...pairRow('body', 'body'), label: '段间距', desc: '段落间距离' },
            {
              ...lineRow(),
              desc: '行（段内换行/软换行）间距离'
            }
          ]
        }
      ]
    }
  }
  return {
    ...base,
    groups: [
      {
        direction: 'self',
        title: `${BLOCK_LABELS[kind]}与${BLOCK_LABELS[kind]}`,
        rows: [pairRow(kind, kind)]
      }
    ]
  }
}

/**
 * 左侧块 + 右侧预览 / 滑块要显示的内容。
 *
 * 配对是有方向的:先点的 `top` 在上面,后点的 `bottom` 在下面。
 * 面板只给这一条边界真正生效的那一档;要看反方向,用预览里的「互换」按钮。
 */
export function pairView(
  top: BlockKind,
  bottom: BlockKind | null,
  self: boolean
): PairView | null {
  if (self) return selfView(top)
  if (!bottom || bottom === top) return null
  const ordered = [...[top, bottom]].sort(
    (a, b) => BLOCK_KINDS.indexOf(a) - BLOCK_KINDS.indexOf(b)
  ) as [BlockKind, BlockKind]
  const groups: SpaceGroup[] = [
    {
      direction: `${top}-above`,
      title: `${BLOCK_LABELS[top]}在上`,
      rows: [pairRow(top, bottom)]
    },
    {
      direction: `${bottom}-above`,
      title: `${BLOCK_LABELS[bottom]}在上`,
      rows: [pairRow(bottom, top)]
    }
  ]
  const active = groups.find(g => g.direction === `${top}-above`)
  return {
    key: pairKey(ordered[0], ordered[1]),
    top,
    bottom,
    mode: 'cross',
    groups: active ? [active] : groups.slice(0, 1)
  }
}
