<script setup lang="ts">
import { computed } from 'vue'
import { ChevronsUpDown, ListTree, Moon, PanelLeft, Settings, Sun } from 'lucide-vue-next'
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
import { openPluginSettings, pluginById } from '../services/pluginService'
import {
  invokeContrib,
  pluginIcon,
  statusEntries,
  statusTitle,
  type StatusEntry
} from '../services/pluginUi'

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
 * 自动保存的即时反馈。自动保存是不声不响发生的,没点动静用户不会放心 ——
 * 但常驻一个「已保存」又会在没改动时误导人,所以只在保存后亮几秒(时刻由服务决定)。
 */
const autoSaveClock = computed(() =>
  appStore.autoSavedAt ? new Date(appStore.autoSavedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
)

/**
 * 插件状态条目的点击规则。
 *
 * 从前的「定时上传」按钮把这条规则写死在组件里(出错就进设置、正常就同步),
 * 现在它成了**所有**插件条目共用的规则 —— 而且不是规定,是唯一说得通的做法:
 * 插件处在错误状态时,它那条 action 自己也正是失败的那个,再点一次只会再失败一次;
 * 这时用户要的是"去设置里看看为什么"。
 */
function onStatusClick(entry: StatusEntry): void {
  const view = pluginById(entry.pluginId)
  if (
    !view ||
    !view.state.enabled ||
    view.state.status === 'error' ||
    view.state.status === 'partial'
  ) {
    openPluginSettings(entry.pluginId)
    return
  }
  void invokeContrib({ pluginId: entry.pluginId, itemId: entry.item.id, from: 'status' })
}

/** 状态栏按钮的着色:成功/失败直接反映插件自己报的状态 */
function statusClass(pluginId: string): Record<string, boolean> {
  const status = pluginById(pluginId)?.state.status
  return {
    'status-plug-error': status === 'error' || status === 'partial',
    'status-plug-ok': status === 'ok',
    'status-plug-running': status === 'running'
  }
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
    <span
      v-if="appStore.autoSaveError"
      class="status-autosave status-autosave-error"
      :title="`自动保存失败:${appStore.autoSaveError}`"
    >
      自动保存失败
    </span>
    <span
      v-else-if="appStore.autoSavedAt"
      :key="appStore.autoSavedAt"
      class="status-autosave"
      :title="`自动保存已写入文件 · ${autoSaveClock}`"
    >
      已自动保存 {{ autoSaveClock }}
    </span>
    <span class="status-file" :title="appStore.filePath ?? '未保存到磁盘'">{{ fileLabel }}</span>
    <span class="status-actions">
      <!--
        插件状态条目:宿主不认识它们是什么(只认识一个 id 和一个动作)。
        图标白名单里认得出的画图标,认不出的显示文字 —— 插件给的是一个名字,
        不是一段界面。
      -->
      <button
        v-for="entry in statusEntries"
        :key="`${entry.pluginId}:${entry.item.id}`"
        class="status-plug"
        :class="{ ...statusClass(entry.pluginId), 'status-plug-text': !pluginIcon(entry.item.icon) }"
        :title="statusTitle(entry)"
        @click="onStatusClick(entry)"
      >
        <component
          :is="pluginIcon(entry.item.icon)"
          v-if="pluginIcon(entry.item.icon)"
          :size="14"
        />
        <span v-else class="status-plug-label">{{ entry.item.label }}</span>
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
