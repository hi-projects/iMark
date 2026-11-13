<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  ChevronDown,
  ChevronRight,
  FileDown,
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
  editableBaseName,
  moveNode,
  openVaultFile,
  refreshVault,
  rememberExpandedDirs,
  renamePath,
  requestVaultSwitch
} from '../services/vaultService'
import { exportHtmlForPath } from '../services/fileService'
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
  // 记下这次开合,下次打开这个仓库时恢复(按仓库分开存)
  rememberExpandedDirs()
}

/**
 * 文件树里选中的行 —— F2 改名的目标。按路径记:树刷新、改名、移动后
 * 原路径找不到了就当作没有选中,不用到处清理这份状态。
 */
const selectedPath = ref<string | null>(null)

const selectedNode = computed<VaultNode | null>(
  () => rows.value.find(r => r.node.path === selectedPath.value)?.node ?? null
)

/**
 * 还没在树里点过任何行时,F2 的落点:当前打开的文件。
 * 只认树里能看见的节点 —— 看不见就没有地方显示改名框,不能凭路径硬改。
 */
function openFileNode(): VaultNode | null {
  const path = activeTab()?.filePath
  if (!path) return null
  return rows.value.find(r => r.node.path === path)?.node ?? null
}

/** 目录行:点一下既展开/收起,也把它设为 F2 的目标 */
function onDirClick(node: VaultNode): void {
  selectedPath.value = node.path
  toggleDir(node)
}

/** 文件行:点一下既打开,也把它设为 F2 的目标 */
function onFileClick(node: VaultNode): void {
  selectedPath.value = node.path
  void openVaultFile(node.path)
}

function isOpenFile(node: VaultNode): boolean {
  return activeTab()?.filePath === node.path
}

/**
 * 新建输入行插在哪一行之后(rows 的下标):
 *   null = 当前不是新建态;-1 = 列表最前(建在仓库根)。
 * 建在某个目录里时插在该目录行之后 —— 它的子项正好从下一行开始,
 * 输入行也就落在父目录展开后的第一个子项位置。
 */
const newEditAfter = computed<number | null>(() => {
  if (editing.mode !== 'new-file' && editing.mode !== 'new-dir') return null
  const parent = editing.parentPath
  if (!parent || parent === appStore.vaultPath) return -1
  return rows.value.findIndex(r => r.node.type === 'dir' && r.node.path === parent)
})

/** 新建输入行的缩进:和目标目录的子项对齐(根级 = 第一层) */
const newEditDepth = computed<number>(() => {
  const i = newEditAfter.value
  if (i === null || i < 0) return 1
  return (rows.value[i]?.depth ?? 0) + 1
})

/**
 * 新建输入行的左内边距:与建好后那一行完全一致 ——
 * 文件行没有展开箭头,靠 +16 把图标对齐到目录图标列;目录行则要留出箭头位置。
 */
const newEditPadding = computed<number>(() => {
  return 8 + newEditDepth.value * 14 + (editing.mode === 'new-file' ? 16 : 0)
})

function startEdit(mode: 'new-file' | 'new-dir' | 'rename', parentPath: string, target: VaultNode | null, initial = ''): void {
  editing.mode = mode
  editing.parentPath = parentPath
  editing.target = target
  // 改名文件时输入框只放名字(不带会自动补回的 `.md`)—— 自动选中(下面的
  // select)于是只选中名字部分,敲字不会把扩展名一起替换掉
  editing.value = mode === 'rename' && target?.type === 'file' ? editableBaseName(initial) : initial
  if (mode !== 'rename' && parentPath) {
    appStore.expandedDirs.add(parentPath)
    rememberExpandedDirs()
  }
  // 输入行可能在 v-for 里(v-for 的模板 ref 会被 Vue 收成数组),按类名取更稳
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.explorer-editing input')
    el?.focus()
    el?.select()
  })
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

/** 条目按节点类型给:目录能"在此新建",文件能导出;改名与删除两者都有 */
const menuEntries = computed<MenuEntry[]>(() => {
  const node = menu.node
  if (!node) return []
  const entries: MenuEntry[] = []
  if (node.type === 'dir') {
    entries.push(
      { label: '新建文件', run: () => startEdit('new-file', node.path, null) },
      { label: '新建文件夹', run: () => startEdit('new-dir', node.path, null) }
    )
  } else {
    entries.push({ label: '导出 HTML...', run: () => void exportHtmlForPath(node.path, node.name) })
  }
  entries.push({ label: '重命名', run: () => startEdit('rename', '', node, node.name) })
  entries.push({ label: '删除', danger: true, run: () => void onDelete(node) })
  return entries
})

async function openMenu(e: MouseEvent, node: VaultNode): Promise<void> {
  selectedPath.value = node.path
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

/**
 * F2:重命名文件树里选中的那一行(文件或文件夹)。
 *
 * 点文件行会把焦点交给编辑器(contenteditable),点目录行也不一定把焦点留在树上,
 * 所以这里**不**把"焦点不在文件树"当成不处理 —— 只要不在真正的输入框里(F2 在
 * input/textarea 里是用户自己的输入)、没有对话框挡着,就重命名选中的行。
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && menu.open) {
    closeMenu()
    return
  }
  if (e.key !== 'F2' || e.defaultPrevented) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (editing.mode || !appStore.explorerVisible) return
  if (document.querySelector('[role="dialog"]')) return
  const node = selectedNode.value ?? openFileNode()
  if (!node) return
  e.preventDefault()
  closeMenu()
  startEdit('rename', '', node, node.name)
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

/**
 * 层级引导线:每个祖先层级一条竖线,与该层目录行的展开箭头**中心**对齐。
 * 根目录行的 depth 是 1、缩进 8 + depth * 14,所以 depth 为 d 的行要画 d-1 条。
 * 展开箭头是 13px 宽、贴在缩进处,中心在 paddingLeft + 6.5;1px 的线左移 0.5
 * 落在整数像素上正好居中,所以偏移取 8 + level * 14 + 6。
 */
function guideLeft(level: number): string {
  return `${8 + level * 14 + 6}px`
}
</script>

<template>
  <Transition name="explorer-slide">
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

        <!-- 新建输入行:建在仓库根时出现在最前 -->
        <div
          v-if="newEditAfter === -1"
          class="explorer-item explorer-editing"
          :style="{ paddingLeft: newEditPadding + 'px' }"
        >
          <span v-if="editing.mode === 'new-dir'" class="explorer-chevron-space" aria-hidden="true"></span>
          <Folder v-if="editing.mode === 'new-dir'" :size="14" class="explorer-icon" />
          <FileText v-else :size="14" class="explorer-icon" />
          <input
            v-model="editing.value"
            :placeholder="editing.mode === 'new-file' ? '文件名' : '文件夹名'"
            @keydown.enter="onEnter"
            @keydown.esc.prevent="cancelEdit"
            @blur="cancelEdit"
          />
        </div>

        <template v-for="(row, i) in rows" :key="row.node.path">
          <!--
            重命名输入行:缩进、引导线、图标都和这一行正常显示时一致
            (文件行没有展开箭头,靠 +16 把图标对齐到目录图标列),输入框才落在名字列上。
          -->
          <div
            v-if="editing.mode === 'rename' && editing.target?.path === row.node.path"
            class="explorer-item explorer-editing"
            :style="{ paddingLeft: 8 + row.depth * 14 + (row.node.type === 'file' ? 16 : 0) + 'px' }"
          >
            <span
              v-for="level in row.depth - 1"
              :key="level"
              class="explorer-guide"
              :style="{ left: guideLeft(level) }"
              aria-hidden="true"
            ></span>
            <span v-if="row.node.type === 'dir'" class="explorer-chevron-space" aria-hidden="true"></span>
            <Folder v-if="row.node.type === 'dir'" :size="14" class="explorer-icon" />
            <FileText v-else :size="14" class="explorer-icon" />
            <input
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
              'explorer-selected': selectedPath === row.node.path,
              'explorer-dragging': draggingNode?.path === row.node.path,
              'explorer-drop-target': dropPath === row.node.path
            }"
            :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
            draggable="true"
            @click="onDirClick(row.node)"
            @contextmenu.prevent="openMenu($event, row.node)"
            @dragstart="onDragStart($event, row.node)"
            @dragend="resetDrag"
            @dragover.stop="onDragOver($event, row.node)"
            @drop.stop="onDrop($event, row.node)"
          >
            <span
              v-for="level in row.depth - 1"
              :key="level"
              class="explorer-guide"
              :style="{ left: guideLeft(level) }"
              aria-hidden="true"
            ></span>
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
              'explorer-selected': selectedPath === row.node.path,
              'explorer-dragging': draggingNode?.path === row.node.path,
              'explorer-drop-target': dropPath === row.node.path
            }"
            :style="{ paddingLeft: 8 + row.depth * 14 + 16 + 'px' }"
            :title="row.node.path"
            draggable="true"
            @click="onFileClick(row.node)"
            @contextmenu.prevent="openMenu($event, row.node)"
            @dragstart="onDragStart($event, row.node)"
            @dragend="resetDrag"
            @dragover.stop="onDragOver($event, row.node)"
            @drop.stop="onDrop($event, row.node)"
          >
            <span
              v-for="level in row.depth - 1"
              :key="level"
              class="explorer-guide"
              :style="{ left: guideLeft(level) }"
              aria-hidden="true"
            ></span>
            <FileText :size="14" class="explorer-icon" />
            <span class="explorer-name">{{ row.node.name }}</span>
            <span class="explorer-item-actions" @click.stop>
              <button title="导出 HTML" @click="exportHtmlForPath(row.node.path, row.node.name)">
                <FileDown :size="13" />
              </button>
              <button title="重命名" @click="startEdit('rename', '', row.node, row.node.name)">
                <Pencil :size="13" />
              </button>
              <button title="删除" @click="onDelete(row.node)">
                <Trash2 :size="13" />
              </button>
            </span>
          </div>

          <!-- 新建输入行:落在对应父目录展开后的第一个子项位置,缩进与建好后的那一行一致 -->
          <div
            v-if="newEditAfter === i"
            class="explorer-item explorer-editing"
            :style="{ paddingLeft: newEditPadding + 'px' }"
          >
            <span
              v-for="level in newEditDepth - 1"
              :key="level"
              class="explorer-guide"
              :style="{ left: guideLeft(level) }"
              aria-hidden="true"
            ></span>
            <span v-if="editing.mode === 'new-dir'" class="explorer-chevron-space" aria-hidden="true"></span>
            <Folder v-if="editing.mode === 'new-dir'" :size="14" class="explorer-icon" />
            <FileText v-else :size="14" class="explorer-icon" />
            <input
              v-model="editing.value"
              :placeholder="editing.mode === 'new-file' ? '文件名' : '文件夹名'"
              @keydown.enter="onEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="cancelEdit"
            />
          </div>
        </template>
      </div>
    </aside>
  </Transition>

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
