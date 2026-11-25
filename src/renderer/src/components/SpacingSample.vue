<script setup lang="ts">
import { computed } from 'vue'
import { Image as ImageIcon, Workflow } from 'lucide-vue-next'
import type { BlockKind } from '../services/spacingPairs'

/**
 * 右栏预览里的一块「文档样本」:按块类型画一段真实的排版效果。
 * 颜色 / 字体都走主题令牌,字号跟着 --editor-body-size 缩放。
 *
 * lines / texts 只对正文样本有意义:lines 是行数(同一段里的换行),
 * 默认 1 行「正文内容。」;texts 可以逐行指定文字,「正文自身」预览用
 * 它标出「第一段第一行 / 第一段第二行 / 第二段」,让人一眼看出哪两行
 * 属同一段、哪一行是下一段。
 */
const props = withDefaults(
  defineProps<{ kind: BlockKind; lines?: number; texts?: string[] }>(),
  { lines: 1 }
)

const bodyLines = computed<string[]>(() =>
  props.texts?.length ? props.texts : Array.from({ length: props.lines }, () => '正文内容。')
)
</script>

<template>
  <div class="spacing-doc-sample" :class="`is-${kind}`" :data-sample="kind">
    <div v-if="kind === 'body'" class="spacing-doc-body">
      <div v-for="(text, i) in bodyLines" :key="i">{{ text }}</div>
    </div>
    <div v-else-if="kind === 'heading'" class="spacing-doc-heading">标题</div>
    <pre v-else-if="kind === 'code'" class="spacing-doc-code">const x = 1</pre>
    <div v-else-if="kind === 'list'" class="spacing-doc-list">
      <div>• 第一项</div>
      <div>• 第二项</div>
    </div>
    <div v-else-if="kind === 'quote'" class="spacing-doc-quote">
      <div>引用第一行</div>
      <div>引用第二行</div>
    </div>
    <div v-else-if="kind === 'image'" class="spacing-doc-image">
      <ImageIcon :size="22" />
      <span>图片</span>
    </div>
    <div v-else-if="kind === 'math'" class="spacing-doc-math">E = mc²</div>
    <div v-else-if="kind === 'mermaid'" class="spacing-doc-mermaid">
      <Workflow :size="20" />
      <span>图表</span>
    </div>
    <div v-else class="spacing-doc-table">
      <span>列甲</span>
      <span>列乙</span>
      <span>1</span>
      <span>2</span>
    </div>
  </div>
</template>
