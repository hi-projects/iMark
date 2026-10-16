<script setup lang="ts">
/**
 * 设置 · 外观 · 自定义样式。
 *
 * 这一块**不做编辑器**:样式文件的正文只存在于磁盘上(见主进程 userStyles.ts),
 * 界面负责的是「去哪儿改、谁在生效、改了有没有生效」。所有 CSS 编辑都发生在用户的
 * 编辑器里,所以实时反馈来自主进程的目录监听,而不是本地输入事件。
 *
 * 列表是**单选**:同时只有一个文件生效(见 userStyleService 的文件头)。
 */

import { computed, ref } from 'vue'
import { FileCode, FilePlus, FolderOpen, RefreshCw, Trash2 } from 'lucide-vue-next'
import { formatBytes } from '../utils/text'
import {
  importUserStyle,
  importUserStylesFromDir,
  openUserStylesDir,
  refreshUserStyles,
  removeUserStyle,
  selectUserStyle,
  styleStore
} from '../services/userStyleService'

/**
 * 一次性提示(导入做了什么)。中性语气,不是错误。
 * 放下一次操作就清掉 —— 它描述的是一次点击的结果,不是持续的状态。
 */
const notice = ref('')

/**
 * 选中的文件不在了(被删、被改名,或只是被独占锁住了)。
 *
 * 这时**不自动改选别人** —— 那会莫名其妙地换掉你的外观;代价是界面上「没有任何
 * 一行被选中」,不说清楚的话看着像坏了。文件放回来,它立刻又生效。
 */
const missingActive = computed(() => {
  const name = styleStore.active
  if (name === null) return null
  return styleStore.files.some(f => f.name === name) ? null : name
})

async function onImport(): Promise<void> {
  notice.value = ''
  notice.value = (await importUserStyle()) ?? ''
}

async function onImportDir(): Promise<void> {
  notice.value = ''
  notice.value = (await importUserStylesFromDir()) ?? ''
}

function onOpenDir(): void {
  notice.value = ''
  void openUserStylesDir()
}

function onRefresh(): void {
  notice.value = ''
  void refreshUserStyles()
}

function onRemove(name: string): void {
  notice.value = ''
  void removeUserStyle(name)
}
</script>

<template>
  <div class="settings-section">
    <div class="settings-section-head">
      <div class="settings-section-title">自定义样式</div>
      <div class="settings-section-desc">
        这里的 CSS 只作用于编辑器内的显示,不影响导出的 HTML。<strong>同时只有一个文件生效</strong>,
        点一行切换;改完保存即刻生效,不用重启。
      </div>
    </div>

    <div class="userstyle-actions">
      <button class="plugin-btn" @click="onImportDir()">
        <FolderOpen :size="13" />
        <span>从文件夹导入</span>
      </button>
      <button class="plugin-btn" @click="onImport()">
        <FilePlus :size="13" />
        <span>导入 CSS 文件</span>
      </button>
      <button class="plugin-icon-btn userstyle-refresh" title="重新读取" @click="onRefresh()">
        <RefreshCw :size="13" />
      </button>
      <!-- 目录路径本身就是「打开文件夹」的入口:不占一个按钮位 -->
      <button class="userstyle-dir" :title="`在文件管理器里打开 ${styleStore.dir}`" @click="onOpenDir()">
        {{ styleStore.dir }}
      </button>
    </div>

    <!-- 整份清单读不到时只显示这一条:此时 styleStore.files 是上一次的旧数据,不能拿来渲染 -->
    <div v-if="styleStore.error" class="userstyle-notice userstyle-notice-bad">
      {{ styleStore.error }}
    </div>
    <template v-else>
      <div v-if="missingActive" class="userstyle-notice">
        「{{ missingActive }}」已经不在了,当前没有任何样式生效。
      </div>
      <div v-if="notice" class="userstyle-notice">{{ notice }}</div>

      <ul v-if="styleStore.files.length > 0" class="userstyle-list">
        <!-- 「不使用」这一项不能省:没有它,一旦选了某个样式就再也回不到默认外观 -->
        <li>
          <label class="userstyle-item">
            <input
              class="userstyle-radio"
              type="radio"
              name="user-style"
              :checked="styleStore.active === null"
              @change="selectUserStyle(null)"
            />
            <span class="userstyle-item-name userstyle-item-dim">不使用自定义样式</span>
          </label>
        </li>
        <li v-for="file in styleStore.files" :key="file.name">
          <label
            class="userstyle-item"
            :class="{
              'userstyle-item-active': styleStore.active === file.name,
              'userstyle-item-bad': file.error
            }"
          >
            <input
              class="userstyle-radio"
              type="radio"
              name="user-style"
              :checked="styleStore.active === file.name"
              :disabled="Boolean(file.error)"
              @change="selectUserStyle(file.name)"
            />
            <FileCode :size="13" class="userstyle-item-icon" />
            <span class="userstyle-item-name" :title="file.name">{{ file.name }}</span>
            <span v-if="file.error" class="userstyle-item-error" :title="file.error">读取失败</span>
            <span class="userstyle-item-size">{{ file.size > 0 ? formatBytes(file.size) : '—' }}</span>
            <button
              class="plugin-icon-btn"
              title="移到回收站"
              @click.stop.prevent="onRemove(file.name)"
            >
              <Trash2 :size="13" />
            </button>
          </label>
        </li>
      </ul>

      <div v-else class="settings-section-desc">
        还没有样式文件。点「导入 CSS 文件」或「从文件夹导入」,也可以往上面那个文件夹里直接放 .css。
      </div>
    </template>

    <!--
      类名清单放在这里而不是只靠文件夹里的 example.css:想改样式的人第一个动作是
      打开设置,不该让他先去翻一个文件才知道能写什么。
    -->
    <details class="userstyle-help">
      <summary>可以改哪些东西?</summary>
      <div class="userstyle-help-body">
        <p>以 <code>.cm-md-</code> 开头的类名对应编辑器里的 Markdown 节点:</p>
        <ul class="userstyle-help-list">
          <li><code>.cm-md-h1</code> ~ <code>.cm-md-h6</code> 标题 1-6</li>
          <li><code>.cm-md-strong</code> <code>.cm-md-em</code> <code>.cm-md-strike</code> 加粗 / 斜体 / 删除线</li>
          <li><code>.cm-md-inlinecode</code> <code>.cm-md-code</code> <code>.cm-md-codeinfo</code> 代码</li>
          <li><code>.cm-md-link</code> <code>.cm-md-url</code> 链接文字 / 链接地址</li>
          <li><code>.cm-md-table</code> 表格(整张表对齐写 <code>text-align</code>)</li>
          <li><code>.cm-md-quote</code> <code>.cm-md-listmark</code> <code>.cm-md-headermark</code> 引用 / 列表标记</li>
          <li><code>.cm-md-math</code> <code>.cm-md-checkbox</code> <code>.cm-md-hr</code> <code>.cm-md-image img</code> 公式 / 任务框 / 分隔线 / 图片</li>
        </ul>
        <p>
          颜色请用主题变量,亮色 / 暗色 / 纯黑三档自动跟随:<br />
          <code>--accent</code> <code>--text-primary</code> <code>--text-secondary</code>
          <code>--text-tertiary</code> <code>--border</code> <code>--bg-code</code>
          <code>--bg-codeblock</code> <code>--bg-selection</code>
        </p>
        <p>例:整张表格居中 —— <code>.cm-md-table { text-align: center }</code></p>
        <p class="userstyle-help-warn">
          写错的规则会被浏览器直接丢掉,不会报错:改完没变化,多半是选择器写错了或文件没保存。
          <code>.cm-cursor</code> <code>.cm-scroller</code> <code>.cm-content</code> 这类由
          CodeMirror 基础主题写死的属性普通写法盖不住,得加 <code>!important</code>。
          样式作用于整个界面,不只是编辑器;写得过于激进时,在上面那个文件夹里删掉文件即可恢复。
          完整清单和更多例子写在文件夹里的 example.css 注释中。
        </p>
      </div>
    </details>
  </div>
</template>
