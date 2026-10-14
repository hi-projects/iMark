<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2
} from 'lucide-vue-next'
import type { VaultNode } from '@shared/types'
import { appStore } from '../stores/app'
import {
  createDir,
  createFile,
  deleteNode,
  openVaultFile,
  refreshVault,
  renamePath,
  requestVaultSwitch
} from '../services/vaultService'

interface Row {
  node: VaultNode
  depth: number
}

interface Editing {
  mode: null | 'new-file' | 'new-dir' | 'rename'
  parentPath: string
  target: VaultNode | null
  value: string
}

const editing = reactive<Editing>({ mode: null, parentPath: '', target: null, value: '' })
const inputEl = ref<HTMLInputElement | null>(null)

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  function walk(n: VaultNode, depth: number): void {
    if (n.type === 'dir') {
      out.push({ node: n, depth })
      if (!appStore.expandedDirs.has(n.path)) return
      for (const c of n.children ?? []) walk(c, depth + 1)
    } else {
      out.push({ node: n, depth })
    }
  }
  for (const c of appStore.vaultTree?.children ?? []) walk(c, 1)
  return out
})

function toggleDir(node: VaultNode): void {
  if (appStore.expandedDirs.has(node.path)) {
    appStore.expandedDirs.delete(node.path)
  } else {
    appStore.expandedDirs.add(node.path)
  }
}

function isOpenFile(node: VaultNode): boolean {
  return appStore.filePath === node.path
}

function startEdit(mode: 'new-file' | 'new-dir' | 'rename', parentPath: string, target: VaultNode | null, initial = ''): void {
  editing.mode = mode
  editing.parentPath = parentPath
  editing.target = target
  editing.value = initial
  if (mode !== 'rename' && parentPath) appStore.expandedDirs.add(parentPath)
  void nextTick(() => inputEl.value?.focus())
}

function cancelEdit(): void {
  editing.mode = null
  editing.target = null
  editing.value = ''
}

async function commitEdit(): Promise<void> {
  const mode = editing.mode
  if (!mode) return
  const value = editing.value.trim()
  if (mode === 'new-file') {
    const created = await createFile(editing.parentPath, value)
    cancelEdit()
    if (created) await openVaultFile(created.path)
    return
  }
  if (mode === 'new-dir') {
    await createDir(editing.parentPath, value)
  } else if (mode === 'rename' && editing.target) {
    await renamePath(editing.target, value)
  }
  cancelEdit()
}

async function onDelete(node: VaultNode): Promise<void> {
  await deleteNode(node)
}
</script>

<template>
  <aside v-show="appStore.explorerVisible" class="explorer">
    <div class="explorer-header">
      <span class="explorer-actions">
        <button
          v-if="appStore.vaultTree"
          title="新建文件"
          @click="startEdit('new-file', appStore.vaultPath!, null)"
        >
          <FilePlus :size="13" />
        </button>
        <button
          v-if="appStore.vaultTree"
          title="新建文件夹"
          @click="startEdit('new-dir', appStore.vaultPath!, null)"
        >
          <FolderPlus :size="13" />
        </button>
        <button v-if="appStore.vaultTree" title="刷新" @click="refreshVault()">
          <RefreshCw :size="13" />
        </button>
      </span>
    </div>

    <div class="explorer-list">
      <button
        v-if="!appStore.vaultTree"
        class="explorer-open-vault"
        @click="requestVaultSwitch()"
      >
        打开仓库...
      </button>

      <!-- 新建输入行(根级) -->
      <div
        v-if="editing.mode === 'new-file' || editing.mode === 'new-dir'"
        class="explorer-item explorer-editing"
      >
        <input
          ref="inputEl"
          v-model="editing.value"
          :placeholder="editing.mode === 'new-file' ? '文件名.md' : '文件夹名'"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="cancelEdit"
          @blur="cancelEdit"
        />
      </div>

      <template v-for="row in rows" :key="row.node.path">
        <!-- 重命名输入行 -->
        <div v-if="editing.mode === 'rename' && editing.target?.path === row.node.path" class="explorer-item explorer-editing" :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }">
          <input
            ref="inputEl"
            v-model="editing.value"
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.prevent="cancelEdit"
            @blur="cancelEdit"
          />
        </div>

        <!-- 目录行 -->
        <div
          v-else-if="row.node.type === 'dir'"
          class="explorer-item"
          :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
          @click="toggleDir(row.node)"
        >
          <component
            :is="appStore.expandedDirs.has(row.node.path) ? ChevronDown : ChevronRight"
            :size="13"
            class="explorer-chevron"
          />
          <component
            :is="appStore.expandedDirs.has(row.node.path) ? FolderOpen : Folder"
            :size="14"
            class="explorer-icon"
          />
          <span class="explorer-name" :title="row.node.name">{{ row.node.name }}</span>
          <span class="explorer-item-actions" @click.stop>
            <button title="新建文件" @click="startEdit('new-file', row.node.path, null)">
              <FilePlus :size="13" />
            </button>
            <button title="新建文件夹" @click="startEdit('new-dir', row.node.path, null)">
              <FolderPlus :size="13" />
            </button>
            <button title="重命名" @click="startEdit('rename', '', row.node, row.node.name)">
              <Pencil :size="13" />
            </button>
            <button title="删除" @click="onDelete(row.node)">
              <Trash2 :size="13" />
            </button>
          </span>
        </div>

        <!-- 文件行 -->
        <div
          v-else
          class="explorer-item explorer-file"
          :class="{ 'explorer-file-active': isOpenFile(row.node) }"
          :style="{ paddingLeft: 8 + row.depth * 14 + 16 + 'px' }"
          :title="row.node.path"
          @click="openVaultFile(row.node.path)"
        >
          <FileText :size="14" class="explorer-icon" />
          <span class="explorer-name">{{ row.node.name }}</span>
          <span class="explorer-item-actions" @click.stop>
            <button title="重命名" @click="startEdit('rename', '', row.node, row.node.name)">
              <Pencil :size="13" />
            </button>
            <button title="删除" @click="onDelete(row.node)">
              <Trash2 :size="13" />
            </button>
          </span>
        </div>
      </template>
    </div>
  </aside>
</template>
