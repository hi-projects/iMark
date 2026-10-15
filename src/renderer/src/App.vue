<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import type { MenuCommandId } from '@shared/ipc-channels'
import FileExplorer from './components/FileExplorer.vue'
import OutlineSidebar from './components/OutlineSidebar.vue'
import QuickSwitcher from './components/QuickSwitcher.vue'
import VaultPicker from './components/VaultPicker.vue'
import EditorPane from './components/EditorPane.vue'
import StatusBar from './components/StatusBar.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import {
  appStore,
  applyTheme,
  editorHolder,
  initExplorerVisible,
  initOutlineVisible,
  initSkipVaultPicker,
  initStoreWatchers,
  openSettings,
  toggleExplorerVisible,
  toggleOutlineVisible,
  toggleTheme
} from './stores/app'
import { runFormatCommand } from './editor/commands'
import {
  exportHtmlFile,
  newFile,
  openFileByPath,
  openFileViaDialog,
  saveBeforeClose,
  saveCurrentFile,
  saveFileAs
} from './services/fileService'
import {
  enterEditorAndWait,
  initVaultList,
  loadVault,
  openVaultViaDialog,
  requestVaultSwitch,
  toggleSwitcher
} from './services/vaultService'
import { openMarketSettings } from './services/pluginService'
import { isInside } from './utils/paths'

let offMenu: (() => void) | null = null

async function handleMenuCommand(id: MenuCommandId): Promise<void> {
  // 仓库选择界面下没有编辑器实例,文件/格式类命令忽略(与 Obsidian 无仓库时一致)
  if (appStore.view === 'picker') {
    if (id === 'view:toggle-theme') {
      await toggleTheme()
      return
    }
    if (id === 'view:settings') {
      openSettings()
      return
    }
    if (id === 'view:market') {
      openMarketSettings()
      return
    }
    if (id === 'file:open-vault') {
      await openVaultViaDialog()
      return
    }
    return
  }
  switch (id) {
    case 'file:new':
      await newFile()
      return
    case 'file:open':
      await openFileViaDialog()
      return
    case 'file:open-vault':
      await openVaultWithConfirm()
      return
    case 'file:quick-switch':
      toggleSwitcher()
      return
    case 'file:save':
      void saveCurrentFile()
      return
    case 'file:save-as':
      void saveFileAs()
      return
    case 'file:export-html':
      await exportHtmlFile()
      return
    case 'view:toggle-theme':
      await toggleTheme()
      return
    case 'view:toggle-outline':
      toggleOutlineVisible()
      return
    case 'view:toggle-explorer':
      toggleExplorerVisible()
      return
    case 'view:settings':
      openSettings()
      return
    case 'view:market':
      openMarketSettings()
      return
    default: {
      const view = editorHolder.view
      if (view) runFormatCommand(view, id)
    }
  }
}

/**
 * 切换仓库(菜单「打开仓库」):先对脏文档做出决定,然后回到仓库选择界面,
 * 由用户在列表中选择目标仓库(与 Obsidian 的 "Open another vault" 一致)。
 */
async function openVaultWithConfirm(): Promise<void> {
  await requestVaultSwitch()
}

onMounted(async () => {
  initStoreWatchers()
  // 阻止窗口级默认拖放导航(文件拖出编辑区时防止 Electron 加载该文件)
  window.addEventListener('dragover', e => e.preventDefault())
  window.addEventListener('drop', e => e.preventDefault())
  try {
    const settings = await window.api.getSettings()
    applyTheme(settings.theme)
    initOutlineVisible(settings.outline ?? true)
    initExplorerVisible(settings.explorer ?? true)
    initVaultList(settings.vaults ?? [])
    initSkipVaultPicker(settings.skipVaultPicker ?? false)

    // 启动流程:默认先进入仓库选择界面;勾选「直接打开上次仓库」时才自动恢复
    const canResume =
      settings.skipVaultPicker && !!settings.vaultPath && settings.vaultPath.length > 0
    if (canResume) {
      const ok = await loadVault(settings.vaultPath!, { silent: true })
      if (ok) {
        // 必须等 EditorPane 挂载完,否则 openFileByPath 拿不到编辑器实例
        await enterEditorAndWait()
        if (settings.lastFile && isInside(settings.vaultPath!, settings.lastFile)) {
          await openFileByPath(settings.lastFile, { silent: true, force: true })
        }
      }
    }
  } catch {
    applyTheme('light')
  }
  offMenu = window.api.onMenuCommand(id => void handleMenuCommand(id))
  window.api.onSaveBeforeClose(() => void saveBeforeClose())
})

onBeforeUnmount(() => {
  offMenu?.()
})
</script>

<template>
  <VaultPicker v-if="appStore.view === 'picker'" />
  <div v-else class="app-shell">
    <div class="app-body">
      <FileExplorer />
      <EditorPane />
      <OutlineSidebar />
    </div>
    <StatusBar />
    <QuickSwitcher />
    <SettingsDialog />
  </div>
</template>
