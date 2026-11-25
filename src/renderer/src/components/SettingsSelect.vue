<script setup lang="ts">
/**
 * 设置页里的下拉选择。
 *
 * 原生 <select> 的弹出层由系统绘制,颜色跟不了应用主题(深色主题下会跳出一块
 * 亮色菜单)。这里用「按钮 + 自绘菜单」:触发器沿用设置页的输入框外观,菜单
 * 用主题令牌上色,选中项填强调色。
 *
 * 菜单 Teleport 到 body:设置卡有 overflow:hidden(圆角要裁边),放在卡片里
 * 会被裁掉。fixed 定位 + 打开时跟随滚动 / 缩放重新摆放。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { ChevronsUpDown } from 'lucide-vue-next'

export interface SelectOption {
  value: string | number
  label: string
}

const props = defineProps<{
  modelValue: string | number
  options: SelectOption[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | number]
}>()

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

const selectedLabel = computed(
  () => props.options.find(option => option.value === props.modelValue)?.label ?? ''
)

/** 估算菜单高度,够显示就往下放,否则翻到按钮上方 */
const MENU_ITEM_HEIGHT = 30

function place(): void {
  const el = trigger.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const estimated = props.options.length * MENU_ITEM_HEIGHT + 10
  const style: Record<string, string> = {
    position: 'fixed',
    right: `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`,
    minWidth: `${Math.round(rect.width)}px`
  }
  if (rect.bottom + estimated <= window.innerHeight - 8) {
    style.top = `${Math.round(rect.bottom + 4)}px`
  } else {
    style.bottom = `${Math.round(window.innerHeight - rect.top + 4)}px`
  }
  menuStyle.value = style
}

function onPointerDown(e: PointerEvent): void {
  const target = e.target as Node
  if (trigger.value?.contains(target) || menu.value?.contains(target)) return
  close()
}

function onViewportChange(): void {
  place()
}

function show(): void {
  place()
  open.value = true
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
}

function close(): void {
  if (!open.value) return
  open.value = false
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
}

function toggle(): void {
  if (open.value) close()
  else show()
}

function pick(value: string | number): void {
  emit('update:modelValue', value)
  close()
  trigger.value?.focus()
}

onBeforeUnmount(close)
</script>

<template>
  <div class="settings-select">
    <button
      ref="trigger"
      type="button"
      class="settings-select-trigger"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <span class="settings-select-value">{{ selectedLabel }}</span>
      <ChevronsUpDown :size="12" class="settings-select-chevron" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        class="settings-select-menu"
        role="listbox"
        :style="menuStyle"
      >
        <button
          v-for="option in options"
          :key="String(option.value)"
          type="button"
          role="option"
          class="settings-select-option"
          :class="{ 'is-active': option.value === modelValue }"
          :aria-selected="option.value === modelValue"
          @click="pick(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </Teleport>
  </div>
</template>
