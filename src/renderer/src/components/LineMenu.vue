<script setup lang="ts">
/**
 * 行首「+」按钮点开的那张小菜单。
 *
 * 条目全部来自扩展贡献点(descriptor.lineMenu),这里一条也不写死 ——
 * 以后「+」里能加什么,取决于装了哪些扩展。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  closeLineMenu,
  lineMenuEntries,
  lineMenuKey,
  lineMenuStore,
  runLineMenuItem
} from '../services/lineMenu'

const menuEl = ref<HTMLElement | null>(null)

const entries = computed(() => (lineMenuStore.open ? lineMenuEntries() : []))

/** 菜单量出尺寸后按窗口边界夹一次(按钮贴着窗口底边时会把菜单顶出去) */
async function place(): Promise<void> {
  const el = menuEl.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  lineMenuStore.x = Math.max(4, Math.min(lineMenuStore.x, window.innerWidth - width - 4))
  lineMenuStore.y = Math.max(4, Math.min(lineMenuStore.y, window.innerHeight - height - 4))
}

// nextTick 在浏览器绘制之前跑完,夹取不会让人看见菜单先出现在屏幕外再跳回来
watch(
  () => lineMenuStore.open,
  open => {
    if (open) void nextTick().then(place)
  }
)

function onWindowKeydown(e: KeyboardEvent): void {
  if (lineMenuStore.open && e.key === 'Escape') closeLineMenu()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <div
    v-if="lineMenuStore.open"
    class="line-menu-mask"
    @mousedown="closeLineMenu()"
    @contextmenu.prevent="closeLineMenu()"
  >
    <div
      ref="menuEl"
      class="line-menu"
      role="menu"
      :style="{ left: `${lineMenuStore.x}px`, top: `${lineMenuStore.y}px` }"
      @mousedown.stop
    >
      <button
        v-for="entry in entries"
        :key="lineMenuKey(entry)"
        class="line-menu-item"
        role="menuitem"
        @click="runLineMenuItem(entry)"
      >
        {{ entry.item.label }}
      </button>
      <div v-if="entries.length === 0" class="line-menu-empty">没有可插入的内容</div>
    </div>
  </div>
</template>
