<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { EditorView } from '@codemirror/view'
import { createEditor } from '../editor/setup'
import { updateOutline } from '../editor/outline'
import { appStore, editorHolder } from '../stores/app'
import { computeStats } from '../utils/text'
import { openFileByPath } from '../services/fileService'
import { noteDocChangeForAutoSave } from '../services/autoSave'
import { api } from '../services/api'

const container = ref<HTMLElement | null>(null)

let statsTimer: ReturnType<typeof setTimeout> | undefined
let dirtyTimer: ReturnType<typeof setTimeout> | undefined
let outlineTimer: ReturnType<typeof setTimeout> | undefined

function onDocChange(view: EditorView): void {
  // 空状态下编辑器是只读的,用户输入到不了这里;真出现程序化写入(插件直接改文档)
  // 说明编辑区已经有内容,那就按「有文档」处理,别让标题栏继续说没有页面。
  if (!appStore.hasDocument) appStore.hasDocument = true
  // 实时保存的防抖从这里起算:只有真实输入才该触发写盘,
  // 打开/新建文档走的是 setState,不会经过这里
  noteDocChangeForAutoSave()
  clearTimeout(statsTimer)
  statsTimer = setTimeout(() => {
    Object.assign(appStore, computeStats(view.state.doc.toString()))
  }, 250)
  clearTimeout(dirtyTimer)
  dirtyTimer = setTimeout(() => {
    appStore.dirty = view.state.doc.toString() !== appStore.savedContent
  }, 250)
  clearTimeout(outlineTimer)
  outlineTimer = setTimeout(() => updateOutline(view), 300)
}

function onDragOver(e: DragEvent): void {
  // 仅文件拖拽接管;文本拖拽交给 CodeMirror
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
}

function onDrop(e: DragEvent): void {
  const dt = e.dataTransfer
  if (!dt || !dt.types.includes('Files')) return
  e.preventDefault()
  const file = dt.files?.[0]
  if (!file) return
  const path = api.getPathForFile(file)
  if (!path || !/\.(md|markdown|mdown|txt)$/i.test(path)) return
  void openFileByPath(path)
}

onMounted(() => {
  if (!container.value) return
  // 没有文档时以只读状态创建:光标不会先闪一下再被清掉,也堵住「随手一敲就新建」
  const view = createEditor(container.value, v => editorHolder.onDocChange?.(v), {
    editable: appStore.hasDocument
  })
  editorHolder.view = view
  editorHolder.onDocChange = onDocChange
  if (appStore.hasDocument) view.focus()
})

onBeforeUnmount(() => {
  editorHolder.view?.destroy()
  editorHolder.view = null
  editorHolder.onDocChange = null
  clearTimeout(statsTimer)
  clearTimeout(dirtyTimer)
  clearTimeout(outlineTimer)
})
</script>

<template>
  <!-- 拖放挂在外层:空状态遮罩会接住鼠标,不能让它把拖入文件挡掉 -->
  <div class="editor-host" @dragover="onDragOver" @drop="onDrop">
    <div ref="container" class="editor-pane"></div>
    <!--
      空状态是一块不可穿透的占位面:盖住编辑器(连同行首「+」与光标),
      点击不会聚焦、也不会在里面留下一个可输入的空白文档。
    -->
    <div v-if="!appStore.hasDocument" class="editor-empty-hint">
      从左侧选择文件,或按 Ctrl+N 新建
    </div>
  </div>
</template>
