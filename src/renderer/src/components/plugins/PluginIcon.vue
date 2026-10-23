<script setup lang="ts">
import { computed, watch } from 'vue'
import { ensureExtensionIcon, extensionIconOf } from '../../services/extensionIcons'

/**
 * 扩展图标。清单没声明 `icon` 时由调用方直接不渲染本组件 —— 这里不负责
 * 拼默认图形;图标加载失败就留一块同尺寸占位,避免列表在读取完成时跳动。
 */
const props = withDefaults(defineProps<{ id: string; size?: number }>(), { size: 18 })

watch(
  () => props.id,
  id => ensureExtensionIcon(id),
  { immediate: true }
)

const url = computed(() => extensionIconOf(props.id))
</script>

<template>
  <img
    v-if="url"
    class="plugin-icon"
    :src="url"
    :width="size"
    :height="size"
    alt=""
    draggable="false"
  />
  <span
    v-else
    class="plugin-icon plugin-icon-empty"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  />
</template>
