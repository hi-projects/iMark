<script setup lang="ts">
/**
 * 市场 · 扩展宿主 —— 集中管理全部插件的宿主分配。
 *
 * 宿主模式与 affinity 是**全局**设置,所以不放在单个插件页里:这一页按宿主
 * 分组展示正在运行的插件,把已停用 / 加载失败 / 纯声明的插件放进「未分配宿主」,
 * 让用户在一屏里决定谁和谁同进程。
 *
 * 分组结果只认主进程推送的 `contribs.hostGroups`:渲染层不重算规划器
 * (清单里的 extensionAffinity 不在 DTO 里),否则两边会给出不同的分组。
 */

import { computed, onMounted } from 'vue'
import { RotateCw } from 'lucide-vue-next'
import type {
  ExtensionHostGroupView,
  ExtensionHostMode,
  ExtensionView
} from '@shared/extensions'
import {
  extensionById,
  extensionStore,
  refreshExtensions,
  reloadExtensionHost,
  setExtensionHostSettings
} from '../../services/extensionService'
import { formatBytes } from '../../utils/text'

const mode = computed(() => extensionStore.hostSettings.mode)
const groups = computed(() => extensionStore.contribs?.hostGroups ?? [])

/** 每张宿主卡:分组本身 + 能在已安装列表里找到的成员视图 */
const groupRows = computed(() =>
  groups.value.map(group => ({
    group,
    members: group.extensionIds
      .map(id => extensionById(id))
      .filter((view): view is ExtensionView => Boolean(view))
  }))
)

const assigned = computed(() => new Set(groups.value.flatMap(group => group.extensionIds)))
const assignedCount = computed(() => assigned.value.size)
const groupCount = computed(() => groups.value.length)

/** 未进入宿主计划的插件:已停用、加载失败、纯声明,或刚改完设置还没推送 */
const unassigned = computed(() =>
  [...extensionStore.list]
    .filter(view => !assigned.value.has(view.descriptor.id))
    .sort((a, b) => a.descriptor.displayName.localeCompare(b.descriptor.displayName, 'zh-CN'))
)

const codeCount = computed(
  () => extensionStore.list.filter(view => Boolean(view.descriptor.main)).length
)
const enabledCodeCount = computed(
  () => extensionStore.list.filter(view => view.enabled && !view.loadError && view.descriptor.main).length
)

const busy = computed(() => extensionStore.busy !== null)

// ---------- 操作 ----------
//
// mutate() 在 extensionStore.busy 非空时会静默返回 false(不排队),所以这里
// 自己串行化:刚改完编号又点模式时,第二次操作不会被丢掉。

let chain: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): void {
  chain = chain.then(task).catch(() => {
    // 错误已由 extensionService 弹过提示
  })
}

function setMode(next: ExtensionHostMode): void {
  if (mode.value === next) return
  enqueue(async () => {
    await setExtensionHostSettings({ mode: next })
  })
}

function affinityOf(view: ExtensionView): number | null {
  return extensionStore.hostSettings.affinity[view.descriptor.id] ?? null
}

/**
 * 提交分组编号:留空 / 非法 / 小于 1 都等于删除编号(按模式自动分组)。
 *
 * 用 @change 而不是 @input:每敲一位就写盘会立刻重启宿主。提交后按 store 里的
 * 规范值回写 input —— 非法输入(如 0)不会改变 store,单靠 :value 不会复原输入框。
 */
function commitAffinity(view: ExtensionView, event: Event): void {
  const input = event.target as HTMLInputElement
  const raw = input.value
  const affinity = { ...extensionStore.hostSettings.affinity }
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
    delete affinity[view.descriptor.id]
  } else {
    affinity[view.descriptor.id] = Math.trunc(value)
  }
  enqueue(async () => {
    await setExtensionHostSettings({ affinity })
    input.value = String(affinityOf(view) ?? '')
  })
}

/** 回车立即提交;blur 会触发 change */
function onAffinityEnter(event: KeyboardEvent): void {
  ;(event.target as HTMLInputElement).blur()
}

/** 共享组里把某个插件挪到独立编号;依赖关系拆不开的行不显示这个按钮 */
function isolate(view: ExtensionView): void {
  const used = Object.values(extensionStore.hostSettings.affinity)
  const next = Math.max(0, ...used) + 1
  enqueue(async () => {
    await setExtensionHostSettings({
      affinity: { ...extensionStore.hostSettings.affinity, [view.descriptor.id]: next }
    })
  })
}

function reloadHost(hostId: number): void {
  enqueue(async () => {
    await reloadExtensionHost(hostId)
  })
}

// ---------- 展示 ----------

const HOST_STATE_LABEL: Record<ExtensionHostGroupView['state'], string> = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  crashed: '已崩溃',
  'crash-loop': '反复崩溃'
}

function hostStateLabel(state: ExtensionHostGroupView['state']): string {
  return HOST_STATE_LABEL[state]
}

function hostTone(state: ExtensionHostGroupView['state']): 'idle' | 'running' | 'ok' | 'error' {
  if (state === 'running') return 'ok'
  if (state === 'starting') return 'running'
  if (state === 'crashed' || state === 'crash-loop') return 'error'
  return 'idle'
}

function memberTone(view: ExtensionView): 'idle' | 'running' | 'ok' | 'error' {
  if (view.loadError) return 'error'
  if (!view.enabled) return 'idle'
  const status = view.runtime.status
  if (status === 'failed' || status === 'crashed' || status === 'crash-loop') return 'error'
  if (status === 'activating') return 'running'
  if (status === 'active') return 'ok'
  return 'idle'
}

function memberStateLabel(view: ExtensionView): string {
  if (view.loadError) return '加载失败'
  if (!view.enabled) return '已停用'
  switch (view.runtime.status) {
    case 'active':
      return '已激活'
    case 'activating':
      return '正在激活'
    case 'failed':
      return '激活失败'
    case 'crashed':
      return '宿主已退出'
    case 'crash-loop':
      return '反复崩溃'
    case 'inactive':
      return '已启用，等待激活'
    default:
      return '已启用'
  }
}

function memoryLabel(bytes: number | null): string {
  return bytes ? formatBytes(bytes) : '—'
}

/** 懒激活的插件分配了宿主但还没拉起进程;重启对它没有意义 */
function canReload(group: ExtensionHostGroupView): boolean {
  return group.state !== 'stopped' && group.state !== 'starting'
}

function reloadTitle(group: ExtensionHostGroupView): string {
  if (group.state === 'stopped') return '重新加载这个宿主（尚未启动，无需重启）'
  if (group.state === 'starting') return '重新加载这个宿主（正在启动）'
  return '重新加载这个宿主'
}

/** 同组内存在依赖边时,affinity 编号也拆不开它们 */
function forcedByDependency(view: ExtensionView): boolean {
  const group = groups.value.find(item => item.extensionIds.includes(view.descriptor.id))
  if (!group) return false
  const peers = group.extensionIds.filter(id => id !== view.descriptor.id)
  if (view.descriptor.extensionDependencies.some(dep => peers.includes(dep))) return true
  return peers.some(peerId => {
    const peer = extensionById(peerId)
    return peer?.descriptor.extensionDependencies.includes(view.descriptor.id) ?? false
  })
}

/** 打开面板时主动拉一次:推送是事件驱动的,首次进入不能只等下一次变化 */
onMounted(() => {
  void refreshExtensions()
})
</script>

<template>
  <div class="market-tab-body market-hosts">
    <section class="market-host-mode">
      <div class="market-host-mode-info">
        <div class="market-host-mode-title">宿主模式</div>
        <p class="market-hint">
          每个扩展跑在独立的扩展宿主进程里：一个扩展崩溃不会影响其他扩展。共享宿主更省内存，
          但同组扩展共享进程、globalThis 与事件循环。
        </p>
      </div>
      <span class="settings-presets">
        <button
          class="settings-preset"
          :class="{ 'settings-preset-active': mode === 'isolated' }"
          :disabled="busy"
          title="每个扩展一个进程：一个扩展崩溃不影响其他扩展"
          @click="setMode('isolated')"
        >
          每扩展独立进程
        </button>
        <button
          class="settings-preset"
          :class="{ 'settings-preset-active': mode === 'shared' }"
          :disabled="busy"
          title="所有扩展共用一个进程：省内存，但崩溃半径也共享"
          @click="setMode('shared')"
        >
          共享宿主
        </button>
      </span>
    </section>

    <p v-if="groups.length > 0" class="market-hint">
      当前 {{ groupCount }} 个宿主、{{ assignedCount }} 个含代码插件。分组编号相同的插件进同一宿主，
      留空按模式自动分组；编号只是分组标记，不等于宿主号。清单里的
      <code class="market-mono">extensionDependencies</code> 与
      <code class="market-mono">extensionAffinity</code> 会强制同组。
    </p>

    <div v-if="extensionStore.contribs === null" class="market-empty">
      <p>正在读取宿主状态…</p>
    </div>

    <template v-else>
      <div v-if="groups.length > 0" class="market-host-groups">
        <section
          v-for="row in groupRows"
          :key="row.group.hostId"
          class="market-host-card"
        >
          <header class="market-host-head">
            <span
              class="plugin-status-dot"
              :class="`plugin-status-${hostTone(row.group.state)}`"
              :title="hostStateLabel(row.group.state)"
            />
            <b>宿主 #{{ row.group.hostId }}</b>
            <span class="market-host-meta">
              {{ hostStateLabel(row.group.state) }} · PID {{ row.group.pid ?? '—' }} ·
              {{ memoryLabel(row.group.memoryBytes) }}
            </span>
            <span class="market-host-count">{{ row.members.length }} 个插件</span>
            <button
              class="plugin-icon-btn"
              :title="reloadTitle(row.group)"
              :disabled="busy || !canReload(row.group)"
              @click="reloadHost(row.group.hostId)"
            >
              <RotateCw :size="13" />
            </button>
          </header>

          <ul class="market-host-members">
            <li
              v-for="view in row.members"
              :key="view.descriptor.id"
              class="market-host-row"
            >
              <span
                class="plugin-status-dot"
                :class="`plugin-status-${memberTone(view)}`"
                :title="memberStateLabel(view)"
              />
              <span class="market-host-name" :title="view.descriptor.displayName">
                {{ view.descriptor.displayName }}
              </span>
              <span v-if="forcedByDependency(view)" class="market-badge">依赖同组</span>
              <label class="market-host-affinity">
                <span>分组编号</span>
                <input
                  class="settings-number"
                  type="number"
                  min="1"
                  step="1"
                  :value="affinityOf(view) ?? ''"
                  :placeholder="mode === 'isolated' ? '自动' : '与同号同组'"
                  :disabled="busy"
                  @change="commitAffinity(view, $event)"
                  @keydown.enter="onAffinityEnter"
                />
              </label>
              <button
                v-if="row.members.length > 1 && !forcedByDependency(view)"
                class="plugin-btn"
                :disabled="busy"
                title="分配一个新的分组编号，把它从这个宿主里挪出去"
                @click="isolate(view)"
              >
                独立
              </button>
            </li>
          </ul>
        </section>
      </div>

      <div v-else-if="codeCount === 0" class="market-empty">
        <p>还没有含代码的插件，纯声明插件不需要宿主进程。</p>
      </div>

      <div v-else-if="enabledCodeCount === 0" class="market-empty">
        <p>当前没有运行中的扩展宿主，启用代码插件后会启动。</p>
      </div>

      <div v-else class="market-empty">
        <p>宿主分组正在更新…</p>
      </div>

      <section v-if="unassigned.length > 0" class="market-host-paused">
        <div class="market-host-paused-head">
          <b>未分配宿主</b>
          <span class="market-host-meta">停用、加载失败与纯声明插件不进入宿主计划</span>
        </div>
        <ul class="market-host-card market-host-members">
          <li
            v-for="view in unassigned"
            :key="view.descriptor.id"
            class="market-host-row"
          >
            <span
              class="plugin-status-dot"
              :class="`plugin-status-${memberTone(view)}`"
              :title="memberStateLabel(view)"
            />
            <span class="market-host-name" :title="view.descriptor.displayName">
              {{ view.descriptor.displayName }}
            </span>
            <span v-if="view.loadError" class="market-badge market-badge-bad">加载失败</span>
            <span v-if="!view.enabled" class="market-badge market-badge-warn">已停用</span>
            <span v-if="!view.descriptor.main" class="market-badge">无需宿主</span>
            <span
              v-if="view.enabled && !view.loadError && view.descriptor.main"
              class="market-badge market-badge-warn"
            >
              等待宿主
            </span>
            <label v-if="view.descriptor.main && !view.loadError" class="market-host-affinity">
              <span>分组编号</span>
              <input
                class="settings-number"
                type="number"
                min="1"
                step="1"
                :value="affinityOf(view) ?? ''"
                :placeholder="mode === 'isolated' ? '自动' : '与同号同组'"
                :disabled="busy"
                title="启用后按这个编号参与分组"
                @change="commitAffinity(view, $event)"
                @keydown.enter="onAffinityEnter"
              />
            </label>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
