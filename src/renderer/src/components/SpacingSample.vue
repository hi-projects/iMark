<script setup lang="ts">
import { Image as ImageIcon, Workflow } from 'lucide-vue-next'
import type { BlockKind } from '../services/spacingPairs'

/**
 * 右栏预览里的一块「文档样本」:按块类型画一段真实的排版效果。
 * 颜色 / 字体都走主题令牌,字号跟着 --editor-body-size 缩放。
 *
 * lines 只对正文样本有意义:画几行「正文内容。」(同一段里的换行),
 * 用来预览行间距;默认 1 行。
 */
withDefaults(defineProps<{ kind: BlockKind; lines?: number }>(), { lines: 1 })
</script>

<template>
  <div class="spacing-doc-sample" :class="`is-${kind}`" :data-sample="kind">
    <div v-if="kind === 'body'" class="spacing-doc-body">
      <div v-for="i in lines" :key="i">正文内容。</div>
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
