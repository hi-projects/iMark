<script setup lang="ts">
/**
 * 市场 · 浏览。
 *
 * 每张卡片都要回答三个问题:这是什么、谁做的、**我装没装**。
 * 第三个问题只能在客户端回答(服务端不知道谁装了什么),所以每行都拿本地
 * 已装列表 join 一下 —— 右侧按钮的「安装 / 更新 / 已安装」与卡片上的
 * 「可更新」标记都由它决定。
 *
 * 卡片上的「安装」只走到确认框为止:真正的下载与落盘发生在用户按下确认之后。
 */

import { computed, onMounted, watch } from 'vue'
import { Download, Package, RefreshCw, Search, Store } from 'lucide-vue-next'
import {
  hasUpdate,
  installFromMarket,
  loadIcon,
  loadAuth,
  localVersion,
  marketStore,
  remoteStore,
  searchMarket
} from '../../services/marketService'
import { settingsNav } from '../../services/pluginService'
import { shapeLabels, shapeOf } from '../../services/pluginShape'
import MarketProgress from './MarketProgress.vue'

const nav = settingsNav.market
const result = computed(() => remoteStore.result)

const SORTS = [
  { id: 'updated', label: '最近更新' },
  { id: 'downloads', label: '下载最多' },
  { id: 'name', label: '按名称' }
] as const

const totalPages = computed(() => {
  const r = result.value
  if (!r) return 1
  return Math.max(1, Math.ceil(r.total / r.pageSize))
})

/** 搜索词/排序变了要回到第一页,否则会停在「第 3 页」这种不存在的页码上 */
async function applyQuery(): Promise<void> {
  nav.page = 1
  await searchMarket()
}

/**
 * 清空搜索框立即回到全量列表。
 *
 * 非空输入仍只在回车/点「搜索」时发请求(避免每敲一个字都打服务端);
 * 但清空是一个明确的「我不筛了」动作,再要求按一次回车没有道理。
 *
 * 用 watch 而不是 @input:v-model 的赋值与模板监听谁先执行取决于指令实现,
 * watch 回调看到的一定是更新后的值。
 */
watch(
  () => nav.query,
  query => {
    if (!query.trim()) void applyQuery()
  }
)

async function goPage(delta: number): Promise<void> {
  const next = nav.page + delta
  if (next < 1 || next > totalPages.value) return
  nav.page = next
  await searchMarket()
}

function openDetail(id: string): void {
  // detailId 一变,MarketPage 就会切到详情组件
  nav.detailId = id
  remoteStore.detail = null
}

function authorLine(entry: { author: string | null; publisher: string }): string {
  return entry.author || entry.publisher
}

/**
 * 列表按钮只在「没装」或「市场确实更新」时可点。
 *
 * 市场里可能留着一个比本地旧的版本(自托管市场尤其常见)。那种情况下按钮仍写
 * 「更新」的话,点下去只会下载一份注定被客户端校验拒绝的包 —— 用户看到的是
 * 一句 "插件包校验失败",而不是「你已经是最新的」。
 */
function canInstall(entry: { id: string; version: string }): boolean {
  const local = localVersion(entry.id)
  return !local || hasUpdate(entry.id, entry.version)
}

function installLabel(entry: { id: string; version: string }): string {
  const local = localVersion(entry.id)
  if (!local) return '安装'
  return hasUpdate(entry.id, entry.version) ? '更新' : '已安装'
}

/**
 * 图标是**懒加载**的:列表一出来就为可见的每一项取一次。
 * 不放在渲染函数里是因为渲染必须是同步的,而这里要发 IPC ——
 * 挂一个 watch 比在每个卡片里各写一份 onMounted 清楚得多。
 */
watch(
  () => result.value?.items.map(i => i.id).join(','),
  () => {
    for (const item of result.value?.items ?? []) void loadIcon(item.id)
  },
  { immediate: true }
)

onMounted(async () => {
  if (!remoteStore.auth) await loadAuth()
  if (!result.value) await searchMarket()
})
</script>

<template>
  <div class="market-tab-body">
    <div class="market-toolbar">
      <label class="market-search">
        <Search :size="13" />
        <input
          v-model="nav.query"
          type="search"
          placeholder="搜索插件名、描述或作者…"
          @keyup.enter="applyQuery()"
        />
      </label>
      <button class="plugin-btn" :disabled="marketStore.loading" @click="applyQuery()">搜索</button>
      <select v-model="nav.sort" class="market-select" @change="applyQuery()">
        <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <span class="market-toolbar-gap" />
      <button
        class="plugin-icon-btn"
        title="刷新"
        :disabled="marketStore.loading"
        @click="applyQuery()"
      >
        <RefreshCw :size="14" />
      </button>
    </div>

    <MarketProgress />

    <p v-if="marketStore.loading" class="market-hint">正在读取市场…</p>

    <div v-else-if="!result" class="market-empty">
      <Store :size="22" />
      <p>没有读到市场内容。</p>
    </div>

    <div v-else-if="result.items.length === 0" class="market-empty">
      <Package :size="22" />
      <p v-if="nav.query">没有匹配「{{ nav.query }}」的插件。</p>
      <p v-else>这个市场里还没有插件。第一个也可以是你 —— 见「发布插件」页。</p>
    </div>

    <template v-else>
      <ul class="market-cards">
        <li
          v-for="item in result.items"
          :key="item.id"
          class="market-card"
          tabindex="0"
          @click="openDetail(item.id)"
          @keydown.enter="openDetail(item.id)"
        >
          <img
            v-if="remoteStore.icons[item.id]"
            class="market-card-icon"
            :src="remoteStore.icons[item.id]!"
            alt=""
            @error="remoteStore.icons[item.id] = null"
          />
          <div v-else class="market-card-icon market-card-icon-fallback">
            <Package :size="18" />
          </div>

          <div class="market-card-main">
            <div class="market-card-name">
              <b>{{ item.name }}</b>
              <span class="market-badge market-mono">v{{ item.version }}</span>
              <!-- 层徽标:main 模式 / render / 无代码能力。未知形态明确标出来,
                   绝不退化成“不含代码” -->
              <span
                v-for="s in shapeLabels(shapeOf(item))"
                :key="s.label"
                class="market-badge"
                :class="`market-shape-${s.tone}`"
                >{{ s.label }}</span
              >
              <!-- 「已安装」由右侧按钮表达;这里只在市场有更新时多提醒一次 -->
              <span
                v-if="localVersion(item.id) && hasUpdate(item.id, item.version)"
                class="market-badge market-badge-ok"
              >
                可更新
              </span>
            </div>
            <p class="market-card-desc">{{ item.description || '（这个插件还没有写说明）' }}</p>
            <div class="market-row-sub">
              <span>{{ authorLine(item) }}</span>
              <span>{{ item.downloads }} 次下载</span>
            </div>
          </div>

          <div class="market-row-actions" @click.stop @keydown.enter.stop>
            <button
              class="plugin-btn plugin-btn-add"
              :disabled="marketStore.busy || marketStore.loading || !canInstall(item)"
              @click="installFromMarket(item.id, null)"
            >
              <Download :size="13" />
              {{ installLabel(item) }}
            </button>
          </div>
        </li>
      </ul>

      <div v-if="totalPages > 1" class="market-pager">
        <button class="plugin-btn" :disabled="nav.page <= 1" @click="goPage(-1)">上一页</button>
        <span class="market-dim">第 {{ nav.page }} 页（共 {{ totalPages }} 页，{{ result.total }} 个）</span>
        <button class="plugin-btn" :disabled="nav.page >= totalPages" @click="goPage(1)">下一页</button>
      </div>
    </template>
  </div>
</template>
