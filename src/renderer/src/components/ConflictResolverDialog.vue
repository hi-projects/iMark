<script setup lang="ts">
/**
 * 处理合并冲突窗口。
 *
 * 面向**没有打开在编辑器里**的冲突文件(典型是 `.gitignore`):左侧是文件列表,
 * 右侧逐处展示当前/传入两段内容,和编辑器内联操作栏一样提供三种取舍。
 * 处理完保存到磁盘,再直接触发「立即同步」完成合并提交。
 */

import { computed, onMounted, ref } from 'vue'
import { AlertTriangle, CheckCircle2, X } from 'lucide-vue-next'
import { Text } from '@codemirror/state'
import { api } from '../services/api'
import {
  closeConflictResolver,
  conflictResolver
} from '../services/conflictResolver'
import {
  applyConflictToText,
  conflictReplacement,
  findConflictBlocks,
  readConflictSides,
  type ConflictBlock,
  type ConflictChoice,
  type ConflictSides
} from '../editor/conflict'
import { appStore } from '../stores/app'
import { replaceTabDocument } from '../services/tabs'
import { runExtensionCommand } from '../services/extensionService'
import { basename, toEol } from '../utils/text'
import { relativeTo } from '../utils/paths'

interface ConflictFileState {
  path: string
  label: string
  eol: 'LF' | 'CRLF'
  content: string
  original: string
  blocks: ConflictBlock[]
  error: string
}

const files = ref<ConflictFileState[]>([])
const selected = ref(0)
const loading = ref(true)
const saving = ref(false)
const saveError = ref('')

function parse(content: string): ConflictBlock[] {
  return findConflictBlocks(Text.of(content.split('\n')))
}

/** 只剩半截标记(没有配对成完整冲突块)时,窗口没法替用户处理,交给手动编辑 */
const STRAY_MARKER = /^(?:<{7}|={7}|>{7}|\|{7})/
function hasStrayMarker(content: string): boolean {
  return content.split('\n').some(line => STRAY_MARKER.test(line))
}

function labelOf(path: string): string {
  return relativeTo(appStore.vaultPath ?? '', path) ?? basename(path)
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function tabOf(path: string) {
  return appStore.tabs.find(
    item => item.filePath && normalize(item.filePath) === normalize(path)
  )
}

/** 重新解析文件,并处理「解析不出完整冲突块」的状态 */
function refreshFile(file: ConflictFileState): void {
  file.blocks = parse(file.content)
  if (file.error.startsWith('无法读取') || file.error.includes('未保存的修改')) return
  file.error =
    file.blocks.length === 0 && hasStrayMarker(file.content)
      ? '检测到无法识别的冲突标记，请在其它文本编辑器中手动处理'
      : ''
}

async function loadFile(path: string): Promise<ConflictFileState> {
  const label = labelOf(path)
  const state: ConflictFileState = {
    path,
    label,
    eol: 'LF',
    content: '',
    original: '',
    blocks: [],
    error: ''
  }
  try {
    const read = await api.readFile(path)
    state.eol = read.eol
    state.content = read.content
    state.original = read.content
    if (read.content.includes('\u0000')) {
      state.error = `${label} 是二进制文件，无法在冲突窗口里处理，请在仓库目录手动合并`
      return state
    }
    if (tabOf(path)?.dirty) {
      state.error = `${label} 在编辑器里有未保存的修改，请先在编辑器内处理`
      return state
    }
    refreshFile(state)
    return state
  } catch (err) {
    state.error = `无法读取 ${label}：${err instanceof Error ? err.message : String(err)}`
    return state
  }
}

onMounted(async () => {
  const paths = [...conflictResolver.files]
  const loaded = await Promise.all(paths.map(loadFile))
  files.value = loaded
  const firstOpen = loaded.findIndex(file => file.blocks.length > 0)
  selected.value = firstOpen >= 0 ? firstOpen : 0
  loading.value = false
})

const current = computed(() => files.value[selected.value] ?? null)

const totalRemaining = computed(() =>
  files.value.reduce((sum, file) => sum + file.blocks.length, 0)
)
const hasErrors = computed(() => files.value.some(file => file.error.length > 0))
// 有文件需要手动处理时不拦着保存其它文件:能在这里解决的先解决,剩下的由同步如实报错
const canSave = computed(
  () => !loading.value && !saving.value && totalRemaining.value === 0
)

const summary = computed(() => {
  if (loading.value) return '正在读取冲突文件…'
  const count = files.value.length
  if (hasErrors.value) return `${count} 个文件 · 有文件需要手动处理`
  return `${count} 个文件 · ${totalRemaining.value === 0 ? '全部处理完' : `还有 ${totalRemaining.value} 处冲突`}`
})

interface ConflictCard {
  block: ConflictBlock
  sides: ConflictSides
}

/** 当前文件的冲突块及其两段内容;每次取舍后 content/blocks 变化,自动重算 */
const cards = computed<ConflictCard[]>(() => {
  const file = current.value
  if (!file) return []
  const doc = Text.of(file.content.split('\n'))
  return file.blocks.map(block => ({ block, sides: readConflictSides(doc, block) }))
})

function selectAfterResolve(file: ConflictFileState): void {
  if (file.blocks.length > 0) return
  const next = files.value.findIndex(item => item.blocks.length > 0)
  if (next >= 0) selected.value = next
}

function choose(file: ConflictFileState, block: ConflictBlock, choice: ConflictChoice): void {
  const next = applyConflictToText(file.content, block.startLine, choice)
  if (next == null) return
  file.content = next
  refreshFile(file)
  selectAfterResolve(file)
}

/** 当前文件剩余的所有冲突一次性取同一边(适合 .gitignore 这种整文件冲突) */
function chooseAll(file: ConflictFileState, choice: ConflictChoice): void {
  let content = file.content
  for (let guard = 0; guard < 1000; guard += 1) {
    const doc = Text.of(content.split('\n'))
    const blocks = findConflictBlocks(doc)
    if (blocks.length === 0) break
    const edit = conflictReplacement(doc, blocks[0]!, choice)
    content = content.slice(0, edit.from) + edit.insert + content.slice(edit.to)
  }
  file.content = content
  refreshFile(file)
  selectAfterResolve(file)
}

async function saveAndSync(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  saveError.value = ''
  try {
    for (const file of files.value) {
      if (file.content === file.original) continue
      await api.writeFile(file.path, toEol(file.content, file.eol))
      const tab = tabOf(file.path)
      // 窗口默认只处理没打开的文档;真有人在窗口开着时把它打开了,也别覆盖脏缓冲区
      if (tab && !tab.dirty) replaceTabDocument(tab.id, file.content, file.eol)
    }
    closeConflictResolver()
    // 保存后直接走完整同步:扩展会补上合并提交并继续推送
    void runExtensionCommand('imark.git-sync.syncNow', [], 'code')
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

function dismiss(): void {
  if (saving.value) return
  const dirty = files.value.some(file => file.content !== file.original)
  if (dirty && !window.confirm('还有未保存的冲突处理结果，确定稍后再处理吗？')) return
  closeConflictResolver()
}
</script>

<template>
  <div
    v-if="conflictResolver.open"
    class="settings-mask conflict-dialog-mask"
    @mousedown.self="dismiss()"
  >
    <div class="conflict-dialog" role="dialog" aria-modal="true" aria-label="处理合并冲突">
      <header class="conflict-dialog-head">
        <div class="conflict-dialog-heading">
          <span class="conflict-dialog-icon"><AlertTriangle :size="16" /></span>
          <div>
            <h1>处理合并冲突</h1>
            <p>{{ summary }}</p>
          </div>
        </div>
        <button class="conflict-dialog-close" title="关闭（稍后再处理）" @click="dismiss()">
          <X :size="16" />
        </button>
      </header>

      <div v-if="loading" class="conflict-dialog-loading">正在读取冲突文件…</div>

      <div v-else class="conflict-dialog-main">
        <nav v-if="files.length > 1" class="conflict-dialog-files" aria-label="冲突文件">
          <button
            v-for="(file, index) in files"
            :key="file.path"
            type="button"
            :class="{ 'is-active': index === selected }"
            :title="file.path"
            @click="selected = index"
          >
            <span class="conflict-file-name">{{ file.label }}</span>
            <span
              class="conflict-file-count"
              :class="{ 'is-resolved': file.blocks.length === 0 && !file.error }"
            >
              {{ file.error ? '需手动处理' : file.blocks.length === 0 ? '已处理' : `${file.blocks.length} 处` }}
            </span>
          </button>
        </nav>

        <div class="conflict-dialog-body">
          <div v-if="current?.error" class="conflict-dialog-fileerror">
            <AlertTriangle :size="14" />
            <span>{{ current.error }}</span>
          </div>

          <template v-else-if="current">
            <div class="conflict-dialog-filebar">
              <span class="conflict-dialog-filename">{{ current.label }}</span>
              <span v-if="current.blocks.length > 0" class="conflict-dialog-pending">
                还剩 {{ current.blocks.length }} 处
              </span>
              <span v-else class="conflict-dialog-resolved">
                <CheckCircle2 :size="13" /> 已处理完
              </span>
              <span class="conflict-dialog-spacer"></span>
              <button
                type="button"
                class="conflict-dialog-mini-btn"
                :disabled="current.blocks.length === 0"
                @click="chooseAll(current, 'ours')"
              >
                全部接受当前
              </button>
              <button
                type="button"
                class="conflict-dialog-mini-btn"
                :disabled="current.blocks.length === 0"
                @click="chooseAll(current, 'theirs')"
              >
                全部接受传入
              </button>
            </div>

            <div v-if="current.blocks.length === 0" class="conflict-dialog-done">
              <CheckCircle2 :size="18" />
              <span>{{ current.label }} 已经没有冲突标记</span>
            </div>

            <article v-for="card in cards" :key="card.block.startLine" class="conflict-card">
              <header class="conflict-card-head">
                <span class="conflict-card-index">
                  冲突 {{ card.block.index }}/{{ current.blocks.length }}
                </span>
                <span class="conflict-dialog-spacer"></span>
                <button type="button" class="conflict-dialog-btn" @click="choose(current, card.block, 'ours')">
                  接受当前
                </button>
                <button type="button" class="conflict-dialog-btn" @click="choose(current, card.block, 'theirs')">
                  接受传入
                </button>
                <button type="button" class="conflict-dialog-btn" @click="choose(current, card.block, 'both')">
                  保留两者
                </button>
              </header>

              <div class="conflict-card-sides">
                <section class="conflict-side conflict-side-current">
                  <h3>
                    当前更改
                    <span v-if="card.block.oursLabel" class="conflict-side-ref">
                      {{ card.block.oursLabel }}
                    </span>
                  </h3>
                  <pre>{{ card.sides.ours || '（空）' }}</pre>
                </section>
                <section class="conflict-side conflict-side-incoming">
                  <h3>
                    传入更改
                    <span v-if="card.block.theirsLabel" class="conflict-side-ref">
                      {{ card.block.theirsLabel }}
                    </span>
                  </h3>
                  <pre>{{ card.sides.theirs || '（空）' }}</pre>
                </section>
              </div>

              <details v-if="card.block.baseLine != null" class="conflict-card-base">
                <summary>
                  基准版本
                  <span v-if="card.block.baseLabel" class="conflict-side-ref">
                    {{ card.block.baseLabel }}
                  </span>
                </summary>
                <pre>{{ card.sides.base || '（空）' }}</pre>
              </details>
            </article>
          </template>
        </div>
      </div>

      <footer class="conflict-dialog-foot">
        <span
          class="conflict-dialog-remaining"
          :class="{ 'is-done': totalRemaining === 0 && !hasErrors }"
        >
          {{ hasErrors
            ? '有文件需要手动处理'
            : totalRemaining === 0
              ? '所有冲突已处理'
              : `还有 ${totalRemaining} 处冲突` }}
        </span>
        <span class="conflict-dialog-spacer"></span>
        <span v-if="saveError" class="conflict-dialog-saveerror">{{ saveError }}</span>
        <button type="button" class="conflict-dialog-cancel" :disabled="saving" @click="dismiss()">
          稍后处理
        </button>
        <button type="button" class="conflict-dialog-primary" :disabled="!canSave" @click="saveAndSync()">
          {{ saving ? '正在保存…' : '保存并继续同步' }}
        </button>
      </footer>
    </div>
  </div>
</template>
