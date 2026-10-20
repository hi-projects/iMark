<script setup lang="ts">
/**
 * 市场 · 已安装 —— 插件的落地页,也是离线时唯一有内容的页。
 *
 * 每行用徽标回答「它能碰我多少东西」:完整权限 / 受限权限。来源(市场装、本地装、
 * 随应用发布)一律不标 —— 这一页要区分的是权限层,那才决定它能碰我什么;
 * 「是谁给的」在安装那一刻已经确认过,留在每行只会多一枚同款胶囊。
 * 权限则逐条列在名字下面,不再另起一个「权限」标题。
 */

import { computed, onMounted, ref, watch } from 'vue'
import { AlertTriangle, Download, Package, RefreshCw, ShieldCheck, Trash2 } from 'lucide-vue-next'
import { copyText } from '../../utils/clipboard'
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
  uninstallPlugin
} from '../../services/marketService'
import { PERMISSION_INFO } from '@shared/pluginPackage'
import type { PluginView } from '@shared/plugins'
import { selectPluginSettings } from '../../services/pluginService'
import { pluginStatusMessage, pluginStatusTone } from '../../services/pluginStatus'
import { shapeLabels, shapeOf } from '../../services/pluginShape'
import MarketProgress from './MarketProgress.vue'

const plugins = computed(() => marketStore.installed?.plugins ?? [])

const listEl = ref<HTMLElement | null>(null)

/** 文字与标签之间留出的呼吸空间:贴得太紧时,徽标看起来像版本号的一部分。 */
const LABEL_GAP_PX = 16

/**
 * 左侧文字列的宽度:取「名字 + 版本号」与「安装于 …」里最宽的那个,再加一段间距。
 *
 * 权限徽标与 sha256 标签都从这一列的右边界起步,于是它们落在同一条竖线上;
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
watch(plugins, syncLabelColumn, { flush: 'post' })

onMounted(() => {
  syncLabelColumn()
  // 字体晚一点就绪时宽度会变,再量一次
  void document.fonts?.ready.then(syncLabelColumn)
})

/**
 * 已安装列表的层徽标。
 *
 * 这里不标 render 层:这一页回答的是「哪些插件会跑、现在什么状态」,而 render
 * 不影响这个判断(它与 main 层同属一个插件)。完整权限 / 受限权限仍然保留 ——
 * 那两枚才决定「它能碰我多少东西」。
 */
function installedShapeLabels(view: PluginView) {
  return shapeLabels(shapeOf(view)).filter(s => s.tone !== 'render')
}

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
        {{ installing ? '正在装回…' : `装回内置插件（${missingBundled.length}）` }}
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
        </div>
        <p v-if="u.newPermissions.length > 0" class="market-update-warn">
          <AlertTriangle :size="12" />
          新版本{{ u.mainMode === 'node' ? '声明新增权限' : '要求新增权限' }}：{{ newPermText(u.newPermissions) }} —— 安装前会再确认一次。
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
      「从目录安装」会把选中的目录打包成插件包再安装，适合自己写的插件 ——
      目录里要有 <code class="market-mono">manifest.json</code>。
    </p>

    <div v-if="plugins.length === 0" class="market-empty">
      <Package :size="22" />
      <p>还没有安装任何插件。</p>
    </div>

    <ul v-else ref="listEl" class="market-list">
      <li v-for="p in plugins" :key="p.descriptor.id" class="market-row">
        <div class="market-row-main">
          <span
            class="plugin-status-dot"
            :class="`plugin-status-${pluginStatusTone(p.state)}`"
            :title="pluginStatusMessage(p.state)"
          />
          <div class="market-row-title">
            <div class="market-row-name">
              <!-- 名字+版本占一列定宽,徽标才能在所有行上对齐成同一竖列 -->
              <span class="market-row-name-main">
                <b :title="p.descriptor.name">{{ p.descriptor.name }}</b>
                <span class="market-mono market-dim">v{{ p.descriptor.version }}</span>
              </span>
              <span class="market-row-badges">
                <span
                  v-for="s in installedShapeLabels(p)"
                  :key="s.label"
                  class="market-badge"
                  :class="`market-shape-${s.tone}`"
                  >{{ s.label }}</span
                >
                <span v-if="p.dev" class="market-badge market-badge-bad">开发模式</span>
                <span v-if="p.disabledByHost" class="market-badge market-badge-bad">
                  已被停用（连续失败）
                </span>
                <span v-else-if="(p.failures ?? 0) > 0" class="market-badge market-badge-warn">
                  失败 {{ p.failures }} 次
                </span>
              </span>
            </div>
            <div class="market-row-sub">
              <span v-if="p.dev" class="market-row-sub-dev">
                代码来自 --plugin-dev 指定的目录，重启应用后不再加载
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
            <!--
              权限逐条摆出来 —— 这里是「受限插件能碰我什么」的落点(插件设置页不再重复列一份)。
              不写「权限」两个字:盾牌图标 + 每枚胶囊自带的说明(title)已经说清楚了,
              再顶一行标题只会让这一块显得跟上面的名称/元信息不是一回事。

              **只列受限层**:它的每一项都是真门禁(没声明就不存在)。node main 本来就有
              完整 Node,清单里的权限只是作者声明,列在这里会被读成「只被允许做这几件事」;
              那份声明留在安装确认框与详情页,那里写明了「完整 Node,以下为告知」。
            -->
            <div v-if="p.permissions?.length && p.mainMode !== 'node'" class="market-row-perms">
              <span class="market-row-perms-icon" title="已授予的权限">
                <ShieldCheck :size="12" />
              </span>
              <span
                v-for="perm in p.permissions"
                :key="perm"
                class="market-row-perm"
                :title="PERMISSION_INFO[perm]?.description ?? ''"
              >
                {{ PERMISSION_INFO[perm]?.label ?? perm }}
              </span>
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
            （插件 id 可能被其他人重新使用，凭据不能留给下一个同名插件）；
            配置默认保留，方便你以后重新装回来时不用重填其余字段。
          </p>
          <label class="market-ack">
            <input v-model="dropConfig" type="checkbox" />
            <span>连同配置一起删除（不可恢复）</span>
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
