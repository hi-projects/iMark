<script setup lang="ts">
/**
 * 插件市场页 —— 设置面板里的第三个页面(外观 / 插件 / 市场)。
 *
 * 只做外壳:页签、当前市场地址、顶部错误条,具体内容交给各个 tab 组件。
 * 页签状态存在 settingsNav 的 market 里,所以从菜单打开市场、
 * 点到某个插件详情再关掉设置、重新打开,看到的还是原来那一屏。
 */

import { computed, onMounted } from 'vue'
import { Store } from 'lucide-vue-next'
import { checkUpdates, marketStore, refreshInstalled, remoteStore } from '../../services/marketService'
import { settingsNav } from '../../services/settingsNav'
import MarketBrowse from './MarketBrowse.vue'
import MarketDetail from './MarketDetail.vue'
import MarketInstalled from './MarketInstalled.vue'
import MarketPublish from './MarketPublish.vue'

const TABS = [
  { id: 'installed', label: '已安装' },
  { id: 'browse', label: '浏览市场' },
  { id: 'publish', label: '发布插件' }
] as const

const registry = computed(() => remoteStore.auth?.registry ?? '')

/** 有可用更新时在「已安装」页签上挂个角标 —— 这是用户唯一会主动看的地方 */
const updateCount = computed(() => remoteStore.updates.length)

function selectTab(tab: (typeof TABS)[number]['id']): void {
  settingsNav.market.tab = tab
  settingsNav.market.detailId = null
}

onMounted(async () => {
  await refreshInstalled()
  // 更新检查是背景动作:失败静默(见 marketService.checkUpdates)
  await checkUpdates()
})
</script>

<template>
  <div class="market-page">
    <div class="market-tabs">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="market-tab"
        :class="{ 'market-tab-active': settingsNav.market.tab === tab.id }"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
        <span v-if="tab.id === 'installed' && updateCount > 0" class="market-tab-badge">
          {{ updateCount }}
        </span>
      </button>
      <span class="market-toolbar-gap" />
      <span class="market-registry" :title="registry">
        <Store :size="13" />
        {{ registry || '未设置市场地址' }}
      </span>
    </div>

    <p v-if="marketStore.error" class="market-banner market-banner-error">{{ marketStore.error }}</p>

    <!-- 详情是「浏览」下面的一个子屏,所以它只在浏览页签里替换列表 -->
    <MarketDetail
      v-if="settingsNav.market.tab === 'browse' && settingsNav.market.detailId"
    />
    <MarketInstalled v-else-if="settingsNav.market.tab === 'installed'" />
    <MarketBrowse v-else-if="settingsNav.market.tab === 'browse'" />
    <MarketPublish v-else />
  </div>
</template>
