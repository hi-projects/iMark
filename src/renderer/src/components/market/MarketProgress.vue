<script setup lang="ts">
/** 安装进度条(主进程按阶段播报;done 与 error 由 service 过滤掉,不在这里显示) */
import { computed } from 'vue'
import { marketStore } from '../../services/marketService'

const progress = computed(() => marketStore.progress)
</script>

<template>
  <div v-if="progress" class="market-progress">
    <div class="market-progress-line">
      <span>{{ progress.message }}</span>
      <span class="market-dim">{{ progress.percent }}%</span>
    </div>
    <div class="market-progress-track">
      <div class="market-progress-bar" :style="{ width: `${progress.percent}%` }" />
    </div>
    <pre v-if="progress.detail" class="market-progress-detail">{{ progress.detail }}</pre>
  </div>
</template>
