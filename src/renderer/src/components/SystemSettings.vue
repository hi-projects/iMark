<script setup lang="ts">
/**
 * 设置 → 系统:与操作系统打交道的那几项。目前只有「默认 Markdown 编辑器」。
 *
 * 文案跟着平台走(见 main/system.ts 顶部):
 *   - Windows 8 起应用写不进 UserChoice(有哈希保护),主进程只能**注册成候选**
 *     + 打开系统设置页,最后一下必须由用户点。文案不承诺「一键设成默认」,
 *     免得用户点完以为没生效。
 *   - Linux 走 `xdg-mime`,应用能一步改完(`status.direct`),文案就直说改好了。
 */

import { computed, onMounted, ref } from 'vue'
import type { DefaultEditorStatus } from '@shared/types'
import { api } from '../services/api'

const status = ref<DefaultEditorStatus | null>(null)
const busy = ref(false)
/** 点完按钮 / 查询失败时的补充说明(成功时可能为空) */
const note = ref('')

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把系统里的标识换成人话:
 * `Applications\MarkText.exe` → MarkText(Linux 的 `org.gnome.TextEditor.desktop`
 * 同理去掉后缀)。其它形式(如 `VSCode.md`)原样显示 —— 它本身就是那个应用
 * 注册的名字,硬拆只会拆出更看不懂的东西。
 */
function appLabel(value: string): string {
  const win = /^Applications\\(.+?)\.exe$/i.exec(value)
  if (win) return win[1]!
  return value.endsWith('.desktop') ? value.slice(0, -'.desktop'.length) : value
}

/** 平台是否缺了可关联的桌面条目(Linux 未安装 / AppImage 未集成) */
const missingEntry = computed(() => status.value?.desktopEntry === null)

async function refresh(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    status.value = await api.defaultEditorStatus()
    note.value = status.value.error ?? ''
  } catch (err) {
    note.value = message(err)
  } finally {
    busy.value = false
  }
}

async function setDefault(): Promise<void> {
  if (busy.value) return
  busy.value = true
  note.value = ''
  try {
    status.value = await api.setDefaultEditor()
    if (status.value.error) {
      note.value = status.value.error
    } else if (status.value.isDefault) {
      // Linux 是一步改完的;Windows 只可能在用户去系统设置点过之后走到这里
      if (status.value.direct) note.value = '已把 iMark 设为 .md、.markdown 的默认打开程序。'
    } else {
      note.value =
        '已注册并打开系统设置。请把 .md、.markdown 的默认应用选成 iMark，选完回到这里点「刷新」确认。'
    }
  } catch (err) {
    note.value = message(err)
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div class="settings-section">
    <div class="settings-section-head">
      <div class="settings-section-title">默认应用</div>
      <div class="settings-section-desc">让文档（.md，.markdown）默认用 iMark 打开</div>
    </div>

    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-title">默认 Markdown 编辑器</div>
          <div class="settings-row-desc">
            <template v-if="status === null">正在查询当前的默认程序…</template>
            <template v-else-if="status.isDefault">iMark 现在是 .md 的默认应用。</template>
            <template v-else-if="status.current">当前默认程序：{{ appLabel(status.current) }}</template>
            <template v-else>还没有查询到 .md 的默认程序。</template>
            <button
              v-if="status?.supported"
              class="settings-inline-link"
              :disabled="busy"
              @click="refresh()"
            >
              刷新
            </button>
          </div>
        </div>
        <button
          class="plugin-btn"
          :disabled="busy || !status?.supported || status?.isDefault || missingEntry"
          @click="setDefault()"
        >
          {{ status?.isDefault ? '已是默认' : busy ? '正在注册…' : '设为默认…' }}
        </button>
      </div>
    </div>

    <p v-if="note" class="settings-note">{{ note }}</p>
    <p v-else-if="missingEntry" class="settings-note">
      没有找到 iMark 的桌面启动条目（.desktop）。安装 deb 包，或把 AppImage 集成到应用菜单后再试。
    </p>
    <p v-else-if="status && !status.supported" class="settings-note">
      当前平台暂不支持由应用代注册，请手动在系统设置里把 .md 关联到 iMark。
    </p>
  </div>
</template>
