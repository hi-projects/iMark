<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Search, Terminal, Zap } from 'lucide-vue-next'
import { appStore, type VaultFileRef } from '../stores/app'
import { closeSwitcher, openVaultFile, searchVaultFiles } from '../services/vaultService'
import { runExtensionCommand } from '../services/extensionService'
import { searchExtensionCommands, type PaletteCommand } from '../services/extensionUi'

/**
 * 快速切换器 —— 一个面板,两种东西:文件与命令。
 *
 * 合成一个面板而不是各做一个,是因为两者的交互逐字相同(输入 → 上下选 → 回车),
 * 分成两个面板只会带来两个快捷键、两套样式,以及"我刚才按的是哪个"。
 * 分界线就是输入框里的 `>`:以它开头就是搜命令 —— 这个约定来自 VSCode/Obsidian,
 * 用户不用学;而打开方式(搜文件 / 命令面板)只是决定要不要**替你打上**这个 `>`。
 */

const query = ref('')
const activeIndex = ref(0)
const listEl = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const COMMAND_PREFIX = '>'

/** 以 `>` 开头 = 命令模式。输入框里的内容才是唯一真相,不是打开时那个模式 */
const isCommandMode = computed(() => query.value.trimStart().startsWith(COMMAND_PREFIX))
/** 命令模式下的实际关键词(去掉前缀) */
const keyword = computed(() =>
  isCommandMode.value ? query.value.trimStart().slice(COMMAND_PREFIX.length).trim() : query.value
)

const fileResults = computed<VaultFileRef[]>(() =>
  isCommandMode.value ? [] : searchVaultFiles(keyword.value)
)
const commandResults = computed<PaletteCommand[]>(() =>
  isCommandMode.value ? searchExtensionCommands(keyword.value) : []
)

/** 当前列出的条数 —— 上下键与回车的边界都由它决定 */
const count = computed(() => (isCommandMode.value ? commandResults.value.length : fileResults.value.length))

function pluginBadge(cmd: PaletteCommand): string {
  return cmd.detail ? `${cmd.extensionName} · ${cmd.detail}` : cmd.extensionName
}

watch(
  () => appStore.switcherOpen,
  open => {
    if (open) {
      // 命令模式直接替用户打上 `>`,省得记约定;删掉它自然就回到搜文件
      query.value = appStore.switcherMode === 'command' ? `${COMMAND_PREFIX} ` : ''
      activeIndex.value = 0
      void nextTick(() => input.value?.focus())
    }
  }
)

watch([keyword, isCommandMode], () => {
  activeIndex.value = 0
})

function scrollToActive(): void {
  void nextTick(() => {
    listEl.value?.querySelector('.switcher-item-active')?.scrollIntoView({ block: 'nearest' })
  })
}

function move(delta: number): void {
  if (count.value === 0) return
  activeIndex.value = (activeIndex.value + delta + count.value) % count.value
  scrollToActive()
}

async function openFile(item: VaultFileRef | undefined): Promise<void> {
  if (!item) return
  closeSwitcher()
  await openVaultFile(item.path)
}

function runCommand(cmd: PaletteCommand | undefined): void {
  if (!cmd) return
  closeSwitcher()
  // 不可用的命令照样可以点:主进程会给出「当前状态下不可用」,
  // 比在面板里静默失败强 —— 至少用户知道这条命令存在、只是现在用不了
  void runExtensionCommand(cmd.command, [], 'commandPalette')
}

function confirmActive(): void {
  if (isCommandMode.value) runCommand(commandResults.value[activeIndex.value])
  else void openFile(fileResults.value[activeIndex.value])
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirmActive()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSwitcher()
  }
}
</script>

<template>
  <div v-if="appStore.switcherOpen" class="switcher-mask" @mousedown.self="closeSwitcher()">
    <div class="switcher">
      <div class="switcher-input-wrap">
        <Terminal v-if="isCommandMode" :size="15" class="switcher-search-icon" />
        <Search v-else :size="15" class="switcher-search-icon" />
        <input
          ref="input"
          v-model="query"
          class="switcher-input"
          :placeholder="
            isCommandMode
              ? '输入命令名或扩展名...'
              : '输入文件名模糊搜索,或输入 > 搜扩展命令...'
          "
          @keydown="onKeydown"
        />
      </div>
      <div ref="listEl" class="switcher-list">
        <!-- 命令模式 -->
        <template v-if="isCommandMode">
          <div
            v-for="(cmd, i) in commandResults"
            :key="cmd.command"
            class="switcher-item"
            :class="{ 'switcher-item-active': i === activeIndex, 'switcher-item-off': !cmd.usable }"
            :title="cmd.usable ? pluginBadge(cmd) : `${pluginBadge(cmd)} · 当前状态下不可用`"
            @mouseenter="activeIndex = i"
            @click="runCommand(cmd)"
          >
            <Zap :size="13" class="switcher-command-icon" />
            <span class="switcher-name">{{ cmd.title }}</span>
            <span class="switcher-badge"
              >{{ pluginBadge(cmd) }}{{ cmd.usable ? '' : ' · 不可用' }}</span
            >
          </div>
          <div v-if="commandResults.length === 0" class="switcher-empty">
            {{ keyword ? '没有匹配的命令' : '没有扩展提供命令(装了扩展后这里会出现它的命令)' }}
          </div>
        </template>
        <!-- 文件模式 -->
        <template v-else>
          <div
            v-for="(item, i) in fileResults"
            :key="item.path"
            class="switcher-item"
            :class="{ 'switcher-item-active': i === activeIndex }"
            :title="item.rel"
            @mouseenter="activeIndex = i"
            @click="openFile(item)"
          >
            <span class="switcher-name">{{ item.name }}</span>
            <span class="switcher-rel">{{ item.rel }}</span>
          </div>
          <div v-if="fileResults.length === 0" class="switcher-empty">
            {{ appStore.vaultTree ? '没有匹配的文件' : '先打开一个仓库 (Ctrl+Alt+O)' }}
          </div>
        </template>
      </div>
      <div class="switcher-hint">
        <span>↑↓ 选择 · Enter {{ isCommandMode ? '执行' : '打开' }} · Esc 关闭</span>
        <span class="switcher-hint-mode">
          {{ isCommandMode ? '命令模式(删掉开头的 > 回到文件搜索)' : '输入 > 切到命令模式' }}
        </span>
      </div>
    </div>
  </div>
</template>
