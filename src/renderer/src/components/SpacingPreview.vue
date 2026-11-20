<script setup lang="ts">
import { computed } from 'vue'
import { appStore } from '../stores/app'
import { type BlockKind, type PairView, type SpaceRow } from '../services/spacingPairs'
import SpacingSample from './SpacingSample.vue'

/**
 * 右栏的文档预览:上块 / 间距 / 下块,按编辑器里的字体和字号实际排出来,
 * 让用户直接看到这条边界长什么样。数值在下方滑块读数里,这里不再重复标。
 */
const props = defineProps<{
  top: BlockKind | null
  bottom: BlockKind | null
  self: boolean
  pair: PairView | null
}>()

const mode = computed(() => {
  if (!props.top) return 'empty'
  if (props.self) return 'self'
  if (props.bottom) return 'pair'
  return 'top'
})

const topKind = computed<BlockKind>(() => props.top ?? 'body')
const lowerKind = computed<BlockKind>(() => props.bottom ?? props.top ?? 'body')

/** 这一条边界真正参与的行(行间距在同一段内部,不画成块间的缝) */
const boundaryRows = computed<SpaceRow[]>(() => {
  const rows = props.pair?.groups[0]?.rows ?? []
  return rows.filter(row => row.target.kind !== 'line')
})

function pxOf(row: SpaceRow): number {
  return Math.round(appStore[row.field] * appStore.editorFontSize)
}

/** 预览里最多留 160px,避免极端档位把卡片撑得太高 */
function clampGap(px: number): number {
  return Math.min(160, Math.max(0, px))
}

/**
 * 标题与正文 / 块之间那条空行在编辑器里是**整行高**(见 editor.css 的
 * cm-md-h-space-before):空行本身不会被压成块间距。预览要还原文档的实际观感,
 * 就得把这一行也算进去 —— 否则预览总比正文里看到的窄一截。
 *
 * 只有两种边界会留下整行空行:
 *   · 下面一块是标题(标题前那条空行不压缩);
 *   · 上面是标题、下面是正文(正文前的空行也不压缩)。
 * 其它块的邻居会把空行压到自己的档位(见 max() 规则),不加整行。
 */
const blankLine = computed(() =>
  Math.round((1 + appStore.lineSpace) * appStore.editorFontSize)
)

const includeBlankLine = computed(() => {
  if (mode.value !== 'pair') return false
  if (lowerKind.value === 'heading') return true
  return lowerKind.value === 'body' && topKind.value === 'heading'
})

const pairGap = computed(() =>
  clampGap(
    boundaryRows.value.reduce((sum, row) => sum + pxOf(row), 0) +
      (includeBlankLine.value ? blankLine.value : 0)
  )
)

/** 同类配对里「两块之间」的那一档:正文看段间距,标题看标题之间 */
const selfPairGap = computed<number | null>(() => {
  if (!props.self) return null
  const rows = props.pair?.groups[0]?.rows ?? []
  if (topKind.value === 'body') {
    const row = rows.find(r => r.field === 'bodySpaceBetween')
    return clampGap(row ? pxOf(row) : 0)
  }
  if (topKind.value === 'heading') {
    const row = rows.find(r => r.field === 'headingSpaceBetween')
    return clampGap(row ? pxOf(row) : 0)
  }
  return null
})

/** 代码块 / 列表 / 引用 / 表格自身:上档、下档分别画在样本外侧 */
const selfBefore = computed(() => {
  const row = boundaryRows.value[0]
  return row ? clampGap(pxOf(row)) : 0
})

const selfAfter = computed(() => {
  const row = boundaryRows.value[1]
  return row ? clampGap(pxOf(row)) : 0
})
</script>

<template>
  <section
    class="spacing-preview"
    data-spacing-preview
    :data-preview-mode="mode"
    :data-preview-top="top ?? ''"
    :data-preview-bottom="bottom ?? ''"
  >
    <div class="spacing-preview-doc" data-preview-doc>
      <div v-if="mode === 'empty'" class="spacing-preview-placeholder">点左边的块开始</div>

      <template v-else-if="mode === 'pair'">
        <SpacingSample :kind="topKind" />
        <div class="spacing-doc-gap" data-preview-gap :style="{ height: `${pairGap}px` }"></div>
        <SpacingSample :kind="lowerKind" />
      </template>

      <template v-else-if="mode === 'self' && selfPairGap !== null">
        <SpacingSample :kind="topKind" />
        <div class="spacing-doc-gap" data-preview-gap :style="{ height: `${selfPairGap}px` }"></div>
        <SpacingSample :kind="topKind" />
      </template>

      <template v-else-if="mode === 'self'">
        <SpacingSample
          :kind="topKind"
          :style="{ marginTop: `${selfBefore}px`, marginBottom: `${selfAfter}px` }"
        />
      </template>

      <template v-else>
        <SpacingSample :kind="topKind" />
        <div class="spacing-doc-ghost">再点一个块作为下面</div>
      </template>
    </div>
  </section>
</template>
