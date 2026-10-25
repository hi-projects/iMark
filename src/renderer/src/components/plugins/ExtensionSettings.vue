<script setup lang="ts">
/**
 * 扩展设置页。
 *
 * 数据全部来自主进程下发的 `ExtensionView`:配置键带扩展 ID 前缀,密钥只有掩码,
 * 状态是扩展最近一次 `imark.reportStatus()` 的结论,宿主组成来自分组规划器。
 * 界面不猜任何东西 —— 表单由 `contributes.configuration` 翻译出的 settingsFields
 * 驱动,动作由 `contributes['imark.actions']` 驱动。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { FileJson, FileText, RotateCw, Trash2 } from 'lucide-vue-next'
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
  refreshExtensions,
  reloadExtension,
  runExtensionCommand,
  saveExtensionField,
  saveExtensionSecret,
  setExtensionEnabled,
  uninstallExtension
} from '../../services/extensionService'
import { settingsNav } from '../../services/settingsNav'
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

// 日志与运行状态只存在主进程内存里:设置页每次打开、每次切换扩展都重新拉一次,
// 否则「调试」看到的还是应用启动时的旧快照。
onMounted(() => {
  void refreshExtensions()
})
watch(
  () => settingsNav.pluginId,
  () => void refreshExtensions()
)

const logsOpen = ref(false)
const recentLogs = computed(() => (selected.value?.logs ?? []).slice(-50))

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

/**
 * 只提交被改的那一项。
 *
 * 整份提交会把「从全局继承来的值」固化进当前仓库的覆盖层 —— 用户以后改全局
 * 默认值时,这些仓库就不会跟随了。主进程按清单里的 imark.scope 决定写入哪一层。
 */
async function commit(field: PluginFieldSpec, value: unknown): Promise<void> {
  // 外部设置由字段组件直接写目标文件,不能进应用的配置存储
  if (field.kind === 'external') return
  const extension = selected.value
  if (!extension) return
  await saveExtensionField(extension.descriptor.id, fullKey(field), value)
}

/** 这一组字段写在哪个外部配置文件里;没有外部字段返回 null */
function externalFieldOf(fields: PluginFieldSpec[]): PluginFieldSpec | null {
  return fields.find(field => field.kind === 'external' && field.external?.file) ?? null
}

async function openExternalFile(fields: PluginFieldSpec[]): Promise<void> {
  const extension = selected.value
  const field = externalFieldOf(fields)
  if (!extension || !field) return
  try {
    await api.openExtensionExternalFile(extension.descriptor.id, field.key)
  } catch (err) {
    notifyError('打开设置文件', err)
  }
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

/**
 * 动作执行期间至少让「进行中」露这么久。
 *
 * 「检查 Claude Code」这类命令可能几十毫秒就返回;不设下限的话,状态卡会从
 * 上一次的「成功」直接跳到新的「成功」,看起来像没执行。下限只影响很快的动作,
 * 慢动作(同步、测试连接)按实际耗时走。
 */
const ACTION_PENDING_MIN_MS = 300

/**
 * 动作执行状态:扩展 id → 正在执行的命令。
 *
 * 设置页在切换扩展时复用同一个组件实例,所以不能只存一个全局的 pending ——
 * 否则在「定时上传」点「立即上传」后切到别的扩展,那边也会显示「进行中」。
 * 只有发起动作的那个扩展显示自己的执行状态;不同扩展的动作互不阻塞。
 */
const pendingByExtension = reactive<Record<string, string>>({})
/** 当前选中扩展正在执行的动作;null = 没有 */
const pendingCommand = computed<string | null>(() => {
  const id = selected.value?.descriptor.id
  return id ? (pendingByExtension[id] ?? null) : null
})
const actionPending = computed(() => pendingCommand.value !== null)

async function runWithPending(command: string, run: () => Promise<void>): Promise<void> {
  const id = selected.value?.descriptor.id
  if (!id || pendingByExtension[id]) return
  pendingByExtension[id] = command
  const startedAt = Date.now()
  try {
    await run()
  } finally {
    const rest = ACTION_PENDING_MIN_MS - (Date.now() - startedAt)
    if (rest > 0) await new Promise(resolve => setTimeout(resolve, rest))
    delete pendingByExtension[id]
  }
}

async function runAction(action: ExtensionActionView): Promise<void> {
  await runWithPending(action.command, async () => {
    await runExtensionCommand(action.command, [], 'action')
    // 动作的结果会写进扩展日志,刷新后「调试」里立刻能看到这一条
    await refreshExtensions()
  })
}

async function runTargetAction(targetId: string, command: string): Promise<void> {
  await runWithPending(command, async () => {
    await runExtensionCommand(command, [{ targetId, source: 'action' }], 'action')
    await refreshExtensions()
  })
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
  status: actionPending.value
    ? ('running' as const)
    : runtimeBad.value
      ? ('error' as const)
      : (selected.value?.status.status ?? 'idle')
}))

const statusTone = computed(() =>
  actionPending.value
    ? 'running'
    : runtimeBad.value
      ? 'error'
      : pluginStatusTone(statusState.value)
)
const statusLabel = computed(() => {
  if (actionPending.value) return '进行中'
  const runtime = selected.value?.runtime.status
  if (runtime === 'failed') return '激活失败'
  if (runtime === 'crashed') return '进程已退出'
  if (runtime === 'crash-loop') return '反复崩溃'
  return pluginStatusLabel(statusState.value)
})
const statusMessage = computed(() => {
  if (actionPending.value) return '正在执行…'
  const extension = selected.value
  if (!extension) return ''
  if (runtimeBad.value) return extension.runtime.lastError ?? '扩展进程异常退出。'
  return pluginStatusMessage({
    enabled: extension.enabled,
    lastMessage: extension.status.lastMessage
  })
})
/** 失败原因等明细(reportStatus 的 detail);只有一行摘要时用户不知道去哪查 */
const statusDetail = computed(() => selected.value?.status.lastDetail ?? '')

// ---------- 调试 ----------

async function reloadSelected(): Promise<void> {
  if (!selected.value) return
  await reloadExtension(selected.value.descriptor.id)
}

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
          {{ pluginStatusTime({ lastRunAt: actionPending ? null : selected.status.lastRunAt }, formatTime) }}
        </span>
      </div>
      <div v-if="statusDetail && !actionPending" class="plugin-status-detail">{{ statusDetail }}</div>
    </div>

    <!-- 动作单独占一行;结果通过 reportStatus 写进上面的状态卡,不再弹通知 -->
    <div v-if="globalActions.length > 0" class="plugin-actions plugin-global-actions">
      <button
        v-for="action in globalActions"
        :key="action.command"
        class="plugin-btn"
        :class="{ 'plugin-btn-action': action.primary }"
        :disabled="!selected.enabled || busy || actionPending"
        @click="runAction(action)"
      >
        {{ pendingCommand === action.command ? '执行中…' : action.label }}
      </button>
    </div>

    <div class="plugin-fields">
      <section v-for="(group, gi) in fieldGroups" :key="gi" class="plugin-group">
        <h3 v-if="group.section" class="plugin-group-title">
          {{ group.section }}
          <button
            v-if="externalFieldOf(group.fields)"
            class="plugin-icon-btn"
            :title="`打开设置文件：${externalFieldOf(group.fields)?.external?.file ?? ''}`"
            @click="openExternalFile(group.fields)"
          >
            <FileJson :size="13" />
          </button>
        </h3>
        <PluginField
          v-for="field in group.fields"
          :key="field.key"
          :extension-id="selected.descriptor.id"
          :field="field"
          :value="fieldValue(field)"
          :hint="passwordHint(selected.descriptor.id, field)"
          :target-secrets="targetSecrets(selected.descriptor.id, field)"
          :target-actions="targetActionsFor(field)"
          :target-results="selected.status.targetResults ?? {}"
          @change="v => commit(field, v)"
          @run-action="runTargetAction"
          @save-secret="v => saveSecret(field, null, v)"
          @clear-secret="saveSecret(field, null, null)"
          @save-target-secret="(targetId, v) => saveSecret(field, targetId, v)"
          @clear-target-secret="targetId => saveSecret(field, targetId, null)"
        />
      </section>

      <!--
        调试:日志尾部(扩展自己 log() 的行 + 命令执行摘要)。
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
        <div v-if="recentLogs.length === 0" class="plugin-ops-empty">
          还没有日志。扩展运行时的输出与命令操作会显示在这里。
        </div>
        <div v-else class="plugin-logs">
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

      <!-- 安装信息已集中到「已安装」页;这里只留下卸载这个操作 -->
      <div
        v-if="selected.source !== 'bundled' && selected.installed"
        class="plugin-actions"
      >
        <button class="plugin-btn plugin-btn-danger" :disabled="busy" @click="removeSelected()">
          <Trash2 :size="13" />
          <span>卸载扩展</span>
        </button>
      </div>
    </div>
  </div>
</template>
