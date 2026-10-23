<script setup lang="ts">
import { computed, ref } from 'vue'
import { PlugZap, Plus, Trash2 } from 'lucide-vue-next'
import type { PluginEndpoint, PluginField, PluginTargetResult } from '@shared/plugins'
import HelpTip from '../HelpTip.vue'

const props = withDefaults(
  defineProps<{
    field: PluginField
    /** 地址列表(按尝试顺序) */
    endpoints: PluginEndpoint[]
    /** 每个地址自己的密钥掩码(endpoint id → 掩码,'' = 未配置) */
    secrets: Record<string, string>
    /** 每个地址单独可执行的动作(如「测试连接」) */
    targetActions: { id: string; label: string }[]
    /** 每个地址的最近一次操作结果:卡片边框的颜色由它决定 */
    targetResults?: Record<string, PluginTargetResult>
  }>(),
  { secrets: () => ({}), targetResults: () => ({}) }
)

const emit = defineEmits<{
  (e: 'change', endpoints: PluginEndpoint[]): void
  (e: 'save-secret', targetId: string, value: string): void
  (e: 'clear-secret', targetId: string): void
  (e: 'run-action', targetId: string, actionId: string): void
}>()

/** 已配置密钥时默认把输入框收起来,点「更换」才展开 */
const replacing = ref<Record<string, boolean>>({})

function update(index: number, patch: Partial<PluginEndpoint>): void {
  emit(
    'change',
    props.endpoints.map((endpoint, i) => (i === index ? { ...endpoint, ...patch } : endpoint))
  )
}

function newId(): string {
  const used = new Set(props.endpoints.map(endpoint => endpoint.id))
  let id = `e${Date.now().toString(36)}`
  while (used.has(id)) id += 'x'
  return id
}

function add(): void {
  // 新地址不继承上一个地址的模型:换服务时模型名通常也要换,替用户猜一个反而危险
  emit('change', [...props.endpoints, { id: newId(), url: '', model: '' }])
}

function remove(index: number): void {
  emit('change', props.endpoints.filter((_, i) => i !== index))
}

const secretOf = (endpoint: PluginEndpoint): string => props.secrets[endpoint.id] ?? ''

const secretPlaceholder = computed(() => props.field.targetSecret?.placeholder ?? '必填')
const modelPlaceholder = computed(() => props.field.endpointModel?.placeholder ?? '必填')

function onSecretInput(targetId: string, e: Event): void {
  const input = e.target as HTMLInputElement
  const value = input.value.trim()
  if (!value) return
  emit('save-secret', targetId, value)
  input.value = ''
  replacing.value[targetId] = false
}

function clearSecret(targetId: string): void {
  replacing.value[targetId] = false
  emit('clear-secret', targetId)
}

/** Azure 的部署名在地址路径里，模型可以留空；判定与主进程的 detectProvider 对齐 */
function isAzureEndpoint(url: string): boolean {
  const text = url.trim()
  return (
    /(^https?:\/\/)?[^/]*\.(openai|openai\.azure|cognitiveservices\.azure)\.com\//i.test(text) ||
    /\/deployments\//i.test(text)
  )
}

/**
 * 本机/内网服务(Ollama 等)通常不校验密钥，允许留空；
 * 公网地址不填密钥几乎必然 401，要列进未完成提示里。
 */
function allowsEmptySecret(url: string): boolean {
  let host = ''
  try {
    host = new URL(url.trim()).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  // IPv6 回环、ULA(fc00::/7)与链路本地(fe80::/10);hostname 带方括号
  if (host === '[::1]' || host === '::1') return true
  return /^\[?(fc|fd)[0-9a-f]{2}:/i.test(host) || /^\[?fe[89ab][0-9a-f]:/i.test(host)
}

/** 这一行还缺哪些必填输入:地址、模型,以及公网地址的 API 密钥 */
const problems = computed(() =>
  props.endpoints.flatMap((endpoint, i) => {
    const missing: string[] = []
    const url = endpoint.url.trim()
    if (!url) missing.push('服务地址')
    if (!(endpoint.model ?? '').trim() && !isAzureEndpoint(url)) missing.push('服务模型')
    if (url && !secretOf(endpoint) && !allowsEmptySecret(url)) missing.push('API 密钥')
    return missing.length > 0 ? [`第 ${i + 1} 个地址：未填${missing.join('、')}`] : []
  })
)

const text = (e: Event): string => (e.target as HTMLInputElement).value
</script>

<template>
  <div class="plugin-targets plugin-endpoints">
    <!-- 输入校验只在这一处说:逐行列出还缺哪些必填项 -->
    <div v-if="problems.length > 0" class="plugin-target-problems">
      <div class="plugin-target-problems-title">
        存在 {{ problems.length }} 个地址配置未完成/错误：
      </div>
      <ul>
        <li v-for="(problem, i) in problems" :key="i">{{ problem }}</li>
      </ul>
    </div>

    <div
      v-for="(endpoint, i) in endpoints"
      :key="endpoint.id"
      class="plugin-target plugin-endpoint"
      :class="{
        'plugin-target-ok': targetResults[endpoint.id] === 'ok',
        'plugin-target-bad': targetResults[endpoint.id] === 'error'
      }"
    >
      <div class="plugin-target-row">
        <label class="plugin-target-cell plugin-target-cell-wide plugin-endpoint-cell">
          <span class="plugin-endpoint-label">
            {{ field.label }}
            <!-- 说明挂在「服务地址」字样的右上角,不占输入框的宽度 -->
            <HelpTip
              v-if="i === 0 && field.description"
              :text="field.description"
              class="plugin-endpoint-help"
            />
          </span>
          <input
            class="plugin-input plugin-endpoint-url"
            type="text"
            :aria-label="field.label"
            :placeholder="field.placeholder ?? '必填'"
            :value="endpoint.url"
            @change="update(i, { url: text($event) })"
          />
        </label>
      </div>

      <div class="plugin-target-row">
        <label class="plugin-target-cell plugin-target-cell-wide plugin-endpoint-cell">
          <span class="plugin-endpoint-label">{{ field.endpointModel?.label ?? '服务模型' }}</span>
          <input
            class="plugin-input"
            type="text"
            :aria-label="field.endpointModel?.label ?? '服务模型'"
            :placeholder="modelPlaceholder"
            :value="endpoint.model ?? ''"
            @change="update(i, { model: text($event) })"
          />
        </label>
      </div>

      <!-- 这一行不能用 <label> 当容器:label 会把非交互区域(掩码、按钮之间的空白)
           的点击转给第一个 labelable 子控件 —— 也就是「更换」按钮,鼠标没对准也会触发。 -->
      <div class="plugin-target-row">
        <div class="plugin-target-cell plugin-target-cell-wide plugin-endpoint-cell">
          <span class="plugin-endpoint-label">{{ field.targetSecret?.label ?? 'API 密钥' }}</span>
          <template v-if="secretOf(endpoint) && !replacing[endpoint.id]">
            <b class="plugin-secret-mask plugin-secret-on">{{ secretOf(endpoint) }}</b>
            <button class="plugin-btn" @click="replacing[endpoint.id] = true">更换</button>
            <button class="plugin-btn" @click="clearSecret(endpoint.id)">清除</button>
          </template>
          <template v-else>
            <input
              class="plugin-input plugin-target-secret"
              type="password"
              :aria-label="field.targetSecret?.label ?? 'API 密钥'"
              :placeholder="secretPlaceholder"
              @change="onSecretInput(endpoint.id, $event)"
            />
            <button
              v-if="secretOf(endpoint)"
              class="plugin-btn"
              @click="replacing[endpoint.id] = false"
            >
              取消
            </button>
          </template>
        </div>
      </div>

      <div class="plugin-target-actions">
        <button
          v-for="a in targetActions"
          :key="a.id"
          class="plugin-icon-btn plugin-icon-btn-accent"
          :title="a.label"
          :aria-label="a.label"
          @click="emit('run-action', endpoint.id, a.id)"
        >
          <PlugZap :size="14" />
        </button>
        <button
          class="plugin-icon-btn"
          title="从列表里移除该地址"
          aria-label="删除地址"
          @click="remove(i)"
        >
          <Trash2 :size="14" />
        </button>
      </div>
    </div>

    <button class="plugin-btn plugin-btn-add" @click="add()">
      <Plus :size="14" />
      添加地址
    </button>
  </div>
</template>
