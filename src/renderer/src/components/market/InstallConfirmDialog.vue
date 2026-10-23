<script setup lang="ts">
/**
 * 安装确认框 —— 整个扩展市场里**最重要的一块界面**。
 *
 * 它不是什么「再点一次的弹窗」,而是这项功能唯一的安全边界:含代码扩展拿到的是
 * 当前用户的完整权限,能读写用户磁盘上的任何文件、发起任何网络请求。系统层面
 * 拦不住它(那正是扩展的定义),所以防线只能是「用户知情」——
 * 而用户知情的唯一机会,就是这个框。
 *
 * 因此这里刻意不做减法:
 *   - 含代码扩展必须**主动勾选**风险确认才能按下安装按钮,默认不勾;
 *   - 纯声明式扩展不需要勾选,只展示它贡献了什么;
 *   - capability 是**告知**,不是权限门禁 —— 文案必须这么说;
 *   - sha256 等宽可复制,用户能拿去和发布页、和别人核对。
 */

import { computed, ref, watch } from 'vue'
import { AlertTriangle, FileCode2, Puzzle, ShieldCheck } from 'lucide-vue-next'
import { formatBytes } from '../../utils/text'
import { copyText } from '../../utils/clipboard'
import { cancelInstall, confirmInstall, marketStore } from '../../services/marketService'

const preview = computed(() => marketStore.pending?.preview ?? null)

/** 展开文件清单(默认收起;确认框的正文应当是风险与贡献,而不是文件列表) */
const showFiles = ref(false)
const copied = ref(false)

// 换了一个包就重置勾选:上一个包勾过的不能替下一个包背书
watch(preview, () => {
  ackCode.value = false
  showFiles.value = false
  copied.value = false
})

const hasMain = computed(() => preview.value?.hasMain === true)
const ackCode = ref(false)

const canInstall = computed(
  () => Boolean(preview.value) && !marketStore.busy && (!hasMain.value || ackCode.value)
)

/** 贡献点摘要:用户装完会在哪儿看到它 */
const contributes = computed(() => {
  const summary = preview.value?.contributesSummary
  if (!summary) return []
  return [
    { label: '命令', count: summary.commands },
    { label: '快捷键', count: summary.keybindings },
    { label: '设置项', count: summary.configuration },
    { label: '行首菜单', count: summary.lineMenu },
    { label: '动作', count: summary.actions }
  ].filter(item => item.count > 0)
})

/** 清单声明的能力 —— 只是告知 */
const capabilityLines = computed(() => {
  const caps = preview.value?.capabilities ?? {}
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

const heading = computed(() => {
  const p = preview.value
  if (!p) return ''
  if (!p.installed) return '安装扩展'
  return p.downgraded ? '安装旧版本扩展' : '更新扩展'
})

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
        <span
          class="market-kind-icon"
          :class="`market-kind-${hasMain ? 'script' : 'declarative'}`"
        >
          <FileCode2 v-if="hasMain" :size="16" />
          <Puzzle v-else :size="16" />
        </span>
        <div class="market-confirm-title">
          <h1>{{ heading }}</h1>
          <p>
            <b>{{ preview.displayName || preview.name }}</b>
            <span class="market-mono">v{{ preview.version }}</span>
            <template v-if="preview.installed">
              <span class="market-confirm-arrow">←</span>
              <span class="market-mono market-dim">v{{ preview.installed.version }}</span>
            </template>
          </p>
        </div>
      </header>

      <div class="market-confirm-body">
        <!-- 含代码扩展的红字警告:这是本框存在的主要理由 -->
        <div v-if="hasMain" class="market-alert market-alert-danger">
          <AlertTriangle :size="15" />
          <div>
            <b>这个扩展包含代码，将以你的用户权限运行。</b>
            <p>
              它能读取或修改你电脑上的任意文件（包括你的笔记、SSH 密钥与已保存的登录令牌），
              也能发起网络请求、启动其他程序。下面的能力声明是<b>告知</b>，不构成沙箱。
              请只安装你信任来源的扩展。
            </p>
            <label class="market-ack">
              <input v-model="ackCode" type="checkbox" />
              <span>我知道扩展代码将以我的用户权限运行，可以读写我的文件、访问网络</span>
            </label>
          </div>
        </div>
        <!-- 纯声明式:不执行第三方代码,不需要勾选 -->
        <div v-else class="market-alert market-alert-safe">
          <ShieldCheck :size="15" />
          <div>
            <b>这个扩展是纯声明式的，不会执行第三方代码。</b>
            <p>它只向 iMark 贡献命令、菜单与设置项，真正执行动作的是编辑器本身。</p>
          </div>
        </div>

        <dl class="market-meta">
          <div><dt>来源</dt><dd>{{ preview.originLabel }}</dd></div>
          <div v-if="preview.author"><dt>作者</dt><dd>{{ preview.author }}</dd></div>
          <div v-if="preview.publisher"><dt>发布者</dt><dd>{{ preview.publisher }}</dd></div>
          <div>
            <dt>扩展 id</dt>
            <dd class="market-mono">{{ preview.id }}</dd>
          </div>
          <div>
            <dt>形态</dt>
            <dd>{{ hasMain ? `含代码（入口 ${preview.main}）` : '纯声明式' }}</dd>
          </div>
          <div>
            <dt>体积</dt>
            <dd>{{ preview.fileCount }} 个文件，共 {{ formatBytes(preview.totalBytes) }}</dd>
          </div>
        </dl>

        <div v-if="contributes.length > 0" class="market-block">
          <div class="market-block-title">它为你添加了什么</div>
          <p class="market-empty-line">
            {{ contributes.map(item => `${item.label} ${item.count}`).join(' · ') }}
          </p>
        </div>

        <div v-if="preview.activationEvents.length > 0" class="market-block">
          <div class="market-block-title">何时启动</div>
          <p class="market-empty-line market-mono">
            {{ preview.activationEvents.join(' · ') }}
          </p>
        </div>

        <div class="market-block">
          <div class="market-block-title">
            能力声明
            <span class="market-dim">（{{ capabilityLines.length }}）</span>
          </div>
          <p v-if="capabilityLines.length === 0" class="market-empty-line">
            {{
              hasMain
                ? '清单没有声明任何能力（但含代码扩展仍然拥有当前用户的全部权限）。'
                : '纯声明式扩展不需要系统能力。'
            }}
          </p>
          <ul v-else class="market-perms">
            <li v-for="cap in capabilityLines" :key="cap.label" class="market-perm">
              <span class="market-perm-label">{{ cap.label }}</span>
              <span class="market-perm-desc">{{ cap.text }}</span>
            </li>
          </ul>
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
            这是整包的 sha256。若发布页给出的值与此不一致，请立刻取消安装 ——
            说明这份包在路上被改过。
          </p>
          <div v-if="preview.mainSha256" class="market-hash market-hash-sub">
            <span class="market-dim">入口 {{ preview.main }}</span>
            <code>{{ preview.mainSha256.slice(0, 32) }}…</code>
          </div>
        </div>

        <!-- 文件清单 -->
        <div class="market-block">
          <button class="market-disclosure" @click="showFiles = !showFiles">
            {{ showFiles ? '▾' : '▸' }} 文件清单（{{ preview.fileCount }}）
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
          :title="!canInstall && hasMain ? '请先勾选风险确认' : ''"
          @click="confirmInstall()"
        >
          {{ marketStore.busy ? '安装中…' : preview.installed ? '更新' : '安装' }}
        </button>
      </footer>
    </div>
  </div>
</template>
