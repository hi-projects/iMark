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
import LineMenu from './components/LineMenu.vue'
import LineActionDialog from './components/LineActionDialog.vue'
import ToastHost from './components/ToastHost.vue'
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
  openFileFromSystem,
  openFileViaDialog,
  saveBeforeClose,
  saveCurrentFile,
  saveFileAs
} from './services/fileService'
import {
  enterEditorAndWait,
  initVaultList,
  loadVault,
  openSwitcher,
  openVaultViaDialog,
  requestVaultSwitch,
  toggleSwitcher
} from './services/vaultService'
import { openMarketSettings } from './services/pluginService'
import { initEditorSettings } from './services/editorSettings'
import { isInside } from './utils/paths'
import { api } from './services/api'

let offMenu: (() => void) | null = null
let offOpenFile: (() => void) | null = null

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
    case 'view:command-palette':
      openSwitcher('command')
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
    const settings = await api.getSettings()
    applyTheme(settings.theme)
    initOutlineVisible(settings.outline ?? true)
    initExplorerVisible(settings.explorer ?? true)
    initVaultList(settings.vaults ?? [])
    initSkipVaultPicker(settings.skipVaultPicker ?? false)
    // 字号/换行要赶在第一个文档装载前定下来:loadDocument 重建 state 时会读换行偏好
    initEditorSettings(settings)

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
  offMenu = api.onMenuCommand(id => void handleMenuCommand(id))
  api.onSaveBeforeClose(() => void saveBeforeClose())
  // 运行中系统又递来一个文件(第二个实例的 argv)
  offOpenFile = api.onOpenFile(path => void openFileFromSystem(path))
  // 启动参数里带的那个文件,等上面这一整套初始化完成后再取 —— 顺序天然正确
  const pending = await api.takePendingOpenFile()
  if (pending) await openFileFromSystem(pending)
})

onBeforeUnmount(() => {
  offMenu?.()
  offOpenFile?.()
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
    <!-- 行首「+」的菜单与参数对话框:两者自带 v-if,没有插件贡献菜单条目时什么都不渲染 -->
    <LineMenu />
    <LineActionDialog />
    <SettingsDialog />
    <!-- 右下角通知:层级最高,插件在用户翻设置时报的错也要看得见 -->
    <ToastHost />
  </div>
</template>
