<script setup lang="ts">
/**
 * 市场 · 已安装 —— 扩展的落地页,也是离线时唯一有内容的页。
 *
 * 每行回答的是「这是什么、从哪来、现在什么状态」:名字与版本、形态徽标
 * (含代码 / 纯声明)、来源(内置 / 市场 / 本地 / 开发)、启用态,以及可复制的
 * 安装 sha256。没有权限行 —— 扩展没有权限沙箱,清单里的 capabilities 是告知,
 * 只在安装确认框与详情页展示。
 */

import { computed, onMounted, ref, watch } from 'vue'
import { Download, Package, RefreshCw, Trash2 } from 'lucide-vue-next'
import { copyText } from '../../utils/clipboard'
import type { ExtensionView } from '@shared/extensions'
import {
  checkUpdates,
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
import { selectExtensionSettings } from '../../services/extensionService'
import { shapeLabels, shapeOf } from '../../services/pluginShape'
import MarketProgress from './MarketProgress.vue'

const extensions = computed(() => marketStore.installed?.extensions ?? [])

const listEl = ref<HTMLElement | null>(null)

/** 文字与标签之间留出的呼吸空间:贴得太紧时,徽标看起来像版本号的一部分。 */
const LABEL_GAP_PX = 16

/**
 * 左侧文字列的宽度:取「名字 + 版本号」与「安装于 …」里最宽的那个,再加一段间距。
 *
 * 徽标与 sha256 标签都从这一列的右边界起步,于是它们落在同一条竖线上;
 * 列宽按实测而不是写死,标签才会紧跟文字,而不是被推到卡片中间的空地上。
 *
 * 先清掉变量让各列回到自然宽度再量;实测与设值在同一帧完成,不会闪。
 */
function syncLabelColumn(): void {
  const list = listEl.value
  if (!list) return
  list.style.removeProperty('--market-label-col')
  let widest = 0
  for (const el of list.querySelectorAll<HTMLElement>('.market-row-name-main')) {
    widest = Math.max(widest, Math.ceil(el.getBoundingClientRect().width))
  }
  // 「安装于 …」也在这一列里:它比名字宽时列要跟着变宽,否则时间会顶到 sha256 上。
  // 用 Range 量文字本身,不受 grid 轨道(尤其是跨列的开发模式提示)影响。
  for (const el of list.querySelectorAll<HTMLElement>('.market-row-sub-main')) {
    const range = document.createRange()
    range.selectNodeContents(el)
    widest = Math.max(widest, Math.ceil(range.getBoundingClientRect().width))
  }
  if (widest > 0) list.style.setProperty('--market-label-col', `${widest + LABEL_GAP_PX}px`)
}

// flush: 'post' 保证量到的是这一轮渲染之后的 DOM
watch(extensions, syncLabelColumn, { flush: 'post' })

onMounted(() => {
  syncLabelColumn()
  // 字体晚一点就绪时宽度会变,再量一次
  void document.fonts?.ready.then(syncLabelColumn)
})

function shapeOfView(view: ExtensionView) {
  return shapeOf({ hasMain: Boolean(view.descriptor.main) })
}

function versionOf(view: ExtensionView): string {
  return view.installed?.version ?? view.descriptor.version
}

/** 圆点的颜色:失败/崩溃优先,其次激活中,再其次启用态 */
function statusTone(view: ExtensionView): 'idle' | 'running' | 'ok' | 'error' {
  const status = view.runtime.status
  if (status === 'failed' || status === 'crashed' || status === 'crash-loop') return 'error'
  if (status === 'activating') return 'running'
  if (status === 'disabled' || !view.enabled) return 'idle'
  return 'ok'
}

function statusMessage(view: ExtensionView): string {
  if (view.runtime.lastError) return view.runtime.lastError
  switch (view.runtime.status) {
    case 'active':
      return '已激活'
    case 'activating':
      return '正在激活'
    case 'inactive':
      return '已启用'
    case 'disabled':
      return '已停用'
    case 'failed':
      return '激活失败'
    case 'crashed':
      return '宿主崩溃'
    case 'crash-loop':
      return '连续崩溃，已停止自动重启'
    default:
      return view.enabled ? '已启用' : '已停用'
  }
}

function isBundled(view: ExtensionView): boolean {
  return view.source === 'bundled' || marketStore.bundled.includes(view.descriptor.id)
}

/**
 * 可用更新。
 *
 * 刻意**不自动装**:更新是一份新代码,它带来的是与首次安装同等的信任问题。
 * 所以这里只摆出来,由用户点。
 */
const updates = computed(() => remoteStore.updates)

/** 有兜底副本、但当前不在已安装列表里的扩展 —— 即「可以装回来的」 */
const missingBundled = computed(() => {
  const present = new Set(extensions.value.map(item => item.descriptor.id))
  return (marketStore.bundled ?? []).filter(id => !present.has(id))
})

const installing = ref(false)

/** 正在展开卸载确认的行(同时只允许一行) */
const uninstallId = ref<string | null>(null)
const copiedId = ref<string | null>(null)

function toggleUninstall(id: string): void {
  uninstallId.value = uninstallId.value === id ? null : id
}

async function doUninstall(id: string): Promise<void> {
  uninstallId.value = null
  await uninstallPlugin(id)
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
        {{ installing ? '正在装回…' : `装回内置扩展（${missingBundled.length}）` }}
      </button>
      <button class="plugin-icon-btn" title="刷新（含检查更新）" @click="refreshAll()">
        <RefreshCw :size="14" />
      </button>
    </div>

    <MarketProgress />

    <ul v-if="updates.length > 0" class="market-updates">
      <li v-for="u in updates" :key="u.id" class="market-update">
        <div class="market-update-main">
          <b>{{ u.name }}</b>
          <span class="market-mono market-dim">{{ u.currentVersion }} → {{ u.latestVersion }}</span>
          <span class="market-badge">{{ u.hasMain ? '含代码' : '纯声明' }}</span>
        </div>
        <div class="market-row-actions">
          <button
            class="plugin-btn"
            :disabled="marketStore.busy || marketStore.loading"
            @click="selectExtensionSettings(u.id)"
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
      「从目录安装」会把选中的目录打包成扩展包再安装，适合自己写的扩展 ——
      目录里要有 <code class="market-mono">package.json</code>。
    </p>

    <div v-if="extensions.length === 0" class="market-empty">
      <Package :size="22" />
      <p>还没有安装任何扩展。</p>
    </div>

    <ul v-else ref="listEl" class="market-list">
      <li v-for="p in extensions" :key="p.descriptor.id" class="market-row">
        <div class="market-row-main">
          <span
            class="plugin-status-dot"
            :class="`plugin-status-${statusTone(p)}`"
            :title="statusMessage(p)"
          />
          <div class="market-row-title">
            <div class="market-row-name">
              <!-- 名字+版本占一列定宽,徽标才能在所有行上对齐成同一竖列 -->
              <span class="market-row-name-main">
                <b :title="p.descriptor.displayName">{{ p.descriptor.displayName }}</b>
                <span class="market-mono market-dim">v{{ versionOf(p) }}</span>
              </span>
              <span class="market-row-badges">
                <span
                  v-for="s in shapeLabels(shapeOfView(p))"
                  :key="s.label"
                  class="market-badge"
                  :class="`market-shape-${s.tone}`"
                  >{{ s.label }}</span
                >
                <span class="market-badge">{{ sourceLabel(p.source, isBundled(p)) }}</span>
                <span v-if="!p.enabled" class="market-badge market-badge-warn">已停用</span>
                <span v-if="p.dev" class="market-badge market-badge-bad">开发模式</span>
                <span v-if="p.runtime.status === 'crash-loop'" class="market-badge market-badge-bad">
                  连续崩溃，已停止自动重启
                </span>
                <span
                  v-else-if="(p.runtime.activationFailures ?? 0) > 0"
                  class="market-badge market-badge-warn"
                >
                  激活失败 {{ p.runtime.activationFailures }} 次
                </span>
              </span>
            </div>
            <div class="market-row-sub">
              <span v-if="p.dev" class="market-row-sub-dev">
                代码来自开发目录，重启应用后按安装目录加载
              </span>
              <span v-if="p.installed" class="market-row-sub-main">
                安装于 {{ formatTime(p.installed.installedAt) }}
              </span>
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
            <button class="plugin-btn" @click="selectExtensionSettings(p.descriptor.id)">设置</button>
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

        <!-- 卸载确认:卸载会删掉扩展的全部数据,所以要把话说死 -->
        <div v-if="uninstallId === p.descriptor.id" class="market-row-confirm">
          <p class="market-hint">
            卸载会停止并删除这个扩展的程序文件，<b>连同它的配置、密钥、globalState 与日志</b>
            （不可恢复）。扩展 id 可能被其他人重新使用，凭据不能留给下一个同名扩展。
          </p>
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
