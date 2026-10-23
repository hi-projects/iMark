<script setup lang="ts">
/**
 * 扩展 webview 的宿主容器。
 *
 * 每个面板是一个 sandbox iframe，src 指向 `imark-webview://<extId>/__imark_panel__/…`。
 * 面板不能直接访问应用的 DOM（跨源 + sandbox），所有交互都走 postMessage。
 *
 * 三种呈现：
 *   - sidebar：编辑器右侧停靠，可拖左边缘改宽；
 *   - overlay：铺满编辑区；
 *   - floating：按 anchor 贴在编辑区四角之一。
 *
 * `retainContextWhenHidden` 为真时隐藏只切 `v-show` 语义（这里用 v-if 的组合：
 * 留着一个 `display:none` 的 section），iframe 不销毁，页面状态与 localStorage 都在；
 * 为假时隐藏会卸载 iframe，下次显示重新加载。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  allPanels,
  attachFrame,
  closePanel,
  frameUrl,
  onPanelDrag,
  type PanelDragEvent,
  type RendererWebviewPanel
} from '../services/webviews'

const panels = computed(() => allPanels())

/** 用户拖动后的尺寸（会话内）；扩展自己 setSize 时以面板状态为准 */
const sizes = reactive<Record<string, { width?: number; height?: number }>>({})

/**
 * 浮动面板拖动后的位移（相对锚点，会话内）。
 *
 * 小人之类的透明面板没有标题栏，拖动从 iframe 内的按下开始；iframe 只管报告位置，
 * 真正移动面板、限制在编辑区内的都是宿主，否则指针一离开 iframe 就断流。
 */
const offsets = reactive<Record<string, { x: number; y: number }>>({})

const hostEl = ref<HTMLElement | null>(null)

interface MoveState {
  panelId: string
  frame: HTMLIFrameElement
  startX: number
  startY: number
  baseX: number
  baseY: number
  left: number
  top: number
  width: number
  height: number
  hostLeft: number
  hostTop: number
  hostRight: number
  hostBottom: number
  /** 超过阈值才算拖动；否则是一次点击 */
  active: boolean
}

const moving = ref<MoveState | null>(null)

const DRAG_THRESHOLD = 4
const EDGE_GAP = 8

function beginMove(event: PanelDragEvent): void {
  const section = event.frame.closest('.webview-panel') as HTMLElement | null
  const host = hostEl.value
  if (!section || !host) return
  endMove()
  const rect = section.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  const current = offsets[event.panelId]
  moving.value = {
    panelId: event.panelId,
    frame: event.frame,
    startX: event.x,
    startY: event.y,
    baseX: current?.x ?? 0,
    baseY: current?.y ?? 0,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    hostLeft: hostRect.left,
    hostTop: hostRect.top,
    hostRight: hostRect.right,
    hostBottom: hostRect.bottom,
    active: false
  }
  window.addEventListener('pointermove', onWindowMove, true)
  window.addEventListener('pointerup', endMove, true)
  window.addEventListener('pointercancel', endMove, true)
  // 指针拖出应用窗口时收不到 pointerup，失焦就当作结束，避免遮罩卡住
  window.addEventListener('blur', endMove, true)
}

function onWindowMove(event: PointerEvent): void {
  applyMove(event.clientX, event.clientY)
}

function applyMove(x: number, y: number): void {
  const state = moving.value
  if (!state) return
  const dx = x - state.startX
  const dy = y - state.startY
  if (!state.active) {
    if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return
    state.active = true
  }
  const minX = state.hostLeft + EDGE_GAP - state.left
  const maxX = state.hostRight - EDGE_GAP - state.width - state.left
  const minY = state.hostTop + EDGE_GAP - state.top
  const maxY = state.hostBottom - EDGE_GAP - state.height - state.top
  offsets[state.panelId] = {
    x: clamp(state.baseX + dx, minX, maxX),
    y: clamp(state.baseY + dy, minY, maxY)
  }
}

function endMove(): void {
  if (!moving.value) return
  moving.value = null
  window.removeEventListener('pointermove', onWindowMove, true)
  window.removeEventListener('pointerup', endMove, true)
  window.removeEventListener('pointercancel', endMove, true)
  window.removeEventListener('blur', endMove, true)
}

let offDrag: (() => void) | null = null

onMounted(() => {
  offDrag = onPanelDrag((phase, event) => {
    if (phase === 'start') beginMove(event)
    else if (phase === 'move') applyMove(event.x, event.y)
    else endMove()
  })
})

onBeforeUnmount(() => {
  offDrag?.()
  offDrag = null
  endMove()
})

interface DragState {
  panelId: string
  startX: number
  startY: number
  width: number
  height: number
}

const drag = ref<DragState | null>(null)

const MIN_SIDEBAR = 280
const MAX_SIDEBAR = 760
const MIN_FLOATING = 220

function widthOf(panel: RendererWebviewPanel): number {
  return sizes[panel.panelId]?.width ?? panel.width
}

function heightOf(panel: RendererWebviewPanel): number {
  return sizes[panel.panelId]?.height ?? panel.height
}

function styleOf(panel: RendererWebviewPanel): Record<string, string> {
  if (panel.presentation === 'sidebar') {
    return { width: `${clamp(widthOf(panel), MIN_SIDEBAR, MAX_SIDEBAR)}px` }
  }
  if (panel.presentation === 'floating') {
    const offset = offsets[panel.panelId]
    return {
      width: `${Math.max(MIN_FLOATING, widthOf(panel))}px`,
      height: `${Math.max(120, heightOf(panel))}px`,
      ...(offset
        ? { transform: `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px)` }
        : {})
    }
  }
  return {}
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function startResize(event: PointerEvent, panel: RendererWebviewPanel): void {
  if (panel.presentation !== 'sidebar') return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  drag.value = {
    panelId: panel.panelId,
    startX: event.clientX,
    startY: event.clientY,
    width: widthOf(panel),
    height: heightOf(panel)
  }
}

function onPointerMove(event: PointerEvent): void {
  const state = drag.value
  if (!state) return
  const panel = panels.value.find(item => item.panelId === state.panelId)
  if (!panel) return
  if (panel.presentation === 'sidebar') {
    // 往左拖变宽：指针移动量与宽度增量相反
    const width = clamp(state.width - (event.clientX - state.startX), MIN_SIDEBAR, MAX_SIDEBAR)
    sizes[state.panelId] = { ...sizes[state.panelId], width }
  } else {
    const width = Math.max(MIN_FLOATING, state.width + (event.clientX - state.startX))
    const height = Math.max(120, state.height + (event.clientY - state.startY))
    sizes[state.panelId] = { width: Math.round(width), height: Math.round(height) }
  }
}

function endResize(event: PointerEvent): void {
  if (!drag.value) return
  drag.value = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function frameRef(panelId: string, element: unknown): void {
  attachFrame(panelId, (element as HTMLIFrameElement | null) || null)
}

function onClose(panelId: string): void {
  closePanel(panelId)
}
</script>

<template>
  <div ref="hostEl" class="webview-host">
    <!-- 拖动浮动面板时接管全窗口指针；否则指针重新划进 iframe 会丢事件 -->
    <div v-if="moving?.active" class="webview-drag-shield"></div>
    <template v-for="panel in panels" :key="panel.panelId">
      <section
        v-if="panel.visible || panel.retainContextWhenHidden"
        class="webview-panel"
        :class="[
          `webview-panel-${panel.presentation}`,
          `webview-anchor-${panel.anchor}`,
          {
            'webview-panel-hidden': !panel.visible,
            'webview-panel-transparent': panel.transparent
          }
        ]"
        :style="styleOf(panel)"
        :data-panel-id="panel.panelId"
        :data-extension-id="panel.extensionId"
      >
        <header class="webview-titlebar">
          <span
            class="webview-status-dot"
            :class="{ 'is-busy': panel.status === 'busy' }"
            aria-hidden="true"
          ></span>
          <span class="webview-title" :title="panel.title">{{ panel.title }}</span>
          <button class="webview-close" title="关闭" @click="onClose(panel.panelId)">
            ×
          </button>
        </header>
        <div class="webview-frame-wrap">
          <iframe
            class="webview-frame"
            :src="frameUrl(panel)"
            sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
            :ref="element => frameRef(panel.panelId, element)"
          ></iframe>
        </div>
        <div
          v-if="panel.presentation === 'sidebar'"
          class="webview-resize webview-resize-column"
          @pointerdown="startResize($event, panel)"
          @pointermove="onPointerMove"
          @pointerup="endResize"
          @pointercancel="endResize"
        ></div>
        <div
          v-else-if="panel.presentation === 'floating'"
          class="webview-resize webview-resize-corner"
          @pointerdown="startResize($event, panel)"
          @pointermove="onPointerMove"
          @pointerup="endResize"
          @pointercancel="endResize"
        ></div>
      </section>
    </template>
  </div>
</template>
