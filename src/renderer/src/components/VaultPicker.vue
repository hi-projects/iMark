<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { FolderOpen, FolderPlus, X } from 'lucide-vue-next'
import { appStore } from '../stores/app'
import { basename } from '../utils/text'
import {
  createVaultAt,
  forgetVault,
  openVaultFromPicker,
  openVaultViaDialog,
  pruneMissingVaults,
  setSkipVaultPicker
} from '../services/vaultService'
import { api } from '../services/api'

const creating = ref(false)
const newName = ref('')
const parentDir = ref<string | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)

// 直接绑定 store,便于启动时已由 settings 初始化
const skipPicker = computed({
  get: () => appStore.skipVaultPicker,
  set: v => {
    appStore.skipVaultPicker = v
  }
})

const recentVaults = computed(() => appStore.vaults)

// 选择页每次出现都清理一遍:文件夹可能在上次使用之后被删掉或移走了
onMounted(() => void pruneMissingVaults())

async function openVault(path: string): Promise<void> {
  await openVaultFromPicker(path)
}

async function startCreate(): Promise<void> {
  parentDir.value = null
  newName.value = ''
  creating.value = true
  await nextTick()
  nameInput.value?.focus()
}

async function pickParentDir(): Promise<void> {
  const dir = await api.selectVaultDialog()
  if (dir) parentDir.value = dir
}

async function confirmCreate(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  let parent = parentDir.value
  if (!parent) {
    parent = await api.selectVaultDialog()
    if (!parent) return
    parentDir.value = parent
  }
  const ok = await createVaultAt(parent, name)
  if (ok) {
    creating.value = false
    newName.value = ''
  }
}

function cancelCreate(): void {
  creating.value = false
  newName.value = ''
  parentDir.value = null
}

async function onSkipChange(): Promise<void> {
  await setSkipVaultPicker(skipPicker.value)
}
</script>

<template>
  <div class="vault-picker">
    <div class="vault-picker-card">
      <header class="vault-picker-header">
        <h1 class="vault-picker-title">iMark</h1>
        <p class="vault-picker-subtitle">选择一个仓库开始,或打开新的文件夹</p>
      </header>

      <div class="vault-picker-list">
        <button
          v-for="v in recentVaults"
          :key="v"
          class="vault-row"
          :title="v"
          @click="openVault(v)"
        >
          <FolderOpen :size="16" class="vault-row-icon" />
          <span class="vault-row-main">
            <span class="vault-row-name">{{ basename(v) }}</span>
            <span class="vault-row-path">{{ v }}</span>
          </span>
          <span class="vault-row-remove" title="从列表移除" @click.stop="forgetVault(v)">
            <X :size="14" />
          </span>
        </button>

        <div v-if="recentVaults.length === 0 && !creating" class="vault-picker-empty">
          还没有打开过仓库
        </div>
      </div>

      <div v-if="creating" class="vault-create-form">
        <div class="vault-create-row">
          <input
            ref="nameInput"
            v-model="newName"
            class="vault-create-input"
            placeholder="仓库名称"
            @keydown.enter.prevent="confirmCreate"
            @keydown.esc.prevent="cancelCreate"
          />
          <button class="vault-create-dir" @click="pickParentDir">
            {{ parentDir ? basename(parentDir) : '选择位置...' }}
          </button>
        </div>
        <div class="vault-create-hint">
          将在 <code>{{ parentDir ?? '所选位置' }}</code> 下创建同名文件夹
        </div>
        <div class="vault-create-actions">
          <button class="vault-btn vault-btn-primary" @click="confirmCreate">创建</button>
          <button class="vault-btn" @click="cancelCreate">取消</button>
        </div>
      </div>

      <footer v-else class="vault-picker-actions">
        <button class="vault-btn vault-btn-primary" @click="openVaultViaDialog()">
          <FolderOpen :size="15" />
          打开文件夹作为仓库
        </button>
        <button class="vault-btn" @click="startCreate">
          <FolderPlus :size="15" />
          创建新仓库
        </button>
      </footer>

      <label class="vault-picker-skip">
        <input v-model="skipPicker" type="checkbox" @change="onSkipChange" />
        启动时直接打开上次使用的仓库
      </label>
    </div>
  </div>
</template>
