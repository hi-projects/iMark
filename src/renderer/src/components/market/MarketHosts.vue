<script setup lang="ts">
/**
 * 市场 · 扩展分配 —— 集中管理全部扩展的进程分配。
 *
 * 进程模式与 affinity 是**全局**设置,所以不放在单个扩展页里:这一页按进程
 * 分组展示正在运行的扩展,把已停用 / 加载失败 / 纯声明的扩展放进「未分配」,
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
/** 当前分组等同于哪个模式按钮;手填编号且结果两种模式都解释不了时,两个都不选中 */
const modeState = computed(() => extensionStore.contribs?.hostModeState ?? mode.value)
const groups = computed(() => extensionStore.contribs?.hostGroups ?? [])

/** 每张进程卡:分组本身 + 能在已安装列表里找到的成员视图 */
const groupRows = computed(() =>
  groups.value.map(group => ({
    group,
    members: group.extensionIds
      .map(id => extensionById(id))
      .filter((view): view is ExtensionView => Boolean(view))
  }))
)

const assigned = computed(() => new Set(groups.value.flatMap(group => group.extensionIds)))

/** 未进入进程计划的扩展:已停用、加载失败、纯声明,或刚改完设置还没推送 */
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
  const hasAffinity = Object.keys(extensionStore.hostSettings.affinity).length > 0
  // 已经是指定模式且没有手填编号时不用重复写盘;有编号时点按钮要回到该模式的默认分组
  if (mode.value === next && !hasAffinity) return
  enqueue(async () => {
    await setExtensionHostSettings({ mode: next, affinity: {} })
  })
}

function affinityOf(view: ExtensionView): number | null {
  return extensionStore.hostSettings.affinity[view.descriptor.id] ?? null
}

/**
 * 与这个扩展通过 `extensionDependencies` 连成一组的全部扩展(无向)。
 *
 * 规划器本来就强制有依赖的扩展同组,用户不必挨个填同一个编号 —— 改一个
 * 就整条依赖链一起改,反向依赖同理。
 */
function dependencyComponent(id: string): Set<string> {
  const installed = new Set(extensionStore.list.map(view => view.descriptor.id))
  const peers = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    const set = peers.get(a) ?? new Set<string>()
    set.add(b)
    peers.set(a, set)
  }
  for (const view of extensionStore.list) {
    for (const dep of view.descriptor.extensionDependencies) {
      if (!installed.has(dep)) continue
      link(view.descriptor.id, dep)
      link(dep, view.descriptor.id)
    }
  }
  const out = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    for (const peer of peers.get(queue.shift()!) ?? []) {
      if (out.has(peer)) continue
      out.add(peer)
      queue.push(peer)
    }
  }
  return out
}

/** 把编号写进整条依赖链;`null` 表示清空 */
function affinityWith(view: ExtensionView, value: number | null): Record<string, number> {
  const affinity = { ...extensionStore.hostSettings.affinity }
  for (const id of dependencyComponent(view.descriptor.id)) {
    if (value === null) delete affinity[id]
    else affinity[id] = value
  }
  return affinity
}

/**
 * 提交分组编号:留空 / 非法 / 小于 1 都等于删除编号(按模式自动分组)。
 *
 * 用 @change 而不是 @input:每敲一位就写盘会立刻重启进程。提交后按 store 里的
 * 规范值回写 input —— 非法输入(如 0)不会改变 store,单靠 :value 不会复原输入框。
 */
function commitAffinity(view: ExtensionView, event: Event): void {
  const input = event.target as HTMLInputElement
  const raw = input.value
  const value = Number(raw)
  const clearing = raw.trim() === '' || !Number.isFinite(value) || value <= 0
  const affinity = affinityWith(view, clearing ? null : Math.trunc(value))
  enqueue(async () => {
    await setExtensionHostSettings({ affinity })
    input.value = String(affinityOf(view) ?? '')
  })
}

/** 回车立即提交;blur 会触发 change */
function onAffinityEnter(event: KeyboardEvent): void {
  ;(event.target as HTMLInputElement).blur()
}

/** 把某个扩展(连同它的依赖组)挪到一个新的分组编号 */
function isolate(view: ExtensionView): void {
  const used = Object.values(extensionStore.hostSettings.affinity)
  const next = Math.max(0, ...used) + 1
  enqueue(async () => {
    await setExtensionHostSettings({ affinity: affinityWith(view, next) })
  })
}

/**
 * 这个成员所在进程里还有不属于它依赖组的扩展吗?
 *
 * 有才显示「独立」——点下去才有东西可拆。如果整个进程本来就只有这一条
 * 依赖链,再分配一个编号只是原地打转。
 */
function canIsolate(view: ExtensionView, group: ExtensionHostGroupView): boolean {
  const component = dependencyComponent(view.descriptor.id)
  return group.extensionIds.some(id => !component.has(id))
}

function isolateTitle(view: ExtensionView): string {
  return dependencyComponent(view.descriptor.id).size > 1
    ? '给这条依赖链分配一个新的分组编号，一起挪到独立进程'
    : '分配一个新的分组编号，把它从这个进程里挪出去'
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

function memberTone(
  view: ExtensionView,
  group?: ExtensionHostGroupView
): 'idle' | 'running' | 'ok' | 'error' {
  if (view.loadError) return 'error'
  if (!view.enabled) return 'idle'
  const status = view.runtime.status
  if (status === 'failed') return 'error'
  // 宿主进程的状态比扩展视图新:切换模式/重启后视图里的 runtime 还停在
  // inactive,但进程已经跑起来了,成员必然已随之激活。
  if (group) {
    if (group.state === 'crashed' || group.state === 'crash-loop') return 'error'
    if (group.state === 'running') return 'ok'
    if (group.state === 'starting') return 'running'
  }
  if (status === 'crashed' || status === 'crash-loop') return 'error'
  if (status === 'activating') return 'running'
  if (status === 'active') return 'ok'
  return 'idle'
}

function memberStateLabel(view: ExtensionView, group?: ExtensionHostGroupView): string {
  if (view.loadError) return '加载失败'
  if (!view.enabled) return '已停用'
  const status = view.runtime.status
  if (status === 'failed') return '激活失败'
  if (status === 'crashed' || status === 'crash-loop') return '进程已退出'
  if (group) {
    if (group.state === 'crashed' || group.state === 'crash-loop') return '进程已退出'
    if (group.state === 'running') return '已激活'
    if (group.state === 'starting') return '正在激活'
  }
  switch (status) {
    case 'active':
      return '已激活'
    case 'activating':
      return '正在激活'
    case 'inactive':
      return '已启用，等待激活'
    default:
      return '已启用'
  }
}

/**
 * 进程卡片的副标题:状态 + 有值才显示的 PID/内存。
 *
 * 未启动(或启动中)的进程没有 PID,不展示「PID —」这种占位符 ——
 * 一个破折号既不是信息,又让人以为进程信息丢了。
 */
function hostMeta(group: ExtensionHostGroupView): string {
  const parts = [hostStateLabel(group.state)]
  if (group.pid !== null) parts.push(`PID ${group.pid}`)
  if (group.memoryBytes) parts.push(formatBytes(group.memoryBytes))
  return parts.join(' · ')
}

/** 懒激活的扩展分配了进程但还没拉起来;重启对它没有意义 */
function canReload(group: ExtensionHostGroupView): boolean {
  return group.state !== 'stopped' && group.state !== 'starting'
}

function reloadTitle(group: ExtensionHostGroupView): string {
  if (group.state === 'stopped') return '重新加载这个进程（尚未启动，无需重启）'
  if (group.state === 'starting') return '重新加载这个进程（正在启动）'
  return '重新加载这个进程'
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
      <p class="market-hint">
        分配扩展运行环境。若干扩展运行在若干进程中，分组编号相同的扩展运行在同一进程，
        未指定分组编号的扩展默认在同一进程。
      </p>
      <span class="settings-presets">
        <button
          class="settings-preset"
          :class="{ 'settings-preset-active': modeState === 'isolated' }"
          :disabled="busy"
          title="每个扩展一个进程：一个扩展崩溃不影响其他扩展"
          @click="setMode('isolated')"
        >
          独立进程
        </button>
        <button
          class="settings-preset"
          :class="{ 'settings-preset-active': modeState === 'shared' }"
          :disabled="busy"
          title="扩展共用一个进程：省内存，但崩溃半径也共享"
          @click="setMode('shared')"
        >
          共享进程
        </button>
      </span>
    </section>

    <div v-if="extensionStore.contribs === null" class="market-empty">
      <p>正在读取进程状态…</p>
    </div>

    <template v-else>
      <section v-if="groups.length > 0" class="market-host-assigned">
        <div class="market-host-section-head">
          <b>已分配</b>
        </div>
        <div class="market-host-groups">
          <section
            v-for="row in groupRows"
            :key="row.group.hostId"
            class="market-host-card"
            :class="`market-host-card-${hostTone(row.group.state)}`"
          >
            <header class="market-host-head">
              <b>进程 #{{ row.group.hostId }}</b>
              <span class="market-host-meta">{{ hostMeta(row.group) }}</span>
              <span class="market-host-count">{{ row.members.length }} 个扩展</span>
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
                  :class="`plugin-status-${memberTone(view, row.group)}`"
                  :title="memberStateLabel(view, row.group)"
                />
                <span class="market-host-ident">
                  <span class="market-host-name" :title="view.descriptor.displayName">
                    {{ view.descriptor.displayName }}
                  </span>
                  <span v-if="forcedByDependency(view)" class="market-badge">依赖同组</span>
                </span>
                <button
                  v-if="canIsolate(view, row.group)"
                  class="plugin-btn"
                  :disabled="busy"
                  :title="isolateTitle(view)"
                  @click="isolate(view)"
                >
                  独立
                </button>
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
              </li>
            </ul>
          </section>
        </div>
      </section>

      <div v-else-if="codeCount === 0" class="market-empty">
        <p>还没有含代码的扩展，纯声明扩展不需要进程。</p>
      </div>

      <div v-else-if="enabledCodeCount === 0" class="market-empty">
        <p>当前没有运行中的扩展进程，启用代码扩展后会启动。</p>
      </div>

      <div v-else class="market-empty">
        <p>进程分组正在更新…</p>
      </div>

      <section v-if="unassigned.length > 0" class="market-host-paused">
        <div class="market-host-section-head">
          <b>未分配</b>
          <span class="market-host-meta">停用、加载失败与纯声明扩展不进入进程计划</span>
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
            <span v-if="!view.descriptor.main" class="market-badge">无需进程</span>
            <span
              v-if="view.enabled && !view.loadError && view.descriptor.main"
              class="market-badge market-badge-warn"
            >
              等待进程
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
