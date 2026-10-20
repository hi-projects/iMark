<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RotateCcw } from 'lucide-vue-next'
import HelpTip from '../HelpTip.vue'
import type { PluginEndpoint, PluginField, PluginTarget, PluginTargetResult } from '@shared/plugins'
import EndpointsField from './EndpointsField.vue'
import TargetsField from './TargetsField.vue'

const props = withDefaults(
  defineProps<{
    field: PluginField
    value: unknown
    /** password 字段的密钥掩码('' = 未配置) */
    hint: string
    /** targets 字段:目标 id → 密钥掩码 */
    targetSecrets: Record<string, string>
    /** targets 字段:每一行自己的动作(如「测试连接」) */
    targetActions: { id: string; label: string }[]
    /** targets 字段:每个目标的最近一次操作结果(id → ok/error;没有条目 = 还没操作过) */
    targetResults?: Record<string, PluginTargetResult>
    /** 正在执行动作的目标 id */
    busyTarget: string | null
  }>(),
  { targetResults: () => ({}) }
)

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

/**
 * textarea 的本地草稿。
 *
 * 不能直接用 props.value 判断「是否改过默认值」:配置要经过 IPC 回写宿主再传回来,
 * 期间恢复图标会一直保持旧状态。草稿在每次 input 时同步,图标因此立即响应。
 */
const draft = ref(String(props.value ?? ''))
watch(
  () => props.value,
  value => {
    draft.value = String(value ?? '')
  }
)
const isDefault = computed(() => draft.value === String(props.field.default ?? ''))

function text(e: Event): string {
  return (e.target as HTMLInputElement | HTMLSelectElement).value
}

function onTextareaInput(e: Event): void {
  draft.value = (e.target as HTMLTextAreaElement).value
}

/**
 * 多行文本失焦提交。
 *
 * required 字段不允许空值:清空后直接还原成默认值并写回 DOM —— 只 emit 默认值不够,
 * 因为 prop 可能本来就是默认值,Vue 不会重新渲染这个 textarea。
 */
function onTextareaChange(e: Event): void {
  const input = e.target as HTMLTextAreaElement
  let value = input.value
  if (props.field.required && !value.trim()) {
    value = String(props.field.default ?? '')
    input.value = value
  }
  draft.value = value
  emit('change', value)
}

function resetToDefault(): void {
  draft.value = String(props.field.default ?? '')
  emit('change', props.field.default)
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
      :target-results="targetResults"
      :busy-target="busyTarget"
      @change="emit('change', $event)"
      @save-secret="(id, v) => emit('save-target-secret', id, v)"
      @clear-secret="id => emit('clear-target-secret', id)"
      @run-action="(id, actionId) => emit('run-action', id, actionId)"
    />
  </div>

  <!-- 地址列表:一行一张卡片,卡片里是地址 + 模型 + 该行自己的密钥 -->
  <div v-else-if="field.kind === 'endpoints'" class="plugin-field">
    <EndpointsField
      :field="field"
      :endpoints="Array.isArray(value) ? (value as PluginEndpoint[]) : []"
      :secrets="targetSecrets"
      :target-actions="targetActions"
      :target-results="targetResults"
      :busy-target="busyTarget"
      @change="emit('change', $event)"
      @save-secret="(id, v) => emit('save-target-secret', id, v)"
      @clear-secret="id => emit('clear-target-secret', id)"
      @run-action="(id, actionId) => emit('run-action', id, actionId)"
    />
  </div>

  <!-- 多行文本:标签在上、控件占满整行;标题旁始终有恢复默认图标 -->
  <div v-else-if="field.kind === 'textarea'" class="plugin-field plugin-field-block">
    <div class="plugin-field-head">
      <span class="plugin-field-label">
        {{ field.label }}
        <HelpTip v-if="field.description" :text="field.description" />
      </span>
      <div v-if="field.resettable" class="plugin-field-actions">
        <button
          type="button"
          class="plugin-icon-btn plugin-icon-btn-accent"
          :title="isDefault ? '当前已是默认提示词' : '恢复默认提示词'"
          aria-label="恢复默认提示词"
          :disabled="isDefault"
          @click="resetToDefault"
        >
          <RotateCcw :size="14" />
        </button>
      </div>
    </div>
    <textarea
      class="plugin-input plugin-textarea"
      :rows="field.rows ?? 8"
      :value="draft"
      :placeholder="field.placeholder"
      @input="onTextareaInput"
      @change="onTextareaChange"
    />
  </div>

  <!-- 其余字段统一「标签在左、控件在右」一行 -->
  <div v-else class="plugin-field plugin-field-row">
    <!-- 标签与问号占固定宽度的一格,后面的控件(输入框/开关)因此左边缘对齐 -->
    <span class="plugin-field-label">
      {{ field.label }}
      <HelpTip v-if="field.description" :text="field.description" />
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
