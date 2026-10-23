<script setup lang="ts">
/**
 * 扩展市场页 —— 设置面板里的第三个页面(外观 / 扩展 / 市场)。
 *
 * 只做外壳:页签与市场错误条,具体内容交给各个 tab 组件。
 * 页签状态存在 settingsNav 的 market 里,所以从菜单打开市场、
 * 点到某个扩展详情再关掉设置、重新打开,看到的还是原来那一屏。
 */

import { computed, onMounted } from 'vue'
import { checkUpdates, marketStore, refreshInstalled, remoteStore } from '../../services/marketService'
import { settingsNav } from '../../services/settingsNav'
import MarketBrowse from './MarketBrowse.vue'
import MarketDetail from './MarketDetail.vue'
import MarketHosts from './MarketHosts.vue'
import MarketInstalled from './MarketInstalled.vue'
import MarketPublish from './MarketPublish.vue'

const TABS = [
  { id: 'installed', label: '已安装' },
  { id: 'browse', label: '浏览市场' },
  { id: 'hosts', label: '扩展分配' },
  { id: 'publish', label: '发布扩展' }
] as const

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
    </div>

    <!-- 市场连接错误只与「浏览市场」有关;其它页签不显示,免得每个页面都顶着一条红条 -->
    <p
      v-if="settingsNav.market.tab === 'browse' && marketStore.error"
      class="market-banner market-banner-error"
    >
      {{ marketStore.error }}
    </p>

    <!-- 详情是「浏览」下面的一个子屏,所以它只在浏览页签里替换列表 -->
    <MarketDetail
      v-if="settingsNav.market.tab === 'browse' && settingsNav.market.detailId"
    />
    <MarketInstalled v-else-if="settingsNav.market.tab === 'installed'" />
    <MarketBrowse v-else-if="settingsNav.market.tab === 'browse'" />
    <MarketHosts v-else-if="settingsNav.market.tab === 'hosts'" />
    <MarketPublish v-else />
  </div>
</template>
