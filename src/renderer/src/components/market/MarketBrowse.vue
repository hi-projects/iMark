<script setup lang="ts">
/**
 * 市场 · 浏览。
 *
 * 每张卡片都要回答三个问题:这是什么、谁做的、**我装没装**。
 * 第三个问题只能在客户端回答(服务端不知道谁装了什么),所以每行都拿本地
 * 已装列表 join 一下 —— 这也是「已安装 / 可更新」那两个标记的由来。
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
  return entry.author ? `${entry.author}(由 ${entry.publisher} 发布)` : `${entry.publisher} 发布`
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
        <li v-for="item in result.items" :key="item.id" class="market-card">
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
              <span class="market-mono market-dim">{{ item.id }}</span>
              <span class="market-badge market-mono">v{{ item.version }}</span>
              <span v-if="item.kind === 'script'" class="market-badge market-badge-code">含代码</span>
              <!-- 声明式插件也明写出来:让「不用信任任何代码」这件事在列表里就能一眼看到,
                   而不是要用户点进详情才发现自己装的是哪一种 -->
              <span v-else class="market-badge market-badge-safe">不含代码</span>
              <span v-if="localVersion(item.id)" class="market-badge market-badge-ok">
                {{ hasUpdate(item.id, item.version) ? '可更新' : '已安装' }}
              </span>
            </div>
            <p class="market-card-desc">{{ item.description || '(这个插件还没有写说明)' }}</p>
            <div class="market-row-sub">
              <span>{{ authorLine(item) }}</span>
              <span>{{ item.downloads }} 次下载</span>
              <span v-if="localVersion(item.id)" class="market-mono">
                本地 v{{ localVersion(item.id) }}
              </span>
            </div>
          </div>

          <div class="market-row-actions">
            <button class="plugin-btn" @click="openDetail(item.id)">详情</button>
            <button
              class="plugin-btn plugin-btn-add"
              :disabled="marketStore.busy || marketStore.loading"
              @click="installFromMarket(item.id, null)"
            >
              <Download :size="13" />
              {{ localVersion(item.id) ? '更新' : '安装' }}
            </button>
          </div>
        </li>
      </ul>

      <div v-if="totalPages > 1" class="market-pager">
        <button class="plugin-btn" :disabled="nav.page <= 1" @click="goPage(-1)">上一页</button>
        <span class="market-dim">第 {{ nav.page }} / {{ totalPages }} 页(共 {{ result.total }} 个)</span>
        <button class="plugin-btn" :disabled="nav.page >= totalPages" @click="goPage(1)">下一页</button>
      </div>
    </template>
  </div>
</template>
