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

import { computed, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  FileCode2,
  Package,
  ShieldCheck
} from 'lucide-vue-next'
import { PERMISSION_INFO } from '@shared/pluginPackage'
import type { MarketVersionInfo } from '@shared/market'
import {
  closeDetail,
  copyText,
  formatTime,
  installFromMarket,
  loadIcon,
  localVersion,
  marketStore,
  openDetail,
  openSource,
  remoteStore,
  searchMarket
} from '../../services/marketService'
import { settingsNav } from '../../services/pluginService'
import MarketProgress from './MarketProgress.vue'

const detail = computed(() => remoteStore.detail)
const id = computed(() => settingsNav.market.detailId)
const copied = ref<string | null>(null)

/** 版本列表默认收起:多数人只关心装哪个版本,不关心历史 */
const showAllVersions = ref(false)

const versions = computed<MarketVersionInfo[]>(() => detail.value?.versions ?? [])
const visibleVersions = computed(() => (showAllVersions.value ? versions.value : versions.value.slice(0, 5)))

const local = computed(() => (id.value ? localVersion(id.value) : null))

async function copy(text: string): Promise<void> {
  if (!(await copyText(text))) return
  copied.value = text
  window.setTimeout(() => {
    if (copied.value === text) copied.value = null
  }, 1500)
}

function back(): void {
  closeDetail()
  void searchMarket()
}

function permLabel(p: string): string {
  return PERMISSION_INFO[p as keyof typeof PERMISSION_INFO]?.label ?? p
}

function permDesc(p: string): string {
  return PERMISSION_INFO[p as keyof typeof PERMISSION_INFO]?.description ?? ''
}

function openHomepage(url: string): void {
  void window.api.openExternal(url)
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
    <div class="market-toolbar">
      <button class="plugin-btn" @click="back()">
        <ArrowLeft :size="13" />
        返回列表
      </button>
      <span class="market-toolbar-gap" />
      <span v-if="id" class="market-mono market-dim">{{ id }}</span>
    </div>

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
            <span v-if="detail.kind === 'script'" class="market-badge market-badge-code">含代码</span>
            <span v-else-if="detail.kind === 'sandboxed'" class="market-badge market-badge-code">
              沙箱代码
            </span>
            <span v-else class="market-badge market-badge-safe">不含代码</span>
          </h1>
          <p class="market-detail-sub">
            <span v-if="detail.author">{{ detail.author }}</span>
            <span>发布者 {{ detail.publisher }}</span>
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
          <button
            v-if="detail.kind === 'script' || detail.kind === 'sandboxed'"
            class="plugin-btn"
            @click="openSource(detail.version)"
          >
            <FileCode2 :size="13" />
            查看源码
          </button>
          <button
            v-if="detail.homepage"
            class="plugin-btn"
            @click="openHomepage(detail.homepage!)"
          >
            <ExternalLink :size="13" />
            主页
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

      <p v-if="local" class="market-hint">
        本地已安装 <b>v{{ local }}</b>{{ local === detail.version ? '(与市场最新版相同)' : '' }}。
        想换回某个旧版本,在下面的版本列表里点对应版本的「安装此版本」。
      </p>

      <p class="market-detail-desc">{{ detail.description || '(这个插件还没有写说明)' }}</p>

      <section class="market-block">
        <h2 class="market-block-title">权限</h2>
        <p v-if="detail.permissions.length === 0" class="market-hint">
          没有声明任何权限。
          <template v-if="detail.kind === 'script'">
            注意:这不代表它做不到什么 —— 脚本插件在系统层面拥有与 iMark 相同的权限,
            这张列表说明的是它「声明要用到」的能力。
          </template>
          <template v-else-if="detail.kind === 'sandboxed'">
            对这个插件来说这是字面意思:它跑在沙箱里,没申请的权限连调用入口都不存在。
          </template>
        </p>
        <ul v-else class="market-perms">
          <li v-for="p in detail.permissions" :key="p" class="market-perm">
            <span class="market-perm-label">{{ permLabel(p) }}</span>
            <span class="market-perm-desc">{{ permDesc(p) }}</span>
          </li>
        </ul>
      </section>

      <section class="market-block">
        <h2 class="market-block-title">版本({{ versions.length }})</h2>
        <ul class="market-files">
          <li v-for="v in visibleVersions" :key="v.version">
            <span>
              <b class="market-mono">v{{ v.version }}</b>
              <span v-if="v.yanked" class="market-badge market-badge-warn">已下架</span>
              <span v-if="local === v.version" class="market-badge market-badge-ok">本地</span>
            </span>
            <span class="market-version-tail">
              <span class="market-dim">{{ formatTime(v.publishedAt) }}</span>
              <button class="market-hash-chip" :title="v.integrity" @click="copy(v.integrity)">
                {{ copied === v.integrity ? '已复制' : `sha256 ${v.integrity.slice(0, 10)}…` }}
              </button>
              <button
                class="plugin-btn"
                :disabled="marketStore.busy || marketStore.loading"
                @click="installFromMarket(detail!.id, v.version)"
              >
                <Check v-if="local === v.version" :size="12" />
                安装此版本
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
        <pre class="market-readme">{{ detail.readme }}</pre>
      </section>

      <section class="market-block">
        <h2 class="market-block-title">下载前请核对</h2>
        <div class="market-hash">
          <code>{{ detail.version }} · {{ versions.find(v => v.version === detail!.version)?.integrity }}</code>
          <button
            class="plugin-btn"
            @click="copy(versions.find(v => v.version === detail!.version)?.integrity ?? '')"
          >
            复制
          </button>
        </div>
        <p class="market-hint">
          这个 sha256 是插件的整包摘要。安装确认框里显示的应当与它一致 ——
          不一致就说明中途被人换过,不要安装。
        </p>
      </section>

      <div v-if="detail.kind === 'script'" class="market-alert market-alert-danger">
        <AlertTriangle :size="14" />
        <div>
          <b>这是一个会在主进程里执行的插件。</b>
          <p>
            安装它等于让作者写的代码以与 iMark 相同的权限在你的电脑上运行:
            可以读写任意文件、发起网络请求、启动其他程序,还能<b>把界面放进 iMark 里</b>
            (它画的东西与 iMark 自己的界面长得一样)。下面的权限清单、发布者与
            sha256 是用来帮你做判断的,它们<b>不构成沙箱</b>。
          </p>
        </div>
      </div>
      <div v-else-if="detail.kind === 'sandboxed'" class="market-alert market-alert-safe">
        <ShieldCheck :size="14" />
        <div>
          <b>这段代码跑在沙箱里,不是主进程。</b>
          <p>
            它没有 Node、没有文件系统:下面的每一条权限都要经 iMark 转发,没申请的连入口都不存在。
            它的界面是<b>自己的页面</b>(独立窗口,或者停靠在主界面一侧的面板)——
            面板顶栏与窗口标题栏都会标出插件名,那是它,不是 iMark。
          </p>
        </div>
      </div>
      <div v-else class="market-alert market-alert-safe">
        <FileCode2 :size="14" />
        <div>
          <b>这个插件不含代码。</b>
          <!-- 「不含代码」只是半句话:它借的是哪只别人的手才是用户要判断的东西。
               认不出能力时也要如实说,而不是含糊过去 —— 那种包本来也装不上 -->
          <p v-if="detail.capabilityName">
            它不会执行任何第三方程序 —— 它只是一份配置,交给 iMark 自带的能力
            <b>「{{ detail.capabilityName }}」</b>按你的设置去执行。
          </p>
          <p v-else>
            它声明了一个<b>本应用不认识的能力</b>(<span class="market-mono">{{
              detail.capability ?? '未声明'
            }}</span>),当前版本装不上它 —— 安装时会明确报错。
          </p>
        </div>
      </div>
    </template>
  </div>
</template>
