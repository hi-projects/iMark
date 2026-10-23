<script setup lang="ts">
/**
 * 行首菜单里需要填参数的条目(如「表格」的行数/列数)弹的那个表单。
 *
 * 表单**完全由扩展声明的字段表渲染**(复用设置面板那套 PluginField),
 * 宿主不知道「行数」是什么,只知道「这里有个 number 字段,默认 3」。
 * 用户确定后值交给扩展,扩展算出要插入的文本,再回宿主来插入。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
// 类型与下面的组件同名,按设置面板的惯例把类型改名(PluginSettings.vue 同样处理)
import type { PluginField as PluginFieldSpec } from '@shared/plugins'
import { cancelLineDialog, confirmLineDialog, lineMenuStore } from '../services/lineMenu'
import PluginField from './plugins/PluginField.vue'

const bodyEl = ref<HTMLElement | null>(null)
const values = reactive<Record<string, unknown>>({})

const dialog = computed(() => lineMenuStore.dialog?.item.dialog ?? null)

// 这几个字段对话框里用不上(校验也挡掉了 targets/password),但 PluginField 要收
const NO_SECRETS: Record<string, string> = {}
const NO_ACTIONS: { id: string; label: string }[] = []

/** 打开时按字段表的 default 铺一遍初值,顺带把焦点放到第一个输入框 */
watch(
  () => lineMenuStore.dialog,
  async entry => {
    for (const key of Object.keys(values)) delete values[key]
    for (const field of entry?.item.dialog?.fields ?? []) values[field.key] = field.default
    await nextTick()
    bodyEl.value?.querySelector<HTMLElement>('input, select')?.focus()
  },
  { immediate: true }
)

function onChange(field: PluginFieldSpec, value: unknown): void {
  values[field.key] = value
}

function confirm(): void {
  confirmLineDialog({ ...values })
}

/**
 * Enter 确认前必须先把输入框里的值逼出来。
 *
 * PluginField 只在 `change` 上派值,而 Enter 的 keydown **早于**它引发的 change ——
 * 直接确认会拿着**上一个**值去建表(把行数从 3 改成 5 再回车,建出来还是 3 行)。
 * blur() 会触发 change,nextTick 之后 values 才是最新的。
 * 点「确定」按钮没有这个问题:mousedown → blur → change → click 的顺序天然安全。
 */
function onEnter(e: KeyboardEvent): void {
  e.preventDefault()
  ;(e.target as HTMLElement | null)?.blur()
  void nextTick().then(confirm)
}

/**
 * Esc 在**捕获阶段**监听:对话框的输入框失焦后按键会落到 CodeMirror 上,
 * 冒泡阶段拦不住(设置面板里的 Esc 也是这么处理的)。
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && lineMenuStore.dialog) {
    e.preventDefault()
    e.stopPropagation()
    cancelLineDialog()
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))
</script>

<template>
  <div v-if="dialog" class="line-dialog-mask" @mousedown.self="cancelLineDialog()">
    <div class="line-dialog" role="dialog" aria-modal="true">
      <div class="line-dialog-head">{{ dialog.title }}</div>
      <div ref="bodyEl" class="line-dialog-body" @keydown.enter="onEnter">
        <PluginField
          v-for="field in dialog.fields"
          :key="field.key"
          :field="field"
          :value="values[field.key]"
          hint=""
          :target-secrets="NO_SECRETS"
          :target-actions="NO_ACTIONS"
          @change="value => onChange(field, value)"
        />
      </div>
      <div class="line-dialog-foot">
        <button class="line-dialog-btn" @click="cancelLineDialog()">取消</button>
        <button class="line-dialog-btn line-dialog-primary" @click="confirm()">
          {{ dialog.confirmLabel ?? '确定' }}
        </button>
      </div>
    </div>
  </div>
</template>
