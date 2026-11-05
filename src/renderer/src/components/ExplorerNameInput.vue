<script setup lang="ts">
/**
 * 文件树里新建/改名的单行输入框。
 *
 * 确认时名字会被自动补上 `.md`(见 vaultService.withExtension),但输入框里
 * 只能显示用户敲的字 —— 一敲字,占位符连同 `.md` 一起消失,看起来像扩展名
 * 丢了。这里在文字后面用浅色补一个 ghost 后缀:它不参与取值,只提示最终会
 * 生成什么名字。
 */
import { computed, onMounted, ref } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  modelValue: string
  placeholder?: string
  /** 会被自动补上的扩展名;空串表示不提示 */
  suffix?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const inputEl = ref<HTMLInputElement | null>(null)

/** 输入框横向滚动量:ghost 跟着文字走,长名字滚到左边时不能飘在框外 */
const scrollLeft = ref(0)

/**
 * ghost 的行盒必须和输入框里的文字行盒完全重合。
 *
 * 输入框是表单控件,`line-height: normal` 用的是字体自身的 ascent + descent
 * (12px 下通常是 14px);而普通元素按 font metrics 算出来的 normal 会大一圈
 * (同一台机器上是 17px),多出来的行距上下均分,ghost 就会比文字低 1~2px。
 * 所以直接量出输入框内容区的高度当作 ghost 的 line-height,起点取边框 + 内边距。
 */
const textLine = ref<{ top: number; lineHeight: number } | null>(null)

function measureTextLine(): void {
  const el = inputEl.value
  if (!el) return
  const cs = getComputedStyle(el)
  textLine.value = {
    top: parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
    lineHeight: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  }
}

onMounted(measureTextLine)

/** 空值时交给占位符提示,不叠一层 ghost */
const ghostVisible = computed(() => !!props.suffix && props.modelValue !== '')

const ghostStyle = computed(() => ({
  transform: `translateX(-${scrollLeft.value}px)`,
  top: textLine.value ? `${textLine.value.top}px` : '3px',
  lineHeight: textLine.value ? `${textLine.value.lineHeight}px` : 'normal'
}))

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
  // 字号/字体若跟着系统设置变了,行高要重新量
  measureTextLine()
}

function onScroll(e: Event): void {
  scrollLeft.value = (e.target as HTMLInputElement).scrollLeft
}
</script>

<template>
  <span class="explorer-name-field">
    <!-- 事件与原生属性(enter/esc/blur)交给父组件,这里只多包一层用于放 ghost -->
    <input
      ref="inputEl"
      v-bind="$attrs"
      :value="modelValue"
      :placeholder="placeholder"
      @input="onInput"
      @scroll="onScroll"
    />
    <span
      v-if="ghostVisible"
      class="explorer-name-ghost"
      :style="ghostStyle"
      aria-hidden="true"
    ><span class="explorer-name-ghost-text">{{ modelValue }}</span>{{ suffix }}</span>
  </span>
</template>
