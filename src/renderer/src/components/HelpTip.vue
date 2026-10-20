<script setup lang="ts">
/**
 * 问号 + 说明浮层。
 *
 * 不用原生 `title`:它的字号由系统/Chromium 决定(本机弹出来接近正文字号,
 * 一两行说明会比字段本身还抢眼),也没法控制换行宽度。这里把提示 teleport
 * 到 body,字号按设置面板的密度来,还不会被设置面板的滚动容器裁掉。
 *
 * 提示只负责展示,不接收鼠标事件 —— 鼠标移出问号就收起,不会出现「浮层挡住
 * 指针导致自己关不掉」的问题。
 *
 * 根元素上的空 `title` 是刻意的:地址卡片本身用 `title` 解释边框颜色,原生提示
 * 会在悬停约一秒后冒出来盖住这里的浮层;最近一层 `title` 为空,浏览器就不再往
 * 上层找。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { CircleHelp } from 'lucide-vue-next'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{ text: string; size?: number }>(), { size: 13 })

const GAP = 6
const EDGE = 8
const MAX_WIDTH = 320

const anchor = ref<HTMLElement | null>(null)
const open = ref(false)
const pos = ref({ left: 0, top: 0, width: MAX_WIDTH, above: false })

const style = computed(() => ({
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
  maxWidth: `${pos.value.width}px`
}))

function place(): void {
  const el = anchor.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  // 浮层大约会占这么高:下方放不下就翻到问号上方
  const above = rect.bottom + 96 > window.innerHeight
  const width = Math.min(MAX_WIDTH, window.innerWidth - EDGE * 2)
  pos.value = {
    left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE)),
    top: above ? rect.top - GAP : rect.bottom + GAP,
    width,
    above
  }
}

function show(): void {
  place()
  open.value = true
  // 设置面板自己会滚动;滚起来浮层就失效,直接收起
  window.addEventListener('scroll', hide, true)
}

function hide(): void {
  open.value = false
  window.removeEventListener('scroll', hide, true)
}

onBeforeUnmount(hide)
</script>

<template>
  <span
    ref="anchor"
    class="plugin-field-help"
    v-bind="$attrs"
    title=""
    :aria-label="text"
    role="note"
    tabindex="0"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="show"
    @blur="hide"
  >
    <CircleHelp :size="size" />
  </span>
  <Teleport to="body">
    <div
      v-if="open"
      class="plugin-help-tip"
      :class="{ 'is-above': pos.above }"
      :style="style"
      role="tooltip"
    >
      {{ text }}
    </div>
  </Teleport>
</template>
