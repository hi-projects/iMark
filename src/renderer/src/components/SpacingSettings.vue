<script setup lang="ts">
import { computed, ref } from 'vue'
import SpacingRing from './SpacingRing.vue'
import SpacingPairPanel from './SpacingPairPanel.vue'
import { BLOCK_LABELS, pairView, type BlockKind } from '../services/spacingPairs'

/**
 * 「外观 → 样式」的圆环状态机。
 *
 *   center  —— 被放到中间的那个块;null = 还没选
 *   target  —— 圆环上第二个块;null = 还没选配对
 *   mode    —— none(只选了中心) / self(同类) / cross(两块)
 *
 * 这里只管选择,具体间距字段由 spacingPairs 的 pairView 编目。
 */
const center = ref<BlockKind | null>(null)
const target = ref<BlockKind | null>(null)
const mode = ref<'none' | 'self' | 'cross'>('none')

const pair = computed(() =>
  center.value ? pairView(center.value, target.value, mode.value) : null
)

function pick(kind: BlockKind): void {
  if (!center.value) {
    center.value = kind
    target.value = null
    mode.value = 'none'
    return
  }
  if (center.value === kind) {
    // 点中心:有配对先清配对,再点一次退出中心
    if (mode.value !== 'none' || target.value) {
      target.value = null
      mode.value = 'none'
    } else {
      center.value = null
    }
    return
  }
  target.value = kind
  mode.value = 'cross'
}

function toggleSelf(): void {
  if (!center.value) return
  if (mode.value === 'self') {
    target.value = null
    mode.value = 'none'
  } else {
    target.value = center.value
    mode.value = 'self'
  }
}

/**
 * 换中心。双击外圈块或点面板里的「以 X 为中心」都走这里:
 * 如果换的正是当前配对里的另一块,就顺手把两个块对调,配对关系不丢。
 */
function recenter(kind: BlockKind): void {
  const previous = center.value
  if (previous && mode.value === 'cross' && target.value === kind) {
    center.value = kind
    target.value = previous
    return
  }
  center.value = kind
  if (mode.value === 'self') {
    target.value = kind
    return
  }
  if (target.value === kind) {
    target.value = null
    mode.value = 'none'
  } else if (!target.value) {
    mode.value = 'none'
  }
}
</script>

<template>
  <div class="spacing-settings">
    <SpacingRing
      :center="center"
      :target="target"
      :mode="mode"
      @pick="pick"
      @self="toggleSelf"
      @recenter="recenter"
    />
    <SpacingPairPanel v-if="pair" :pair="pair" @recenter="recenter" />
    <div v-else-if="center" class="spacing-settings-idle" role="status">
      点圆环外圈的块，调它和「{{ BLOCK_LABELS[center] }}」之间的距离。
    </div>
  </div>
</template>
