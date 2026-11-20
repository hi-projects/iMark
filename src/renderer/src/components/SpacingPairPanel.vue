<script setup lang="ts">
import {
  BLOCK_SPACE_MAX,
  BLOCK_SPACE_MIN,
  BLOCK_SPACE_STEP,
  HEADING_SPACE_MAX,
  HEADING_SPACE_MIN,
  HEADING_SPACE_STEP,
  IMAGE_SPACE_MAX,
  IMAGE_SPACE_MIN,
  IMAGE_SPACE_STEP,
  LINE_SPACE_MAX,
  LINE_SPACE_MIN,
  LINE_SPACE_STEP
} from '@shared/editorSettings'
import { appStore } from '../stores/app'
import {
  previewBlockSpace,
  previewHeadingSpace,
  previewImageSpace,
  previewLineSpace,
  setBlockSpace,
  setHeadingSpace,
  setImageSpace,
  setLineSpace
} from '../services/editorSettings'
import type { PairView, SpaceRow } from '../services/spacingPairs'

/**
 * 一条边界的方向组:只列「上块在上、下块在下」这一侧真正生效的字段。
 * 行上保留旧的 data-heading-space / data-block-space / data-image-space /
 * data-line-space 属性,验收 harness 不必依赖具体布局。
 */
const props = defineProps<{ pair: PairView }>()

function valueOf(row: SpaceRow): number {
  return appStore[row.field]
}

function readout(row: SpaceRow): string {
  const value = valueOf(row)
  return `${value.toFixed(1)} 档 · ${Math.round(value * appStore.editorFontSize)} px`
}

/** 滑块的区间跟着字段类型走(行间距 / 标题 / 块 / 图片目前相同,但别写死) */
function bounds(row: SpaceRow): [number, number, number] {
  switch (row.target.kind) {
    case 'heading':
      return [HEADING_SPACE_MIN, HEADING_SPACE_MAX, HEADING_SPACE_STEP]
    case 'block':
      return [BLOCK_SPACE_MIN, BLOCK_SPACE_MAX, BLOCK_SPACE_STEP]
    case 'image':
      return [IMAGE_SPACE_MIN, IMAGE_SPACE_MAX, IMAGE_SPACE_STEP]
    case 'line':
      return [LINE_SPACE_MIN, LINE_SPACE_MAX, LINE_SPACE_STEP]
  }
}

function dataAttrs(row: SpaceRow): Record<string, string> {
  switch (row.target.kind) {
    case 'heading':
      return { 'data-heading-space': row.target.side }
    case 'block':
      return { 'data-block-space': row.target.side }
    case 'image':
      return { 'data-image-space': row.target.side }
    case 'line':
      return { 'data-line-space': 'lineSpace' }
  }
}

function onInput(row: SpaceRow, e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  switch (row.target.kind) {
    case 'heading':
      previewHeadingSpace(row.target.side, value)
      break
    case 'block':
      previewBlockSpace(row.target.side, value)
      break
    case 'image':
      previewImageSpace(row.target.side, value)
      break
    case 'line':
      previewLineSpace(value)
      break
  }
}

function onCommit(row: SpaceRow, e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  switch (row.target.kind) {
    case 'heading':
      void setHeadingSpace(row.target.side, value)
      break
    case 'block':
      void setBlockSpace(row.target.side, value)
      break
    case 'image':
      void setImageSpace(row.target.side, value)
      break
    case 'line':
      void setLineSpace(value)
      break
  }
}

</script>

<template>
  <section
    class="spacing-pair-panel"
    :data-pair-panel="pair.key"
    :data-pair-top="pair.top"
    :data-pair-bottom="pair.bottom"
    :data-pair-mode="pair.mode"
  >
    <div v-if="pair.groups.length" class="spacing-pair-groups">
      <div
        v-for="group in pair.groups"
        :key="group.direction"
        class="spacing-pair-group"
        :data-pair-direction="group.direction"
      >
        <div
          v-for="row in group.rows"
          :key="row.field"
          class="settings-row spacing-pair-row"
          :data-space-field="row.field"
          :data-space-group="group.direction"
        >
          <div class="settings-row-info">
            <div class="settings-row-title">{{ row.label }}</div>
            <div v-if="row.desc" class="settings-row-desc">{{ row.desc }}</div>
            <div
              v-if="row.note"
              class="spacing-pair-note"
              :data-space-note="row.note.kind"
            >
              {{ row.note.text }}
            </div>
          </div>
          <div class="settings-control">
            <input
              v-bind="dataAttrs(row)"
              class="settings-range"
              type="range"
              :min="bounds(row)[0]"
              :max="bounds(row)[1]"
              :step="bounds(row)[2]"
              :value="valueOf(row)"
              @input="onInput(row, $event)"
              @change="onCommit(row, $event)"
            />
            <span class="settings-readout">{{ readout(row) }}</span>
          </div>
        </div>

        <div
          v-for="inert in group.inert ?? []"
          :key="inert.field"
          class="spacing-pair-inert"
          :data-space-inert="inert.field"
          :data-space-note="'inert'"
        >
          {{ inert.text }}
        </div>
      </div>
    </div>

    <div v-else class="spacing-pair-empty">{{ pair.empty }}</div>
  </section>
</template>
