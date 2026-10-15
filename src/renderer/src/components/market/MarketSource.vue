<script setup lang="ts">
/**
 * 源码查看器。
 *
 * 这是「知情同意」里最实在的一块:README 是作者写的散文,详情页是市场给的元信息,
 * 只有这里是作者真正要执行的字节。所以它的措辞刻意写死成一句可核对的话 ——
 * 「与将要安装的那份是同一份」—— 而不是含糊的「参考源码」。
 *
 * 显示的是纯文本,`<pre>` 里塞不进任何东西:没有高亮、没有 iframe、不解析 HTML。
 * 一份恶意 main.js 在这里能造成的最坏后果,就是一行很难看的长字符串。
 */

import { computed, ref, watch } from 'vue'
import { AlertTriangle, FileCode2, X } from 'lucide-vue-next'
import { closeSource, formatBytes, openSource, remoteStore } from '../../services/marketService'

const source = computed(() => remoteStore.source)
const current = ref(0)

// 换了一份包就回到第一个文件:上一份的选中位置对新包没有意义
watch(source, () => (current.value = 0))

const files = computed(() => source.value?.files ?? [])
const active = computed(() => files.value[current.value] ?? null)

/** 入口文件单独标一下 —— 用户要读的首先是这段。清单里的 main 名不在这里,按惯例认 main.js */
const mainName = computed(() => (files.value.some(f => f.name === 'main.js') ? 'main.js' : null))
</script>

<template>
  <div v-if="source" class="settings-mask market-source-mask" @mousedown.self="closeSource()">
    <div class="market-source">
      <header class="market-source-head">
        <FileCode2 :size="15" />
        <div class="market-source-title">
          <h1>
            源码
            <span class="market-mono market-dim">{{ source.id }} v{{ source.version }}</span>
          </h1>
          <p class="market-hint">
            下面是这个版本包里的文本文件,与将要安装的那份是<b>同一份字节</b>
            (整包 sha256 与详情页一致)。二进制文件不在这里显示。
          </p>
        </div>
        <button class="settings-close" title="关闭" @click="closeSource()">
          <X :size="16" />
        </button>
      </header>

      <div class="market-source-body">
        <ul class="market-source-list">
          <li v-for="(f, i) in files" :key="f.name">
            <button
              class="market-source-file"
              :class="{ 'market-source-file-active': i === current }"
              @click="current = i"
            >
              <span class="market-mono market-source-name">{{ f.name }}</span>
              <span v-if="f.name === mainName" class="market-badge market-badge-code">入口</span>
              <span class="market-dim">{{ formatBytes(f.size) }}</span>
            </button>
          </li>
          <li v-if="files.length === 0" class="market-hint">这个包里没有文本文件。</li>
        </ul>

        <div class="market-source-view">
          <template v-if="active">
            <p v-if="active.truncated" class="market-alert market-alert-danger">
              <AlertTriangle :size="14" />
              <div>
                <b>这个文件太大,只显示了一部分。</b>
                <p>
                  界面里显示不下整份文件。要完整审查它,请把它下载下来在编辑器里读 ——
                  在看不全的情况下做判断是不安全的。
                </p>
              </div>
            </p>
            <pre class="market-source-code">{{ active.text }}</pre>
          </template>
          <p v-else class="market-hint">左边选一个文件。</p>
        </div>
      </div>

      <footer class="market-source-foot">
        <span class="market-dim">
          sha256 <span class="market-mono">{{ source.integrity.slice(0, 16) }}…</span>
        </span>
        <span class="market-toolbar-gap" />
        <button class="plugin-btn" :disabled="remoteStore.loading" @click="openSource(source.version)">
          重新读取
        </button>
        <button class="plugin-btn" @click="closeSource()">关闭</button>
      </footer>
    </div>
  </div>
</template>
