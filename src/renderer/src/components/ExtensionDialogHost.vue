<script setup lang="ts">
/**
 * 扩展模态请求的宿主界面：消息框 / 输入框 / 快速选择。
 *
 * 队列与应答都在 services/extensionUiHost.ts；这里只负责画和收键盘。
 * 样式复用行首菜单的参数对话框（`line-dialog-*`）：扩展弹的框与应用自己弹的框
 * 长得一样，用户不需要分辨「这是谁的窗口」——标题里已经写了扩展名。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  extensionUiStore,
  resolveExtensionUi,
  type ExtensionUiPickItem,
  type ExtensionUiRequest
} from '../services/extensionUiHost'

const current = computed<ExtensionUiRequest | null>(() => extensionUiStore.queue[0] ?? null)

const inputEl = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const inputValue = ref('')
const keyword = ref('')
const activeIndex = ref(0)
const pickedLabels = ref<string[]>([])

const LEVEL_LABEL: Record<'info' | 'warning' | 'error', string> = {
  info: '提示',
  warning: '警告',
  error: '错误'
}

const filteredItems = computed<ExtensionUiPickItem[]>(() => {
  const request = current.value
  if (request?.kind !== 'pick') return []
  const keywordText = keyword.value.trim().toLowerCase()
  if (!keywordText) return request.items
  return request.items.filter(item =>
    [item.label, item.description, item.detail].some(value =>
      value?.toLowerCase().includes(keywordText)
    )
  )
})

watch(
  current,
  async request => {
    inputValue.value = request?.kind === 'input' ? request.value : ''
    keyword.value = ''
    activeIndex.value = 0
    pickedLabels.value =
      request?.kind === 'pick'
        ? request.items.filter(item => item.picked).map(item => item.label)
        : []
    await nextTick()
    if (request?.kind === 'message') dialogEl.value?.focus()
    else inputEl.value?.focus()
  },
  { immediate: true }
)

// 筛选后当前项可能已经不在列表里；不夹取的话回车会拿到 undefined
watch(filteredItems, items => {
  if (activeIndex.value >= items.length) activeIndex.value = Math.max(0, items.length - 1)
})

function confirmInput(): void {
  if (current.value?.kind !== 'input') return
  resolveExtensionUi(inputValue.value)
}

function confirmPick(): void {
  const request = current.value
  if (request?.kind !== 'pick') return
  if (request.canPickMany) {
    resolveExtensionUi(pickedLabels.value.length > 0 ? [...pickedLabels.value] : null)
    return
  }
  const item = filteredItems.value[activeIndex.value]
  resolveExtensionUi(item ? item.label : null)
}

function togglePicked(label: string): void {
  const index = pickedLabels.value.indexOf(label)
  if (index >= 0) pickedLabels.value.splice(index, 1)
  else pickedLabels.value.push(label)
}

function onItemClick(item: ExtensionUiPickItem): void {
  const request = current.value
  if (request?.kind !== 'pick') return
  if (request.canPickMany) togglePicked(item.label)
  else resolveExtensionUi(item.label)
}

function onDialogKeydown(e: KeyboardEvent): void {
  const request = current.value
  if (!request) return
  if (request.kind === 'message') {
    // 消息框没有输入框：回车等同于点主按钮，退格/删除不做事
    if (e.key === 'Enter') {
      e.preventDefault()
      resolveExtensionUi(request.items.length > 0 ? request.items[0] : null)
    }
    return
  }
  if (request.kind === 'input') return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (filteredItems.value.length > 0) {
      activeIndex.value = (activeIndex.value + 1) % filteredItems.value.length
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (filteredItems.value.length > 0) {
      activeIndex.value =
        (activeIndex.value - 1 + filteredItems.value.length) % filteredItems.value.length
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirmPick()
  }
}

/** Esc 必须在捕获阶段拦：焦点可能落在下面的 CodeMirror 上，冒泡阶段收不到 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && current.value) {
    e.preventDefault()
    e.stopPropagation()
    resolveExtensionUi(null)
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))
</script>

<template>
  <div v-if="current" class="line-dialog-mask" @mousedown.self="resolveExtensionUi(null)">
    <div
      ref="dialogEl"
      class="line-dialog ext-dialog"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <div class="line-dialog-head ext-dialog-head">
        <span class="ext-dialog-title">{{ current.title }}</span>
        <span
          v-if="current.kind === 'message'"
          class="ext-dialog-level"
          :class="`ext-dialog-level-${current.level}`"
          >{{ LEVEL_LABEL[current.level] }}</span
        >
      </div>

      <div class="line-dialog-body">
        <template v-if="current.kind === 'message'">
          <div class="ext-dialog-message">{{ current.message }}</div>
          <pre v-if="current.detail" class="ext-dialog-detail">{{ current.detail }}</pre>
        </template>

        <template v-else-if="current.kind === 'input'">
          <div v-if="current.prompt" class="ext-dialog-message">{{ current.prompt }}</div>
          <input
            ref="inputEl"
            v-model="inputValue"
            class="ext-dialog-input"
            :type="current.password ? 'password' : 'text'"
            :placeholder="current.placeHolder ?? ''"
            @keydown.enter.prevent="confirmInput"
          />
        </template>

        <template v-else>
          <input
            ref="inputEl"
            v-model="keyword"
            class="ext-dialog-input"
            type="text"
            :placeholder="current.placeHolder ?? '输入以筛选…'"
          />
          <div class="ext-dialog-list">
            <button
              v-for="(item, i) in filteredItems"
              :key="`${item.label}\u0000${i}`"
              type="button"
              class="ext-dialog-item"
              :class="{
                'ext-dialog-item-active': i === activeIndex,
                'ext-dialog-item-picked': current.canPickMany && pickedLabels.includes(item.label)
              }"
              @mouseenter="activeIndex = i"
              @click="onItemClick(item)"
            >
              <span v-if="current.canPickMany" class="ext-dialog-check" aria-hidden="true">{{
                pickedLabels.includes(item.label) ? '✓' : ''
              }}</span>
              <span class="ext-dialog-item-label">{{ item.label }}</span>
              <span v-if="item.description" class="ext-dialog-item-desc">{{
                item.description
              }}</span>
              <span v-if="item.detail" class="ext-dialog-item-detail">{{ item.detail }}</span>
            </button>
            <div v-if="filteredItems.length === 0" class="ext-dialog-empty">没有匹配项</div>
          </div>
        </template>
      </div>

      <div class="line-dialog-foot">
        <template v-if="current.kind === 'message'">
          <button
            v-if="current.items.length === 0"
            class="line-dialog-btn line-dialog-primary"
            @click="resolveExtensionUi(null)"
          >
            确定
          </button>
          <button
            v-for="(item, i) in current.items"
            :key="item"
            class="line-dialog-btn"
            :class="{ 'line-dialog-primary': i === 0 }"
            @click="resolveExtensionUi(item)"
          >
            {{ item }}
          </button>
        </template>
        <template v-else>
          <button class="line-dialog-btn" @click="resolveExtensionUi(null)">取消</button>
          <button
            class="line-dialog-btn line-dialog-primary"
            @click="current.kind === 'input' ? confirmInput() : confirmPick()"
          >
            确定
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
