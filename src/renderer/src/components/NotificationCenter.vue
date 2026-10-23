<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { AlertTriangle, Bell, CheckCircle2, Info, XCircle } from 'lucide-vue-next'
import {
  clearNotices,
  closeNoticeCenter,
  noticeCenter,
  noticeHistory,
  type NoticeRecord
} from '../services/notice'

/**
 * 状态栏铃铛弹出的小框。
 *
 * 它只画历史;什么时候记、什么时候算已读,全在 services/notice.ts 里 ——
 * 和气泡共用一套来源与等级,避免出现"气泡里是红的、列表里却是灰的"。
 */
const ICON = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle
} as const

const SOURCE_LABEL: Record<NoticeRecord['source'], string> = {
  app: '应用',
  plugin: '扩展',
  browser: '浏览器'
}

const panel = ref<HTMLElement | null>(null)

/** 今天只显示时分,更早的带上月/日 —— 会话内也可能跨过午夜 */
function clock(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString('zh-CN', { hour12: false })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

/**
 * 点小框外面就收起来。
 *
 * 用 `pointerdown` 而不是 click:拖动、选字时也会把面板收走,符合"点外面"的直觉。
 * 铃铛自己带 `data-notify-toggle`,否则一次点击会先被这里关掉、再被按钮打开 ——
 * 看起来像点不动。
 */
function onPointerDown(event: PointerEvent): void {
  if (!noticeCenter.open) return
  const target = event.target as Element | null
  if (!target) return
  if (panel.value?.contains(target)) return
  if (target.closest('[data-notify-toggle]')) return
  closeNoticeCenter()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && noticeCenter.open) closeNoticeCenter()
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div
    v-if="noticeCenter.open"
    ref="panel"
    class="notif-panel"
    role="dialog"
    aria-label="通知"
  >
    <div class="notif-head">
      <span class="notif-head-title"><Bell :size="13" /> 通知</span>
      <button
        v-if="noticeHistory.list.length"
        class="notif-clear"
        title="清空通知历史"
        @click="clearNotices()"
      >
        清空
      </button>
    </div>
    <div v-if="!noticeHistory.list.length" class="notif-empty">暂无通知</div>
    <div v-else class="notif-list">
      <div
        v-for="item in noticeHistory.list"
        :key="item.id"
        class="notif-item"
        :class="`notif-${item.level}`"
      >
        <component :is="ICON[item.level]" :size="14" class="notif-icon" />
        <div class="notif-body">
          <div class="notif-meta">
            <span v-if="item.source !== 'app'" class="notif-source">
              {{ SOURCE_LABEL[item.source] }}
            </span>
            <span class="notif-name" :title="item.title">{{ item.title }}</span>
            <time class="notif-time">{{ clock(item.at) }}</time>
          </div>
          <div v-if="item.message" class="notif-message">{{ item.message }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
