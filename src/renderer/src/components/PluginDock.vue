<script setup lang="ts">
/**
 * 插件停靠在主界面上的那一列/那一行。
 *
 * 里面有两种东西,长得一样但来源完全不同:
 *
 *   - **停靠面板**(沙箱插件):这里只是一个**空槽位** —— 插件自己的页面
 *     (WebContentsView)会被主进程摆在这个矩形上。槽位里必须保持空的:
 *     原生视图会把它整个盖住,画什么都会被挡掉。
 *   - **注入界面**(脚本插件):宿主把插件给的 HTML 直接挂在这里(那段 HTML
 *     跑不了脚本,交互经 `data-imk-click` 回到插件代码里)。
 *
 * 两者的共同点是**顶栏由宿主来画**:插件名、收起按钮都在宿主手里 ——
 * 一块能盖住主界面的东西,必须能一眼看出是谁的、也必须有宿主提供的关闭方式。
 */
import { computed, nextTick, onMounted, watch } from 'vue'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { dockPanels, pluginHostState, reportDockRects, toggleCollapsed } from '../services/pluginHostOps'

const props = defineProps<{ side: 'left' | 'right' | 'bottom' }>()

const panels = computed(() => dockPanels(props.side))
const injected = computed(() => pluginHostState.mounts.filter(m => m.side === props.side))
const vertical = computed(() => props.side !== 'bottom')

/** 面板宽度(左/右栏按插件声明的宽度;底栏撑满) */
function panelStyle(id: string): Record<string, string> {
  const panel = panels.value.find(p => p.pluginId === id)
  if (!panel) return {}
  if (props.side === 'bottom') return { height: panel.collapsed ? 'auto' : `${panel.height}px` }
  return { width: `${panel.width}px` }
}

/** 槽位挪了位置就重新报一次 —— 停靠面板的原生视图靠它跟着走 */
function sync(): void {
  void nextTick(() => reportDockRects())
}

onMounted(sync)
watch([panels, injected], sync, { deep: true })
</script>

<template>
  <!-- 两侧什么都没有时整块不占位(否则会多出一条 0 宽的空栏) -->
  <div v-if="panels.length || injected.length" class="plugin-dock" :class="`plugin-dock-${side}`">
    <!-- ① 沙箱插件:空槽位 + 宿主画的顶栏 -->
    <section
      v-for="panel in panels"
      :key="panel.pluginId"
      class="plugin-panel"
      :class="{ 'plugin-panel-vertical': vertical }"
      :style="panelStyle(panel.pluginId)"
    >
      <header class="plugin-panel-head">
        <button
          class="plugin-panel-toggle"
          :title="panel.collapsed ? '展开' : '收起'"
          @click="toggleCollapsed(panel.pluginId)"
        >
          <ChevronRight v-if="panel.collapsed" :size="13" />
          <ChevronDown v-else :size="13" />
        </button>
        <span class="plugin-panel-title" :title="panel.name">{{ panel.name }}</span>
        <!-- 形态标签:用户得一眼看出这块界面是谁的、以及它属于哪一类插件 -->
        <span class="plugin-panel-kind">沙箱插件</span>
        <!-- 收起而不是关闭:停靠面板就是插件的运行时,关掉等于把插件停了。
             真要停它,去设置 → 插件里关 —— 那里才有"这个插件在干什么"的上下文 -->
      </header>
      <!-- 槽位:原生视图盖在这儿。里面**必须**是空的 -->
      <div v-show="!panel.collapsed" class="plugin-panel-slot" :data-dock-slot="panel.pluginId" />
    </section>

    <!-- ② 脚本插件:宿主把它的 HTML 挂在这儿(顶栏同样由宿主画) -->
    <section
      v-for="mount in injected"
      :key="`${mount.pluginId}:${mount.id}`"
      class="plugin-panel"
      :class="{ 'plugin-panel-vertical': vertical }"
    >
      <header class="plugin-panel-head">
        <span class="plugin-panel-title">{{ mount.title || mount.id }}</span>
        <span class="plugin-panel-kind plugin-panel-kind-script">脚本插件</span>
      </header>
      <!--
        v-html 挂的是**宿主校验过的 HTML**(见 main/plugins/ops.ts 的 sanitizeHtml):
        脚本/框架/外链都被去掉,而主窗口的 CSP 让内联脚本与 onclick 也跑不起来。
        交互只能经 data-imk-click 回到插件自己的代码里。
      -->
      <div
        class="plugin-panel-body"
        :data-imk-plugin="mount.pluginId"
        :data-imk-mount="mount.id"
        v-html="mount.html"
      />
    </section>
  </div>
</template>
