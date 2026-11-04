<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import { appStore } from '../stores/app'
import { activateTab, moveTab, tabLabel, tabTooltip, type DocTab } from '../services/tabs'
import { closeAllTabs, closeOtherTabs, closeTab, newFile } from '../services/fileService'

/**
 * 标签栏(仿 Obsidian):
 *   - 点击激活;中键关闭;右键菜单可关闭其余/全部标签
 *   - 拖动排序;拖到目标标签的左/右半边决定插在前面还是后面
 *   - 脏标记是标题右侧的小圆点,鼠标悬停/激活时圆点让位给关闭按钮
 *   - 空白处双击 = 新建标签页(与 Obsidian 一致)
 */

const strip = ref<HTMLElement | null>(null)
const draggingId = ref<string | null>(null)
const dropTarget = ref<{ id: string; after: boolean } | null>(null)

function onAuxClick(e: MouseEvent, tab: DocTab): void {
  // 中键关闭。用 auxclick 而不是 mousedown:中键按下还可能被用作自动滚动,
  // 真正决定「这是一次中键点击」的是释放时的 auxclick
  if (e.button !== 1) return
  e.preventDefault()
  void closeTab(tab.id)
}

function onDragStart(e: DragEvent, tab: DocTab): void {
  draggingId.value = tab.id
  if (!e.dataTransfer) return
  e.dataTransfer.effectAllowed = 'move'
  // 必须写一份数据,否则 Chromium 不会真正开始拖拽
  e.dataTransfer.setData('text/plain', tab.id)
}

function onDragOver(e: DragEvent, tab: DocTab): void {
  if (!draggingId.value || draggingId.value === tab.id) {
    dropTarget.value = null
    return
  }
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropTarget.value = {
    id: tab.id,
    after: e.clientX > rect.left + rect.width / 2
  }
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  const dragged = draggingId.value
  const target = dropTarget.value
  draggingId.value = null
  dropTarget.value = null
  if (dragged && target) moveTab(dragged, target.id, target.after)
}

function onDragEnd(): void {
  draggingId.value = null
  dropTarget.value = null
}

function createTab(): void {
  void newFile()
}

// ---------- 右键菜单 ----------

const menu = reactive<{ open: boolean; x: number; y: number; tabId: string | null }>({
  open: false,
  x: 0,
  y: 0,
  tabId: null
})
const menuEl = ref<HTMLElement | null>(null)

async function openMenu(e: MouseEvent, tab: DocTab): Promise<void> {
  e.preventDefault()
  menu.tabId = tab.id
  menu.x = e.clientX
  menu.y = e.clientY
  menu.open = true
  // 贴边右键时把菜单挪回可视区;nextTick 在浏览器绘制前跑完,不会闪一下
  await nextTick()
  const el = menuEl.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  menu.x = Math.max(4, Math.min(menu.x, window.innerWidth - width - 4))
  menu.y = Math.max(4, Math.min(menu.y, window.innerHeight - height - 4))
}

function closeMenu(): void {
  menu.open = false
  menu.tabId = null
}

function runCloseOthers(): void {
  const keepId = menu.tabId
  closeMenu()
  if (keepId) void closeOtherTabs(keepId)
}

function runCloseAll(): void {
  closeMenu()
  void closeAllTabs()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (menu.open && e.key === 'Escape') closeMenu()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

/** 激活项变化时把标签滚进可视区(标签多了以后,切换快捷键不能切到看不见的页) */
watch(
  () => appStore.activeTabId,
  () => {
    void nextTick(() => {
      strip.value?.querySelector('.tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
)
</script>

<template>
  <div
    class="tab-bar"
    :class="{ 'tab-bar-flush-right': !appStore.outlineVisible }"
    @dblclick.self="createTab"
  >
    <div ref="strip" class="tab-strip" @dblclick.self="createTab">
      <div
        v-for="tab in appStore.tabs"
        :key="tab.id"
        class="tab"
        :class="{
          'tab-active': appStore.activeTabId === tab.id,
          'tab-dirty': tab.dirty,
          'tab-dragging': draggingId === tab.id,
          'tab-drop-before': dropTarget?.id === tab.id && !dropTarget.after,
          'tab-drop-after': dropTarget?.id === tab.id && dropTarget.after
        }"
        role="tab"
        :aria-selected="appStore.activeTabId === tab.id"
        :title="tabTooltip(tab)"
        draggable="true"
        @click="activateTab(tab.id)"
        @contextmenu.prevent="openMenu($event, tab)"
        @auxclick="onAuxClick($event, tab)"
        @dragstart="onDragStart($event, tab)"
        @dragover="onDragOver($event, tab)"
        @drop="onDrop"
        @dragend="onDragEnd"
      >
        <span class="tab-title">{{ tabLabel(tab) }}</span>
        <span class="tab-status">
          <span v-if="tab.dirty" class="tab-dot" aria-label="未保存"></span>
          <button
            class="tab-close"
            :title="`关闭 ${tabLabel(tab)} (Ctrl+W)`"
            draggable="false"
            @mousedown.stop
            @click.stop="closeTab(tab.id)"
          >
            <X :size="12" />
          </button>
        </span>
      </div>
    </div>
    <button class="tab-new" title="新建标签页 (Ctrl+N)" @click="createTab">
      <Plus :size="15" />
    </button>
  </div>

  <!-- 标签右键菜单。遮罩负责「点别处就关掉」,也挡住底下的误点 -->
  <div
    v-if="menu.open"
    class="tab-menu-mask"
    @click="closeMenu"
    @contextmenu.prevent="closeMenu"
    @wheel="closeMenu"
  >
    <div
      ref="menuEl"
      class="tab-menu"
      role="menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <button
        class="tab-menu-item"
        role="menuitem"
        :disabled="appStore.tabs.length <= 1"
        @click="runCloseOthers"
      >
        关闭其余标签
      </button>
      <button class="tab-menu-item" role="menuitem" @click="runCloseAll">关闭所有标签</button>
    </div>
  </div>
</template>
