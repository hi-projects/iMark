<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import type { MenuCommandId } from '@shared/ipc-channels'
import type { LaunchIntent, Settings } from '@shared/types'
import FileExplorer from './components/FileExplorer.vue'
import OutlineSidebar from './components/OutlineSidebar.vue'
import QuickSwitcher from './components/QuickSwitcher.vue'
import VaultPicker from './components/VaultPicker.vue'
import TabBar from './components/TabBar.vue'
import EditorPane from './components/EditorPane.vue'
import WebviewHost from './components/WebviewHost.vue'
import PaneResizer from './components/PaneResizer.vue'
import StatusBar from './components/StatusBar.vue'
import NotificationCenter from './components/NotificationCenter.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import LineMenu from './components/LineMenu.vue'
import LineActionDialog from './components/LineActionDialog.vue'
import ExtensionDialogHost from './components/ExtensionDialogHost.vue'
import ConflictResolverDialog from './components/ConflictResolverDialog.vue'
import ToastHost from './components/ToastHost.vue'
import {
  activeTab,
  appStore,
  applyTheme,
  editorHolder,
  initExplorerVisible,
  initOutlineVisible,
  initSidebarWidths,
  initSkipVaultPicker,
  initStoreWatchers,
  openSettings,
  toggleExplorerVisible,
  toggleOutlineVisible,
  toggleTheme
} from './stores/app'
import { runFormatCommand, selectAllSmart } from './editor/commands'
import {
  closeTab,
  exportHtmlFile,
  newFile,
  openFileViaDialog,
  saveBeforeClose,
  saveCurrentFile,
  saveFileAs
} from './services/fileService'
import { stepTab } from './services/tabs'
import {
  enterEditorAndWait,
  initVaultList,
  loadVault,
  openFileFromSystem,
  openSwitcher,
  openVaultViaDialog,
  pruneMissingVaults,
  requestVaultSwitch,
  restoreLastDocument,
  toggleSwitcher
} from './services/vaultService'
import { openMarketSettings } from './services/settingsNav'
import { initEditorSettings, installFontSizeWheelZoom } from './services/editorSettings'
import { conflictResolver } from './services/conflictResolver'
import { api } from './services/api'

let offMenu: (() => void) | null = null
let offOpenFile: (() => void) | null = null
let offFontWheelZoom: (() => void) | null = null

/**
 * 扩展标签激活时，这些菜单命令属于扩展自己的文档，应该转发给面板而不是
 * 落到画布背后那个看不见的 Markdown 上。原生菜单加速键（Ctrl+S 等）会在
 * 渲染层 keydown 之前拦下事件，所以扩展页面里自己的快捷键接不到。
 */
const WEBVIEW_TAB_COMMANDS = new Set<MenuCommandId>([
  'file:save',
  'file:save-as',
  'edit:select-all'
])

function forwardToWebview(panelId: string, id: MenuCommandId): void {
  api.sendExtensionMessage({
    type: 'webview.message',
    panelId,
    message: { type: 'imark:command', command: id }
  })
}

async function handleMenuCommand(id: MenuCommandId): Promise<void> {
  // 仓库选择界面下没有编辑器实例,文件/格式类命令忽略(与 Obsidian 无仓库时一致)
  if (appStore.view === 'picker') {
    if (id === 'edit:select-all') {
      document.execCommand('selectAll')
      return
    }
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
  const current = activeTab()
  if (current?.kind === 'webview') {
    if (current.panelId && WEBVIEW_TAB_COMMANDS.has(id)) {
      forwardToWebview(current.panelId, id)
      return
    }
    // 格式化 / 导出 HTML 只对 Markdown 有意义：扩展标签激活时静默忽略，
    // 不能把命令应用到后面那个隐藏的编辑器上
    if (id.startsWith('format:') || id === 'file:export-html') return
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
    case 'file:close-tab': {
      const tab = activeTab()
      if (tab) await closeTab(tab.id)
      return
    }
    case 'file:next-tab':
      stepTab(1)
      return
    case 'file:prev-tab':
      stepTab(-1)
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
    case 'edit:select-all': {
      // 焦点在编辑器:代码块里先选这一块;焦点在输入框 / 扩展面板(iframe)里:
      // 不能用编辑器打全选 —— 交回浏览器原生的「全选当前焦点」
      const view = editorHolder.view
      if (view && view.hasFocus) selectAllSmart(view)
      else document.execCommand('selectAll')
      return
    }
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
  // Ctrl + 滚轮调正文字号:全窗口生效,不要求焦点在编辑器里
  offFontWheelZoom = installFontSizeWheelZoom()
  // 启动意图与设置一起取:任务栏中键「新开一个」要停在选择页,不能恢复上次仓库
  let settings: Settings | null = null
  let launch: LaunchIntent = { newWindow: false }
  try {
    ;[settings, launch] = await Promise.all([
      api.getSettings(),
      api.getLaunchIntent().catch(() => ({ newWindow: false }))
    ])
  } catch (err) {
    // 连设置都读不到:按默认亮色启动(主进程此时用的也是默认值)。
    // 必须真的 applyTheme,而不是只依赖 CSS 默认值 —— applyTheme 顺带把
    // 窗口控件配色同步给主进程,否则右上角会留在另一档颜色上。
    console.error('[iMark] 读取启动设置失败,按默认亮色主题启动:', err)
    applyTheme('light')
  }

  if (settings) {
    try {
      applyTheme(settings.theme)
      initOutlineVisible(settings.outline)
      initExplorerVisible(settings.explorer)
      initSidebarWidths(settings.explorerWidth, settings.outlineWidth)
      initVaultList(settings.vaults ?? [])
      // 列表初始化后再清一遍:选择页的 onMounted 早于这里,那时还没有仓库可查
      void pruneMissingVaults()
      initSkipVaultPicker(settings.skipVaultPicker)
      // 字号/换行要赶在第一个文档装载前定下来:新建 EditorState 时会读换行偏好
      initEditorSettings(settings)

      // 启动参数里带的文件优先于「恢复上次会话」:用户双击的就是这一份,
      // 不该先把上次那批标签恢复出来(它还可能属于另一个仓库)。
      // openFileFromSystem 会自己决定要不要顺带载入文件所属的仓库。
      const pending = await api.takePendingOpenFile()
      // 启动流程:默认先进入仓库选择界面;勾选「直接打开上次仓库」时才自动恢复。
      // 任务栏中键/Shift+点击明确要的是新窗口,即使勾了也不恢复。
      const canResume =
        !launch.newWindow && settings.skipVaultPicker && !!settings.vaultPath && settings.vaultPath.length > 0
      if (pending) {
        await openFileFromSystem(pending)
      } else if (canResume) {
        const ok = await loadVault(settings.vaultPath!, { silent: true })
        if (ok) {
          // 必须等 EditorPane 挂载完,否则恢复页面拿不到编辑器实例
          await enterEditorAndWait()
          // 关闭前打开了页面就恢复它;没有就什么都不打开
          await restoreLastDocument(settings.vaultPath!, settings)
        }
      }
    } catch (err) {
      // 恢复会话失败不影响主题:设置已经读到了,界面就该是设置里的那一档
      console.error('[iMark] 启动恢复失败:', err)
    }
  }
  // 启动意图已定:这时才允许选择页出现。恢复仓库的路径此时 view 已是 editor,
  // 选择页从来不会被渲染;停在选择页的路径则在这里一次性显示出来。
  appStore.booted = true
  // 主进程可能按「恢复上次仓库」先以最大化开窗,但恢复失败后界面仍停在选择页。
  // 选择页必须是启动尺寸且不可最大化,这里把窗口状态拉回来(正常启动是无操作)。
  if (appStore.view === 'picker') api.setWindowView('picker')
  offMenu = api.onMenuCommand(id => void handleMenuCommand(id))
  api.onSaveBeforeClose(() => void saveBeforeClose())
  // 运行中主进程递来一个文件(另一个实例打开同一仓库时转交过来)
  offOpenFile = api.onOpenFile(path => void openFileFromSystem(path))
})

onBeforeUnmount(() => {
  offMenu?.()
  offOpenFile?.()
  offFontWheelZoom?.()
})
</script>

<template>
  <!-- 启动意图确定前不画选择页:勾了「直接打开上次仓库」时它会一闪而过 -->
  <VaultPicker v-if="appStore.booted && appStore.view === 'picker'" />
  <div v-else-if="appStore.view === 'editor'" class="app-shell">
    <div
      class="app-body"
      :style="{
        '--explorer-width': appStore.explorerWidth + 'px',
        '--outline-width': appStore.outlineWidth + 'px'
      }"
    >
      <FileExplorer />
      <!-- 侧栏的可见性由各自组件里的 v-show 管:分界线跟着一起隐藏 -->
      <PaneResizer v-if="appStore.explorerVisible" side="explorer" />
      <!-- 标签栏与编辑器同处一列:它只在编辑区上方,不横跨左右侧栏 -->
      <div class="editor-column">
        <TabBar />
        <!-- webview 面板只覆盖编辑区，不压住标签栏 -->
        <div class="editor-stage">
          <EditorPane />
          <WebviewHost />
        </div>
      </div>
      <PaneResizer v-if="appStore.outlineVisible" side="outline" />
      <OutlineSidebar />
    </div>
    <StatusBar />
    <!-- 状态栏铃铛的小框:固定在右下角,层级低于设置 / 市场这些模态层 -->
    <NotificationCenter />
    <QuickSwitcher />
    <!-- 行首「+」的菜单与参数对话框:两者自带 v-if,没有扩展贡献菜单条目时什么都不渲染 -->
    <LineMenu />
    <LineActionDialog />
    <!-- 扩展要的模态框（消息/输入/快速选择），与行首菜单的参数框共用一套外观 -->
    <ExtensionDialogHost />
    <SettingsDialog />
    <!-- 合并冲突处理窗口:由扩展在冲突时打开,处理完可直接继续同步 -->
    <ConflictResolverDialog v-if="conflictResolver.open" />
    <!-- 右下角通知:层级最高,扩展在用户翻设置时报的错也要看得见 -->
    <ToastHost />
  </div>
  <!-- 启动的一小段:只留窗口背景色,等 booted 定下来再画选择页或编辑器 -->
  <div v-else class="app-boot"></div>
</template>
