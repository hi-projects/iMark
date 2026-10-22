<script setup lang="ts">
/**
 * 左右侧栏之间的拖动分界线。
 *
 * 视觉上是一条 1px 的边线,但命中区域向两侧各扩
 * 4px,鼠标不必精确压在那 1px 上。拖动过程直接改 appStore 里的宽度,松手才落盘。
 *
 * `side` 指的是**这条线左边是谁**:explorer 向左拖变小、向右拖变大;
 * outline 在右边,方向相反。
 */
import { onBeforeUnmount, ref } from 'vue'
import { appStore } from '../stores/app'
import { api } from '../services/api'

const props = defineProps<{ side: 'explorer' | 'outline' }>()

/**
 * 侧栏最小宽度:再窄,顶部的按钮/标题就会被裁掉。
 * 大纲更宽,是因为它的标题栏要给右上角窗口控件让出 150px
 * (见 OutlineSidebar 的 .outline-header 与 main/window.ts 的 titleBarOverlay)。
 */
const MIN_WIDTH = { explorer: 160, outline: 200 } as const
/** 正文区最小宽度:两个侧栏都拖到极限时,编辑器仍要能放下一行字 */
const EDITOR_MIN_WIDTH = 320
const DEFAULT_WIDTH = 240

function minWidth(): number {
  return MIN_WIDTH[props.side]
}

const dragging = ref(false)
const rootEl = ref<HTMLElement | null>(null)

let startX = 0
let startWidth = 0
let pointerId: number | null = null

function currentWidth(): number {
  return props.side === 'explorer' ? appStore.explorerWidth : appStore.outlineWidth
}

function applyWidth(width: number): void {
  if (props.side === 'explorer') appStore.explorerWidth = width
  else appStore.outlineWidth = width
}

/** 最大宽度:给正文和另一侧栏留够位置 */
function maxWidth(): number {
  const body = document.querySelector('.app-body') as HTMLElement | null
  const total = body?.clientWidth ?? window.innerWidth
  const otherVisible = props.side === 'explorer' ? appStore.outlineVisible : appStore.explorerVisible
  const otherWidth = props.side === 'explorer' ? appStore.outlineWidth : appStore.explorerWidth
  const otherMin = props.side === 'explorer' ? MIN_WIDTH.outline : MIN_WIDTH.explorer
  const otherSpace = otherVisible ? Math.max(otherWidth, otherMin) + 1 : 0
  // 末尾的 1px 是当前这条分界线自己
  return Math.max(minWidth(), total - EDITOR_MIN_WIDTH - otherSpace - 1)
}

/**
 * 结束一次拖动。`persist` 为 false 只清状态(组件卸载),不写盘。
 *
 * 拖动中只改内存,松手才写盘:每移动 1px 写一次 settings.json 太浪费。
 */
function endDrag(persist: boolean): void {
  if (!dragging.value) return
  dragging.value = false
  document.body.classList.remove('pane-resizing')
  const el = rootEl.value
  if (el && pointerId !== null && el.hasPointerCapture(pointerId)) {
    el.releasePointerCapture(pointerId)
  }
  pointerId = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  window.removeEventListener('blur', onWindowBlur)
  if (!persist) return
  if (props.side === 'explorer') void api.saveSettings({ explorerWidth: appStore.explorerWidth })
  else void api.saveSettings({ outlineWidth: appStore.outlineWidth })
}

/** 窗口失焦时收不到 pointerup:不留一个「永远在拖」的状态 */
function onWindowBlur(): void {
  endDrag(true)
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  startX = event.clientX
  startWidth = currentWidth()
  pointerId = event.pointerId
  dragging.value = true
  document.body.classList.add('pane-resizing')
  // 指针捕获是主手段;窗口级监听兜底:
  // 捕获在个别情况下会丢(调试器注入的指针事件、元素被重新挂载),
  // 只靠事件落在 1px 的分界线上,拖一下就会断。两个都挂上,同一事件重复处理
  // 也无害 —— onPointerMove 每次都从 startX 重算,而不是累加。
  try {
    rootEl.value?.setPointerCapture(event.pointerId)
  } catch {
    /* 捕获失败不影响窗口级监听 */
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('blur', onWindowBlur)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  /*
   * 没有按键的移动说明松手事件丢了(窗口失焦、调试器注入、指针被系统取消)。
   * 必须在这里收尾:否则拖动态会一直挂着,之后用户只是在界面上普通地划过鼠标,
   * 侧栏也会跟着乱跳。
   */
  if (event.buttons === 0) {
    endDrag(true)
    return
  }
  const dx = event.clientX - startX
  // 大纲在右侧:线往左拖才是变宽
  const raw = props.side === 'explorer' ? startWidth + dx : startWidth - dx
  applyWidth(Math.round(Math.min(Math.max(raw, minWidth()), maxWidth())))
}

function onPointerUp(): void {
  endDrag(true)
}

/** 双击恢复默认宽度 —— 拖坏了不用去翻设置文件 */
function onDoubleClick(): void {
  applyWidth(DEFAULT_WIDTH)
  if (props.side === 'explorer') void api.saveSettings({ explorerWidth: DEFAULT_WIDTH })
  else void api.saveSettings({ outlineWidth: DEFAULT_WIDTH })
}

onBeforeUnmount(() => {
  endDrag(false)
})
</script>

<template>
  <div
    ref="rootEl"
    class="pane-resizer"
    :class="{ 'pane-resizer-active': dragging }"
    :data-side="side"
    role="separator"
    aria-orientation="vertical"
    :aria-label="side === 'explorer' ? '拖动调整文件浏览器宽度' : '拖动调整大纲宽度'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="onDoubleClick"
  />
</template>
