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
  const view = createEditor(container.value, v => editorHolder.onDocChange?.(v))
  editorHolder.view = view
  editorHolder.onDocChange = onDocChange
  view.focus()
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
  <div ref="container" class="editor-pane" @dragover="onDragOver" @drop="onDrop"></div>
</template>
