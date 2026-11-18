<script setup lang="ts">
import { computed } from 'vue'
import { Code2, Heading1, Image as ImageIcon, List, Quote, Table2, Type } from 'lucide-vue-next'
import { BLOCK_KINDS, BLOCK_LABELS, type BlockKind } from '../services/spacingPairs'

/**
 * 间距圆环:空状态七个块围一圈;点一个块 → 它到中心,其余环绕;再点一个块 →
 * 两个块配对。圆环只负责"选谁",具体滑块在 SpacingPairPanel 里。
 */
const props = defineProps<{
  center: BlockKind | null
  target: BlockKind | null
  mode: 'none' | 'self' | 'cross'
}>()

const emit = defineEmits<{
  pick: [kind: BlockKind]
  self: []
  recenter: [kind: BlockKind]
}>()

const ICONS = {
  body: Type,
  heading: Heading1,
  code: Code2,
  list: List,
  quote: Quote,
  image: ImageIcon,
  table: Table2
} as const

/** 外圈节点离画布中心的距离(画布宽度的百分比) */
const NODE_RADIUS = 38

interface NodePos {
  x: number
  y: number
}

const positions = computed<Map<BlockKind, NodePos>>(() => {
  const map = new Map<BlockKind, NodePos>()
  const ring = props.center ? BLOCK_KINDS.filter(k => k !== props.center) : BLOCK_KINDS
  if (props.center) map.set(props.center, { x: 50, y: 50 })
  ring.forEach((kind, i) => {
    // 从正上方开始顺时针排,七个块时也不会有一个落在正下方被提示文字挡住
    const angle = ((-90 + (360 / ring.length) * i) * Math.PI) / 180
    map.set(kind, {
      x: 50 + NODE_RADIUS * Math.cos(angle),
      y: 50 + NODE_RADIUS * Math.sin(angle)
    })
  })
  return map
})

const ringState = computed(() => {
  if (!props.center) return 'empty'
  if (props.mode === 'self') return 'self'
  if (props.mode === 'cross' && props.target) return 'cross'
  return 'centered'
})

const hint = computed(() => {
  if (!props.center) return '点一个块，把它放到中心'
  if (props.mode === 'self') {
    return `正在调「${BLOCK_LABELS[props.center]}」与自身；再点一次「自身」退出`
  }
  if (props.mode === 'cross' && props.target) {
    return `已选「${BLOCK_LABELS[props.center]}」与「${BLOCK_LABELS[props.target]}」；点中心可清除配对`
  }
  return `再点一个块，调它和「${BLOCK_LABELS[props.center]}」之间的距离`
})

function isCenter(kind: BlockKind): boolean {
  return props.center === kind
}

function isPair(kind: BlockKind): boolean {
  return props.mode === 'cross' && props.target === kind
}

function styleFor(kind: BlockKind): Record<string, string> {
  const pos = positions.value.get(kind)
  return pos ? { left: `${pos.x}%`, top: `${pos.y}%` } : {}
}

/**
 * 单击立即选中;双击留给"换中心"。
 *
 * 第二次 click 的 detail 是 2,先吞掉,免得它把刚选中的配对又清掉 ——
 * 这样单击不用等双击判定,手感不拖。
 */
function onPick(kind: BlockKind, e: MouseEvent): void {
  if (e.detail > 1) return
  emit('pick', kind)
}

function onDblClick(kind: BlockKind): void {
  if (!isCenter(kind)) emit('recenter', kind)
}
</script>

<template>
  <div class="spacing-ring" data-spacing-ring :data-ring-state="ringState">
    <div class="spacing-ring-canvas">
      <button
        v-for="kind in BLOCK_KINDS"
        :key="kind"
        class="spacing-ring-node"
        :class="{ 'is-center': isCenter(kind), 'is-pair': isPair(kind) }"
        :style="styleFor(kind)"
        :data-block-node="kind"
        :data-block-role="isCenter(kind) ? 'center' : 'ring'"
        :aria-pressed="isCenter(kind) || isPair(kind)"
        :title="BLOCK_LABELS[kind]"
        type="button"
        @click="onPick(kind, $event)"
        @dblclick="onDblClick(kind)"
      >
        <component :is="ICONS[kind]" :size="isCenter(kind) ? 22 : 18" />
        <span class="spacing-ring-label">{{ BLOCK_LABELS[kind] }}</span>
      </button>

      <button
        v-if="center"
        class="spacing-ring-self"
        :class="{ 'is-active': mode === 'self' }"
        :data-block-self="center"
        :aria-pressed="mode === 'self'"
        type="button"
        title="调同类块之间的间距"
        @click="emit('self')"
      >
        自身
      </button>
    </div>
    <div class="spacing-ring-hint" role="status" aria-live="polite">{{ hint }}</div>
  </div>
</template>
