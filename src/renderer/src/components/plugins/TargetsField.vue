<script setup lang="ts">
import { ref } from 'vue'
import { Plus } from 'lucide-vue-next'
import { targetSecretSlot, type PluginAuthMode, type PluginField, type PluginTarget } from '@shared/plugins'

const props = defineProps<{
  field: PluginField
  targets: PluginTarget[]
  /** 密钥掩码(形如 ab****23,'' = 未配置):key 为目标 id */
  secrets: Record<string, string>
  /** 每个目标单独可执行的动作(如「测试连接」) */
  targetActions: { id: string; label: string }[]
  /** 正在执行动作的目标 id */
  busyTarget: string | null
}>()

const emit = defineEmits<{
  (e: 'change', targets: PluginTarget[]): void
  (e: 'save-secret', targetId: string, value: string): void
  (e: 'clear-secret', targetId: string): void
  (e: 'run-action', targetId: string, actionId: string): void
}>()

/** 已配置密钥时默认把输入框收起来,点「更换」才展开 */
const replacing = ref<Record<string, boolean>>({})

/** 这一行是否被碰过:在任意输入框里失焦后开始判定(即使又清空,也按必填规则显示红框) */
const touched = ref<Record<string, boolean>>({})

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
 * 这一行远端的填写状态:
 * blank = 还什么都没填(保持默认外观) / ok = 可以推送 / incomplete = 缺东西(红框)
 * 判定与主进程的推送前校验保持一致:file:// 等本地地址不需要凭据,SSH 也不需要。
 */
type TargetState = 'blank' | 'ok' | 'incomplete'

function targetState(target: PluginTarget): TargetState {
  const hasUrl = Boolean(target.url.trim())
  const hasLocal = Boolean(target.localBranch.trim())
  const hasSecret = Boolean(props.secrets[targetSecretSlot(target)])
  // 全新、且没被碰过的一行保持默认外观;一旦点开填写过,就按必填规则判定
  if (!touched.value[target.id] && !hasUrl && !hasLocal && !hasSecret && !target.username.trim()) {
    return 'blank'
  }

  if (!hasUrl || !hasLocal) return 'incomplete'
  if (target.auth === 'ssh' || !/^https?:/i.test(target.url.trim())) return 'ok'
  if (!hasSecret) return 'incomplete'
  if (target.auth === 'password' && !target.username.trim()) return 'incomplete'
  return 'ok'
}

/** 缺什么,给悬停提示用 */
function missingHint(target: PluginTarget): string {
  const state = targetState(target)
  if (state === 'ok') return '已配置,可以推送'
  if (state === 'blank') return '还没填写'
  if (!target.url.trim()) return '还没填远程仓库地址'
  if (!target.localBranch.trim()) return '还没填本地分支'
  if (target.auth === 'password' && !target.username.trim()) return '还没填账号'
  return `还没填${target.auth === 'password' ? '密码' : '访问令牌'}`
}

const text = (e: Event): string => (e.target as HTMLInputElement | HTMLSelectElement).value
</script>

<template>
  <div class="plugin-targets">
    <div
      v-for="(target, i) in targets"
      :key="target.id"
      class="plugin-target"
      :class="{
        'plugin-target-ok': targetState(target) === 'ok',
        'plugin-target-bad': targetState(target) === 'incomplete'
      }"
      @focusout="touched[target.id] = true"
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
        <!-- 是否已配置好:绿点=可以推送;灰点=还没填齐 -->
        <span
          class="plugin-status-dot"
          :class="targetState(target) === 'ok' ? 'plugin-status-ok' : 'plugin-status-idle'"
          :title="missingHint(target)"
        />
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
      <p v-else class="plugin-target-hint">SSH 认证:使用本机 SSH 密钥,无需填写密钥。</p>

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
