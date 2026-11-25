<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SpacingRing from './SpacingRing.vue'
import SpacingPreview from './SpacingPreview.vue'
import SpacingPairPanel from './SpacingPairPanel.vue'
import { pairView, type BlockKind, type PairView } from '../services/spacingPairs'

/**
 * 「外观 → 样式」的两栏状态机。
 *
 *   top    —— 上面那个块(先点的)
 *   bottom —— 下面那个块(后点的)
 *   self   —— 同类配对(连点同一个块两次)
 *
 * 点击规则:
 *   · 空 → 设 top;
 *   · 只有 top:点同一块进 self,点另一块设 bottom;
 *   · self:再点同一块取消,点别的块重新以它为 top;
 *   · 已有两块的配对:点任一已选块取消,点新块重新以它为 top。
 */
const top = ref<BlockKind | null>(null)
const bottom = ref<BlockKind | null>(null)
const self = ref(false)

const pair = computed(() =>
  top.value ? pairView(top.value, bottom.value, self.value) : null
)

/** 把当前选中的边界交给设置页:面板下方的「恢复当前默认」要知道重置哪一条 */
const emit = defineEmits<{ selection: [pair: PairView | null] }>()
watch(pair, value => emit('selection', value), { immediate: true })

function clear(): void {
  top.value = null
  bottom.value = null
  self.value = false
}

function pick(kind: BlockKind): void {
  if (!top.value) {
    top.value = kind
    return
  }
  if (kind === top.value) {
    if (self.value) clear()
    else if (!bottom.value) self.value = true
    else clear()
    return
  }
  if (kind === bottom.value) {
    clear()
    return
  }
  if (self.value) {
    top.value = kind
    return
  }
  if (!bottom.value) {
    bottom.value = kind
    return
  }
  top.value = kind
  bottom.value = null
}

/** 互换上下:先点 / 后点反过来,滑块与预览跟着换到另一条边界 */
function swap(): void {
  if (!top.value || !bottom.value) return
  const previousTop = top.value
  top.value = bottom.value
  bottom.value = previousTop
}
</script>

<template>
  <div class="settings-card settings-card-ring">
    <div class="spacing-settings">
      <SpacingRing
        :top="top"
        :bottom="bottom"
        :self="self"
        @pick="pick"
        @swap="swap"
        @clear="clear"
      />
      <div class="spacing-side">
        <SpacingPreview :top="top" :bottom="bottom" :self="self" :pair="pair" />
      </div>
    </div>

    <div v-if="pair" class="spacing-pair-section">
      <SpacingPairPanel :pair="pair" />
    </div>
  </div>
</template>
