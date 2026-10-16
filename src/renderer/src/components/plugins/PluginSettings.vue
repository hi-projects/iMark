<script setup lang="ts">
import { computed, ref } from 'vue'
// 类型名与组件名 PluginField 冲突,这里给类型起别名
import {
  secretKey,
  targetSecretSlot,
  type PluginField as PluginFieldSpec,
  type PluginStatus,
  type PluginTarget
} from '@shared/plugins'
// 权限词表与中文说明定义在 pluginPackage(清单的概念),这里只取来展示
import { PERMISSION_INFO } from '@shared/pluginPackage'
import {
  openMarketSettings,
  pluginStore,
  runPluginAction,
  savePlugin,
  setPluginSecret,
  settingsNav
} from '../../services/pluginService'
import { copyText, marketStore, sourceLabel } from '../../services/marketService'
import PluginField from './PluginField.vue'


/** 复制过 integrity 的插件 id(短暂显示「已复制」) */
const copiedId = ref<string | null>(null)

/** 只有外部安装的插件才有来源/权限/校验值;内置核心插件这几行整个不显示 */
const hasMeta = computed(
  () => Boolean(selected.value?.installed) || Boolean(selected.value?.permissions?.length)
)

async function copyIntegrity(): Promise<void> {
  const p = selected.value
  if (!p?.installed) return
  if (!(await copyText(p.installed.integrity))) return
  copiedId.value = p.descriptor.id
  window.setTimeout(() => {
    if (copiedId.value === p.descriptor.id) copiedId.value = null
  }, 1500)
}

/**
 * 插件自己 log() 出来的行。第三方插件出问题时这是唯一的现场,
 * 所以默认展开最近 20 行、可折叠 —— 但**不**放进那个「运行状态」卡片里,
 * 免得把一次运行的结果和一串历史日志混成一团。
 */
const logsOpen = ref(false)
const recentLogs = computed(() => (selected.value?.logs ?? []).slice(-50))


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

    <!--
      开发模式(--plugin-dev=<目录>)加载的插件。它和装进来的插件在列表里长得一样,
      所以必须显眼地说清楚:代码不在 userData 里、改文件即时生效、重启应用就不见了。
    -->
    <div v-if="selected.dev" class="plugin-dev-banner">
      <span class="plugin-dev-dot" />
      <span>开发模式:代码来自你指定的目录,改文件即时生效;它不是安装进来的,重启应用就不在了</span>
    </div>

    <!-- 外部安装的插件:来源、权限与校验值(内置插件不显示这一块) -->
    <div v-if="hasMeta" class="plugin-meta">
      <div class="plugin-meta-line">
        <span class="plugin-chip">
          {{ selected.kind === 'script' ? '含可执行代码' : '无代码(声明式)' }}
        </span>
        <span class="plugin-chip">{{ sourceLabel(selected.source, marketStore.bundled.includes(selected.descriptor.id)) }}</span>
        <span v-if="selected.installed?.publisher" class="plugin-chip">
          发布者 {{ selected.installed.publisher }}
        </span>
        <span v-if="selected.kind === 'script'" class="plugin-meta-warn">
          此插件以完整权限运行,可读写你电脑上的任意文件
        </span>
      </div>
      <div v-if="selected.installed" class="plugin-meta-line">
        <span class="market-dim">安装于 {{ formatTime(selected.installed.installedAt) }}</span>
        <button
          class="plugin-chip plugin-chip-btn"
          :title="selected.installed.integrity"
          @click="copyIntegrity()"
        >
          {{ copiedId === selected.descriptor.id ? '已复制' : `sha256 ${selected.installed.integrity.slice(0, 12)}…` }}
        </button>
        <button class="plugin-link" @click="openMarketSettings('installed')">在市场里管理</button>
      </div>
      <div v-if="selected.permissions?.length" class="plugin-perm-bar">
        <span class="market-dim">权限</span>
        <!-- 只给一行小字做提示,完整的解释在安装确认框里 —— 那里才是要用户真正读进去的地方 -->
        <span
          v-for="perm in selected.permissions"
          :key="perm"
          class="plugin-chip"
          :title="PERMISSION_INFO[perm]?.description ?? ''"
        >
          {{ PERMISSION_INFO[perm]?.label ?? perm }}
        </span>
      </div>
    </div>

    <!-- 被宿主熔断:这不是「偶发失败」,是插件已经被停下来了,必须说清楚怎么恢复 -->
    <div v-if="selected.disabledByHost" class="plugin-status-card plugin-status-card-error">
      <div class="plugin-status-line">
        <b>已自动停用</b>
        <span>这个插件连续失败多次,宿主已停止调用它。修好配置或重装后再手动开启。</span>
      </div>
    </div>

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

    <!-- 插件自己的日志(第三方插件出问题时唯一的现场) -->
    <div v-if="recentLogs.length > 0" class="plugin-logs">
      <button class="plugin-link" @click="logsOpen = !logsOpen">
        {{ logsOpen ? '▾' : '▸' }} 插件日志(最近 {{ recentLogs.length }} 行)
      </button>
      <pre v-if="logsOpen" class="plugin-logs-body">{{ recentLogs.join('\n') }}</pre>
    </div>
  </div>
</template>
