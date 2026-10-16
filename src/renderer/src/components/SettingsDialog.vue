<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { Palette, RotateCcw, Store, TextCursorInput, X } from 'lucide-vue-next'
import { computed } from 'vue'
import {
  AUTO_SAVE_INTERVAL_MAX,
  AUTO_SAVE_INTERVAL_MIN,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  intervalLabel
} from '@shared/editorSettings'
import { appStore, closeSettings, setTheme, THEME_LABELS, THEME_ORDER } from '../stores/app'
import {
  previewFontSize,
  resetEditorSettings,
  setAutoSave,
  setAutoSaveInterval,
  setEditorFontSize,
  setLineWrapping
} from '../services/editorSettings'
import { remoteStore } from '../services/marketService'
import {
  openMarketSettings,
  pluginStore,
  selectPluginSettings,
  settingsNav,
  type MarketNav
} from '../services/pluginService'
import PluginSettings from './plugins/PluginSettings.vue'
import UserStyleSettings from './UserStyleSettings.vue'
import MarketPage from './market/MarketPage.vue'
import InstallConfirmDialog from './market/InstallConfirmDialog.vue'
import MarketSource from './market/MarketSource.vue'

/**
 * 形态在列表里的短标签。
 *
 * 用词刻意选得直白(而不是"声明式/沙箱"这种术语):
 * 用户要判断的是"这东西能碰我多少东西",不是记住了几个名词。
 */
const KIND_SHORT: Record<string, string> = {
  script: '完整权限',
  sandboxed: '沙箱',
  declarative: '无代码',
  builtin: '内置'
}

/** 右侧标题:选中的是插件就显示插件名,市场页则跟着它的页签走 */
const title = computed(() => {
  if (settingsNav.page === 'market') {
    const tab: MarketNav['tab'] = settingsNav.market.tab
    if (tab === 'browse') return settingsNav.market.detailId ? '插件详情' : '浏览市场'
    return tab === 'publish' ? '发布插件' : '已安装插件'
  }
  if (settingsNav.page === 'editor') return '编辑器'
  if (settingsNav.page === 'plugin') {
    return (
      pluginStore.list.find(p => p.descriptor.id === settingsNav.pluginId)?.descriptor.name ?? '插件'
    )
  }
  return '外观'
})

/** 间隔的常用档位。多数人只想在「别太频繁」和「别丢太多」之间挑一个,不想算秒数 */
const INTERVAL_PRESETS = [
  { label: '10 秒', sec: 10 },
  { label: '30 秒', sec: 30 },
  { label: '1 分钟', sec: 60 },
  { label: '5 分钟', sec: 300 },
  { label: '10 分钟', sec: 600 }
]

/**
 * 手打间隔:越界由 clampInterval 夹到上下限,输入框会跟着回弹。
 * 清空时按「没输入」而不是 0 处理 —— 否则一顿删除反而落到最短的 5 秒,
 * 成了最激进的档位,显然不是清空的人想要的。
 */
function onIntervalChange(e: Event): void {
  const raw = (e.target as HTMLInputElement).value.trim()
  void setAutoSaveInterval(raw === '' ? Number.NaN : Number(raw))
}

/** 拖滑块时即时预览字号(只改画面),松手才写盘 */
function onFontSizeInput(e: Event): void {
  previewFontSize(Number((e.target as HTMLInputElement).value))
}

function onFontSizeCommit(e: Event): void {
  void setEditorFontSize(Number((e.target as HTMLInputElement).value))
}

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
        <button
          class="settings-nav-item"
          :class="{ 'settings-nav-active': settingsNav.page === 'editor' }"
          @click="settingsNav.page = 'editor'"
        >
          <TextCursorInput :size="15" />
          <span>编辑器</span>
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
          <span class="settings-nav-label">{{ plugin.descriptor.name }}</span>
          <!--
            形态标签:**列表上就要看得见**。
            脚本插件能做的事(完整权限 + 改主界面)和沙箱插件差着一个量级,
            而这个区别只写在详情页里等于没写 —— 用户是在列表里挑插件的。
          -->
          <span class="plugin-kind-chip" :class="`plugin-kind-${plugin.kind ?? 'builtin'}`">
            {{ KIND_SHORT[plugin.kind ?? 'builtin'] }}
          </span>
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

        <div v-else-if="settingsNav.page === 'editor'" class="settings-body">
          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">定时保存</div>
              <div class="settings-section-desc">
                按固定间隔把改动写回文件,不用一直惦记着按 Ctrl+S。
                只对已经保存过的文件生效:还没落过盘的新文档不会被自动保存,
                免得在输入到一半时弹出「另存为」。
              </div>
            </div>

            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row-info">
                  <div class="settings-row-title">启用定时保存</div>
                  <div class="settings-row-desc">
                    {{
                      appStore.autoSave
                        ? `已开启 · ${intervalLabel(appStore.autoSaveInterval)}保存一次`
                        : '当前关闭,只能手动保存 (Ctrl+S)'
                    }}
                  </div>
                </div>
                <label
                  class="settings-switch"
                  :title="appStore.autoSave ? '关闭定时保存' : '开启定时保存'"
                >
                  <input type="checkbox" :checked="appStore.autoSave" @change="setAutoSave(!appStore.autoSave)" />
                  <span class="settings-switch-track" />
                </label>
              </div>

              <div class="settings-row settings-row-stack">
                <div class="settings-row-info">
                  <div class="settings-row-title">保存间隔</div>
                  <div class="settings-row-desc">
                    最短 {{ AUTO_SAVE_INTERVAL_MIN }} 秒,最长 1 小时。
                    没有改动的间隔不写盘,文件不会被无谓地刷新时间戳。
                  </div>
                </div>
                <div class="settings-control">
                  <span class="settings-presets">
                    <button
                      v-for="p in INTERVAL_PRESETS"
                      :key="p.sec"
                      class="settings-preset"
                      :class="{ 'settings-preset-active': appStore.autoSaveInterval === p.sec }"
                      @click="setAutoSaveInterval(p.sec)"
                    >
                      {{ p.label }}
                    </button>
                  </span>
                  <label class="settings-number-wrap">
                    <input
                      class="settings-number"
                      type="number"
                      :min="AUTO_SAVE_INTERVAL_MIN"
                      :max="AUTO_SAVE_INTERVAL_MAX"
                      step="5"
                      :value="appStore.autoSaveInterval"
                      @change="onIntervalChange"
                    />
                    <span class="settings-unit">秒</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-section-head">
              <div class="settings-section-title">显示</div>
            </div>

            <div class="settings-card">
              <div class="settings-row">
                <div class="settings-row-info">
                  <div class="settings-row-title">自动换行</div>
                  <div class="settings-row-desc">
                    关闭后长段落不折行,靠横向滚动看完整行;表格、公式这类宽内容更适合关闭。
                  </div>
                </div>
                <label
                  class="settings-switch"
                  :title="appStore.lineWrapping ? '关闭自动换行' : '开启自动换行'"
                >
                  <input type="checkbox" :checked="appStore.lineWrapping" @change="setLineWrapping(!appStore.lineWrapping)" />
                  <span class="settings-switch-track" />
                </label>
              </div>

              <div class="settings-row settings-row-stack">
                <div class="settings-row-info">
                  <div class="settings-row-title">正文字号</div>
                  <div class="settings-row-desc">标题、代码块会按比例一起缩放,只影响编辑器,不影响导出。</div>
                </div>
                <div class="settings-control">
                  <input
                    class="settings-range"
                    type="range"
                    :min="EDITOR_FONT_SIZE_MIN"
                    :max="EDITOR_FONT_SIZE_MAX"
                    step="1"
                    :value="appStore.editorFontSize"
                    @input="onFontSizeInput"
                    @change="onFontSizeCommit"
                  />
                  <span class="settings-readout">{{ appStore.editorFontSize }} px</span>
                </div>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <button class="settings-reset" @click="resetEditorSettings()">
              <RotateCcw :size="13" />
              <span>恢复默认设置</span>
            </button>
          </div>
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

          <UserStyleSettings />
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
