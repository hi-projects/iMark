<script setup lang="ts">
import { computed, watch } from 'vue'
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
  activeTab,
  appStore,
  editorHolder,
  openSettings,
  THEME_LABELS,
  THEME_ORDER,
  toggleExplorerVisible,
  toggleOutlineVisible,
  toggleTheme
} from '../stores/app'
import type { ExtensionStatusItemView } from '@shared/extensions'
import { requestVaultSwitch } from '../services/vaultService'
import {
  clickStatusItem,
  statusColor,
  statusEntries,
  statusIcon,
  statusLabel,
  statusTitle,
  statusTone
} from '../services/extensionUi'
import { extensionById } from '../services/extensionService'
import { ensureExtensionIcon, extensionIconOf } from '../services/extensionIcons'
import PluginIcon from './plugins/PluginIcon.vue'
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

const activeDoc = computed(() => activeTab())
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
 * 左右两组按 `alignment` 分开:扩展在 `createStatusBarItem(alignment)` 里
 * 声明的就是「贴左」还是「贴右」,宿主替它决定位置就等于说谎。
 */
const leftStatusEntries = computed(() =>
  statusEntries.value.filter(entry => entry.alignment === 'left')
)
const rightStatusEntries = computed(() =>
  statusEntries.value.filter(entry => entry.alignment === 'right')
)

function statusClass(entry: ExtensionStatusItemView): Record<string, boolean> {
  const tone = statusTone(entry.status)
  return {
    'status-plug-error': tone === 'error',
    'status-plug-ok': tone === 'ok',
    'status-plug-running': tone === 'running'
  }
}

function statusStyle(entry: ExtensionStatusItemView): Record<string, string> {
  const style: Record<string, string> = {}
  const color = statusColor(entry.color)
  if (color) style.color = color
  const background = statusColor(entry.backgroundColor)
  if (background) style.backgroundColor = background
  return style
}

/** 清单声明了图标的扩展:状态栏优先画它自己的图标,比文字/通用 codicon 更好认 */
function hasExtensionIcon(entry: ExtensionStatusItemView): boolean {
  return Boolean(extensionIconOf(entry.extensionId))
}

// 状态条目出现时预取图标;取不到(旧安装包没带 icon.svg)就继续用文字,不放空按钮
watch(
  () => statusEntries.value.map(entry => entry.extensionId),
  ids => {
    for (const id of ids) {
      if (extensionById(id)?.descriptor.icon) ensureExtensionIcon(id)
    }
  },
  { immediate: true }
)

function statusItemTitle(entry: ExtensionStatusItemView): string {
  const title = statusTitle(entry)
  return hasExtensionIcon(entry) ? `${entry.extensionName}\n${title}` : title
}
</script>

<template>
  <div class="status-bar">
    <!--
      左下角从左到右:设置 / 主题 → 目录、大纲 → 扩展图标。
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
    <!--
      扩展状态条目(贴左的那些):扩展只给文本、命令与状态,宿主只负责画。
      文本里的 `$(icon)` 走图标白名单;认不出就原样显示文字 —— 扩展给的是名字,
      不是一段要宿主渲染的界面。
    -->
    <template v-if="leftStatusEntries.length">
      <span class="status-sep" aria-hidden="true"></span>
      <span class="status-plugin-group">
        <button
          v-for="entry in leftStatusEntries"
          :key="entry.id"
          class="status-plug"
          :class="{ ...statusClass(entry), 'status-plug-text': !hasExtensionIcon(entry) && !statusIcon(entry.text) }"
          :style="statusStyle(entry)"
          :title="statusItemTitle(entry)"
          @click="clickStatusItem(entry)"
        >
          <template v-if="hasExtensionIcon(entry)">
            <PluginIcon :id="entry.extensionId" :size="14" class="status-plug-icon" />
            <span
              class="status-plug-dot"
              :class="`status-plug-dot-${statusTone(entry.status)}`"
            />
          </template>
          <template v-else>
            <component v-if="statusIcon(entry.text)" :is="statusIcon(entry.text)" :size="14" />
            <span v-if="statusLabel(entry.text)" class="status-plug-label">
              {{ statusLabel(entry.text) }}
            </span>
          </template>
        </button>
      </span>
    </template>
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
    <template v-if="activeDoc">
      <span>字数 {{ activeDoc.words }}</span>
      <span>字符 {{ activeDoc.chars }}</span>
      <span>行数 {{ activeDoc.lines }}</span>
    </template>
    <span class="status-spacer"></span>
    <!-- 贴右的扩展条目:在自动保存提示与通知铃铛之前 -->
    <span v-if="rightStatusEntries.length" class="status-plugin-group">
      <button
        v-for="entry in rightStatusEntries"
        :key="entry.id"
        class="status-plug"
        :class="{ ...statusClass(entry), 'status-plug-text': !hasExtensionIcon(entry) && !statusIcon(entry.text) }"
        :style="statusStyle(entry)"
        :title="statusItemTitle(entry)"
        @click="clickStatusItem(entry)"
      >
        <template v-if="hasExtensionIcon(entry)">
          <PluginIcon :id="entry.extensionId" :size="14" class="status-plug-icon" />
          <span
            class="status-plug-dot"
            :class="`status-plug-dot-${statusTone(entry.status)}`"
          />
        </template>
        <template v-else>
          <component v-if="statusIcon(entry.text)" :is="statusIcon(entry.text)" :size="14" />
          <span v-if="statusLabel(entry.text)" class="status-plug-label">
            {{ statusLabel(entry.text) }}
          </span>
        </template>
      </button>
    </span>
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
