<script setup lang="ts">
import { ref } from 'vue'
import { CircleHelp } from 'lucide-vue-next'
import type { PluginField, PluginTarget } from '@shared/plugins'
import TargetsField from './TargetsField.vue'

const props = defineProps<{
  field: PluginField
  value: unknown
  /** password 字段的密钥掩码('' = 未配置) */
  hint: string
  /** targets 字段:目标 id → 密钥掩码 */
  targetSecrets: Record<string, string>
  /** targets 字段:每一行自己的动作(如「测试连接」) */
  targetActions: { id: string; label: string }[]
  /** 正在执行动作的目标 id */
  busyTarget: string | null
}>()

const emit = defineEmits<{
  (e: 'change', value: unknown): void
  (e: 'save-secret', value: string): void
  (e: 'clear-secret'): void
  (e: 'save-target-secret', targetId: string, value: string): void
  (e: 'clear-target-secret', targetId: string): void
  (e: 'run-action', targetId: string, actionId: string): void
}>()

/** 已配置的密钥默认收起输入框,点「更换」才展开 */
const replacing = ref(false)

function text(e: Event): string {
  return (e.target as HTMLInputElement | HTMLSelectElement).value
}

function numberValue(e: Event): number {
  const n = Number((e.target as HTMLInputElement).value)
  return Number.isFinite(n) ? n : (props.field.default as number)
}

function bool(e: Event): boolean {
  return (e.target as HTMLInputElement).checked
}

function onSecretInput(e: Event): void {
  const input = e.target as HTMLInputElement
  const value = input.value.trim()
  if (!value) return
  emit('save-secret', value)
  input.value = ''
  replacing.value = false
}
</script>

<template>
  <!-- 目标列表自带整块布局 -->
  <div v-if="field.kind === 'targets'" class="plugin-field">
    <TargetsField
      :field="field"
      :targets="Array.isArray(value) ? (value as PluginTarget[]) : []"
      :secrets="targetSecrets"
      :target-actions="targetActions"
      :busy-target="busyTarget"
      @change="emit('change', $event)"
      @save-secret="(id, v) => emit('save-target-secret', id, v)"
      @clear-secret="id => emit('clear-target-secret', id)"
      @run-action="(id, actionId) => emit('run-action', id, actionId)"
    />
  </div>

  <!-- 其余字段统一「标签在左、控件在右」一行 -->
  <div v-else class="plugin-field plugin-field-row">
    <!-- 标签与问号占固定宽度的一格,后面的控件(输入框/开关)因此左边缘对齐 -->
    <span class="plugin-field-label">
      {{ field.label }}
      <span v-if="field.description" class="plugin-field-help" :title="field.description">
        <CircleHelp :size="13" />
      </span>
    </span>

    <label v-if="field.kind === 'boolean'" class="plugin-switch">
      <input type="checkbox" :checked="Boolean(value)" @change="emit('change', bool($event))" />
      <span class="plugin-switch-track" />
    </label>

    <input
      v-else-if="field.kind === 'text'"
      class="plugin-input plugin-field-control"
      type="text"
      :value="String(value ?? '')"
      :placeholder="field.placeholder"
      @change="emit('change', text($event))"
    />

    <input
      v-else-if="field.kind === 'number'"
      class="plugin-input plugin-input-num"
      type="number"
      :value="Number(value ?? field.default)"
      :min="field.min"
      :max="field.max"
      @change="emit('change', numberValue($event))"
    />

    <select
      v-else-if="field.kind === 'select'"
      class="plugin-input plugin-input-select"
      :value="String(value ?? '')"
      @change="emit('change', text($event))"
    >
      <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </select>

    <template v-else-if="field.kind === 'password'">
      <b v-if="hint && !replacing" class="plugin-secret-mask plugin-secret-on">{{ hint }}</b>
      <input
        v-if="!hint || replacing"
        class="plugin-input plugin-field-control"
        type="password"
        :placeholder="field.placeholder ?? '粘贴令牌后回车或失焦保存'"
        @change="onSecretInput($event)"
      />
      <button v-if="hint && replacing" class="plugin-btn" @click="replacing = false">取消</button>
      <button v-if="hint && !replacing" class="plugin-btn" @click="replacing = true">更换</button>
      <button v-if="hint" class="plugin-btn" @click="emit('clear-secret')">清除</button>
    </template>
  </div>
</template>
