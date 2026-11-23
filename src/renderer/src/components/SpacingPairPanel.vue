<script setup lang="ts">
import {
  LINE_SPACE_MAX,
  LINE_SPACE_MIN,
  LINE_SPACE_STEP,
  PAIR_SPACE_DEFAULT,
  PAIR_SPACE_MAX,
  PAIR_SPACE_MIN,
  PAIR_SPACE_STEP
} from '@shared/editorSettings'
import { appStore } from '../stores/app'
import {
  previewLineSpace,
  previewPairGap,
  setLineSpace,
  setPairGap
} from '../services/editorSettings'
import type { PairView, SpaceRow } from '../services/spacingPairs'

/**
 * 一条边界的方向组:只列「上块在上、下块在下」这一侧真正生效的字段。
 * 配对间距是唯一来源,每个方向一根滑块;行间距只在「正文 · 自身」里出现。
 */
const props = defineProps<{ pair: PairView }>()

function valueOf(row: SpaceRow): number {
  if (row.target.kind === 'pair') return appStore.pairGaps[row.target.key] ?? PAIR_SPACE_DEFAULT
  return appStore.lineSpace
}

function readout(row: SpaceRow): string {
  const value = valueOf(row)
  return `${value.toFixed(1)} 档 · ${Math.round(value * appStore.editorFontSize)} px`
}

function bounds(row: SpaceRow): [number, number, number] {
  return row.target.kind === 'pair'
    ? [PAIR_SPACE_MIN, PAIR_SPACE_MAX, PAIR_SPACE_STEP]
    : [LINE_SPACE_MIN, LINE_SPACE_MAX, LINE_SPACE_STEP]
}

function dataAttrs(row: SpaceRow): Record<string, string> {
  return row.target.kind === 'pair'
    ? { 'data-pair-space': row.target.key }
    : { 'data-line-space': 'lineSpace' }
}

function onInput(row: SpaceRow, e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (row.target.kind === 'pair') previewPairGap(row.target.key, value)
  else previewLineSpace(value)
}

function onCommit(row: SpaceRow, e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (row.target.kind === 'pair') void setPairGap(row.target.key, value)
  else void setLineSpace(value)
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
    <div class="spacing-pair-groups">
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
      </div>
    </div>
  </section>
</template>
