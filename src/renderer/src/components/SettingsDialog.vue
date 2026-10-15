<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { Palette, Store, X } from 'lucide-vue-next'
import { computed } from 'vue'
import { appStore, closeSettings, setTheme, THEME_LABELS, THEME_ORDER } from '../stores/app'
import { remoteStore } from '../services/marketService'
import {
  openMarketSettings,
  pluginStore,
  selectPluginSettings,
  settingsNav,
  type MarketNav
} from '../services/pluginService'
import PluginSettings from './plugins/PluginSettings.vue'
import MarketPage from './market/MarketPage.vue'
import InstallConfirmDialog from './market/InstallConfirmDialog.vue'
import MarketSource from './market/MarketSource.vue'

/** 右侧标题:选中的是插件就显示插件名,市场页则跟着它的页签走 */
const title = computed(() => {
  if (settingsNav.page === 'market') {
    const tab: MarketNav['tab'] = settingsNav.market.tab
    if (tab === 'browse') return settingsNav.market.detailId ? '插件详情' : '浏览市场'
    return tab === 'publish' ? '发布插件' : '已安装插件'
  }
  if (settingsNav.page === 'plugin') {
    return (
      pluginStore.list.find(p => p.descriptor.id === settingsNav.pluginId)?.descriptor.name ?? '插件'
    )
  }
  return '外观'
})

/** 市场入口在左栏「插件」分组里排第一项(与 Obsidian 的心智一致) */
function openMarket(): void {
  openMarketSettings()
}

/** Esc 关闭:捕获阶段先于 CodeMirror 处理,面板打开时不会被编辑器吃掉 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && appStore.settingsOpen) {
    e.preventDefault()
    e.stopPropagation()
    closeSettings()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div v-if="appStore.settingsOpen" class="settings-mask" @mousedown.self="closeSettings()">
    <div class="settings-dialog">
      <aside class="settings-nav">
        <div class="settings-nav-group">选项</div>
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'appearance' }"
          @click="settingsNav.page = 'appearance'"
        >
          <Palette :size="15" />
          <span>外观</span>
        </button>
        <!-- 插件单独一行分组:市场排第一项,下面直接列出每个已安装插件 -->
        <div class="settings-nav-group">插件</div>
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'market' }"
          @click="openMarket()"
        >
          <Store :size="15" />
          <span>浏览市场</span>
          <!-- 有可用更新时挂个角标:这是用户唯一会主动看的地方 -->
          <span v-if="remoteStore.updates.length > 0" class="settings-nav-badge">
            {{ remoteStore.updates.length }}
          </span>
        </button>
        <button
          v-for="plugin in pluginStore.list"
          :key="plugin.descriptor.id"
          class="settings-nav-item"
          :class="{
            'settings-nav-active':
              settingsNav.page === 'plugin' && settingsNav.pluginId === plugin.descriptor.id
          }"
          @click="selectPluginSettings(plugin.descriptor.id)"
        >
          <span
            class="plugin-status-dot"
            :class="`plugin-status-${plugin.state.status}`"
            :title="plugin.state.lastMessage || '待运行'"
          />
          <span>{{ plugin.descriptor.name }}</span>
        </button>
        <div v-if="pluginStore.list.length === 0" class="settings-nav-empty">没有可用的插件</div>
      </aside>

      <section class="settings-main">
        <header class="settings-main-header">
          <h1>{{ title }}</h1>
          <button class="settings-close" title="关闭 (Esc)" @click="closeSettings()">
            <X :size="16" />
          </button>
        </header>

        <div v-if="settingsNav.page === 'market'" class="settings-body">
          <MarketPage />
        </div>

        <div v-else-if="settingsNav.page === 'plugin'" class="settings-body">
          <PluginSettings />
        </div>

        <div v-else class="settings-body">
          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">基础颜色</div>
              <div class="settings-section-desc">设置界面主题。选择后立即生效,并保存到本地设置。</div>
            </div>
            <div class="settings-themes">
              <button
                v-for="t in THEME_ORDER"
                :key="t"
                class="settings-theme"
                :class="{ 'settings-theme-active': appStore.theme === t }"
                :title="`${THEME_LABELS[t]}主题`"
                @click="setTheme(t)"
              >
                <span class="settings-theme-swatch" :data-preview="t">
                  <span class="settings-theme-swatch-bar"></span>
                  <span class="settings-theme-swatch-line"></span>
                  <span class="settings-theme-swatch-line settings-theme-swatch-line-short"></span>
                </span>
                <span class="settings-theme-label">{{ THEME_LABELS[t] }}</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>

  <!--
    确认框放在设置面板**外面**:它是由市场页发起的,而关闭设置面板不该顺手把
    一个待确认的安装丢掉(那会让人以为「点了取消」,但主进程那边其实还留着)。
    它自带 v-if,没有待确认项时什么都不渲染。
  -->
  <InstallConfirmDialog />

  <!-- 源码查看器同样放在外面:它是个全屏浮层,不该受设置面板的滚动区域与关闭逻辑约束 -->
  <MarketSource />
</template>
