<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileText } from 'lucide-vue-next'
// 类型名与组件名 PluginField 冲突,这里给类型起别名
import {
  secretKey,
  targetSecretSlot,
  type PluginField as PluginFieldSpec,
  type PluginLogLevel,
  type PluginTarget
} from '@shared/plugins'
import {
  pluginStore,
  runPluginAction,
  savePlugin,
  setPluginNetAccess,
  setPluginSecret,
  settingsNav
} from '../../services/pluginService'
import { notifyError } from '../../services/notice'
import {
  pluginStatusLabel,
  pluginStatusMessage,
  pluginStatusTime,
  pluginStatusTone
} from '../../services/pluginStatus'
import { api } from '../../services/api'
import PluginField from './PluginField.vue'

/** restricted main 且声明了联网,才给出「允许访问本机地址」 */
const restrictedNetToggle = computed(
  () =>
    selected.value?.mainMode === 'restricted' &&
    selected.value.permissions?.includes('network')
)

/**
 * 顶部信息卡:只有「发布者」和 restricted 的联网开关需要它。
 *
 * 来源(内置 / 市场)、形态、安装时间、sha256 与权限明细都在市场「已安装」里 ——
 * 同一件事只说一遍。
 */
const hasMeta = computed(
  () => Boolean(selected.value?.installed?.publisher) || restrictedNetToggle.value
)

/**
 * 日志尾巴:插件自己 log() 的行 + 宿主记录的操作摘要/警告。
 *
 * 与 `logs/plugins/<id>.log` 是同一份内容(那边保留完整历史) —— 第三方插件出问题时
 * 这是唯一的现场。默认收起、可展开;不放进「运行状态」卡片,免得把一次运行的结果
 * 和一串历史日志混成一团。
 */
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

/** 日志行的时间精确到秒;完整日期留给磁盘日志文件 */
function formatLogTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 最近 3 次操作(宿主已截好);新的在前 */
const recentOps = computed(() => selected.value?.recentOps ?? [])


/** 选中哪个插件由左侧导航决定(settingsNav) */
const selected = computed(() =>
  pluginStore.list.find(p => p.descriptor.id === settingsNav.pluginId)
)

function formatTime(ts: number): string {
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

/** 用系统默认程序打开完整日志文件(不存在时主进程会先建一个空文件) */
async function openLog(): Promise<void> {
  if (!selected.value) return
  try {
    await api.openPluginLog(selected.value.descriptor.id)
  } catch (err) {
    notifyError('打开插件日志', err)
  }
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
      所以必须显眼地说清楚:代码不在数据目录里、改文件即时生效、重启应用就不见了。
    -->
    <div v-if="selected.dev" class="plugin-dev-banner">
      <span class="plugin-dev-dot" />
      <span>开发模式：代码来自你指定的目录，改文件即时生效；它不是安装进来的，重启应用就不在了</span>
    </div>

    <!--
      装进来的插件:只剩发布者。
      来源(内置 / 市场)、形态、安装时间、sha256 与权限明细都在市场「已安装」里 ——
      同一件事只说一遍。
    -->
    <div v-if="hasMeta" class="plugin-meta">
      <div class="plugin-meta-line">
        <span v-if="selected.installed?.publisher" class="plugin-chip">
          发布者 {{ selected.installed.publisher }}
        </span>
      </div>
      <!--
        restricted main 的联网开关:
        默认拒绝(见 main/plugins/ops.ts 的 net.fetch),需要连本机服务的插件由**用户**在这里放开。
      -->
      <div v-if="restrictedNetToggle" class="plugin-meta-line">
        <label
          class="plugin-net-toggle"
          title="默认拒绝插件访问 127.0.0.1 与内网地址。需要连你本机跑的服务时才打开。"
        >
          <input
            type="checkbox"
            :checked="selected.allowLocalNet === true"
            @change="setPluginNetAccess(selected.descriptor.id, !selected.allowLocalNet)"
          />
          <span>允许访问本机地址</span>
        </label>
      </div>
    </div>

    <!-- 被宿主熔断:这不是「偶发失败」,是插件已经被停下来了,必须说清楚怎么恢复 -->
    <div v-if="selected.disabledByHost" class="plugin-status-card plugin-status-card-error">
      <div class="plugin-status-line">
        <b>已自动停用</b>
        <span>这个插件连续失败多次，宿主已停止调用它。修好配置或重装后再手动开启。</span>
      </div>
    </div>

    <div class="plugin-status-card" :class="`plugin-status-card-${pluginStatusTone(selected.state)}`">
      <div class="plugin-status-line">
        <b>{{ pluginStatusLabel(selected.state) }}</b>
        <span class="plugin-status-message">{{ pluginStatusMessage(selected.state) }}</span>
        <span class="plugin-status-time">
          {{ pluginStatusTime(selected.state, formatTime) }}
        </span>
      </div>
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
          :target-results="selected.state.targetResults ?? {}"
          :busy-target="targetBusyId"
          @change="v => commit(field, v)"
          @run-action="runTargetAction"
          @save-secret="v => saveSecret(field, null, v)"
          @clear-secret="saveSecret(field, null, null)"
          @save-target-secret="(targetId, v) => saveSecret(field, targetId, v)"
          @clear-target-secret="targetId => saveSecret(field, targetId, null)"
        />
      </section>

      <!--
        调试:最近 3 次操作结果 + 日志尾部(插件自己 log() 的行 + 操作摘要)。
        完整版(含更早的操作与全部日志行)在数据根下的 logs/plugins/<id>.log,
        右上角的小图标用系统默认程序打开它。
      -->
      <section class="plugin-group plugin-ops">
        <div class="plugin-ops-head">
          <h3 class="plugin-group-title">调试</h3>
          <button class="plugin-icon-btn" title="打开完整日志文件" @click="openLog()">
            <FileText :size="13" />
          </button>
        </div>
        <div v-if="recentOps.length === 0" class="plugin-ops-empty">还没有操作记录。</div>
        <ul v-else class="plugin-ops-list">
          <li v-for="op in recentOps" :key="`${op.at}:${op.action}`" class="plugin-op">
            <div class="plugin-op-head">
              <span class="plugin-op-result" :class="op.status === 'ok' ? 'plugin-op-ok' : 'plugin-op-bad'">
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
            {{ logsOpen ? '▾' : '▸' }} 插件日志（最近 {{ recentLogs.length }} 条）
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
    </div>
  </div>
</template>
