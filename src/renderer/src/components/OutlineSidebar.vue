<script setup lang="ts">
import { computed, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import { activeTab, appStore, editorHolder, type OutlineItem } from '../stores/app'
import { jumpToHeading } from '../editor/outline'

const outline = computed(() => activeTab()?.outline ?? [])
const itemEls = new Map<number, HTMLElement>()

function setItemRef(from: number, el: unknown): void {
  if (el) itemEls.set(from, el as HTMLElement)
  else itemEls.delete(from)
}

// 视口滚动导致激活项变化时,让侧栏列表跟随
watch(
  () => appStore.outlineActive,
  pos => {
    if (pos == null) return
    itemEls.get(pos)?.scrollIntoView({ block: 'nearest' })
  }
)

function jump(item: OutlineItem): void {
  const view = editorHolder.view
  if (!view) return
  jumpToHeading(view as EditorView, item)
}

function indent(level: number): string {
  return `${14 + (level - 1) * 14}px`
}
</script>

<template>
  <aside v-show="appStore.outlineVisible" class="outline-sidebar">
    <div class="outline-header">大纲</div>
    <div class="outline-list">
      <div
        v-for="item in outline"
        :key="item.from"
        :ref="el => setItemRef(item.from, el)"
        class="outline-item"
        :class="['outline-h' + item.level, { 'outline-active': item.from === appStore.outlineActive }]"
        :style="{ paddingLeft: indent(item.level) }"
        :title="item.text"
        @click="jump(item)"
      >
        {{ item.text }}
      </div>
      <div v-if="outline.length === 0" class="outline-empty">暂无标题,使用 # 创建标题后显示大纲</div>
    </div>
  </aside>
</template>
