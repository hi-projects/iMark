<script setup lang="ts">
/**
 * 带「候选列表」的文本输入框。
 *
 * 原生 `<input list>` 的箭头只在悬停时出现,datalist 弹层在深色主题下仍是
 * 系统白底,改不动。这里自绘:输入框右侧常驻一个上下箭头按钮,点开后用
 * Teleport 到 body 的主题化菜单列出候选;输入框本身仍可自由编辑。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { ChevronsUpDown } from 'lucide-vue-next'
import type { SuggestOption } from './suggest'

const props = defineProps<{
  modelValue: string
  options: SuggestOption[]
  placeholder?: string
}>()

const emit = defineEmits<{
  (e: 'select', value: string): void
  (e: 'commit', value: string): void
}>()

const text = ref(props.modelValue)
watch(
  () => props.modelValue,
  value => {
    // 菜单打开时不要用外部回写覆盖用户正在敲的内容
    if (!open.value) text.value = value
  }
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

const ITEM_HEIGHT = 32

function place(): void {
  const el = input.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const estimated = Math.min(props.options.length, 8) * ITEM_HEIGHT + 10
  const style: Record<string, string> = {
    position: 'fixed',
    right: `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`,
    minWidth: `${Math.round(Math.max(rect.width, 320))}px`,
    maxWidth: 'min(680px, calc(100vw - 24px))',
    maxHeight: '280px'
  }
  if (rect.bottom + estimated <= window.innerHeight - 8) {
    style.top = `${Math.round(rect.bottom + 4)}px`
  } else {
    style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`
  }
  menuStyle.value = style
}

function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node
  // 箭头按钮在输入框外面,必须按整个包装盒判断,否则点箭头会先被当成「点外面」
  // 关掉菜单,紧接着 click 又把它打开 —— 看起来永远关不掉。
  if (root.value?.contains(target) || menu.value?.contains(target)) return
  close()
}

function onViewportChange(): void {
  place()
}

function show(): void {
  if (props.options.length === 0) return
  place()
  open.value = true
  window.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
}

function close(): void {
  if (!open.value) return
  open.value = false
  window.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
}

function toggle(): void {
  if (open.value) close()
  else show()
}

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement).value
}

function commit(): void {
  emit('commit', text.value.trim())
}

function pick(option: SuggestOption): void {
  text.value = option.value
  emit('select', option.value)
  close()
  input.value?.focus()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    close()
    commit()
  }
}

onBeforeUnmount(close)
</script>

<template>
  <div
    ref="root"
    class="plugin-suggest"
    :class="{ 'plugin-suggest-has-options': options.length > 0 }"
  >
    <input
      ref="input"
      class="plugin-input plugin-suggest-input"
      type="text"
      :value="text"
      :placeholder="placeholder"
      spellcheck="false"
      @input="onInput"
      @change="commit"
      @keydown="onKeydown"
    />
    <button
      v-if="options.length > 0"
      type="button"
      class="plugin-suggest-chevron"
      title="选择已配置的远程"
      aria-label="选择已配置的远程"
      @mousedown.prevent
      @click="toggle"
    >
      <ChevronsUpDown :size="13" />
    </button>

    <Teleport to="body">
      <div v-if="open" ref="menu" class="plugin-suggest-menu" role="listbox" :style="menuStyle">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="plugin-suggest-item"
          role="option"
          @mousedown.prevent
          @click="pick(option)"
        >
          <span class="plugin-suggest-url">{{ option.value }}</span>
          <span v-if="option.meta" class="plugin-suggest-meta">{{ option.meta }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
