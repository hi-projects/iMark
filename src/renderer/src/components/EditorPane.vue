<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { EditorView } from '@codemirror/view'
import { createEditor } from '../editor/setup'
import { appStore, editorHolder } from '../stores/app'
import { openFileByPath } from '../services/fileService'
import { noteDocChangeForAutoSave } from '../services/autoSave'
import { attachActiveTab, handleEditorDocChange } from '../services/tabs'
import { notifyEditorReady } from '../services/editorBridge'
import { api } from '../services/api'

const container = ref<HTMLElement | null>(null)

function onDocChange(view: EditorView): void {
  // 字数 / 脏标记 / 大纲都归当前标签自己(见 services/tabs.ts);
  // 定时器按标签 id 结算,切走之后晚到的回调不会写错标签
  handleEditorDocChange(view)
  // 实时保存的防抖从这里起算:只有真实输入才该触发写盘,
  // 打开/新建文档走的是 setState,不会经过这里
  noteDocChangeForAutoSave()
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
  // 极端情况下挂载前已经有当前标签(见 attachActiveTab 的说明)
  attachActiveTab()
  // 视图与当前标签都就位后再向扩展宿主报「编辑器就绪」
  notifyEditorReady()
  if (appStore.hasDocument) view.focus()
})

onBeforeUnmount(() => {
  editorHolder.view?.destroy()
  editorHolder.view = null
  editorHolder.onDocChange = null
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
