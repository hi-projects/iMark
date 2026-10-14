<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import { appStore, type VaultFileRef } from '../stores/app'
import { closeSwitcher, openVaultFile, searchVaultFiles } from '../services/vaultService'

const query = ref('')
const activeIndex = ref(0)
const listEl = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const results = computed<VaultFileRef[]>(() => searchVaultFiles(query.value))

watch(
  () => appStore.switcherOpen,
  open => {
    if (open) {
      query.value = ''
      activeIndex.value = 0
      void nextTick(() => input.value?.focus())
    }
  }
)

watch(results, () => {
  activeIndex.value = 0
})

function move(delta: number): void {
  const n = results.value.length
  if (n === 0) return
  activeIndex.value = (activeIndex.value + delta + n) % n
  void nextTick(() => {
    listEl.value
      ?.querySelector('.switcher-item-active')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

async function open(item: VaultFileRef | undefined): Promise<void> {
  if (!item) return
  closeSwitcher()
  await openVaultFile(item.path)
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
    void open(results.value[activeIndex.value])
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
        <Search :size="15" class="switcher-search-icon" />
        <input
          ref="input"
          v-model="query"
          class="switcher-input"
          placeholder="输入文件名模糊搜索..."
          @keydown="onKeydown"
        />
      </div>
      <div ref="listEl" class="switcher-list">
        <div
          v-for="(item, i) in results"
          :key="item.path"
          class="switcher-item"
          :class="{ 'switcher-item-active': i === activeIndex }"
          :title="item.rel"
          @mouseenter="activeIndex = i"
          @click="open(item)"
        >
          <span class="switcher-name">{{ item.name }}</span>
          <span class="switcher-rel">{{ item.rel }}</span>
        </div>
        <div v-if="results.length === 0" class="switcher-empty">
          {{ appStore.vaultTree ? '没有匹配的文件' : '先打开一个仓库 (Ctrl+Alt+O)' }}
        </div>
      </div>
      <div class="switcher-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </div>
  </div>
</template>
