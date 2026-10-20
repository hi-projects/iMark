<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Palette, RotateCcw, Settings2, Store, TextCursorInput, X } from 'lucide-vue-next'
import HelpTip from './HelpTip.vue'
import { computed } from 'vue'
import type { AutoSaveMode } from '@shared/types'
import {
  AUTO_SAVE_DELAY_MIN,
  CODE_INDENT_OPTIONS,
  delayLabel,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN
} from '@shared/editorSettings'
import { appStore, closeSettings, setTheme, THEME_LABELS, THEME_ORDER } from '../stores/app'
import {
  previewFontSize,
  resetEditorSettings,
  setAutoSaveDelay,
  setAutoSaveMode,
  setCodeIndentSize,
  setEditorFontSize,
  setLineWrapping
} from '../services/editorSettings'
import { remoteStore } from '../services/marketService'
import {
  openMarketSettings,
  pluginStore,
  selectPluginSettings,
  settingsNav,
  type MarketNav
} from '../services/pluginService'
import { pluginStatusMessage, pluginStatusTone } from '../services/pluginStatus'
import PluginSettings from './plugins/PluginSettings.vue'
import SystemSettings from './SystemSettings.vue'
import UserStyleSettings from './UserStyleSettings.vue'
import MarketPage from './market/MarketPage.vue'
import InstallConfirmDialog from './market/InstallConfirmDialog.vue'
import MarketSource from './market/MarketSource.vue'

/**
 * 「插件」分组标题旁那个问号的内容。
 *
 * 列表里已经不再挂形态标签,而两层之间的信任差着一个量级 ——
 * 这个区别总得有地方说清楚,所以就放在这一句提示里,不占列表的地。
 */
const LAYER_HELP = [
  'node main：代码在主进程里跑，拥有完整 Node 权限 —— 能读写任意文件、执行命令。',
  'restricted main：代码在隐藏沙箱页里跑，没有 Node、文件系统；权限逐条申请、由宿主门禁放行。',
  'render 层：与主界面同 realm，能改界面、读当前文档，但没有系统能力；需要时消息给 main 层。'
].join('\n')

/** 右侧标题:选中的是插件就显示插件名,市场页则跟着它的页签走 */
const title = computed(() => {
  if (settingsNav.page === 'market') {
    const tab: MarketNav['tab'] = settingsNav.market.tab
    if (tab === 'browse') return settingsNav.market.detailId ? '插件详情' : '浏览市场'
    return tab === 'publish' ? '发布插件' : '已安装插件'
  }
  if (settingsNav.page === 'editor') return '编辑器'
  if (settingsNav.page === 'system') return '系统'
  if (settingsNav.page === 'plugin') {
    return (
      pluginStore.list.find(p => p.descriptor.id === settingsNav.pluginId)?.descriptor.name ?? '插件'
    )
  }
  return '外观'
})

/** 保存方式:名称与 VS Code 的 files.autoSave 对齐,「定时保存」含 1 秒档(即实时保存) */
const AUTO_SAVE_MODE_OPTIONS: { mode: AutoSaveMode; label: string; title: string }[] = [
  { mode: 'off', label: '关闭', title: '只能手动保存（Ctrl+S）' },
  { mode: 'afterDelay', label: '定时保存', title: '停止输入一段时间后写盘' },
  { mode: 'onFocusChange', label: '切换焦点时', title: '编辑器失去焦点时写盘' },
  { mode: 'onWindowChange', label: '切换窗口时', title: '切换到其他窗口时写盘' }
]

/** 延迟的常用档位。1 秒档就是原来的「实时保存」 */
const DELAY_PRESETS = [
  { label: '1 秒', sec: 1 },
  { label: '5 秒', sec: 5 },
  { label: '30 秒', sec: 30 },
  { label: '1 分钟', sec: 60 },
  { label: '5 分钟', sec: 300 },
  { label: '10 分钟', sec: 600 }
]

/** 保存方式下方那句话:当前到底会不会自动写盘、在什么时候写 */
const autoSaveSummary = computed(() => {
  switch (appStore.autoSaveMode) {
    case 'afterDelay':
      return `已开启 · 停止输入 ${delayLabel(appStore.autoSaveDelay)}后写盘`
    case 'onFocusChange':
      return '已开启 · 编辑器失去焦点时写盘'
    case 'onWindowChange':
      return '已开启 · 切换到其他窗口时写盘'
    default:
      return '当前关闭，只能手动保存（Ctrl+S）'
  }
})

/**
 * 手打延迟:越界由 clampAutoSaveDelay 夹到上下限,输入框会跟着回弹。
 * 清空时按「没输入」而不是 0 处理 —— 否则一顿删除反而落到最短的 1 秒,
 * 成了最激进的档位,显然不是清空的人想要的。
 */
function onDelayChange(e: Event): void {
  const raw = (e.target as HTMLInputElement).value.trim()
  void setAutoSaveDelay(raw === '' ? Number.NaN : Number(raw))
}

/** 拖滑块时即时预览字号(只改画面),松手才写盘 */
function onFontSizeInput(e: Event): void {
  previewFontSize(Number((e.target as HTMLInputElement).value))
}

function onFontSizeCommit(e: Event): void {
  void setEditorFontSize(Number((e.target as HTMLInputElement).value))
}

/** 市场入口在左栏「插件」分组里排第一项(与 Obsidian 的心智一致) */
function openMarket(): void {
  openMarketSettings()
}

/** Esc 关闭:捕获阶段先于 CodeMirror 处理,面板打开时不会被编辑器吃掉 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && appStore.settingsOpen) {
    e.preventDefault()
    e.stopPropagation()
    closeSettings()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// ---------- 拖动面板 ----------
//
// 只改**相对居中位置的位移**(transform),不改 layout:这样窗口尺寸一变,基准位置
// 仍然跟着居中走,不会因为一次拖动就把面板永久偏到一边。关闭面板时归零 ——
// 下次打开还是一个居中、完整的面板(而不是上次随手拖到的某个角落)。

const dialogEl = ref<HTMLElement | null>(null)
const dragOffset = reactive({ x: 0, y: 0 })
const dragging = ref(false)
/** 用户拖右下角调整过的尺寸;null = 用 CSS 里的默认尺寸(90vw / 86vh 且封顶) */
const dialogSize = ref<{ width: number; height: number } | null>(null)
const resizing = ref(false)
/** 一次拖动的起点;base* 是「没拖动时面板在视口里的位置」,用来算边界 */
let dragStart: {
  pointerX: number
  pointerY: number
  originX: number
  originY: number
  baseLeft: number
  baseTop: number
  width: number
  height: number
} | null = null

/** 面板与视口边缘至少留这么多,怎么拖都整块留在视线里 */
const DRAG_MARGIN = 8

/** 最小尺寸取默认尺寸(1080×760)的 85%,长宽比与默认一致;
 *  缩得更小左侧导航 + 内容就挤得没法用了(窗口更小时以视口为准) */
const MIN_DIALOG_WIDTH = 918
const MIN_DIALOG_HEIGHT = 646

const dialogStyle = computed(() => {
  const size = dialogSize.value
  return {
    transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
    ...(size ? { width: `${size.width}px`, height: `${size.height}px` } : {})
  }
})

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max))
}

function onDragStart(e: PointerEvent): void {
  if (e.button !== 0 || !dialogEl.value) return
  // 标题栏里的按钮(关闭)不参与拖动
  if ((e.target as HTMLElement).closest('button, input, a')) return
  const rect = dialogEl.value.getBoundingClientRect()
  dragStart = {
    pointerX: e.clientX,
    pointerY: e.clientY,
    originX: dragOffset.x,
    originY: dragOffset.y,
    baseLeft: rect.left - dragOffset.x,
    baseTop: rect.top - dragOffset.y,
    width: rect.width,
    height: rect.height
  }
  dragging.value = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  e.preventDefault()
}

function onDragMove(e: PointerEvent): void {
  const from = dragStart
  if (!from) return
  const minX = DRAG_MARGIN - from.baseLeft
  const maxX = window.innerWidth - DRAG_MARGIN - from.baseLeft - from.width
  const minY = DRAG_MARGIN - from.baseTop
  const maxY = window.innerHeight - DRAG_MARGIN - from.baseTop - from.height
  dragOffset.x = clamp(from.originX + (e.clientX - from.pointerX), minX, maxX)
  dragOffset.y = clamp(from.originY + (e.clientY - from.pointerY), minY, maxY)
}

function onDragEnd(): void {
  dragStart = null
  dragging.value = false
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
}

// ---------- 调整面板大小 ----------
//
// 四条边 + 四个角各有一条透明热区(贴在面板外侧,不压滚动条)。拖动时只移动
// 被拖的那条边:对边钉住。面板本身是 flex 居中的,宽高变化会把基准位置推走,
// 所以这里直接由目标 left/top 反算 translate,对边自然不动。
// 上限是视口减两倍边距,下限见 MIN_DIALOG_*。

/** 八个方向:边 n/s/e/w 改一个维度,角改两个维度 */
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

let resizeStart: {
  pointerX: number
  pointerY: number
  left: number
  top: number
  width: number
  height: number
  edge: ResizeEdge
} | null = null

function onResizeStart(e: PointerEvent, edge: ResizeEdge): void {
  if (e.button !== 0 || !dialogEl.value) return
  const rect = dialogEl.value.getBoundingClientRect()
  resizeStart = {
    pointerX: e.clientX,
    pointerY: e.clientY,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    edge
  }
  resizing.value = true
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
  e.preventDefault()
}

function onResizeMove(e: PointerEvent): void {
  const from = resizeStart
  if (!from) return

  const viewW = window.innerWidth
  const viewH = window.innerHeight
  const maxW = Math.max(0, viewW - DRAG_MARGIN * 2)
  const maxH = Math.max(0, viewH - DRAG_MARGIN * 2)
  const minW = Math.min(MIN_DIALOG_WIDTH, maxW)
  const minH = Math.min(MIN_DIALOG_HEIGHT, maxH)
  const dx = e.clientX - from.pointerX
  const dy = e.clientY - from.pointerY
  const right0 = from.left + from.width
  const bottom0 = from.top + from.height

  let left = from.left
  let right = right0
  let top = from.top
  let bottom = bottom0
  if (from.edge.includes('e')) right = clamp(right0 + dx, from.left + minW, viewW - DRAG_MARGIN)
  if (from.edge.includes('w')) left = clamp(from.left + dx, DRAG_MARGIN, right0 - minW)
  if (from.edge.includes('s')) bottom = clamp(bottom0 + dy, from.top + minH, viewH - DRAG_MARGIN)
  if (from.edge.includes('n')) top = clamp(from.top + dy, DRAG_MARGIN, bottom0 - minH)

  const width = right - left
  const height = bottom - top
  dialogSize.value = { width, height }
  // 居中基准 + 位移 = 目标 left/top;这样没被拖的边保持不动
  dragOffset.x = left - (viewW - width) / 2
  dragOffset.y = top - (viewH - height) / 2
  e.preventDefault()
}

function onResizeEnd(): void {
  resizeStart = null
  resizing.value = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
}

/** 窗口变小 / 拖动中改了尺寸:把面板重新夹回视口,别让它有一半在屏幕外 */
function clampIntoView(): void {
  const el = dialogEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const baseLeft = rect.left - dragOffset.x
  const baseTop = rect.top - dragOffset.y
  dragOffset.x = clamp(
    dragOffset.x,
    DRAG_MARGIN - baseLeft,
    window.innerWidth - DRAG_MARGIN - baseLeft - rect.width
  )
  dragOffset.y = clamp(
    dragOffset.y,
    DRAG_MARGIN - baseTop,
    window.innerHeight - DRAG_MARGIN - baseTop - rect.height
  )
}

// 关掉面板就还原位置:Esc / 点遮罩 / 关闭按钮都会走到这里
watch(
  () => appStore.settingsOpen,
  open => {
    if (open) return
    dragOffset.x = 0
    dragOffset.y = 0
    onDragEnd()
    onResizeEnd()
  }
)

/** 窗口变小:尺寸与位移一起夹回视口(尺寸改完要等 Vue 落到 DOM 再量位置) */
function onWindowResize(): void {
  const size = dialogSize.value
  if (size) {
    const width = Math.min(size.width, Math.max(0, window.innerWidth - DRAG_MARGIN * 2))
    const height = Math.min(size.height, Math.max(0, window.innerHeight - DRAG_MARGIN * 2))
    if (width !== size.width || height !== size.height) {
      dialogSize.value = { width, height }
    }
  }
  void nextTick(clampIntoView)
}

onMounted(() => window.addEventListener('resize', onWindowResize))
onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  onDragEnd()
  onResizeEnd()
})
</script>

<template>
  <div v-if="appStore.settingsOpen" class="settings-mask" @mousedown.self="closeSettings()">
    <!--
      外框只负责尺寸、位移与边缘热区;真正的面板(.settings-dialog)铺满外框。
      四条边/四个角的热区放在面板**外侧**:面板右缘就是内容滚动条,热区若压在
      里面会把滚动条抢走。
    -->
    <div
      ref="dialogEl"
      class="settings-dialog-frame"
      :class="{ 'settings-dialog-dragging': dragging, 'settings-dialog-resizing': resizing }"
      :style="dialogStyle"
    >
      <div class="settings-dialog">
      <aside class="settings-nav">
        <div class="settings-nav-group">选项</div>
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'appearance' }"
          @click="settingsNav.page = 'appearance'"
        >
          <Palette :size="15" />
          <span>外观</span>
        </button>
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'editor' }"
          @click="settingsNav.page = 'editor'"
        >
          <TextCursorInput :size="15" />
          <span>编辑器</span>
        </button>
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'system' }"
          @click="settingsNav.page = 'system'"
        >
          <Settings2 :size="15" />
          <span>系统</span>
        </button>
        <!-- 插件单独一行分组:市场排第一项,下面直接列出每个已安装插件 -->
        <div class="settings-nav-group">
          <span>插件</span>
          <HelpTip :text="LAYER_HELP" :size="12" class="settings-nav-help" />
        </div>
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'market' }"
          @click="openMarket()"
        >
          <Store :size="15" />
          <span>浏览市场</span>
          <!-- 有可用更新时挂个角标:这是用户唯一会主动看的地方 -->
          <span v-if="remoteStore.updates.length > 0" class="settings-nav-badge">
            {{ remoteStore.updates.length }}
          </span>
        </button>
        <button
          v-for="plugin in pluginStore.list"
          :key="plugin.descriptor.id"
          class="settings-nav-item"
          :class="{
            'settings-nav-active':
              settingsNav.page === 'plugin' && settingsNav.pluginId === plugin.descriptor.id
          }"
          @click="selectPluginSettings(plugin.descriptor.id)"
        >
          <span
            class="plugin-status-dot"
            :class="`plugin-status-${pluginStatusTone(plugin.state)}`"
            :title="pluginStatusMessage(plugin.state)"
          />
          <span class="settings-nav-label">{{ plugin.descriptor.name }}</span>
          <!--
            这里刻意不挂形态标签(完整权限 / 沙箱 / 无代码):
            形态之间的差别由分组标题旁的那个问号解释,权限明细在市场「已安装」里逐条列着 ——
            列表只负责回答「装了哪几个、各自跑得怎么样」。
          -->
        </button>
        <div v-if="pluginStore.list.length === 0" class="settings-nav-empty">没有可用的插件</div>
      </aside>

      <section class="settings-main">
        <!-- 标题栏就是拖动把手:标题文字上按下并拖动即可挪动整个面板 -->
        <header class="settings-main-header" @pointerdown="onDragStart">
          <h1>{{ title }}</h1>
          <button class="settings-close" title="关闭（Esc）" @click="closeSettings()">
            <X :size="16" />
          </button>
        </header>

        <div v-if="settingsNav.page === 'market'" class="settings-body">
          <MarketPage />
        </div>

        <div v-else-if="settingsNav.page === 'plugin'" class="settings-body">
          <PluginSettings />
        </div>

        <div v-else-if="settingsNav.page === 'system'" class="settings-body">
          <SystemSettings />
        </div>

        <div v-else-if="settingsNav.page === 'editor'" class="settings-body">
          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">自动保存</div>
              <div class="settings-section-desc">自动保存文档改动。注意：该功能只对已保存文件生效，未落盘的新文档不生效，以免弹出保存弹窗</div>
            </div>

            <div class="settings-card">
              <div class="settings-row settings-row-stack">
                <div class="settings-row-info">
                  <div class="settings-row-title">保存方式</div>
                  <div class="settings-row-desc">{{ autoSaveSummary }}</div>
                </div>
                <div class="settings-control">
                  <span class="settings-presets">
                    <button
                      v-for="option in AUTO_SAVE_MODE_OPTIONS"
                      :key="option.mode"
                      class="settings-preset"
                      :class="{ 'settings-preset-active': appStore.autoSaveMode === option.mode }"
                      :title="option.title"
                      @click="setAutoSaveMode(option.mode)"
                    >
                      {{ option.label }}
                    </button>
                  </span>
                </div>
              </div>

              <div v-if="appStore.autoSaveMode === 'afterDelay'" class="settings-row settings-row-stack">
                <div class="settings-row-info">
                  <div class="settings-row-title">保存延迟</div>
                  <div class="settings-row-desc">自动保存间隔时长，最短{{ AUTO_SAVE_DELAY_MIN }}秒，文档没有改动时，不触发自动保存</div>
                </div>
                <div class="settings-control">
                  <span class="settings-presets">
                    <button
                      v-for="p in DELAY_PRESETS"
                      :key="p.sec"
                      class="settings-preset"
                      :class="{ 'settings-preset-active': appStore.autoSaveDelay === p.sec }"
                      @click="setAutoSaveDelay(p.sec)"
                    >
                      {{ p.label }}
                    </button>
                  </span>
                  <label class="settings-number-wrap">
                    <input
                      class="settings-number"
                      type="number"
                      :min="AUTO_SAVE_DELAY_MIN"
                      step="1"
                      :value="appStore.autoSaveDelay"
                      @change="onDelayChange"
                    />
                    <span class="settings-unit">秒</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">显示</div>
            </div>

            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row-info">
                  <div class="settings-row-title">自动换行</div>
                  <div class="settings-row-desc">
                    关闭后长段落不折行，靠横向滚动看完整行；表格、公式这类宽内容更适合关闭。
                  </div>
                </div>
                <label
                  class="settings-switch"
                  :title="appStore.lineWrapping ? '关闭自动换行' : '开启自动换行'"
                >
                  <input type="checkbox" :checked="appStore.lineWrapping" @change="setLineWrapping(!appStore.lineWrapping)" />
                  <span class="settings-switch-track" />
                </label>
              </div>

              <div class="settings-row settings-row-stack">
                <div class="settings-row-info">
                  <div class="settings-row-title">正文字号</div>
                  <div class="settings-row-desc">标题、代码块会按比例一起缩放，只影响编辑器，不影响导出。</div>
                </div>
                <div class="settings-control">
                  <input
                    class="settings-range"
                    type="range"
                    :min="EDITOR_FONT_SIZE_MIN"
                    :max="EDITOR_FONT_SIZE_MAX"
                    step="1"
                    :value="appStore.editorFontSize"
                    @input="onFontSizeInput"
                    @change="onFontSizeCommit"
                  />
                  <span class="settings-readout">{{ appStore.editorFontSize }} px</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">编辑</div>
            </div>

            <div class="settings-card">
              <div class="settings-row settings-row-stack">
                <div class="settings-row-info">
                  <div class="settings-row-title">代码块 Tab 缩进</div>
                  <div class="settings-row-desc">
                    在代码块里按 Tab 时插入的空格数；正文中 Tab 仍用于切换焦点。
                  </div>
                </div>
                <div class="settings-control">
                  <span class="settings-presets">
                    <button
                      v-for="size in CODE_INDENT_OPTIONS"
                      :key="size"
                      class="settings-preset"
                      :class="{ 'settings-preset-active': appStore.codeIndentSize === size }"
                      @click="setCodeIndentSize(size)"
                    >
                      {{ size }} 个空格
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <button class="settings-reset" @click="resetEditorSettings()">
              <RotateCcw :size="13" />
              <span>恢复默认设置</span>
            </button>
          </div>
        </div>

        <div v-else class="settings-body">
          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">基础颜色</div>
              <div class="settings-section-desc">设置界面主题。选择后立即生效，并保存到本地设置。</div>
            </div>
            <div class="settings-themes">
              <button
                v-for="t in THEME_ORDER"
                :key="t"
                class="settings-theme"
                :class="{ 'settings-theme-active': appStore.theme === t }"
                :title="`${THEME_LABELS[t]}主题`"
                @click="setTheme(t)"
              >
                <span class="settings-theme-swatch" :data-preview="t">
                  <span class="settings-theme-swatch-bar"></span>
                  <span class="settings-theme-swatch-line"></span>
                  <span class="settings-theme-swatch-line settings-theme-swatch-line-short"></span>
                </span>
                <span class="settings-theme-label">{{ THEME_LABELS[t] }}</span>
              </button>
            </div>
          </div>

          <UserStyleSettings />
        </div>
      </section>
      </div>

      <!-- 四条边 + 四个角:鼠标贴边即可拖动改大小(热区在面板外侧) -->
      <div
        v-for="edge in RESIZE_EDGES"
        :key="edge"
        class="settings-resize-edge"
        :class="`settings-resize-${edge}`"
        @pointerdown.stop.prevent="onResizeStart($event, edge)"
      />
    </div>
  </div>

  <!--
    确认框放在设置面板**外面**:它是由市场页发起的,而关闭设置面板不该顺手把
    一个待确认的安装丢掉(那会让人以为「点了取消」,但主进程那边其实还留着)。
    它自带 v-if,没有待确认项时什么都不渲染。
  -->
  <InstallConfirmDialog />

  <!-- 源码查看器同样放在外面:它是个全屏浮层,不该受设置面板的滚动区域与关闭逻辑约束 -->
  <MarketSource />
</template>
