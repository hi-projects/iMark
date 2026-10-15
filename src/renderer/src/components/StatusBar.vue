<script setup lang="ts">
import { computed } from 'vue'
import { ChevronsUpDown, CloudUpload, ListTree, Moon, PanelLeft, Settings, Sun } from 'lucide-vue-next'
import {
  appStore,
  editorHolder,
  openSettings,
  THEME_LABELS,
  THEME_ORDER,
  toggleExplorerVisible,
  toggleOutlineVisible,
  toggleTheme
} from '../stores/app'
import { requestVaultSwitch } from '../services/vaultService'
import { gitSyncPlugin, openPluginSettings, syncNow } from '../services/pluginService'

function openVaultSwitcher(): void {
  void requestVaultSwitch()
}

/** 侧栏开关:切换后把焦点还给编辑器,便于继续输入 */
function toggleExplorer(): void {
  toggleExplorerVisible()
  editorHolder.view?.focus()
}

function toggleOutline(): void {
  toggleOutlineVisible()
  editorHolder.view?.focus()
}

const isDark = computed(() => appStore.theme !== 'light')
const nextTheme = computed(() => THEME_ORDER[(THEME_ORDER.indexOf(appStore.theme) + 1) % THEME_ORDER.length]!)
const themeTitle = computed(
  () => `${THEME_LABELS[appStore.theme]}主题 · 点击切换为${THEME_LABELS[nextTheme.value]}主题`
)
const fileLabel = computed(() => `${appStore.fileName}${appStore.dirty ? ' ●' : ''}`)

/**
 * 定时上传插件的状态图标。
 * 按 id 找、而不是取列表里的第一个:插件现在可以任意装卸,列表首位是谁并不确定。
 * 没装/已卸载时整颗按钮不显示 —— 这正是用户卸载了它之后应该看到的。
 */
const syncPlugin = computed(() => gitSyncPlugin())
const syncTitle = computed(() => {
  const p = syncPlugin.value
  if (!p) return ''
  if (!p.state.enabled) return '定时上传未启用 · 点击打开插件设置'
  const when = p.state.lastRunAt
    ? new Date(p.state.lastRunAt).toLocaleString('zh-CN', { hour12: false })
    : '从未运行'
  const detail = p.state.lastDetail ? `\n${p.state.lastDetail}` : ''
  return `定时上传:${p.state.lastMessage || '待运行'}(上次 ${when})${detail}`
})

function onSyncClick(): void {
  const p = syncPlugin.value
  if (!p) return
  // 失败或未启用时直接进插件设置(那里有详情与「立即上传」),正常情况下点一下就是手动同步
  if (!p.state.enabled || p.state.status === 'error') openPluginSettings()
  else void syncNow()
}
</script>

<template>
  <div class="status-bar">
    <!-- 侧栏开关:文件列表 / 大纲 -->
    <span class="status-toggles">
      <button
        :class="{ 'status-toggle-on': appStore.explorerVisible }"
        :title="`${appStore.explorerVisible ? '收起' : '展开'}文件列表 (Ctrl+Shift+L)`"
        @click="toggleExplorer()"
      >
        <PanelLeft :size="14" />
      </button>
      <button
        :class="{ 'status-toggle-on': appStore.outlineVisible }"
        :title="`${appStore.outlineVisible ? '收起' : '展开'}大纲 (Ctrl+Shift+O)`"
        @click="toggleOutline()"
      >
        <ListTree :size="14" />
      </button>
    </span>
    <button
      v-if="appStore.vaultName"
      class="status-vault"
      :title="`${appStore.vaultPath ?? ''} · 点击切换仓库`"
      @click="openVaultSwitcher()"
    >
      <ChevronsUpDown :size="13" />
      <span class="status-vault-name">{{ appStore.vaultName }}</span>
    </button>
    <span>字数 {{ appStore.words }}</span>
    <span>字符 {{ appStore.chars }}</span>
    <span>行数 {{ appStore.lines }}</span>
    <span class="status-spacer"></span>
    <span class="status-file" :title="appStore.filePath ?? '未保存到磁盘'">{{ fileLabel }}</span>
    <span class="status-actions">
      <button
        v-if="syncPlugin"
        class="status-sync-btn"
        :class="{
          'status-sync-error': syncPlugin.state.status === 'error',
          'status-sync-ok': syncPlugin.state.status === 'ok'
        }"
        :title="syncTitle"
        @click="onSyncClick()"
      >
        <CloudUpload :size="14" :class="{ 'status-sync-running': syncPlugin.state.status === 'running' }" />
      </button>
      <button :title="themeTitle" @click="toggleTheme()">
        <Sun v-if="isDark" :size="14" />
        <Moon v-else :size="14" />
      </button>
      <button title="设置 (Ctrl+,)" @click="openSettings()">
        <Settings :size="14" />
      </button>
    </span>
  </div>
</template>
