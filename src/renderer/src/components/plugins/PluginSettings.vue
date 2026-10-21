<script setup lang="ts">
/**
 * 扩展设置页(文件名保留 PluginSettings,免得到处改 import)。
 *
 * 数据全部来自主进程下发的 `ExtensionView`:配置键带扩展 ID 前缀,密钥只有掩码,
 * 状态是扩展最近一次 `imark.reportStatus()` 的结论,宿主组成来自分组规划器。
 * 界面不猜任何东西 —— 表单由 `contributes.configuration` 翻译出的 settingsFields
 * 驱动,动作由 `contributes['imark.actions']` 驱动。
 */
import { computed, ref } from 'vue'
import { FileText, RotateCw, Trash2 } from 'lucide-vue-next'
// 类型名与组件名 PluginField 冲突,这里给类型起别名
import {
  secretKey,
  targetSecretSlot,
  type PluginField as PluginFieldSpec,
  type PluginLogLevel,
  type PluginTarget
} from '@shared/plugins'
import type { ExtensionActionView } from '@shared/extensions'
import {
  extensionById,
  extensionStore,
  reloadExtension,
  reloadExtensionHost,
  runExtensionCommand,
  saveExtensionConfig,
  saveExtensionSecret,
  setExtensionEnabled,
  setExtensionHostSettings,
  uninstallExtension
} from '../../services/extensionService'
import { settingsNav } from '../../services/pluginService'
import { notifyError } from '../../services/notice'
import {
  pluginStatusLabel,
  pluginStatusMessage,
  pluginStatusTime,
  pluginStatusTone
} from '../../services/pluginStatus'
import { api } from '../../services/api'
import PluginField from './PluginField.vue'

/** 选中哪个扩展由左侧导航决定(settingsNav.pluginId) */
const selected = computed(() => extensionById(settingsNav.pluginId ?? ''))

const logsOpen = ref(false)
const recentLogs = computed(() => (selected.value?.logs ?? []).slice(-50))
const recentOps = computed(() => selected.value?.recentOps ?? [])

const LOG_LEVEL_LABEL: Record<PluginLogLevel, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  operation: '操作'
}

function logLevelLabel(level: PluginLogLevel): string {
  return LOG_LEVEL_LABEL[level]
}

function formatLogTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—'
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

// ---------- 配置 ----------

/** 配置在 `ExtensionView.config` 里是**完整键**;字段描述里是短键 */
function fullKey(field: PluginFieldSpec): string {
  const id = selected.value?.descriptor.id ?? ''
  return `${id}.${field.key}`
}

function fieldValue(field: PluginFieldSpec): unknown {
  return selected.value?.config[fullKey(field)] ?? field.default
}

/** 按 section 分组(相邻同名的归一组),并按 showWhen 过滤 */
const fieldGroups = computed(() => {
  const extension = selected.value
  if (!extension) return []
  const visible = extension.descriptor.settingsFields.filter(field => {
    if (!field.showWhen) return true
    const dependency = `${extension.descriptor.id}.${field.showWhen.key}`
    return extension.config[dependency] === field.showWhen.value
  })
  const out: { section: string | null; fields: PluginFieldSpec[] }[] = []
  for (const field of visible) {
    const section = field.section ?? null
    const last = out[out.length - 1]
    if (last && last.section === section) last.fields.push(field)
    else out.push({ section, fields: [field] })
  }
  return out
})

async function commit(field: PluginFieldSpec, value: unknown): Promise<void> {
  const extension = selected.value
  if (!extension) return
  await saveExtensionConfig(extension.descriptor.id, {
    ...extension.config,
    [fullKey(field)]: value
  })
}

function passwordHint(extensionId: string, field: PluginFieldSpec): string {
  return selected.value?.secrets[secretKey(extensionId, field.key)] ?? ''
}

function targetSecrets(extensionId: string, field: PluginFieldSpec): Record<string, string> {
  const out: Record<string, string> = {}
  if (!field.targetSecret) return out
  const value = fieldValue(field)
  if (!Array.isArray(value)) return out
  for (const target of value as PluginTarget[]) {
    const slot = targetSecretSlot(target)
    out[slot] = selected.value?.secrets[secretKey(extensionId, field.key, slot)] ?? ''
  }
  return out
}

function saveSecret(field: PluginFieldSpec, targetId: string | null, value: string | null): void {
  const extension = selected.value
  if (!extension) return
  void saveExtensionSecret(
    extension.descriptor.id,
    secretKey(extension.descriptor.id, field.key, targetId ?? undefined),
    value
  )
}

// ---------- 动作 ----------

const allActions = computed<ExtensionActionView[]>(() => {
  const id = selected.value?.descriptor.id
  if (!id) return []
  return (extensionStore.contribs?.actions ?? []).filter(action => action.extensionId === id)
})
const globalActions = computed(() => allActions.value.filter(action => action.scope === 'global'))
const targetActions = computed(() => allActions.value.filter(action => action.scope === 'target'))

/** 目标级动作挂在哪个「目标列表」字段上(清单里声明的 targetSetting 决定) */
const targetFieldKey = computed<string | null>(() => {
  const setting = targetActions.value.find(action => action.targetSetting)?.targetSetting
  const id = selected.value?.descriptor.id
  if (!setting || !id || !setting.startsWith(`${id}.`)) return null
  return setting.slice(id.length + 1)
})

function targetActionsFor(field: PluginFieldSpec): { id: string; label: string }[] {
  if (field.key !== targetFieldKey.value) return []
  return targetActions.value.map(action => ({ id: action.command, label: action.label }))
}

async function runAction(action: ExtensionActionView): Promise<void> {
  const result = await runExtensionCommand(action.command, [], 'action')
  if (!result.ok) return
}

async function runTargetAction(targetId: string, command: string): Promise<void> {
  await runExtensionCommand(command, [{ targetId, source: 'action' }], 'action')
}

// ---------- 启用 / 状态 ----------

async function toggleEnabled(enabled: boolean): Promise<void> {
  if (!selected.value) return
  await setExtensionEnabled(selected.value.descriptor.id, enabled)
}

const runtimeBad = computed(() => {
  const status = selected.value?.runtime.status
  return status === 'failed' || status === 'crashed' || status === 'crash-loop'
})

const statusState = computed(() => ({
  enabled: selected.value?.enabled ?? false,
  status: runtimeBad.value ? ('error' as const) : (selected.value?.status.status ?? 'idle')
}))

const statusTone = computed(() => (runtimeBad.value ? 'error' : pluginStatusTone(statusState.value)))
const statusLabel = computed(() => {
  const runtime = selected.value?.runtime.status
  if (runtime === 'failed') return '激活失败'
  if (runtime === 'crashed') return '宿主已退出'
  if (runtime === 'crash-loop') return '反复崩溃'
  return pluginStatusLabel(statusState.value)
})
const statusMessage = computed(() => {
  const extension = selected.value
  if (!extension) return ''
  if (runtimeBad.value) return extension.runtime.lastError ?? '扩展进程异常退出。'
  return pluginStatusMessage({
    enabled: extension.enabled,
    lastMessage: extension.status.lastMessage
  })
})

// ---------- 宿主 ----------

const hostMode = computed(() => extensionStore.hostSettings.mode)
const affinityValue = computed(() => {
  const id = selected.value?.descriptor.id
  return id ? (extensionStore.hostSettings.affinity[id] ?? null) : null
})

const hostGroups = computed(() => extensionStore.contribs?.hostGroups ?? [])

const hostGroupOfSelected = computed(() => {
  const id = selected.value?.descriptor.id
  return hostGroups.value.find(group => group.extensionIds.includes(id ?? '')) ?? null
})

function extensionName(id: string): string {
  return extensionById(id)?.descriptor.displayName ?? id
}

async function setMode(mode: 'isolated' | 'shared'): Promise<void> {
  await setExtensionHostSettings({ mode })
}

async function setAffinity(raw: string): Promise<void> {
  const extension = selected.value
  if (!extension) return
  const affinity = { ...extensionStore.hostSettings.affinity }
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
    delete affinity[extension.descriptor.id]
  } else {
    affinity[extension.descriptor.id] = Math.trunc(value)
  }
  await setExtensionHostSettings({ affinity })
}

/** 共享宿主里反复崩溃的扩展:给它一个独立组号,把它从出事的那组里挪出去 */
async function isolateSelected(): Promise<void> {
  const extension = selected.value
  if (!extension) return
  const used = Object.values(extensionStore.hostSettings.affinity)
  const next = Math.max(0, ...used) + 1
  await setExtensionHostSettings({
    affinity: { ...extensionStore.hostSettings.affinity, [extension.descriptor.id]: next }
  })
}

async function reloadHost(hostId: number): Promise<void> {
  await reloadExtensionHost(hostId)
}

async function reloadSelected(): Promise<void> {
  if (!selected.value) return
  await reloadExtension(selected.value.descriptor.id)
}

// ---------- 安装信息 ----------

const CAPABILITY_LABELS: Record<string, string> = {
  filesystem: '文件系统',
  network: '网络',
  secrets: '密钥存储',
  git: 'Git',
  process: '子进程',
  shell: 'Shell'
}

const capabilityLabels = computed(() => {
  const caps = selected.value?.descriptor.capabilities ?? {}
  const out: string[] = []
  for (const [key, label] of Object.entries(CAPABILITY_LABELS)) {
    const value = (caps as Record<string, unknown>)[key]
    if (!value) continue
    if (key === 'filesystem' && typeof value === 'string') {
      out.push(`${label}(${value === 'workspace' ? '仅工作区' : '用户目录'})`)
    } else {
      out.push(label)
    }
  }
  return out
})

async function openLog(): Promise<void> {
  if (!selected.value) return
  try {
    await api.openExtensionLog(selected.value.descriptor.id)
  } catch (err) {
    notifyError('打开扩展日志', err)
  }
}

async function removeSelected(): Promise<void> {
  const extension = selected.value
  if (!extension) return
  const ok = window.confirm(
    `卸载「${extension.descriptor.displayName}」？\n\n` +
      '这个扩展的配置、密钥与状态会被一并删除。扩展代码以你的用户权限运行，卸载后它就不能再访问任何东西。'
  )
  if (!ok) return
  await uninstallExtension(extension.descriptor.id)
}

const busy = computed(() => extensionStore.busy !== null)
</script>

<template>
  <!-- 扩展设置(选中哪个由左侧导航决定) -->
  <div v-if="selected" class="plugin-page">
    <div class="plugin-detail-head">
      <span class="plugin-detail-version">v{{ selected.descriptor.version }}</span>
      <label class="plugin-switch" :title="selected.enabled ? '停用' : '启用'">
        <input
          type="checkbox"
          :checked="selected.enabled"
          :disabled="busy"
          @change="toggleEnabled(!selected.enabled)"
        />
        <span class="plugin-switch-track" />
      </label>
    </div>

    <p class="plugin-field-desc">{{ selected.descriptor.description }}</p>

    <!-- 开发模式:代码不在数据目录里,改文件即时生效 -->
    <div v-if="selected.dev" class="plugin-dev-banner">
      <span class="plugin-dev-dot" />
      <span>开发模式：代码来自你指定的目录，改文件即时生效；它不是安装进来的，重启应用就不在了</span>
    </div>

    <div v-if="selected.loadError" class="plugin-status-card plugin-status-card-error">
      <div class="plugin-status-line">
        <b>加载失败</b>
        <span class="plugin-status-message">{{ selected.loadError }}</span>
      </div>
    </div>

    <div class="plugin-status-card" :class="`plugin-status-card-${statusTone}`">
      <div class="plugin-status-line">
        <b>{{ statusLabel }}</b>
        <span class="plugin-status-message">{{ statusMessage }}</span>
        <span class="plugin-status-time">
          {{ pluginStatusTime({ lastRunAt: selected.status.lastRunAt }, formatTime) }}
        </span>
      </div>
    </div>

    <div v-if="globalActions.length > 0" class="plugin-actions">
      <button
        v-for="action in globalActions"
        :key="action.command"
        class="plugin-btn"
        :class="{ 'plugin-btn-action': action.primary }"
        :disabled="!selected.enabled || busy"
        @click="runAction(action)"
      >
        {{ busy ? '执行中…' : action.label }}
      </button>
    </div>

    <div class="plugin-fields">
      <section v-for="(group, gi) in fieldGroups" :key="gi" class="plugin-group">
        <h3 v-if="group.section" class="plugin-group-title">{{ group.section }}</h3>
        <PluginField
          v-for="field in group.fields"
          :key="field.key"
          :field="field"
          :value="fieldValue(field)"
          :hint="passwordHint(selected.descriptor.id, field)"
          :target-secrets="targetSecrets(selected.descriptor.id, field)"
          :target-actions="targetActionsFor(field)"
          :target-results="selected.status.targetResults ?? {}"
          :busy-target="null"
          @change="v => commit(field, v)"
          @run-action="runTargetAction"
          @save-secret="v => saveSecret(field, null, v)"
          @clear-secret="saveSecret(field, null, null)"
          @save-target-secret="(targetId, v) => saveSecret(field, targetId, v)"
          @clear-target-secret="targetId => saveSecret(field, targetId, null)"
        />
      </section>

      <!-- 宿主:拓扑与 PID 是排查「一个扩展拖垮另一个」时最直接的信息 -->
      <section class="plugin-group">
        <h3 class="plugin-group-title">扩展宿主</h3>
        <div class="plugin-meta">
          <div class="plugin-meta-line">
            <span class="plugin-field-label">宿主模式</span>
            <span class="settings-presets">
              <button
                class="settings-preset"
                :class="{ 'settings-preset-active': hostMode === 'isolated' }"
                :disabled="busy"
                title="每个扩展一个进程：一个扩展崩溃不影响其他扩展"
                @click="setMode('isolated')"
              >
                每扩展独立进程
              </button>
              <button
                class="settings-preset"
                :class="{ 'settings-preset-active': hostMode === 'shared' }"
                :disabled="busy"
                title="所有扩展共用一个进程：省内存，但崩溃半径也共享"
                @click="setMode('shared')"
              >
                共享宿主
              </button>
            </span>
          </div>
          <div class="plugin-meta-line">
            <span class="plugin-field-label">affinity</span>
            <input
              class="settings-number"
              type="number"
              min="0"
              step="1"
              :value="affinityValue ?? ''"
              :placeholder="hostMode === 'isolated' ? '自动' : '与同号扩展同宿主'"
              :disabled="busy"
              @change="setAffinity(($event.target as HTMLInputElement).value)"
            />
            <span class="plugin-field-hint">
              正整数相同的扩展进同一个宿主；留空 = 按模式自动分组。
            </span>
          </div>
          <div v-if="hostGroups.length > 0" class="plugin-meta-line">
            <span class="plugin-field-label">当前宿主</span>
            <ul class="plugin-ops-list">
              <li v-for="group in hostGroups" :key="group.hostId" class="plugin-op">
                <div class="plugin-op-head">
                  <span class="plugin-op-result">#{{ group.hostId }}</span>
                  <span class="plugin-op-action">
                    {{ group.extensionIds.map(extensionName).join('、') }}
                  </span>
                  <span class="plugin-op-time">
                    {{ group.state }} · PID {{ group.pid ?? '—' }} ·
                    {{ formatBytes(group.memoryBytes) }}
                  </span>
                  <button
                    class="plugin-icon-btn"
                    title="重新加载这个宿主"
                    :disabled="busy"
                    @click="reloadHost(group.hostId)"
                  >
                    <RotateCw :size="12" />
                  </button>
                </div>
              </li>
            </ul>
          </div>
          <div class="plugin-meta-line">
            <span class="plugin-field-hint">
              共享宿主里，同组扩展共享进程、globalThis 与事件循环：一个扩展调用
              process.exit()、阻塞事件循环或触发原生崩溃，会带走同组其他扩展。
            </span>
            <button
              v-if="runtimeBad || (hostMode === 'shared' && hostGroupOfSelected && hostGroupOfSelected.extensionIds.length > 1)"
              class="plugin-btn"
              :disabled="busy"
              @click="isolateSelected()"
            >
              隔离到独立宿主
            </button>
          </div>
        </div>
      </section>

      <!--
        调试:最近 3 次操作结果 + 日志尾部(扩展自己 log() 的行 + 操作摘要)。
        完整版在数据根下的 logs/extensions/<id>.log,右上角用系统默认程序打开。
      -->
      <section class="plugin-group plugin-ops">
        <div class="plugin-ops-head">
          <h3 class="plugin-group-title">调试</h3>
          <span class="plugin-ops-tools">
            <button class="plugin-icon-btn" title="重新加载此扩展" :disabled="busy" @click="reloadSelected()">
              <RotateCw :size="13" />
            </button>
            <button class="plugin-icon-btn" title="打开完整日志文件" @click="openLog()">
              <FileText :size="13" />
            </button>
          </span>
        </div>
        <div v-if="recentOps.length === 0" class="plugin-ops-empty">还没有操作记录。</div>
        <ul v-else class="plugin-ops-list">
          <li v-for="op in recentOps" :key="`${op.at}:${op.action}`" class="plugin-op">
            <div class="plugin-op-head">
              <span
                class="plugin-op-result"
                :class="op.status === 'ok' ? 'plugin-op-ok' : 'plugin-op-bad'"
              >
                {{ op.status === 'ok' ? '成功' : op.status === 'partial' ? '部分失败' : '失败' }}
              </span>
              <span class="plugin-op-action">{{ op.action }}</span>
              <span class="plugin-op-time">{{ formatTime(op.at) }}</span>
            </div>
            <div class="plugin-op-message">{{ op.message }}</div>
            <pre v-if="op.detail" class="plugin-op-detail">{{ op.detail }}</pre>
          </li>
        </ul>
        <div v-if="recentLogs.length > 0" class="plugin-logs">
          <button class="plugin-link" @click="logsOpen = !logsOpen">
            {{ logsOpen ? '▾' : '▸' }} 扩展日志（最近 {{ recentLogs.length }} 条）
          </button>
          <ol v-if="logsOpen" class="plugin-logs-body">
            <li v-for="(line, i) in recentLogs" :key="i" class="plugin-log-line">
              <span class="plugin-log-time">{{ formatLogTime(line.at) }}</span>
              <span class="plugin-log-level" :class="`plugin-log-level-${line.level}`">
                {{ logLevelLabel(line.level) }}
              </span>
              <span class="plugin-log-message">{{ line.message }}</span>
            </li>
          </ol>
        </div>
      </section>

      <!-- 安装信息:来源、integrity、权限披露;卸载入口放在最后 -->
      <section class="plugin-group">
        <h3 class="plugin-group-title">安装信息</h3>
        <div class="plugin-meta">
          <div class="plugin-meta-line">
            <span class="plugin-field-hint">
              扩展代码以你的用户权限运行：能读写文件、执行命令、访问网络，不做权限沙箱。
            </span>
          </div>
          <div class="plugin-meta-line">
            <span class="plugin-field-label">来源</span>
            <span>{{ selected.source }}</span>
            <span v-if="selected.installed"> · 安装于 {{ formatTime(selected.installed.installedAt) }}</span>
          </div>
          <div v-if="selected.installed" class="plugin-meta-line">
            <span class="plugin-field-label">integrity</span>
            <code class="plugin-code">{{ selected.installed.integrity.slice(0, 24) }}…</code>
          </div>
          <div v-if="selected.installed?.mainSha256" class="plugin-meta-line">
            <span class="plugin-field-label">入口 sha256</span>
            <code class="plugin-code">{{ selected.installed.mainSha256.slice(0, 24) }}…</code>
          </div>
          <div class="plugin-meta-line">
            <span class="plugin-field-label">权限</span>
            <span>{{ capabilityLabels.length > 0 ? capabilityLabels.join('、') : '仅声明式贡献' }}</span>
          </div>
          <div class="plugin-meta-line">
            <span class="plugin-field-label">激活事件</span>
            <span>{{ selected.descriptor.activationEvents.join('、') || '无' }}</span>
          </div>
          <div v-if="selected.source !== 'bundled' && selected.installed" class="plugin-meta-line">
            <button class="plugin-btn" :disabled="busy" @click="removeSelected()">
              <Trash2 :size="13" />
              <span>卸载扩展</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
