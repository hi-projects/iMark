<script setup lang="ts">
/**
 * 扩展模态请求的宿主界面：消息框 / 输入框 / 快速选择。
 *
 * 队列与应答都在 services/extensionUiHost.ts；这里只负责画和收键盘。
 * 样式复用行首菜单的参数对话框（`line-dialog-*`）：扩展弹的框与应用自己弹的框
 * 长得一样，用户不需要分辨「这是谁的窗口」——标题里已经写了扩展名。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HelpTip from './HelpTip.vue'
import {
  extensionUiStore,
  resolveExtensionUi,
  validateExtensionUiInput,
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
const inputError = ref<string | null>(null)
const validating = ref(false)
let validateTimer: ReturnType<typeof setTimeout> | null = null
/** 刚换成另一个输入框时的赋值不算「用户输入」，不该立刻报空值错误 */
let skipNextValidation = false

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

function clearValidateTimer(): void {
  if (!validateTimer) return
  clearTimeout(validateTimer)
  validateTimer = null
}

watch(
  current,
  async request => {
    clearValidateTimer()
    inputError.value = null
    validating.value = false
    skipNextValidation = true
    inputValue.value = request?.kind === 'input' ? request.value : ''
    keyword.value = ''
    activeIndex.value = 0
    pickedLabels.value =
      request?.kind === 'pick'
        ? request.items.filter(item => item.picked).map(item => item.label)
        : []
    await nextTick()
    // 值没变时 watcher 不会触发，skip 标记要在这里收回来，否则用户第一次
    // 输入会被误当成「刚打开输入框」
    skipNextValidation = false
    if (request?.kind === 'message') dialogEl.value?.focus()
    else inputEl.value?.focus()
  },
  { immediate: true }
)

// 输入时防抖回问宿主；结果回来时值可能已经变了，只采用最新一次的
watch(inputValue, () => {
  inputError.value = null
  if (skipNextValidation) {
    skipNextValidation = false
    return
  }
  const request = current.value
  if (request?.kind !== 'input' || !request.validateInput) return
  clearValidateTimer()
  validateTimer = setTimeout(() => void runInputValidation(), 180)
})

// 筛选后当前项可能已经不在列表里；不夹取的话回车会拿到 undefined
watch(filteredItems, items => {
  if (activeIndex.value >= items.length) activeIndex.value = Math.max(0, items.length - 1)
})

/**
 * 跑一次扩展的 validateInput。返回值仍属于当前输入框才采纳，避免旧请求的
 * 结果盖掉用户刚改成的新值。
 */
async function runInputValidation(): Promise<boolean> {
  const request = current.value
  if (request?.kind !== 'input' || !request.validateInput) return true
  const value = inputValue.value
  validating.value = true
  let error: string | null = null
  try {
    error = await validateExtensionUiInput(request.id, value)
  } finally {
    if (current.value === request) {
      validating.value = false
      if (inputValue.value === value) inputError.value = error
    }
  }
  return error === null
}

function confirmInput(): void {
  const request = current.value
  if (request?.kind !== 'input' || validating.value) return
  // 没有校验的输入框保持原来的即时行为
  if (!request.validateInput) {
    resolveExtensionUi(inputValue.value)
    return
  }
  clearValidateTimer()
  void (async () => {
    if (await runInputValidation()) {
      if (current.value === request) resolveExtensionUi(inputValue.value)
    }
  })()
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
onBeforeUnmount(() => {
  clearValidateTimer()
  window.removeEventListener('keydown', onWindowKeydown, true)
})
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
        <!-- promptAsHelp：说明收进标题旁的小问号，悬停用应用主题化的浮层 -->
        <HelpTip
          v-if="current.kind === 'input' && current.prompt && current.promptAsHelp"
          class="ext-dialog-help"
          :text="current.prompt"
        />
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
          <!-- 提示文字是标注，不是内容：字号小一点，也不让鼠标拖选 -->
          <div
            v-if="current.prompt && !current.promptAsHelp"
            class="ext-dialog-message ext-dialog-prompt"
          >
            {{ current.prompt }}
          </div>
          <input
            ref="inputEl"
            v-model="inputValue"
            class="ext-dialog-input"
            :class="{ 'ext-dialog-input-invalid': inputError }"
            :type="current.password ? 'password' : 'text'"
            :placeholder="current.placeHolder ?? ''"
            :aria-invalid="inputError ? 'true' : undefined"
            @keydown.enter.prevent="confirmInput"
          />
          <div v-if="inputError" class="ext-dialog-error" role="alert">{{ inputError }}</div>
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
            :disabled="current.kind === 'input' && validating"
            @click="current.kind === 'input' ? confirmInput() : confirmPick()"
          >
            确定
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
