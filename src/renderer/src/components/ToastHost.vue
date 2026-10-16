<script setup lang="ts">
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-vue-next'
import { dismissNotice, noticeStore } from '../services/notice'

/**
 * 右下角通知的舞台。
 *
 * 它只负责画:谁、什么时候消失,全在 services/notice.ts 里定 ——
 * 那种"过 3 秒消失"的规则散在组件里,第二个能发通知的地方就会各写一遍。
 */
const ICON = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle
} as const
</script>

<template>
  <!-- 容器本身不吃鼠标事件,只有每条气泡自己吃 —— 否则右下角会有一块
       看不见的挡板,点不到底下的东西 -->
  <div class="toast-host">
    <div
      v-for="n in noticeStore.list"
      :key="n.id"
      class="toast"
      :class="`toast-${n.level}`"
      role="status"
    >
      <component :is="ICON[n.level]" :size="15" class="toast-icon" />
      <div class="toast-body">
        <div class="toast-title">{{ n.title }}</div>
        <div class="toast-message">{{ n.message }}</div>
      </div>
      <span v-if="n.count > 1" class="toast-count">×{{ n.count }}</span>
      <button class="toast-close" title="关闭" @click="dismissNotice(n.id)">
        <X :size="13" />
      </button>
    </div>
  </div>
</template>
