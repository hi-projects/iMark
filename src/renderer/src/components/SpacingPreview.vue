<script setup lang="ts">
import { computed } from 'vue'
import { appStore } from '../stores/app'
import { pairGapOf, pairView, type BlockKind, type PairView } from '../services/spacingPairs'
import SpacingSample from './SpacingSample.vue'

/**
 * 右栏的文档预览:上块 / 间距 / 下块,按编辑器里的字体和字号实际排出来。
 *
 * 间距就是这条边界的有序配对值(`<上块>-<下块>`),与编辑器里下方块首行的
 * padding-top 是同一个数;结构空行本身不占高度,所以预览里只看这条缝。
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

/** 预览里最多留 160px,避免极端档位把卡片撑得太高 */
function clampGap(px: number): number {
  return Math.min(160, Math.max(0, px))
}

/** 当前这条边界的配对键(同类配对时 key 为 `<kind>-<kind>`) */
const pairKeyNow = computed(() =>
  props.top ? pairView(props.top, props.bottom, props.self)?.key ?? '' : ''
)

/** 配对间距(px):预览里两个样本之间的距离 */
const gapPx = computed(() => {
  const key = pairKeyNow.value
  if (!key) return 0
  const [a, b] = key.split('-') as [BlockKind, BlockKind]
  return clampGap(pairGapOf(appStore.pairGaps, a, b) * appStore.editorFontSize)
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
        <div class="spacing-doc-gap" data-preview-gap :style="{ height: `${gapPx}px` }"></div>
        <SpacingSample :kind="lowerKind" />
      </template>

      <template v-else-if="mode === 'self'">
        <!-- 上块画两行(同一段里的段内换行),看行间距;下面一块看配对间距 -->
        <SpacingSample :kind="topKind" :lines="topKind === 'body' ? 2 : 1" />
        <div class="spacing-doc-gap" data-preview-gap :style="{ height: `${gapPx}px` }"></div>
        <SpacingSample :kind="topKind" />
      </template>

      <template v-else>
        <SpacingSample :kind="topKind" />
        <div class="spacing-doc-ghost">再点一个块作为下面</div>
      </template>
    </div>
  </section>
</template>
