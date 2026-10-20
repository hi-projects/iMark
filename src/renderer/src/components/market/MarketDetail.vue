<script setup lang="ts">
/**
 * 市场 · 插件详情。
 *
 * 详情页要承担的是「**在按下安装之前能看完**」:这个包是谁发的、要哪些权限、
 * 每个版本的 sha256 是多少、README 说了什么。装一个脚本插件等于让一段陌生代码
 * 在你的电脑上以完整权限跑起来,详情页是用户唯一能从容检查的地方。
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
  ShieldCheck,
  Trash2
} from 'lucide-vue-next'
import { PERMISSION_INFO } from '@shared/pluginPackage'
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
  uninstallPlugin
} from '../../services/marketService'
import { renderMarkdownFragment } from '../../services/exportHtml'
import { appStore } from '../../stores/app'
import { settingsNav } from '../../services/pluginService'
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
 * 卸载确认。
 *
 * 与「已安装」页同一套两段式确认:卸载会删程序文件与密钥,是不可撤销的操作,
 * 不能点一下就发生。配置默认保留,勾选才一并删除。
 */
const uninstallOpen = ref(false)
const dropConfig = ref(false)

function toggleUninstall(): void {
  uninstallOpen.value = !uninstallOpen.value
  dropConfig.value = false
}

async function doUninstall(): Promise<void> {
  if (!id.value) return
  const removeConfig = dropConfig.value
  uninstallOpen.value = false
  await uninstallPlugin(id.value, removeConfig)
}

// 切到别的插件时,上一页打开的确认框不能跟过去
watch(id, () => {
  uninstallOpen.value = false
  dropConfig.value = false
})

/**
 * README 用宿主自己的 markdown-it 渲染(html:false,原始标签已被转义)。
 * 异步渲染加了序号:切换插件时旧结果不能盖掉新结果。
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

function permLabel(p: string): string {
  return PERMISSION_INFO[p as keyof typeof PERMISSION_INFO]?.label ?? p
}

function permDesc(p: string): string {
  return PERMISSION_INFO[p as keyof typeof PERMISSION_INFO]?.description ?? ''
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
      <p>{{ marketStore.loading ? '正在读取…' : '读不到这个插件的详情。' }}</p>
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
            {{ detail.name }}
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
          <!-- 沙箱插件也要能看源码:它是**真的会跑的代码**,只是跑在沙箱里。
               「显示的就是将要运行的字节」这条承诺对它同样成立,而且更该兑现 ——
               用户要判断的正是"这段代码值不值得我给它那些权限" -->
          <!-- 只留图案:源码是次要动作,不抢「安装/重新安装」的视觉重量 -->
          <button
            v-if="detail.mainMode || detail.hasRender"
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

      <p class="market-detail-desc">{{ detail.description || '（这个插件还没有写说明）' }}</p>

      <!-- 卸载确认用的是「已安装」页同一套说明:密钥一定删,配置默认留 -->
      <div v-if="uninstallOpen" class="market-row-confirm">
        <p class="market-hint">
          卸载会停止并删除这个插件的程序文件。<b>已保存的密钥一定会被删除</b>
          （插件 id 可能被其他人重新使用，凭据不能留给下一个同名插件）；
          配置默认保留，方便你以后重新装回来时不用重填其余字段。
        </p>
        <label class="market-ack">
          <input v-model="dropConfig" type="checkbox" />
          <span>连同配置一起删除（不可恢复）</span>
        </label>
        <div class="market-row-confirm-actions">
          <button class="plugin-btn" @click="uninstallOpen = false">取消</button>
          <button class="plugin-btn market-btn-danger" :disabled="marketStore.busy" @click="doUninstall()">
            确认卸载
          </button>
        </div>
      </div>

      <section class="market-block">
        <h2 class="market-block-title">权限</h2>
        <p v-if="detail.permissions.length === 0" class="market-hint">
          没有声明任何权限。
          <template v-if="detail.mainMode === 'node'">
            注意：这不代表它做不到什么 —— node main 在系统层面拥有与 iMark 相同的权限，
            这张列表说明的是它「声明要用到」的能力。
          </template>
          <template v-else-if="detail.mainMode === 'restricted'">
            对这个插件来说这是字面意思：它跑在受限沙箱页里，没申请的权限连调用入口都不存在。
          </template>
          <template v-else-if="detail.hasRender">
            它只有 render 层：能改界面、读当前文档，但不申请任何系统能力。
          </template>
          <template v-else-if="detail.capability">
            它不含代码，行为完全由宿主内置能力实现。
          </template>
        </p>
        <template v-else>
          <p v-if="detail.mainMode === 'node'" class="market-hint">
            它拥有完整 Node，下面不是它「被允许」的范围，只是作者声明会用到哪些能力。
          </p>
          <ul class="market-perms">
            <li v-for="p in detail.permissions" :key="p" class="market-perm">
              <span class="market-perm-label">{{ permLabel(p) }}</span>
              <span class="market-perm-desc">{{ permDesc(p) }}</span>
            </li>
          </ul>
        </template>
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
              <!-- 当前装着的那个版本只做状态说明;重装走顶部的「重新安装」 -->
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

      <div v-if="detail.mainMode === 'node'" class="market-alert market-alert-danger">
        <AlertTriangle :size="14" />
        <div>
          <b>它的 main 层在主进程里执行代码，拥有完整 Node 权限。</b>
          <p>
            安装它等于让作者写的代码以与 iMark 相同的权限在你的电脑上运行：
            可以读写任意文件、发起网络请求、启动其他程序。上面的权限清单
            是用来帮你做判断的，它<b>不构成沙箱</b>。
          </p>
        </div>
      </div>
      <div v-if="detail.hasRender" class="market-alert market-alert-danger">
        <AlertTriangle :size="14" />
        <div>
          <b>它的 render 层在主界面里执行代码。</b>
          <p>
            它与 iMark 的界面跑在同一个 realm：能改界面、读当前文档、看到你在这个窗口里的
            键盘输入 —— 请只安装你信任来源的插件。它<b>拿不到系统能力</b>：文件、网络、git、
            密钥都由 main 层经 iMark 逐项授权后转发；没有 main 层时它连这些能力都没有。
          </p>
        </div>
      </div>
      <div v-if="detail.mainMode === 'restricted'" class="market-alert market-alert-safe">
        <ShieldCheck :size="14" />
        <div>
          <b>它的 main 层跑在受限沙箱页里，不是主进程。</b>
          <p>
            它没有 Node、没有文件系统：下面的每一条权限都要经 iMark 转发，没申请的连入口都不存在，
            而且<b>每一次调用</b>都会再审查一遍。
          </p>
        </div>
      </div>
      <div
        v-if="!detail.mainMode && !detail.hasRender && detail.capabilityName"
        class="market-alert market-alert-safe"
      >
        <FileCode2 :size="14" />
        <div>
          <b>这个插件不含代码。</b>
          <!-- 「不含代码」只是半句话:它借的是哪只别人的手才是用户要判断的东西。 -->
          <p>
            它不会执行任何第三方程序 —— 它只是一份配置，交给 iMark 自带的能力
            <b>「{{ detail.capabilityName }}」</b>按你的设置去执行。
          </p>
        </div>
      </div>
      <div
        v-if="!detail.mainMode && !detail.hasRender && !detail.capability"
        class="market-alert market-alert-danger"
      >
        <AlertTriangle :size="14" />
        <div>
          <b>未知形态。</b>
          <p>这份清单既没有 main、render，也没有绑定内置能力 —— 当前版本装不上它。</p>
        </div>
      </div>
      <div
        v-if="detail.capability && (detail.mainMode || detail.hasRender)"
        class="market-alert market-alert-danger"
      >
        <AlertTriangle :size="14" />
        <div>
          <b>清单同时声明了代码层与 capability。</b>
          <p>这是非法组合，当前版本会拒绝安装。</p>
        </div>
      </div>
    </template>
  </div>
</template>
