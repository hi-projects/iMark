<script setup lang="ts">
import { computed } from 'vue'
// 类型名与组件名 PluginField 冲突,这里给类型起别名
import {
  secretKey,
  targetSecretSlot,
  type PluginField as PluginFieldSpec,
  type PluginStatus,
  type PluginTarget
} from '@shared/plugins'
import {
  pluginStore,
  runPluginAction,
  savePlugin,
  setPluginSecret,
  settingsNav
} from '../../services/pluginService'
import PluginField from './PluginField.vue'


/** 选中哪个插件由左侧导航决定(settingsNav) */
const selected = computed(() =>
  pluginStore.list.find(p => p.descriptor.id === settingsNav.pluginId)
)

const STATUS_LABEL: Record<PluginStatus, string> = {
  idle: '待运行',
  running: '进行中',
  ok: '成功',
  error: '失败'
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '从未运行'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 提交单个字段:整体替换该插件的 config,主进程会归一化后回传 */
async function commit(field: PluginFieldSpec, value: unknown): Promise<void> {
  if (!selected.value) return
  const id = selected.value.descriptor.id
  await savePlugin(id, { config: { ...selected.value.config, [field.key]: value } })
}

/** 按 section 分组(相邻同名的归一组;没有 section 的单独一组且不显示标题),并按 showWhen 过滤 */
const fieldGroups = computed(() => {
  const config = selected.value?.config ?? {}
  const visible = (selected.value?.descriptor.fields ?? []).filter(
    f => !f.showWhen || config[f.showWhen.key] === f.showWhen.value
  )
  const out: { section: string | null; fields: PluginFieldSpec[] }[] = []
  for (const field of visible) {
    const section = field.section ?? null
    const last = out[out.length - 1]
    if (last && last.section === section) last.fields.push(field)
    else out.push({ section, fields: [field] })
  }
  return out
})

function passwordHint(pluginId: string, field: PluginFieldSpec): string {
  return selected.value?.secrets[secretKey(pluginId, field.key)] ?? ''
}

/** 只对带 targetSecret 的「目标列表」字段有意义;其他字段直接返回空表(否则会遍历到数字/字符串上去) */
function targetSecrets(pluginId: string, field: PluginFieldSpec): Record<string, string> {
  const out: Record<string, string> = {}
  if (!field.targetSecret) return out
  const value = selected.value?.config[field.key]
  if (!Array.isArray(value)) return out
  for (const t of value as PluginTarget[]) {
    const slot = targetSecretSlot(t)
    out[slot] = selected.value?.secrets[secretKey(pluginId, field.key, slot)] ?? ''
  }
  return out
}

async function toggleEnabled(enabled: boolean): Promise<void> {
  if (!selected.value) return
  await savePlugin(selected.value.descriptor.id, { enabled })
}

async function runAction(action: string): Promise<void> {
  if (!selected.value) return
  await runPluginAction(selected.value.descriptor.id, action)
}

function busyWith(action: string): boolean {
  return Boolean(selected.value) && pluginStore.busy === `${selected.value!.descriptor.id}:${action}`
}

/** 正在执行「目标级动作」的目标 id(busy 形如 plugin:action:targetId) */
const targetBusyId = computed<string | null>(() => {
  const busy = pluginStore.busy
  const id = selected.value?.descriptor.id
  if (!busy || !id || !busy.startsWith(`${id}:`)) return null
  const rest = busy.slice(id.length + 1).split(':')
  return rest.length >= 2 ? rest[1] : null
})

async function runTargetAction(targetId: string, actionId: string): Promise<void> {
  if (!selected.value) return
  await runPluginAction(selected.value.descriptor.id, actionId, targetId)
}

function saveSecret(field: PluginFieldSpec, targetId: string | null, value: string | null): void {
  if (!selected.value) return
  void setPluginSecret(selected.value.descriptor.id, field.key, targetId, value)
}
</script>

<template>
  <!-- 插件配置(选中哪个由左侧导航决定) -->
  <div v-if="selected" class="plugin-page">
    <div class="plugin-detail-head">
      <span class="plugin-detail-version">v{{ selected.descriptor.version }}</span>
      <label class="plugin-switch" :title="selected.state.enabled ? '停用' : '启用'">
        <input type="checkbox" :checked="selected.state.enabled" @change="toggleEnabled(!selected.state.enabled)" />
        <span class="plugin-switch-track" />
      </label>
    </div>

    <p class="plugin-field-desc">{{ selected.descriptor.description }}</p>

    <div class="plugin-status-card" :class="`plugin-status-card-${selected.state.status}`">
      <div class="plugin-status-line">
        <b>{{ STATUS_LABEL[selected.state.status] }}</b>
        <span>{{ selected.state.lastMessage || '尚未运行' }}</span>
        <span class="plugin-status-time">{{ formatTime(selected.state.lastRunAt) }}</span>
      </div>
      <pre v-if="selected.state.lastDetail" class="plugin-status-detail">{{ selected.state.lastDetail }}</pre>
    </div>

    <div class="plugin-actions">
      <button
        v-for="action in selected.descriptor.actions"
        :key="action.id"
        class="plugin-btn plugin-btn-action"
        :disabled="!selected.state.enabled || busyWith(action.id)"
        @click="runAction(action.id)"
      >
        {{ busyWith(action.id) ? '执行中…' : action.label }}
      </button>
    </div>

    <div class="plugin-fields">
      <section v-for="(group, gi) in fieldGroups" :key="gi" class="plugin-group">
        <h3 v-if="group.section" class="plugin-group-title">{{ group.section }}</h3>
        <PluginField
          v-for="field in group.fields"
          :key="field.key"
          :field="field"
          :value="selected.config[field.key]"
          :hint="passwordHint(selected.descriptor.id, field)"
          :target-secrets="targetSecrets(selected.descriptor.id, field)"
          :target-actions="field.key === selected.descriptor.targetFieldKey ? (selected.descriptor.targetActions ?? []) : []"
          :busy-target="targetBusyId"
          @change="v => commit(field, v)"
          @run-action="runTargetAction"
          @save-secret="v => saveSecret(field, null, v)"
          @clear-secret="saveSecret(field, null, null)"
          @save-target-secret="(targetId, v) => saveSecret(field, targetId, v)"
          @clear-target-secret="targetId => saveSecret(field, targetId, null)"
        />
      </section>
    </div>
  </div>
</template>
