<script setup lang="ts">
/**
 * 安装确认框 —— 整个插件市场里**最重要的一块界面**。
 *
 * 它不是什么「再点一次的弹窗」,而是这项功能唯一的安全边界:脚本插件拿到的是
 * 完整的 Node 权限,能读写用户磁盘上的任何文件、发起任何网络请求。系统层面
 * 拦不住它(那正是脚本插件的定义),所以防线只能是「用户知情」——
 * 而用户知情的唯一机会,就是这个框。
 *
 * 因此这里刻意不做减法:
 *   - 权限逐条给出中文解释,而不是扔一个 'git' 给用户猜;
 *   - 升级时把**新增的权限**单独顶到最前面(「包还是那个包,但它现在要读你的整个仓库了」
 *     是最容易被忽略的一种风险);
 *   - sha256 等宽可复制,用户能拿去和发布页、和别人核对;
 *   - 脚本插件必须**主动勾选**风险确认才能按下安装按钮,默认不勾。
 */

import { computed, ref, watch } from 'vue'
import { AlertTriangle, FileCode2, Puzzle, ShieldCheck } from 'lucide-vue-next'
import { PERMISSION_INFO } from '@shared/pluginPackage'
import {
  cancelInstall,
  confirmInstall,
  copyText,
  formatBytes,
  marketStore
} from '../../services/marketService'

const preview = computed(() => marketStore.pending?.preview ?? null)

/** 展开文件清单(默认收起;确认框的正文应当是权限而不是文件列表) */
const showFiles = ref(false)
/** 脚本插件的风险确认,默认不勾 */
const acknowledged = ref(false)
const copied = ref(false)

// 换了一个包就重置勾选:上一个包勾过的不能替下一个包背书
watch(preview, () => {
  acknowledged.value = false
  showFiles.value = false
  copied.value = false
})

const isScript = computed(() => preview.value?.kind === 'script')
/** 权限扩大:非空时界面必须把它当成一个独立的、更重的提示 */
const added = computed(() => preview.value?.newPermissions ?? [])

/**
 * 界面贡献点(目前只有行首菜单)。
 *
 * 与权限是两件不同的事:权限说的是「它能碰你的东西」,贡献点说的是「它会往你眼前
 * 加东西」。后者是个**静默能力** —— 不说的话,用户装完只会发现编辑器里凭空多出一个
 * 按钮,而不知道该去哪儿关。
 */
const editorItems = computed(() => preview.value?.descriptor.lineMenu ?? [])
const editorLabels = computed(() => {
  const labels = editorItems.value.map(i => i.label)
  return labels.length > 4 ? `${labels.slice(0, 4).join('、')} 等` : labels.join('、')
})

const heading = computed(() => {
  const p = preview.value
  if (!p) return ''
  if (!p.installed) return '安装插件'
  return p.downgraded ? '安装旧版本插件' : '更新插件'
})

const canInstall = computed(
  () => Boolean(preview.value) && !marketStore.busy && (!isScript.value || acknowledged.value)
)

async function copyIntegrity(): Promise<void> {
  if (!preview.value) return
  copied.value = await copyText(preview.value.integrity)
  if (copied.value) window.setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div v-if="preview" class="settings-mask market-confirm-mask" @mousedown.self="cancelInstall()">
    <div class="market-confirm">
      <header class="market-confirm-head">
        <span class="market-kind-icon" :class="`market-kind-${preview.kind}`">
          <FileCode2 v-if="isScript" :size="16" />
          <Puzzle v-else :size="16" />
        </span>
        <div class="market-confirm-title">
          <h1>{{ heading }}</h1>
          <p>
            <b>{{ preview.name }}</b>
            <span class="market-mono">v{{ preview.version }}</span>
            <template v-if="preview.installed">
              <span class="market-confirm-arrow">←</span>
              <span class="market-mono market-dim">v{{ preview.installed.version }}</span>
            </template>
          </p>
        </div>
      </header>

      <div class="market-confirm-body">
        <!-- 脚本插件的红字警告:这是本框存在的主要理由 -->
        <div v-if="isScript" class="market-alert market-alert-danger">
          <AlertTriangle :size="15" />
          <div>
            <b>此插件包含可执行代码,将获得与 iMark 相同的权限。</b>
            <p>
              它能读取或修改你电脑上的任意文件(包括你的笔记、SSH 密钥与已保存的登录令牌),
              也能发起网络请求。请只安装你信任来源的插件。
            </p>
            <label class="market-ack">
              <input v-model="acknowledged" type="checkbox" />
              <span>我已了解风险,并信任该插件的来源</span>
            </label>
          </div>
        </div>
        <div v-else class="market-alert market-alert-safe">
          <ShieldCheck :size="15" />
          <div>
            <b>此插件不含任何代码。</b>
            <p v-if="preview.capabilityName">
              它是一份纯配置,不会执行第三方程序 —— 真正干活的,是 iMark 自带的
              <b>「{{ preview.capabilityName }}」</b>。
            </p>
            <p v-else>它是一份纯配置,只会调用 iMark 自带的功能,不会执行第三方程序。</p>
          </div>
        </div>

        <dl class="market-meta">
          <div><dt>来源</dt><dd>{{ preview.originLabel }}</dd></div>
          <div v-if="preview.author"><dt>作者</dt><dd>{{ preview.author }}</dd></div>
          <div>
            <dt>插件 id</dt>
            <dd class="market-mono">{{ preview.id }}</dd>
          </div>
          <div>
            <dt>体积</dt>
            <dd>{{ preview.fileCount }} 个文件,共 {{ formatBytes(preview.totalBytes) }}</dd>
          </div>
          <div v-if="editorItems.length">
            <dt>编辑器</dt>
            <dd>
              往光标行左侧的「+」菜单添加 {{ editorItems.length }} 项({{ editorLabels }})
            </dd>
          </div>
        </dl>

        <!-- 权限 -->
        <div class="market-block">
          <div class="market-block-title">
            申请权限
            <span class="market-dim">({{ preview.permissions.length }})</span>
          </div>
          <p v-if="preview.permissions.length === 0" class="market-empty-line">
            此插件没有申请任何权限。
          </p>
          <ul v-else class="market-perms">
            <li
              v-for="perm in preview.permissions"
              :key="perm"
              class="market-perm"
              :class="{ 'market-perm-new': added.includes(perm) }"
            >
              <span class="market-perm-label">
                {{ PERMISSION_INFO[perm]?.label ?? perm }}
                <span v-if="added.includes(perm)" class="market-badge market-badge-warn">新增</span>
              </span>
              <span class="market-perm-desc">{{ PERMISSION_INFO[perm]?.description ?? '' }}</span>
            </li>
          </ul>
          <p v-if="added.length > 0" class="market-new-perms-note">
            这个新版本比已安装的版本多要 {{ added.length }} 项权限(上面标「新增」的几条)。
          </p>
        </div>

        <!-- 校验值:用户能拿去核对的那个数 -->
        <div class="market-block">
          <div class="market-block-title">校验值</div>
          <div class="market-hash">
            <code>{{ preview.integrity }}</code>
            <button class="plugin-btn" @click="copyIntegrity()">
              {{ copied ? '已复制' : '复制' }}
            </button>
          </div>
          <p class="market-hint">
            这是整包的 sha256。若发布页给出的值与此不一致,请立刻取消安装 ——
            说明这份包在路上被改过。
          </p>
          <div v-if="preview.mainSha256" class="market-hash market-hash-sub">
            <span class="market-dim">入口 main.js</span>
            <code>{{ preview.mainSha256.slice(0, 32) }}…</code>
          </div>
        </div>

        <!-- 文件清单 -->
        <div class="market-block">
          <button class="market-disclosure" @click="showFiles = !showFiles">
            {{ showFiles ? '▾' : '▸' }} 文件清单({{ preview.fileCount }})
          </button>
          <ul v-if="showFiles" class="market-files">
            <li v-for="f in preview.files" :key="f.name">
              <span class="market-mono">{{ f.name }}</span>
              <span class="market-dim">{{ formatBytes(f.size) }}</span>
            </li>
          </ul>
        </div>
      </div>

      <footer class="market-confirm-foot">
        <button class="plugin-btn" :disabled="marketStore.busy" @click="cancelInstall()">取消</button>
        <button
          class="plugin-btn plugin-btn-action"
          :disabled="!canInstall"
          :title="!canInstall && isScript ? '请先勾选「我已了解风险」' : ''"
          @click="confirmInstall()"
        >
          {{ marketStore.busy ? '安装中…' : preview.installed ? '更新' : '安装' }}
        </button>
      </footer>
    </div>
  </div>
</template>
