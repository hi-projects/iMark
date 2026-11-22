<script setup lang="ts">
/**
 * 设置 → 关于:本应用与同系列应用。
 * 应用矩阵后续新增应用时往 FAMILY_APPS 里加一项即可。
 */
import { Github } from 'lucide-vue-next'
import imarkIcon from '../../../../build/icon.svg'
import idrawIcon from '../../../../build/idraw.svg'
import { api } from '../services/api'
import { notifyError } from '../services/notice'

interface FamilyApp {
  key: string
  name: string
  description: string
  icon: string
  /** 应用主页,点右侧 GitHub 图标时用系统浏览器打开 */
  url: string
}

const FAMILY_APPS: FamilyApp[] = [
  {
    key: 'idraw',
    name: 'iDraw',
    description: '专注绘制流程图与示意图，作品可在各类软件中自由打开与继续编辑',
    icon: idrawIcon,
    url: 'https://github.com/hi-projects/iDraw'
  }
]

const appVersion = __APP_VERSION__

async function openAppPage(item: FamilyApp): Promise<void> {
  try {
    await api.openExternal(item.url)
  } catch (err) {
    notifyError('打开链接', err)
  }
}
</script>

<template>
  <div class="settings-section">
    <div class="settings-section-head">
      <div class="settings-section-title">本应用</div>
    </div>

    <div class="settings-card settings-card-pad">
      <div class="settings-about">
        <img :src="imarkIcon" alt="" draggable="false" />
        <div>
          <h3>iMark</h3>
          <p>版本 {{ appVersion }}</p>
        </div>
      </div>
      <p class="settings-about-desc">专注文字创作，内容与版式即时呈现</p>
    </div>
  </div>

  <div class="settings-section">
    <div class="settings-section-head">
      <div class="settings-section-title">应用矩阵</div>
    </div>

    <div class="settings-card">
      <div
        v-for="item in FAMILY_APPS"
        :key="item.key"
        class="settings-family-app"
        :data-app="item.key"
      >
        <img
          class="settings-family-app-icon"
          :src="item.icon"
          :alt="item.name"
          draggable="false"
        />
        <div class="settings-family-app-body">
          <div class="settings-family-app-name">{{ item.name }}</div>
          <div class="settings-family-app-desc">{{ item.description }}</div>
        </div>
        <button
          class="settings-family-app-link"
          type="button"
          :title="`在 GitHub 上查看 ${item.name}`"
          :aria-label="`在 GitHub 上查看 ${item.name}`"
          @click="openAppPage(item)"
        >
          <Github :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>
