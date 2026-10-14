<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { Palette, X } from 'lucide-vue-next'
import { computed } from 'vue'
import { appStore, closeSettings, setTheme, THEME_LABELS, THEME_ORDER } from '../stores/app'
import { pluginStore, selectPluginSettings, settingsNav } from '../services/pluginService'
import PluginSettings from './plugins/PluginSettings.vue'

/** 右侧标题:选中的是插件就显示插件名 */
const title = computed(() => {
  if (settingsNav.page !== 'plugin') return '外观'
  return pluginStore.list.find(p => p.descriptor.id === settingsNav.pluginId)?.descriptor.name ?? '插件'
})

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
        <!-- 插件单独一行分组,下面直接列出每个插件;点插件右侧就是它的配置 -->
        <div class="settings-nav-group">插件</div>
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

        <div v-if="settingsNav.page === 'plugin'" class="settings-body">
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
</template>
