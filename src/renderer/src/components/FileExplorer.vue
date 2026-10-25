<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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
import { activeTab, appStore } from '../stores/app'
import {
  createDir,
  createFile,
  deleteNode,
  moveNode,
  openVaultFile,
  refreshVault,
  renamePath,
  requestVaultSwitch
} from '../services/vaultService'
import { isInside, joinPath } from '../utils/paths'

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
  return activeTab()?.filePath === node.path
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

/**
 * 回车确认。中文输入法里,回车先是「把候选词敲上去」——
 * 那一下不能当成确认,否则文件会带着半截名字被建出来。
 */
function onEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  e.preventDefault()
  void commitEdit()
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

// ---------- 拖拽移动 ----------

/**
 * 正在拖的节点。dataTransfer 在 dragover 阶段读不到数据(浏览器只在 drop 时才
 * 解除保护),所以拖动源只能自己记一份。
 */
const draggingNode = ref<VaultNode | null>(null)
/** 高亮的落点行(文件行 = 移进它所在的目录);null 表示没有有效落点 */
const dropPath = ref<string | null>(null)
/** 是否落在列表空白处(= 移到仓库根) */
const rootDrop = ref(false)

/** 节点所在目录。根部下要保留分隔符:`C:\a.md` → `C:\`、`/a.md` → `/` */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return ''
  if (i === 0 || p[i - 1] === ':') return p.slice(0, i + 1)
  return p.slice(0, i)
}

/** 这个落点会移进哪个目录;不能拖时返回 null */
function dropTargetDir(target: VaultNode | null): string | null {
  const source = draggingNode.value
  if (!source) return null
  if (target && target.path === source.path) return null
  const dir = target ? (target.type === 'dir' ? target.path : dirOf(target.path)) : appStore.vaultPath
  if (!dir) return null
  // 目录不能进自己或自己的子孙
  if (source.type === 'dir' && isInside(source.path, dir)) return null
  // 本来就在这个目录里,不算一次移动(也避免无意义的刷新与高亮)
  if (joinPath(dir, source.name) === source.path) return null
  return dir
}

function onDragStart(e: DragEvent, node: VaultNode): void {
  draggingNode.value = node
  closeMenu()
  if (!e.dataTransfer) return
  e.dataTransfer.effectAllowed = 'move'
  // 必须写一份数据,否则 Chromium 不会真正开始拖拽;自定义类型避免被编辑器当成文本
  e.dataTransfer.setData('application/x-imark-vault-node', node.path)
}

function onDragOver(e: DragEvent, node: VaultNode): void {
  rootDrop.value = false
  const dir = dropTargetDir(node)
  if (!dir) {
    dropPath.value = null
    return
  }
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropPath.value = node.path
}

async function onDrop(e: DragEvent, node: VaultNode): Promise<void> {
  e.preventDefault()
  const source = draggingNode.value
  const dir = dropTargetDir(node)
  resetDrag()
  if (source && dir) await moveNode(source, dir)
}

function onRootDragOver(e: DragEvent): void {
  const dir = dropTargetDir(null)
  if (!dir) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  rootDrop.value = true
}

async function onRootDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  const source = draggingNode.value
  const dir = dropTargetDir(null)
  resetDrag()
  if (source && dir) await moveNode(source, dir)
}

/** 从空白区移到行上时 dragleave 也会触发,只有真正离开整个列表才收起高亮 */
function onRootDragLeave(e: DragEvent): void {
  const list = e.currentTarget as HTMLElement
  if (e.relatedTarget instanceof Node && list.contains(e.relatedTarget)) return
  rootDrop.value = false
}

function resetDrag(): void {
  draggingNode.value = null
  dropPath.value = null
  rootDrop.value = false
}

// ---------- 右键菜单 ----------

interface MenuEntry {
  label: string
  /** 危险动作(删除)用红色 */
  danger?: boolean
  /** 分组线:应用自己的条目与扩展条目之间要有一条,不然分不清哪些是外来的 */
  separator?: boolean
  /** 条目来源(扩展名)。空 = 应用自带 —— 用户得能一眼看出哪一条不是原装的 */
  source?: string
  run: () => void
}

const menu = reactive<{ open: boolean; x: number; y: number; node: VaultNode | null }>({
  open: false,
  x: 0,
  y: 0,
  node: null
})
const menuEl = ref<HTMLElement | null>(null)

/** 条目按节点类型给:目录能"在此新建",文件只有改名与删除 */
const menuEntries = computed<MenuEntry[]>(() => {
  const node = menu.node
  if (!node) return []
  const entries: MenuEntry[] = []
  if (node.type === 'dir') {
    entries.push(
      { label: '新建文件', run: () => startEdit('new-file', node.path, null) },
      { label: '新建文件夹', run: () => startEdit('new-dir', node.path, null) }
    )
  }
  entries.push({ label: '重命名', run: () => startEdit('rename', '', node, node.name) })
  entries.push({ label: '删除', danger: true, run: () => void onDelete(node) })
  return entries
})

async function openMenu(e: MouseEvent, node: VaultNode): Promise<void> {
  menu.node = node
  menu.x = e.clientX
  menu.y = e.clientY
  menu.open = true
  // 贴着窗口右边/下边右键时把菜单挪回可视区;nextTick 在浏览器绘制前跑完,不会闪一下
  await nextTick()
  const el = menuEl.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  menu.x = Math.max(4, Math.min(menu.x, window.innerWidth - width - 4))
  menu.y = Math.max(4, Math.min(menu.y, window.innerHeight - height - 4))
}

function closeMenu(): void {
  menu.open = false
  menu.node = null
}

function runEntry(entry: MenuEntry): void {
  closeMenu()
  entry.run()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (menu.open && e.key === 'Escape') closeMenu()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
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

    <div
      class="explorer-list"
      :class="{ 'explorer-list-drop': rootDrop }"
      @dragover="onRootDragOver"
      @dragleave="onRootDragLeave"
      @drop="onRootDrop"
    >
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
          @keydown.enter="onEnter"
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
            @keydown.enter="onEnter"
            @keydown.esc.prevent="cancelEdit"
            @blur="cancelEdit"
          />
        </div>

        <!-- 目录行 -->
        <div
          v-else-if="row.node.type === 'dir'"
          class="explorer-item"
          :class="{
            'explorer-dragging': draggingNode?.path === row.node.path,
            'explorer-drop-target': dropPath === row.node.path
          }"
          :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
          draggable="true"
          @click="toggleDir(row.node)"
          @contextmenu.prevent="openMenu($event, row.node)"
          @dragstart="onDragStart($event, row.node)"
          @dragend="resetDrag"
          @dragover.stop="onDragOver($event, row.node)"
          @drop.stop="onDrop($event, row.node)"
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
          :class="{
            'explorer-file-active': isOpenFile(row.node),
            'explorer-dragging': draggingNode?.path === row.node.path,
            'explorer-drop-target': dropPath === row.node.path
          }"
          :style="{ paddingLeft: 8 + row.depth * 14 + 16 + 'px' }"
          :title="row.node.path"
          draggable="true"
          @click="openVaultFile(row.node.path)"
          @contextmenu.prevent="openMenu($event, row.node)"
          @dragstart="onDragStart($event, row.node)"
          @dragend="resetDrag"
          @dragover.stop="onDragOver($event, row.node)"
          @drop.stop="onDrop($event, row.node)"
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

  <!--
    右键菜单。整屏透明遮罩负责"点别处就关掉",顺带挡住底下的误点;
    z-index 压在快速切换器(100)与各对话框(110+)之下,弹出对话框时它不会盖上来。
  -->
  <div
    v-if="menu.open"
    class="explorer-menu-mask"
    @click="closeMenu"
    @contextmenu.prevent="closeMenu"
    @wheel="closeMenu"
  >
    <div
      ref="menuEl"
      class="explorer-menu"
      role="menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <template v-for="(entry, i) in menuEntries" :key="`${i}:${entry.label}`">
        <div v-if="entry.separator" class="explorer-menu-sep"></div>
        <button
          v-else
          class="explorer-menu-item"
          :class="{ 'explorer-menu-danger': entry.danger }"
          role="menuitem"
          @click="runEntry(entry)"
        >
          <span class="explorer-menu-label">{{ entry.label }}</span>
          <span v-if="entry.source" class="explorer-menu-source">{{ entry.source }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
