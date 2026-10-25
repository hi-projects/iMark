<script setup lang="ts">
/**
 * 市场 · 扩展详情。
 *
 * 详情页要承担的是「**在按下安装之前能看完**」:这个包是谁发的、会不会执行代码、
 * 贡献了什么、每个版本的 sha256 是多少、README 说了什么。装一个含代码扩展等于
 * 让一段陌生代码以当前用户权限跑起来,详情页是用户唯一能从容检查的地方。
 *
 * 这里只区分「含代码」与「纯声明」,并把清单声明的 capabilities 作为**告知**展示
 * (扩展没有权限沙箱,以当前用户权限运行)。
 *
 * 版本列表**含已下架版本**并明确标注:已下架不等于不能装(别人锁定过的版本
 * 仍然可以按精确版本号取到),但用户有权知道自己正在装一个作者撤回过的版本。
 */

import { computed, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FileCode2,
  Package,
  Puzzle,
  ShieldCheck,
  Trash2
} from 'lucide-vue-next'
import type { MarketVersionInfo } from '@shared/market'
import { copyText } from '../../utils/clipboard'
import {
  formatTime,
  installFromMarket,
  loadIcon,
  localVersion,
  marketStore,
  openDetail,
  openSource,
  remoteStore,
  uninstallFromMarket
} from '../../services/marketService'
import { renderMarkdownFragment } from '../../services/exportHtml'
import { appStore } from '../../stores/app'
import { settingsNav } from '../../services/settingsNav'
import { shapeLabels, shapeOf } from '../../services/pluginShape'
import MarketProgress from './MarketProgress.vue'
import { api } from '../../services/api'

const detail = computed(() => remoteStore.detail)
const id = computed(() => settingsNav.market.detailId)
const copied = ref<string | null>(null)

/** 版本列表默认收起:多数人只关心装哪个版本,不关心历史 */
const showAllVersions = ref(false)

const versions = computed<MarketVersionInfo[]>(() => detail.value?.versions ?? [])
const visibleVersions = computed(() => (showAllVersions.value ? versions.value : versions.value.slice(0, 5)))

const local = computed(() => (id.value ? localVersion(id.value) : null))

/**
 * 清单声明的能力 —— 只是告知。
 * 扩展代码以当前用户权限运行,清单不会拦住任何东西。
 */
const capabilityLines = computed(() => {
  const caps = detail.value?.capabilities ?? {}
  const out: { label: string; text: string }[] = []
  if (caps.filesystem) {
    out.push({
      label: '文件系统',
      text: caps.filesystem === 'user' ? '可读写用户目录下的其它位置' : '只读写当前仓库'
    })
  }
  if (caps.network) out.push({ label: '网络', text: '会发起网络请求' })
  if (caps.secrets) out.push({ label: '密钥', text: '会保存或读取密钥' })
  if (caps.git) out.push({ label: 'Git', text: '会调用 git' })
  if (caps.process) out.push({ label: '子进程', text: '会启动子进程' })
  if (caps.shell) out.push({ label: 'Shell', text: '会执行 shell 命令' })
  return out
})

const contributes = computed(() => {
  const summary = detail.value?.contributesSummary
  if (!summary) return []
  return [
    { label: '命令', count: summary.commands },
    { label: '快捷键', count: summary.keybindings },
    { label: '设置项', count: summary.configuration },
    { label: '行首菜单', count: summary.lineMenu },
    { label: '动作', count: summary.actions }
  ].filter(item => item.count > 0)
})

/**
 * 卸载确认。
 *
 * 与「已安装」页同一套两段式确认:卸载会删程序文件、配置与密钥,是不可撤销的
 * 操作,不能点一下就发生。
 */
const uninstallOpen = ref(false)

function toggleUninstall(): void {
  uninstallOpen.value = !uninstallOpen.value
}

async function doUninstall(): Promise<void> {
  if (!id.value) return
  const target = id.value
  uninstallOpen.value = false
  await uninstallFromMarket(target)
}

// 切到别的扩展时,上一页打开的确认框不能跟过去
watch(id, () => {
  uninstallOpen.value = false
})

/**
 * README 用宿主自己的 markdown-it 渲染(html:false,原始标签已被转义)。
 * 异步渲染加了序号:切换扩展时旧结果不能盖掉新结果。
 */
const readmeHtml = ref('')
let readmeSeq = 0

watch(
  () => [detail.value?.readme ?? '', appStore.theme] as const,
  async ([readme, theme]) => {
    const seq = ++readmeSeq
    if (!readme) {
      readmeHtml.value = ''
      return
    }
    try {
      const html = await renderMarkdownFragment(readme, theme)
      if (seq === readmeSeq) readmeHtml.value = html
    } catch {
      const escaped = readme
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      if (seq === readmeSeq) readmeHtml.value = `<pre>${escaped}</pre>`
    }
  },
  { immediate: true }
)

/** 说明里的外链交给系统浏览器,不能让整个界面被导航走 */
function onReadmeClick(e: MouseEvent): void {
  const anchor = (e.target as HTMLElement | null)?.closest('a')
  if (!anchor) return
  e.preventDefault()
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) void api.openExternal(href)
}

async function copy(text: string): Promise<void> {
  if (!(await copyText(text))) return
  copied.value = text
  window.setTimeout(() => {
    if (copied.value === text) copied.value = null
  }, 1500)
}

function openHomepage(url: string): void {
  void api.openExternal(url)
}

onMounted(() => {
  if (id.value) {
    void loadIcon(id.value)
    if (remoteStore.detail?.id !== id.value) void openDetail(id.value)
  }
})
</script>

<template>
  <div class="market-tab-body">
    <MarketProgress />

    <div v-if="!detail" class="market-empty">
      <Package :size="22" />
      <p>{{ marketStore.loading ? '正在读取…' : '读不到这个扩展的详情。' }}</p>
    </div>

    <template v-else>
      <div class="market-detail-head">
        <img
          v-if="remoteStore.icons[detail.id]"
          class="market-card-icon market-detail-icon"
          :src="remoteStore.icons[detail.id]!"
          alt=""
        />
        <div v-else class="market-card-icon market-card-icon-fallback market-detail-icon">
          <Package :size="22" />
        </div>

        <div class="market-detail-title">
          <h1>
            {{ detail.displayName }}
            <span class="market-mono market-dim">v{{ detail.version }}</span>
            <span
              v-for="s in shapeLabels(shapeOf(detail))"
              :key="s.label"
              class="market-badge"
              :class="`market-shape-${s.tone}`"
              >{{ s.label }}</span
            >
          </h1>
          <p class="market-detail-sub">
            <span v-if="detail.author">{{ detail.author }}</span>
            <span>{{ detail.downloads }} 次下载</span>
            <span>更新于 {{ formatTime(detail.updatedAt) }}</span>
          </p>
        </div>

        <div class="market-row-actions">
          <!-- 明确传当前展示的版本,而不是让服务端再解析一次「最新」:
               下架状态下两者可能不是同一个版本,而界面上写的是这一个 -->
          <!-- 含代码扩展要能看源码:它是**真的会跑的代码**,
               「显示的就是将要运行的字节」这条承诺对它才成立 -->
          <button
            v-if="detail.hasMain"
            class="plugin-icon-btn plugin-icon-btn-accent"
            title="查看源码"
            aria-label="查看源码"
            @click="openSource(detail.version)"
          >
            <FileCode2 :size="14" />
          </button>
          <button
            v-if="detail.homepage"
            class="plugin-btn"
            @click="openHomepage(detail.homepage!)"
          >
            <ExternalLink :size="13" />
            主页
          </button>
          <!-- 只在本地确实装着时出现。图标按钮与「已安装」页的卸载保持一致,
               也避免在头部一排文字按钮里塞进一个破坏性操作 -->
          <button
            v-if="local"
            class="plugin-icon-btn"
            title="卸载"
            aria-label="卸载"
            :disabled="marketStore.busy"
            @click="toggleUninstall()"
          >
            <Trash2 :size="14" />
          </button>
          <button
            class="plugin-btn plugin-btn-add"
            :disabled="marketStore.busy || marketStore.loading"
            @click="installFromMarket(detail.id, null)"
          >
            <Download :size="13" />
            {{ local ? (local === detail.version ? '重新安装' : `更新到 v${detail.version}`) : '安装' }}
          </button>
        </div>
      </div>

      <p class="market-detail-desc">{{ detail.description || '（这个扩展还没有写说明）' }}</p>

      <!-- 卸载确认用的是「已安装」页同一套说明:所有数据都会删 -->
      <div v-if="uninstallOpen" class="market-row-confirm">
        <p class="market-hint">
          卸载会停止并删除这个扩展的程序文件，<b>连同它的配置、密钥、globalState 与日志</b>
          （不可恢复）。扩展 id 可能被其他人重新使用，凭据不能留给下一个同名扩展。
        </p>
        <div class="market-row-confirm-actions">
          <button class="plugin-btn" @click="uninstallOpen = false">取消</button>
          <button class="plugin-btn market-btn-danger" :disabled="marketStore.busy" @click="doUninstall()">
            确认卸载
          </button>
        </div>
      </div>

      <!-- 形态:含代码 / 纯声明 -->
      <section class="market-block">
        <h2 class="market-block-title">形态</h2>
        <div v-if="detail.hasMain" class="market-alert market-alert-danger">
          <AlertTriangle :size="15" />
          <div>
            <b>这个扩展含代码，会以你的用户权限运行。</b>
            <p>
              它与 iMark 拥有相同的系统权限：可以读写任意文件、发起网络请求、启动其他程序。
              清单里的能力声明是<b>告知</b>，不构成沙箱。请只安装你信任来源的扩展。
            </p>
          </div>
        </div>
        <div v-else class="market-alert market-alert-safe">
          <ShieldCheck :size="15" />
          <div>
            <b>这个扩展是纯声明式的，不会执行第三方代码。</b>
            <p>它只向 iMark 贡献命令、菜单与设置项，真正执行动作的是编辑器本身。</p>
          </div>
        </div>
      </section>

      <section v-if="detail.activationEvents.length > 0" class="market-block">
        <h2 class="market-block-title">何时启动</h2>
        <ul class="market-files">
          <li v-for="event in detail.activationEvents" :key="event">
            <span class="market-mono">{{ event }}</span>
          </li>
        </ul>
        <p class="market-hint">
          扩展按激活事件懒启动：没有命中的扩展不会占用进程，直到你执行它的命令或打开相关面板。
        </p>
      </section>

      <section class="market-block">
        <h2 class="market-block-title">能力声明</h2>
        <p v-if="capabilityLines.length === 0" class="market-hint">
          清单没有声明任何能力。
          <template v-if="detail.hasMain">
            这不代表它做不到什么 —— 含代码扩展在系统层面拥有与 iMark 相同的权限。
          </template>
          <template v-else>纯声明式扩展本来就不需要系统能力。</template>
        </p>
        <ul v-else class="market-perms">
          <li v-for="cap in capabilityLines" :key="cap.label" class="market-perm">
            <span class="market-perm-label">{{ cap.label }}</span>
            <span class="market-perm-desc">{{ cap.text }}</span>
          </li>
        </ul>
      </section>

      <section class="market-block">
        <h2 class="market-block-title">它为你添加了什么</h2>
        <p v-if="contributes.length === 0" class="market-hint">
          <Puzzle :size="13" />
          没有声明任何贡献点 —— 安装后不会在界面上添加东西。
        </p>
        <p v-else class="market-hint">
          <Puzzle :size="13" />
          {{ contributes.map(item => `${item.label} ${item.count}`).join(' · ') }}
        </p>
        <p v-if="detail.main" class="market-hint">
          入口：<code class="market-mono">{{ detail.main }}</code>
        </p>
      </section>

      <section class="market-block">
        <h2 class="market-block-title">版本（{{ versions.length }}）</h2>
        <ul class="market-files">
          <li
            v-for="v in visibleVersions"
            :key="v.version"
            :class="{ 'market-version-current': local === v.version }"
          >
            <span>
              <b class="market-mono">v{{ v.version }}</b>
              <span v-if="v.yanked" class="market-badge market-badge-warn">已下架</span>
            </span>
            <span class="market-version-tail">
              <button class="market-hash-chip" :title="v.integrity" @click="copy(v.integrity)">
                {{ copied === v.integrity ? '已复制' : `sha256 ${v.integrity.slice(0, 10)}…` }}
              </button>
              <!-- 已安装只留一个勾:绿边已经把「当前版本」说清楚了,
                   按钮再写一遍「已安装」是重复信息 -->
              <button
                class="plugin-btn"
                :title="local === v.version ? '已安装' : undefined"
                :aria-label="local === v.version ? '已安装' : undefined"
                :disabled="marketStore.busy || marketStore.loading || local === v.version"
                @click="installFromMarket(detail!.id, v.version)"
              >
                <Check v-if="local === v.version" :size="12" />
                <template v-else>安装</template>
              </button>
            </span>
          </li>
        </ul>
        <button
          v-if="versions.length > 5"
          class="market-disclosure"
          @click="showAllVersions = !showAllVersions"
        >
          {{ showAllVersions ? '只看最近 5 个版本' : `展开全部 ${versions.length} 个版本` }}
        </button>
      </section>

      <section v-if="detail.readme" class="market-block">
        <h2 class="market-block-title">说明</h2>
        <!-- 片段来自 markdown-it(html:false):原始 HTML 已被转义,链接也过了校验 -->
        <div class="market-readme" v-html="readmeHtml" @click="onReadmeClick" />
      </section>
    </template>
  </div>
</template>
