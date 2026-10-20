<script setup lang="ts">
import { computed } from 'vue'
import {
  Bell,
  ChevronsUpDown,
  ListTree,
  Moon,
  PanelLeft,
  Settings,
  Sun
} from 'lucide-vue-next'
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
import { noticeCenter, toggleNoticeCenter } from '../services/notice'

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

/**
 * 自动保存的即时反馈。自动保存是不声不响发生的,没点动静用户不会放心 ——
 * 但常驻一个「已保存」又会在没改动时误导人,所以只在保存后亮几秒(时刻由服务决定)。
 */
const autoSaveClock = computed(() =>
  appStore.autoSavedAt ? new Date(appStore.autoSavedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''
)

/** 铃铛角标:未读超过两位数就不再往里塞,免得把按钮撑变形 */
const unreadLabel = computed(() =>
  noticeCenter.unread > 99 ? '99+' : String(noticeCenter.unread)
)
const notifyTitle = computed(() =>
  noticeCenter.unread > 0 ? `通知（${noticeCenter.unread} 条未读）` : '通知'
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
    <!--
      左下角从左到右:设置 / 主题 → 目录、大纲 → 插件图标。
      两条竖线把它们分成三组,组内按钮只隔 2px,组与组之间靠状态栏的 gap 拉开。
    -->
    <span class="status-app-actions">
      <button title="设置 (Ctrl+,)" @click="openSettings()">
        <Settings :size="14" />
      </button>
      <button :title="themeTitle" @click="toggleTheme()">
        <Sun v-if="isDark" :size="14" />
        <Moon v-else :size="14" />
      </button>
    </span>
    <span class="status-sep" aria-hidden="true"></span>
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
    <span class="status-sep" aria-hidden="true"></span>
    <!--
      插件图标组:插件声明的状态条目 + render 层插件自画的按钮(AI for Edit)。
      宿主不认识它们是什么(只认识一个 id 和一个动作):图标白名单里认得出的画图标,
      认不出的显示文字 —— 插件给的是一个名字,不是一段界面。
    -->
    <span class="status-plugin-group">
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
      <!--
        render 层插件自画的状态栏按钮落在这里(目前是 AI for Edit)。
        它是一个**空槽**:Vue 不往里面放节点,插件挂进来的按钮就不会在
        状态栏重渲染时被一起抹掉。
      -->
      <span class="status-plugin-slot"></span>
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
    <!-- 没有打开页面时,0 字 0 行不是「统计结果」,是空状态;不显示反而诚实 -->
    <template v-if="appStore.hasDocument">
      <span>字数 {{ appStore.words }}</span>
      <span>字符 {{ appStore.chars }}</span>
      <span>行数 {{ appStore.lines }}</span>
    </template>
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
    <span class="status-actions">
      <!-- 右下角:通知中心。未读数用角标,点开是 NotificationCenter 的小框 -->
      <button
        class="status-notify"
        data-notify-toggle
        :class="{ 'status-toggle-on': noticeCenter.open }"
        :title="notifyTitle"
        @click="toggleNoticeCenter()"
      >
        <Bell :size="14" />
        <span v-if="noticeCenter.unread > 0" class="status-notify-badge">
          {{ unreadLabel }}
        </span>
      </button>
    </span>
  </div>
</template>
