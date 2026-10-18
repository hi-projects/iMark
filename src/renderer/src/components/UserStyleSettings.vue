<script setup lang="ts">
/**
 * 设置 · 外观 · 自定义样式。
 *
 * 这一块**不做编辑器**:样式文件的正文只存在于磁盘上(见主进程 userStyles.ts),
 * 界面负责的是「去哪儿改、谁在生效、改了有没有生效」。所有 CSS 编辑都发生在用户的
 * 编辑器里,所以实时反馈来自主进程的目录监听,而不是本地输入事件。
 *
 * 列表是**单选**,候选既可以是单个 .css,也可以是一个目录(目录里所有 .css 一起
 * 生效,见 userStyleService 的文件头)。什么都不选就是「不使用自定义样式」——
 * 所以没有单独一行来表示它。
 */

import { computed, ref } from 'vue'
import { FileCode, FilePlus, Folder, FolderCog, FolderOpen, RefreshCw, Trash2 } from 'lucide-vue-next'
import type { UserStyleItem } from '@shared/userStyles'
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
 * 选中的那一项不在了(被删、被改名,或只是被独占锁住了)。
 *
 * 这时**不自动改选别人** —— 那会莫名其妙地换掉你的外观;代价是界面上「没有任何
 * 一行被选中」,不说清楚的话看着像坏了。放回来,它就又生效。
 */
const missingActive = computed(() => {
  const name = styleStore.active
  if (name === null) return null
  return styleStore.items.some(f => f.name === name) ? null : name
})

/**
 * 点一行。
 *
 * 点没选中的 → 选中它;点**已经选中的** → 取消。radio 自己不吃第二次点击,
 * 而取消又是必须能做的事(什么都没选 = 不使用自定义样式),所以由这里兜住。
 *
 * 行上的 click 带 `.prevent`(见模板):label 的默认行为是把点击**转发**给里面的
 * radio,于是这个处理函数会被叫第二次 —— 第一次刚取消,第二次又给选回来。挡住转发,
 * 一次点击就只走一条路;radio 的勾选状态由 `:checked` 跟着状态走,不靠浏览器自己点。
 * 键盘另算:空格/方向键不产生 click,走 radio 自己的 `@change`。
 */
function onRowClick(item: UserStyleItem): void {
  notice.value = ''
  // 读不动的项不许选中:选上一个「什么都不生效」的东西,界面还显示它在生效
  if (item.error && styleStore.active !== item.name) return
  void selectUserStyle(styleStore.active === item.name ? null : item.name)
}

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
        自定义编辑器展示效果。只支持同时选中单个.css文件、.css目录：未选中时，使用默认css样式；选中单个.css文件时，该样式文件生效；选中单个.css目录时，该目录下的所有样式文件生效。注意：改动保存即刻生效，无需重启；该功能只影响显示，不影响导出
      </div>
    </div>

    <div class="userstyle-actions">
      <!-- 两个「导入」的动作要一眼分得清:一个收文件夹、一个收单个文件,
           所以文案里都带上宾语(而不是「从文件夹导入」对「导入 CSS 文件」) -->
      <button class="plugin-btn" @click="onImportDir()">
        <FolderOpen :size="13" />
        <span>导入 CSS 文件夹</span>
      </button>
      <button class="plugin-btn" @click="onImport()">
        <FilePlus :size="13" />
        <span>导入 CSS 文件</span>
      </button>
      <!-- 打开配置文件夹只用图标:它每次都开同一个目录,一句文案占的地方比它带来的
           信息多。路径挪进 tooltip —— 想知道样式存在哪儿的人悬停就能看到,也省得
           一行里塞下一个又长又会换行的绝对路径 -->
      <button
        class="plugin-icon-btn userstyle-open-dir"
        :title="`打开配置文件夹 ${styleStore.dir}`"
        @click="onOpenDir()"
      >
        <FolderCog :size="13" />
      </button>
      <button class="plugin-icon-btn userstyle-refresh" title="重新读取" @click="onRefresh()">
        <RefreshCw :size="13" />
      </button>
    </div>

    <!-- 整份清单读不到时只显示这一条:此时 styleStore.items 是上一次的旧数据,不能拿来渲染 -->
    <div v-if="styleStore.error" class="userstyle-notice userstyle-notice-bad">
      {{ styleStore.error }}
    </div>
    <template v-else>
      <div v-if="missingActive" class="userstyle-notice">
        「{{ missingActive }}」已经不在了，当前没有任何样式生效。
      </div>
      <div v-if="notice" class="userstyle-notice">{{ notice }}</div>

      <!-- 没有「不使用自定义样式」这一行:它不是一个候选项,而是「一个都没选」这个状态。
           取消的办法是再点一次已选中的那一行(见 onRowClick) -->
      <ul v-if="styleStore.items.length > 0" class="userstyle-list">
        <li v-for="item in styleStore.items" :key="item.name">
          <label
            class="userstyle-item"
            :class="{
              'userstyle-item-active': styleStore.active === item.name,
              'userstyle-item-bad': item.error
            }"
            :title="styleStore.active === item.name ? '再点一次取消，不使用自定义样式' : ''"
            @click.prevent="onRowClick(item)"
          >
            <input
              class="userstyle-radio"
              type="radio"
              name="user-style"
              :checked="styleStore.active === item.name"
              :disabled="Boolean(item.error)"
              @change="selectUserStyle(item.name)"
            />
            <Folder v-if="item.kind === 'dir'" :size="13" class="userstyle-item-icon" />
            <FileCode v-else :size="13" class="userstyle-item-icon" />
            <span class="userstyle-item-name" :title="item.name">{{ item.name }}</span>
            <span class="userstyle-item-meta">
              <span v-if="item.kind === 'dir' && item.fileCount > 0" class="userstyle-item-count">
                {{ item.fileCount }} 个 .css
              </span>
              <!-- 跳过的那几个文件说出来:界面上一切正常、却少了几条规则,是最难自己想明白的 -->
              <span
                v-if="item.skipped.length > 0"
                class="userstyle-item-warn"
                :title="`读不动，已跳过：${item.skipped.join('、')}`"
              >
                {{ item.skipped.length }} 个读不动
              </span>
              <span v-if="item.error" class="userstyle-item-error" :title="item.error">
                {{ item.error }}
              </span>
            </span>
            <button
              class="plugin-icon-btn"
              title="移到回收站"
              @click.stop.prevent="onRemove(item.name)"
            >
              <Trash2 :size="13" />
            </button>
          </label>
        </li>
      </ul>

      <div v-else class="settings-section-desc">
        还没有样式。点「导入 CSS 文件」收一份 .css，点「导入 CSS 文件夹」把一个文件夹<strong>整个</strong>作为样式目录收进来，
        也可以用「打开配置文件夹」直接往里放文件、建子目录。
      </div>
    </template>

    <!--
      类名清单放在这里而不是只靠文件夹里的 example.css:想改样式的人第一个动作是
      打开设置,不该让他先去翻一个文件才知道能写什么。
    -->
    <details class="userstyle-help">
      <summary>可以改哪些东西？</summary>
      <div class="userstyle-help-body">
        <p>以 <code>.cm-md-</code> 开头的类名对应编辑器里的 Markdown 节点：</p>
        <ul class="userstyle-help-list">
          <li><code>.cm-md-h1</code> ~ <code>.cm-md-h6</code> 标题 1 到 6</li>
          <li><code>.cm-md-strong</code> <code>.cm-md-em</code> <code>.cm-md-strike</code> 加粗、斜体、删除线</li>
          <li><code>.cm-md-inlinecode</code> <code>.cm-md-code</code> <code>.cm-md-codeinfo</code> 代码</li>
          <li><code>.cm-md-link</code> <code>.cm-md-url</code> 链接文字、链接地址</li>
          <li>
            <code>.cm-md-table-widget</code> 渲染态表格、<code>.cm-md-table-host</code> 表格宿主行、<code>.cm-md-table-spacer</code> 表格上下折起的空行、<code>.cm-md-table</code> 源码态表格
          </li>
          <li><code>.cm-md-quote</code> <code>.cm-md-listmark</code> <code>.cm-md-headermark</code> 引用、列表标记</li>
          <li><code>.cm-md-math</code> <code>.cm-md-checkbox</code> <code>.cm-md-hr</code> <code>.cm-md-image img</code> 公式、任务框、分隔线、图片</li>
        </ul>
        <p>
          颜色请用主题变量，亮色、深色两档自动跟随：<br />
          <code>--accent</code> <code>--text-primary</code> <code>--text-secondary</code>
          <code>--text-tertiary</code> <code>--border</code> <code>--bg-code</code>
          <code>--bg-codeblock</code> <code>--bg-selection</code>
        </p>
        <p>
          例：渲染态表格居中 ——
          <code>.cm-md-table-widget table { margin-left: auto; margin-right: auto }</code>
        </p>
        <p>
          例：调整渲染态表格上下的视觉留白 ——
          <code>:root { --md-table-gap: 8px }</code>
        </p>
        <p class="userstyle-help-warn">
          写错的规则会被浏览器直接丢掉，不会报错：改完没变化，多半是选择器写错了或文件没保存。
          <code>.cm-cursor</code> <code>.cm-scroller</code> <code>.cm-content</code> 这类由
          CodeMirror 基础主题写死的属性普通写法盖不住，得加 <code>!important</code>。
          样式作用于整个界面，不只是编辑器；写得过于激进时，在上面那个文件夹里删掉文件即可恢复。
          完整清单和更多例子写在文件夹里的 example.css 注释中。
        </p>
      </div>
    </details>
  </div>
</template>
