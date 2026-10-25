<script setup lang="ts">
/**
 * 市场 · 发布扩展。
 *
 * 这一页同时是**第一次接市场时的设置页**:地址、账号、发布三件事挤在一条
 * 从上到下的流程里,因为它们本来就是一回事 —— 你想发布,于是要有个账号,
 * 而账号长在某个服务端上。把地址挪去别的设置页只会让人来回找。
 *
 * 预览是这一页的核心:上传 8 MiB 之前,先把「这个 id 是不是你的」
 * 「这个版本号是不是发过了」说清楚。服务端这两件事都会拒(403/409),
 * 但让用户白等一次上传再收到拒绝是没道理的。
 */

import { computed, onMounted, ref, watch } from 'vue'
import { AlertTriangle, Check, FileCode2, Info, Package } from 'lucide-vue-next'
import { formatBytes } from '../../utils/text'
import { copyText } from '../../utils/clipboard'
import {
  acknowledgePlainHttp,
  loadAuth,
  loginMarket,
  logoutMarket,
  marketStore,
  previewPublish,
  publishNow,
  registerMarket,
  remoteStore,
  setRegistry,
  testRegistry
} from '../../services/marketService'
import { shapeLabels, shapeOf } from '../../services/pluginShape'
import MarketProgress from './MarketProgress.vue'

const auth = computed(() => remoteStore.auth)
const preview = computed(() => remoteStore.publishPreview)

/** 地址输入框的本地草稿:用户没点「保存」之前不该影响任何东西 */
const urlDraft = ref('')
const username = ref('')
const password = ref('')
const testResult = ref('')
const copied = ref(false)

/** 只用来把「注册」和「登录」两个按钮的等待状态分开显示 */
const mode = ref<'idle' | 'login' | 'register'>('idle')

watch(
  auth,
  value => {
    if (value) urlDraft.value = value.registry
  },
  { immediate: true }
)

const canSubmitAccount = computed(
  () => username.value.trim().length >= 2 && password.value.length >= 8 && mode.value === 'idle'
)

async function saveUrl(): Promise<void> {
  testResult.value = ''
  if (await setRegistry(urlDraft.value)) remoteStore.publishPreview = null
}

async function doTest(): Promise<void> {
  testResult.value = ''
  const text = await testRegistry(urlDraft.value)
  if (text) testResult.value = text
}

async function doAuth(kind: 'login' | 'register'): Promise<void> {
  mode.value = kind
  try {
    const ok =
      kind === 'login'
        ? await loginMarket(username.value.trim(), password.value)
        : await registerMarket(username.value.trim(), password.value)
    if (ok) {
      // 登录成功后清掉口令:它已经换成令牌存在主进程里了,没有理由再留在界面上
      password.value = ''
      remoteStore.publishPreview = null
    }
  } finally {
    mode.value = 'idle'
  }
}

async function doLogout(): Promise<void> {
  await logoutMarket()
}

async function copyHash(text: string): Promise<void> {
  if (!(await copyText(text))) return
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1500)
}

onMounted(async () => {
  if (!remoteStore.auth) await loadAuth()
  urlDraft.value = remoteStore.auth?.registry ?? ''
})
</script>

<template>
  <div class="market-tab-body">
    <MarketProgress />

    <!-- ---------- 1. 市场地址 ---------- -->
    <section class="market-block">
      <h2 class="market-block-title">1 · 市场地址</h2>
      <div class="market-toolbar">
        <input
          v-model="urlDraft"
          class="market-input market-input-wide"
          placeholder="http://127.0.0.1:8787"
          spellcheck="false"
          @keyup.enter="saveUrl()"
        />
        <button class="plugin-btn" :disabled="marketStore.loading" @click="saveUrl()">保存</button>
        <button class="plugin-btn" :disabled="marketStore.loading" @click="doTest()">测试连接</button>
      </div>
      <p v-if="testResult" class="market-hint market-hint-ok">{{ testResult }}</p>
      <p class="market-hint">
        留空表示不使用市场。仓库里自带一个零依赖的自托管服务端，在项目目录跑
        <code class="market-mono">npm run market</code> 就能起一个。
      </p>

      <div v-if="auth?.plainHttp" class="market-alert market-alert-danger">
        <AlertTriangle :size="14" />
        <div>
          <b>这个地址用的是明文 HTTP，而且不在本机。</b>
          <p>
            加密、扩展包以及<b>你登录时输入的口令</b>都会以明文经过网络，
            同一网段上的任何人都能看到。自建服务请在前面加一层 HTTPS
            （nginx 或 caddy 都行），或者只在可信网络里使用。
          </p>
          <button class="plugin-btn" @click="acknowledgePlainHttp()">我知道了，不再提示</button>
        </div>
      </div>

      <div v-if="auth && !auth.secureStorage" class="market-alert">
        <Info :size="14" />
        <div>
          <b>系统的密钥库不可用，登录令牌会以明文存放在本机。</b>
          <p>在 Linux 上通常意味着没有可用的 keyring 服务。令牌本身不会离开这台机器，但同机的其他程序可以读到它。</p>
        </div>
      </div>
    </section>

    <!-- ---------- 2. 账号 ---------- -->
    <section class="market-block">
      <h2 class="market-block-title">2 · 账号</h2>

      <p v-if="auth?.loggedIn" class="market-hint market-hint-ok">
        <Check :size="13" />
        已以 <b>{{ auth.user ?? '（未知用户）' }}</b> 的身份登录 {{ auth.registry }}。
      </p>

      <div v-else class="market-toolbar">
        <input
          v-model="username"
          class="market-input"
          placeholder="用户名"
          autocomplete="username"
          spellcheck="false"
        />
        <input
          v-model="password"
          class="market-input"
          type="password"
          placeholder="口令（至少 8 位）"
          autocomplete="current-password"
          @keyup.enter="canSubmitAccount && doAuth('login')"
        />
        <button class="plugin-btn plugin-btn-add" :disabled="!canSubmitAccount" @click="doAuth('login')">
          {{ mode === 'login' ? '登录中…' : '登录' }}
        </button>
        <button class="plugin-btn" :disabled="!canSubmitAccount" @click="doAuth('register')">
          {{ mode === 'register' ? '注册中…' : '注册新账号' }}
        </button>
      </div>

      <div v-if="auth?.loggedIn" class="market-toolbar">
        <button class="plugin-btn" :disabled="marketStore.loading" @click="doLogout()">退出登录</button>
      </div>

      <p v-else class="market-hint">
        在自建服务端上，第一个注册的账号就是这个市场的管理员。
        口令只用于换取令牌，主进程把它换成令牌之后，界面上的口令会被清掉。
      </p>
    </section>

    <!-- ---------- 3. 打包与发布 ---------- -->
    <section class="market-block">
      <h2 class="market-block-title">3 · 打包与发布</h2>

      <div class="market-toolbar">
        <button
          class="plugin-btn"
          :disabled="marketStore.loading || !auth?.loggedIn"
          @click="previewPublish()"
        >
          <Package :size="13" />
          选择扩展目录…
        </button>
        <span v-if="remoteStore.publishDir" class="market-mono market-dim market-ellipsis">
          {{ remoteStore.publishDir }}
        </span>
      </div>

      <p v-if="!auth?.loggedIn" class="market-hint">发布需要先登录。</p>

      <template v-if="preview">
        <p class="market-detail-desc">
          {{ preview.displayName }}
          <span class="market-mono market-dim">{{ preview.id }}@{{ preview.version }}</span>
          <span
            v-for="s in shapeLabels(shapeOf(preview))"
            :key="s.label"
            class="market-badge"
            :class="`market-shape-${s.tone}`"
            >{{ s.label }}</span
          >
        </p>

        <dl class="market-meta">
          <div>
            <dt>文件</dt>
            <dd>{{ preview.fileCount }} 个，共 {{ formatBytes(preview.totalBytes) }}</dd>
          </div>
          <div>
            <dt>入口</dt>
            <dd class="market-mono">{{ preview.main ?? '（纯声明式，无入口）' }}</dd>
          </div>
          <div>
            <dt>入口 sha256</dt>
            <dd class="market-mono">{{ preview.mainSha256 ?? '（纯声明式，无入口）' }}</dd>
          </div>
          <div>
            <dt>激活事件</dt>
            <dd>
              <template v-if="preview.activationEvents.length === 0">无</template>
              <template v-else class="market-mono">{{ preview.activationEvents.join('、') }}</template>
            </dd>
          </div>
          <div>
            <dt>贡献点</dt>
            <dd>
              命令 {{ preview.contributesSummary.commands }} · 快捷键
              {{ preview.contributesSummary.keybindings }} · 设置项
              {{ preview.contributesSummary.configuration }} · 行首菜单
              {{ preview.contributesSummary.lineMenu }} · 动作 {{ preview.contributesSummary.actions }}
            </dd>
          </div>
        </dl>

        <div class="market-hash">
          <code>{{ preview.integrity }}</code>
          <button class="plugin-btn" @click="copyHash(preview.integrity)">
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
        <p class="market-hint">
          这是整包的 sha256。发布后它也会显示在详情页，用户可以拿它来核对下载到的东西。
        </p>

        <ul class="market-files">
          <li v-for="f in preview.files" :key="f.name">
            <span class="market-mono">{{ f.name }}</span>
            <span class="market-dim">{{ formatBytes(f.size) }}</span>
          </li>
        </ul>

        <!-- 服务端那边的状态:这两件事上传之后必然会被拒,所以在这里先说 -->
        <div v-if="preview.versionExists" class="market-alert market-alert-danger">
          <AlertTriangle :size="14" />
          <div>
            <b>版本 {{ preview.version }} 已经发布过了。</b>
            <p>
              已发布的版本<b>不可覆盖</b> —— 同一个版本号底下的字节如果能悄悄换人，
              那个 sha256 就失去了意义。请把 <code class="market-mono">package.json</code>
              里的版本号升一位（比如 {{ preview.version }} → 下一版）再发布。
              <template v-if="preview.identical">当前的包与已发布的那个内容完全相同，这次发布没有意义。</template>
            </p>
          </div>
        </div>
        <div v-else-if="preview.existingOwner && preview.existingOwner !== auth?.user" class="market-alert market-alert-danger">
          <AlertTriangle :size="14" />
          <div>
            <b>扩展 id「{{ preview.id }}」属于 {{ preview.existingOwner }}。</b>
            <p>换一个 id，或者请服务端管理员把这个扩展的所有权转移给你。</p>
          </div>
        </div>
        <div v-else-if="preview.existingOwner" class="market-alert">
          <Info :size="14" />
          <div>
            <b>{{ preview.id }} 当前最高版本是 {{ preview.existingVersion }}。</b>
            <p>这次发布的 {{ preview.version }} 会成为新的最高版本。</p>
          </div>
        </div>

        <div class="market-toolbar">
          <button
            class="plugin-btn plugin-btn-add"
            :disabled="marketStore.loading || preview.versionExists || (!!preview.existingOwner && preview.existingOwner !== auth?.user)"
            @click="publishNow()"
          >
            {{ marketStore.loading ? '发布中…' : '发布' }}
          </button>
          <button class="plugin-btn" :disabled="marketStore.loading" @click="previewPublish()">
            重新打包
          </button>
        </div>
      </template>

      <div v-if="remoteStore.lastPublished" class="market-alert market-alert-safe">
        <Check :size="14" />
        <div>
          <b>已发布 {{ remoteStore.lastPublished.id }}@{{ remoteStore.lastPublished.version }}</b>
          <p>
            sha256 <code class="market-mono">{{ remoteStore.lastPublished.integrity }}</code>
          </p>
        </div>
      </div>

      <p class="market-hint">
        目录里要有 <code class="market-mono">package.json</code>；含代码扩展还要有已编译好的入口文件
        （TypeScript 写的扩展先编译再发）。<code class="market-mono">README.md</code> 会显示在详情页。
      </p>
      <p class="market-hint">
        <FileCode2 :size="13" />
        发布是可撤销的：在详情页里可以把某个版本「下架」。下架不等于删除，已装了这个版本的人不受影响。
      </p>
    </section>
  </div>
</template>
