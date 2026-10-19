<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import {
  targetSecretSlot,
  type PluginAuthMode,
  type PluginField,
  type PluginTarget,
  type PluginTargetResult
} from '@shared/plugins'

const props = withDefaults(
  defineProps<{
    field: PluginField
    targets: PluginTarget[]
    /** 密钥掩码(形如 ab****23,'' = 未配置):key 为目标 id */
    secrets: Record<string, string>
    /** 每个目标单独可执行的动作(如「测试连接」) */
    targetActions: { id: string; label: string }[]
    /** 每个目标的最近一次操作结果:卡片边框的颜色由它决定 */
    targetResults?: Record<string, PluginTargetResult>
    /** 正在执行动作的目标 id */
    busyTarget: string | null
  }>(),
  { targetResults: () => ({}) }
)

const emit = defineEmits<{
  (e: 'change', targets: PluginTarget[]): void
  (e: 'save-secret', targetId: string, value: string): void
  (e: 'clear-secret', targetId: string): void
  (e: 'run-action', targetId: string, actionId: string): void
}>()

/** 已配置密钥时默认把输入框收起来,点「更换」才展开 */
const replacing = ref<Record<string, boolean>>({})

function update(index: number, patch: Partial<PluginTarget>): void {
  const next = props.targets.map((t, i) => (i === index ? { ...t, ...patch } : t))
  emit('change', next)
}

function add(): void {
  const id = `t${Date.now().toString(36)}`
  emit('change', [
    ...props.targets,
    { id, url: '', localBranch: '', remoteBranch: '', auth: 'token', username: '' }
  ])
}

function remove(index: number): void {
  emit('change', props.targets.filter((_, i) => i !== index))
}

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

/** 密钥这一行随认证方式变名字与提示 */
function secretLabel(target: PluginTarget): string {
  return target.auth === 'password' ? '密码' : '访问令牌'
}

function secretPlaceholder(target: PluginTarget): string {
  return target.auth === 'password'
    ? '必填（账号对应的密码）'
    : '必填（私有仓库需要访问令牌）'
}

/**
 * 这一行远端还缺哪些必填输入。
 *
 * 判定与主进程推送前的校验保持一致:地址与本地分支必填;HTTP(S) 地址在
 * token / password 认证下还需要密钥(password 另需账号);SSH 与本地路径不需要凭据。
 */
function missingFields(target: PluginTarget): string[] {
  const missing: string[] = []
  if (!target.url.trim()) missing.push('远程仓库')
  if (!target.localBranch.trim()) missing.push('本地分支')
  if (target.auth === 'ssh' || !/^https?:/i.test(target.url.trim())) return missing
  if (target.auth === 'password' && !target.username.trim()) missing.push('账号')
  if (!props.secrets[targetSecretSlot(target)]) {
    missing.push(target.auth === 'password' ? '密码' : '访问令牌')
  }
  return missing
}

/**
 * 整行一个字都没填。
 *
 * 运行时(同步/测试)会直接跳过这种行,所以校验也不拿它报错 ——
 * 否则刚点「添加远端」就会立刻跳出一条红字。
 */
function isBlank(target: PluginTarget): boolean {
  return (
    !target.url.trim() &&
    !target.localBranch.trim() &&
    !target.remoteBranch.trim() &&
    !target.username.trim() &&
    !props.secrets[targetSecretSlot(target)]
  )
}

/** 统一列出缺什么:行号与界面上的行序一致,不再用卡片边框表达 */
const problems = computed(() =>
  props.targets.flatMap((target, i) => {
    if (isBlank(target)) return []
    const missing = missingFields(target)
    return missing.length > 0 ? [`第 ${i + 1} 个远端：未填${missing.join('、')}`] : []
  })
)

/** 卡片边框的含义(悬停时说明,免得把绿/红误读成「填得对不对」) */
function resultTitle(target: PluginTarget): string {
  const result = props.targetResults[target.id]
  if (result === 'ok') return '上次操作成功'
  if (result === 'error') return '上次操作失败'
  return '还没有对它执行过操作'
}

const text = (e: Event): string => (e.target as HTMLInputElement | HTMLSelectElement).value
</script>

<template>
  <div class="plugin-targets">
    <!-- 输入校验只在这一处说:逐行列出还缺哪些必填项 -->
    <div v-if="problems.length > 0" class="plugin-target-problems">
      <div class="plugin-target-problems-title">存在 {{ problems.length }} 个远端配置未完成/错误：</div>
      <ul>
        <li v-for="(problem, i) in problems" :key="i">{{ problem }}</li>
      </ul>
    </div>

    <div
      v-for="(target, i) in targets"
      :key="target.id"
      class="plugin-target"
      :class="{
        'plugin-target-ok': targetResults[target.id] === 'ok',
        'plugin-target-bad': targetResults[target.id] === 'error'
      }"
      :title="resultTitle(target)"
    >
      <div class="plugin-target-row">
        <label class="plugin-target-cell plugin-target-cell-wide">
          <span>远程仓库</span>
          <input
            class="plugin-input"
            type="text"
            placeholder="必填（如 https://gitlab.com/用户名/仓库.git）"
            :value="target.url"
            @change="update(i, { url: text($event) })"
          />
        </label>
      </div>

      <div class="plugin-target-row">
        <label class="plugin-target-cell">
          <span>本地分支</span>
          <input
            class="plugin-input"
            type="text"
            placeholder="必填（如 main）"
            :value="target.localBranch"
            @change="update(i, { localBranch: text($event) })"
          />
        </label>
        <label class="plugin-target-cell">
          <span>远程分支</span>
          <input
            class="plugin-input"
            type="text"
            placeholder="选填（默认与本地分支同名）"
            :value="target.remoteBranch"
            @change="update(i, { remoteBranch: text($event) })"
          />
        </label>
      </div>

      <div class="plugin-target-row">
        <label class="plugin-target-cell">
          <span>认证方式</span>
          <select
            class="plugin-input plugin-target-auth"
            :value="target.auth || 'token'"
            @change="update(i, { auth: text($event) as PluginAuthMode })"
          >
            <option value="token">访问令牌</option>
            <option value="password">账号密码</option>
            <option value="ssh">SSH</option>
          </select>
        </label>
      </div>

      <!-- 账号:只有「账号密码」认证才需要 -->
      <div v-if="target.auth === 'password'" class="plugin-target-row">
        <label class="plugin-target-cell plugin-target-cell-wide">
          <span>账号</span>
          <input
            class="plugin-input"
            type="text"
            placeholder="必填（如 gitee 用户名）"
            :value="target.username"
            @change="update(i, { username: text($event) })"
          />
        </label>
      </div>

      <!-- 密钥:token / password 需要;ssh 用本机密钥,不显示这一行 -->
      <div v-if="target.auth !== 'ssh'" class="plugin-target-row">
        <label class="plugin-target-cell plugin-target-cell-wide">
          <span>{{ secretLabel(target) }}</span>
          <template v-if="secrets[targetSecretSlot(target)] && !replacing[target.id]">
            <b class="plugin-secret-mask plugin-secret-on">{{ secrets[targetSecretSlot(target)] }}</b>
            <button class="plugin-btn" @click="replacing[target.id] = true">更换</button>
            <button class="plugin-btn" @click="clearSecret(targetSecretSlot(target))">清除</button>
          </template>
          <template v-else>
            <input
              class="plugin-input plugin-target-secret"
              type="password"
              :placeholder="secretPlaceholder(target)"
              @change="onSecretInput(targetSecretSlot(target), $event)"
            />
            <button v-if="secrets[targetSecretSlot(target)]" class="plugin-btn" @click="replacing[target.id] = false">
              取消
            </button>
          </template>
        </label>
      </div>
      <p v-else class="plugin-target-hint">SSH 认证：使用本机 SSH 密钥，无需填写密钥。</p>

      <!-- 每个远端自己的动作(测试连接…)与删除 -->
      <div class="plugin-target-actions">
        <button
          v-for="a in targetActions"
          :key="a.id"
          class="plugin-btn"
          :disabled="busyTarget === target.id"
          @click="emit('run-action', target.id, a.id)"
        >
          {{ busyTarget === target.id ? '执行中…' : a.label }}
        </button>
        <button class="plugin-btn plugin-btn-danger" title="从列表里移除该远端" @click="remove(i)">
          删除远端
        </button>
      </div>
    </div>

    <button class="plugin-btn plugin-btn-add" @click="add()">
      <Plus :size="14" />
      添加远端
    </button>
  </div>
</template>
