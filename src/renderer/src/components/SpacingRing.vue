<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowUpDown,
  Code2,
  Heading1,
  Image as ImageIcon,
  List,
  Quote,
  Sigma,
  Table2,
  Type,
  Workflow,
  X
} from 'lucide-vue-next'
import { BLOCK_LABELS, type BlockKind } from '../services/spacingPairs'

/**
 * 圆圈在网格里的显示顺序(3 × 3):
 *   正文 / 标题 / 表格
 *   列表 / 引用 / 图片
 *   代码块 / 公式 / 图表
 * 只影响摆放位置,配对 key、已保存的间距都按块名走,不受它影响。
 */
const RING_ORDER: BlockKind[] = [
  'body',
  'heading',
  'table',
  'list',
  'quote',
  'image',
  'code',
  'math',
  'mermaid'
]

/**
 * 左栏的块调色板:九个圆圈排成网格。
 *
 *   · 第一次点 = 上面那个块;
 *   · 再点另一个块 = 下面那个块;
 *   · 连点同一个块两次 = 调同类块之间的间距。
 *
 * 选中状态交给父组件,这里只画颜色和转发点击(上 / 下用两种颜色区分)。
 */
const props = defineProps<{
  top: BlockKind | null
  bottom: BlockKind | null
  self: boolean
}>()

const emit = defineEmits<{
  pick: [kind: BlockKind]
  swap: []
  clear: []
}>()

const ICONS = {
  body: Type,
  heading: Heading1,
  code: Code2,
  list: List,
  quote: Quote,
  image: ImageIcon,
  table: Table2,
  math: Sigma,
  mermaid: Workflow
} as const

/** 圆环里用更短的叫法(配对面板 / 说明里仍写「代码块」) */
const RING_LABELS: Partial<Record<BlockKind, string>> = { code: '代码' }

function ringLabel(kind: BlockKind): string {
  return RING_LABELS[kind] ?? BLOCK_LABELS[kind]
}

function roleOf(kind: BlockKind): 'top' | 'bottom' | 'none' {
  if (props.top === kind) return 'top'
  if (props.bottom === kind) return 'bottom'
  return 'none'
}

const ringState = computed(() => {
  if (!props.top) return 'empty'
  if (props.self) return 'self'
  if (props.bottom) return 'pair'
  return 'top'
})

const hint = computed(() => {
  if (!props.top) return '先点一个块，作为上面的内容'
  if (props.self) return `正在调「${BLOCK_LABELS[props.top]}」与自身；再点一次取消`
  if (props.bottom) {
    return `上：「${BLOCK_LABELS[props.top]}」 下：「${BLOCK_LABELS[props.bottom]}」；点已选中的块取消`
  }
  return `再点一个块作为下面的内容；连点「${BLOCK_LABELS[props.top]}」调同类间距`
})
</script>

<template>
  <div class="spacing-palette" data-spacing-ring :data-ring-state="ringState">
    <div class="spacing-palette-grid">
      <button
        v-for="kind in RING_ORDER"
        :key="kind"
        class="spacing-ring-node"
        :class="{
          'is-top': roleOf(kind) === 'top',
          'is-bottom': roleOf(kind) === 'bottom',
          'is-self': self && top === kind
        }"
        :data-block-node="kind"
        :data-block-role="roleOf(kind)"
        :aria-pressed="roleOf(kind) !== 'none'"
        :title="ringLabel(kind)"
        type="button"
        @click="emit('pick', kind)"
      >
        <component :is="ICONS[kind]" :size="18" />
        <span class="spacing-ring-label">{{ ringLabel(kind) }}</span>
      </button>
    </div>

    <div v-if="top" class="spacing-palette-actions">
      <button
        class="spacing-action"
        data-ring-swap
        type="button"
        :disabled="!bottom || self"
        :title="
          self
            ? '同类块之间无需交换上下'
            : !bottom
              ? '再点一个块作为下面的内容'
              : '交换上下'
        "
        @click="emit('swap')"
      >
        <ArrowUpDown :size="13" />
        <span>交换上下</span>
      </button>
      <button
        class="spacing-action"
        data-ring-clear
        type="button"
        @click="emit('clear')"
      >
        <X :size="13" />
        <span>清除</span>
      </button>
    </div>

    <div class="spacing-ring-hint" role="status" aria-live="polite">{{ hint }}</div>
  </div>
</template>
