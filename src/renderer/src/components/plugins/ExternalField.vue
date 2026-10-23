<script setup lang="ts">
/**
 * 外部 JSON 设置字段(清单里 `imark.kind: "external"`)。
 *
 * 值的唯一事实是目标文件(例如 `~/.claude/settings.json`)。这里不经过应用的
 * 配置存储:挂载时读文件,失焦/选择时写回文件,其它字段原样保留。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PluginField } from '@shared/plugins'
import HelpTip from '../HelpTip.vue'
import { api } from '../../services/api'

const props = defineProps<{ extensionId: string; field: PluginField }>()

const value = ref('')
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const error = ref('')
let seq = 0
let queued = false
let savedTimer: ReturnType<typeof setTimeout> | null = null

const secret = computed(() => props.field.external?.secret === true)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function flashSaved(): void {
  saved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = false
  }, 1500)
}

async function load(): Promise<void> {
  const current = ++seq
  loading.value = true
  error.value = ''
  try {
    const next = await api.readExtensionExternal(props.extensionId, props.field.key)
    if (current === seq) value.value = next
  } catch (err) {
    if (current === seq) error.value = messageOf(err)
  } finally {
    if (current === seq) loading.value = false
  }
}

watch(() => [props.extensionId, props.field.key], load, { immediate: true })

async function save(): Promise<void> {
  if (saving.value) {
    queued = true
    return
  }
  saving.value = true
  error.value = ''
  try {
    await api.writeExtensionExternal(props.extensionId, props.field.key, value.value)
    flashSaved()
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    saving.value = false
    if (queued) {
      queued = false
      void save()
    }
  }
}

function onInput(event: Event): void {
  value.value = (event.target as HTMLInputElement).value
}

function onChange(event: Event): void {
  value.value = (event.target as HTMLInputElement | HTMLSelectElement).value
  void save()
}

function clearValue(): void {
  value.value = ''
  void save()
}

onBeforeUnmount(() => {
  if (savedTimer) clearTimeout(savedTimer)
})
</script>

<template>
  <div class="plugin-field plugin-field-row">
    <span class="plugin-field-label">
      {{ field.label }}
      <HelpTip v-if="field.description" :text="field.description" />
    </span>

    <div class="plugin-external-control">
      <select
        v-if="field.options && field.options.length > 0"
        class="plugin-input plugin-input-select"
        :value="value"
        :disabled="loading || saving"
        @change="onChange"
      >
        <option value="">不设置</option>
        <option v-for="option in field.options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>

      <input
        v-else
        class="plugin-input plugin-field-control"
        :type="secret ? 'password' : 'text'"
        :value="value"
        :placeholder="field.placeholder"
        :disabled="loading || saving"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @change="onChange"
      />

      <button
        v-if="value && secret"
        type="button"
        class="plugin-btn"
        :disabled="saving"
        @click="clearValue"
      >
        清除
      </button>

      <span v-if="error" class="plugin-external-status plugin-external-error" :title="error">
        {{ error }}
      </span>
      <span v-else-if="saving" class="plugin-external-status">保存中…</span>
      <span v-else-if="saved" class="plugin-external-status">已保存</span>
      <span v-else-if="loading" class="plugin-external-status">读取中…</span>
    </div>
  </div>
</template>
