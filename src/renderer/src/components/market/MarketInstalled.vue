<script setup lang="ts">
/**
 * 市场 · 已安装 —— 插件的落地页,也是离线时唯一有内容的页。
 *
 * 这里刻意让「来源」一眼可见:应用自带 / 来自市场 / 本地安装三种来源的风险完全不同
 * (自带的是随应用一起发布的,本地安装的可能是自己随手打的包),
 * 用户要能分辨自己到底装了谁的东西。
 */

import { computed, ref } from 'vue'
import { AlertTriangle, Download, Package, RefreshCw, Trash2 } from 'lucide-vue-next'
import {
  checkUpdates,
  copyText,
  formatTime,
  installFromMarket,
  marketStore,
  pickPackage,
  packDirectory,
  refreshInstalled,
  remoteStore,
  restoreBundled,
  sourceLabel,
  uninstallPlugin
} from '../../services/marketService'
import { PERMISSION_INFO } from '@shared/pluginPackage'
import { selectPluginSettings } from '../../services/pluginService'
import MarketProgress from './MarketProgress.vue'

const plugins = computed(() => marketStore.installed?.plugins ?? [])

/**
 * 可用更新。
 *
 * 刻意**不自动装**:更新是一份新代码,它带来的是与首次安装同等的信任问题
 * (有时候还更多 —— 新版本可能多要了一个权限)。所以这里只摆出来,由用户点。
 * 权限扩大时额外标一行红字,因为「包还是那个包,但它现在要读你的整个仓库了」
 * 是最容易被忽略的一种变化。
 */
const updates = computed(() => remoteStore.updates)

function newPermText(perms: string[]): string {
  return perms.map(p => PERMISSION_INFO[p as keyof typeof PERMISSION_INFO]?.label ?? p).join('、')
}

/** 有兜底副本、但当前不在已安装列表里的插件 —— 即「可以装回来的」 */
const missingBundled = computed(() => {
  const present = new Set(plugins.value.map(p => p.descriptor.id))
  return (marketStore.bundled ?? []).filter(id => !present.has(id))
})

const installing = ref(false)

/** 正在展开卸载确认的行(同时只允许一行) */
const uninstallId = ref<string | null>(null)
const dropConfig = ref(false)
const copiedId = ref<string | null>(null)

function toggleUninstall(id: string): void {
  uninstallId.value = uninstallId.value === id ? null : id
  dropConfig.value = false
}

async function doUninstall(id: string): Promise<void> {
  const removeConfig = dropConfig.value
  uninstallId.value = null
  await uninstallPlugin(id, removeConfig)
}

async function copy(id: string, text: string): Promise<void> {
  if (!(await copyText(text))) return
  copiedId.value = id
  window.setTimeout(() => {
    if (copiedId.value === id) copiedId.value = null
  }, 1500)
}

async function restore(): Promise<void> {
  installing.value = true
  try {
    await restoreBundled()
  } finally {
    installing.value = false
  }
}

/** 刷新按钮:本地列表与更新检查一起重来(更新检查走 force,不吃 10 分钟的缓存) */
async function refreshAll(): Promise<void> {
  if (marketStore.loading) return
  marketStore.loading = true
  try {
    await Promise.all([refreshInstalled(), checkUpdates(true)])
  } finally {
    marketStore.loading = false
  }
}
</script>

<template>
  <div class="market-tab-body">
    <div class="market-toolbar">
      <button class="plugin-btn" :disabled="marketStore.busy" @click="pickPackage()">
        从文件安装…
      </button>
      <button class="plugin-btn" :disabled="marketStore.busy" @click="packDirectory()">
        从目录安装…
      </button>
      <span class="market-toolbar-gap" />
      <button
        v-if="missingBundled.length > 0"
        class="plugin-btn plugin-btn-add"
        :disabled="installing || marketStore.busy"
        @click="restore()"
      >
        {{ installing ? '正在装回…' : `装回自带插件(${missingBundled.length})` }}
      </button>
      <button class="plugin-icon-btn" title="刷新(含检查更新)" @click="refreshAll()">
        <RefreshCw :size="14" />
      </button>
    </div>

    <MarketProgress />

    <ul v-if="updates.length > 0" class="market-updates">
      <li v-for="u in updates" :key="u.id" class="market-update">
        <div class="market-update-main">
          <b>{{ u.name }}</b>
          <span class="market-mono market-dim">{{ u.currentVersion }} → {{ u.latestVersion }}</span>
        </div>
        <p v-if="u.newPermissions.length > 0" class="market-update-warn">
          <AlertTriangle :size="12" />
          新版本要求新增权限:{{ newPermText(u.newPermissions) }} —— 安装前会再确认一次。
        </p>
        <div class="market-row-actions">
          <button
            class="plugin-btn"
            :disabled="marketStore.busy || marketStore.loading"
            @click="selectPluginSettings(u.id)"
          >
            设置
          </button>
          <button
            class="plugin-btn plugin-btn-add"
            :disabled="marketStore.busy || marketStore.loading"
            @click="installFromMarket(u.id, null)"
          >
            <Download :size="13" />
            更新
          </button>
        </div>
      </li>
    </ul>

    <p class="market-hint">
      「从目录安装」会把选中的目录打包成插件包再安装,适合自己写的插件 ——
      目录里要有 <code class="market-mono">manifest.json</code>。
    </p>

    <div v-if="plugins.length === 0" class="market-empty">
      <Package :size="22" />
      <p>还没有安装任何插件。</p>
    </div>

    <ul v-else class="market-list">
      <li v-for="p in plugins" :key="p.descriptor.id" class="market-row">
        <div class="market-row-main">
          <span
            class="plugin-status-dot"
            :class="`plugin-status-${p.state.status}`"
            :title="p.state.lastMessage || '待运行'"
          />
          <div class="market-row-title">
            <div class="market-row-name">
              <b>{{ p.descriptor.name }}</b>
              <span class="market-mono market-dim">v{{ p.descriptor.version }}</span>
              <span v-if="p.dev" class="market-badge market-badge-bad">开发模式</span>
              <span v-else class="market-badge">{{ sourceLabel(p.source, marketStore.bundled.includes(p.descriptor.id)) }}</span>
              <span v-if="p.kind === 'script'" class="market-badge market-badge-code">含代码</span>
              <span v-else-if="p.kind === 'declarative'" class="market-badge market-badge-safe">
                不含代码
              </span>
              <span v-if="p.disabledByHost" class="market-badge market-badge-bad">
                已被停用(连续失败)
              </span>
              <span v-else-if="(p.failures ?? 0) > 0" class="market-badge market-badge-warn">
                失败 {{ p.failures }} 次
              </span>
            </div>
            <div class="market-row-sub">
              <span v-if="p.dev">代码来自 --plugin-dev 指定的目录,重启应用后不再加载</span>
              <span v-if="p.installed?.publisher">发布者 {{ p.installed.publisher }}</span>
              <span v-if="p.installed">安装于 {{ formatTime(p.installed.installedAt) }}</span>
              <button
                v-if="p.installed?.integrity"
                class="market-hash-chip"
                :title="p.installed.integrity"
                @click="copy(p.descriptor.id, p.installed!.integrity)"
              >
                {{ copiedId === p.descriptor.id ? '已复制' : `sha256 ${p.installed.integrity.slice(0, 12)}…` }}
              </button>
            </div>
          </div>
          <div class="market-row-actions">
            <button class="plugin-btn" @click="selectPluginSettings(p.descriptor.id)">设置</button>
            <button
              v-if="!p.dev"
              class="plugin-icon-btn"
              title="卸载"
              :disabled="marketStore.busy"
              @click="toggleUninstall(p.descriptor.id)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <pre v-if="p.loadError" class="market-row-error">{{ p.loadError }}</pre>

        <!-- 卸载确认:密钥与配置的处理方式不同,所以要把差异说清楚 -->
        <div v-if="uninstallId === p.descriptor.id" class="market-row-confirm">
          <p class="market-hint">
            卸载会停止并删除这个插件的程序文件。<b>已保存的密钥一定会被删除</b>
            (插件 id 可能被其他人重新使用,凭据不能留给下一个同名插件);
            配置默认保留,方便你以后重新装回来时不用重填其余字段。
          </p>
          <label class="market-ack">
            <input v-model="dropConfig" type="checkbox" />
            <span>连同配置一起删除(不可恢复)</span>
          </label>
          <div class="market-row-confirm-actions">
            <button class="plugin-btn" @click="uninstallId = null">取消</button>
            <button
              class="plugin-btn market-btn-danger"
              :disabled="marketStore.busy"
              @click="doUninstall(p.descriptor.id)"
            >
              确认卸载
            </button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
