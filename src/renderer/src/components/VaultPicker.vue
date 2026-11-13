<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import {
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  Settings2,
  X
} from 'lucide-vue-next'
import type { PluginAuthMode } from '@shared/plugins'
import { appStore } from '../stores/app'
import { joinPath } from '../utils/paths'
import { basename } from '../utils/text'
import {
  cloneVaultAndOpen,
  createVaultAt,
  forgetVault,
  loadVaultGitRemotes,
  openVaultFromPicker,
  openVaultViaDialog,
  pruneMissingVaults,
  saveVaultGitRemote,
  setSkipVaultPicker,
  validName
} from '../services/vaultService'
import { notifyError, pushNotice } from '../services/notice'
import { api } from '../services/api'
import type { VaultGitRemote } from '@shared/types'
import iconSvg from '../../../../build/icon.svg?raw'

type Panel = 'actions' | 'clone' | 'create' | 'git'

const panel = ref<Panel>('actions')

// 直接绑定 store,便于启动时已由 settings 初始化
const skipPicker = computed({
  get: () => appStore.skipVaultPicker,
  set: v => {
    appStore.skipVaultPicker = v
  }
})

const recentVaults = computed(() => appStore.vaults)

/** 每个项目的 Git 远端(键 = 仓库绝对路径);没有配置的项为 null */
const gitRemotes = ref<Record<string, VaultGitRemote | null>>({})

async function refreshGitRemotes(): Promise<void> {
  const paths = [...recentVaults.value]
  if (paths.length === 0) {
    gitRemotes.value = {}
    return
  }
  try {
    gitRemotes.value = await loadVaultGitRemotes(paths)
  } catch (err) {
    // 读不到远端不耽误选仓库:列表照常显示,只是少一个标记
    console.error('[iMark] 读取项目 Git 远端失败', err)
    gitRemotes.value = {}
  }
}

watch(recentVaults, () => void refreshGitRemotes(), { deep: true })

// 选择页每次出现都清理一遍:文件夹可能在上次使用之后被删掉或移走了
onMounted(async () => {
  await pruneMissingVaults()
  await refreshGitRemotes()
})

function remoteOf(path: string): VaultGitRemote | null {
  return gitRemotes.value[path] ?? null
}

async function openVault(path: string): Promise<void> {
  await openVaultFromPicker(path)
}

// ---------- 从 Git 克隆 ----------

const clone = reactive({
  url: '',
  parentDir: '' as string | null,
  name: '',
  branch: '',
  auth: 'token' as PluginAuthMode,
  username: '',
  secret: ''
})
/** 用户手动改过文件夹名后,不再跟着地址自动变 */
const nameEdited = ref(false)
const cloning = ref(false)
const cloneError = ref('')
const cloneUrlInput = ref<HTMLInputElement | null>(null)

/** 文件夹名和克隆位置都填了以后,实际会创建出来的仓库路径 */
const cloneTargetPath = computed(() => {
  const name = clone.name.trim()
  return clone.parentDir && name ? joinPath(clone.parentDir, name) : ''
})

/** `https://host/组/笔记.git` → `笔记`(scp 风格的 `git@host:组/笔记.git` 也认) */
function folderNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/:]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return last.replace(/\.git$/i, '')
}

watch(
  () => clone.url,
  url => {
    if (!nameEdited.value) clone.name = folderNameFromUrl(url)
  }
)

function startClone(): void {
  panel.value = 'clone'
  cloneError.value = ''
  void nextTick(() => cloneUrlInput.value?.focus())
}

async function pickCloneParent(): Promise<void> {
  const dir = await api.selectVaultDialog()
  if (dir) clone.parentDir = dir
}

async function confirmClone(): Promise<void> {
  if (cloning.value) return
  cloneError.value = ''
  const url = clone.url.trim()
  if (!url) {
    cloneError.value = '请填写仓库地址'
    return
  }
  const name = clone.name.trim() || folderNameFromUrl(url)
  if (!name) {
    cloneError.value = '请填写文件夹名'
    return
  }
  if (!validName(name)) {
    cloneError.value = '文件夹名不合法(不能包含 \\ / : * ? " < > | 等字符)'
    return
  }
  let parent = clone.parentDir
  if (!parent) {
    parent = await api.selectVaultDialog()
    if (!parent) return
    clone.parentDir = parent
  }
  cloning.value = true
  try {
    const ok = await cloneVaultAndOpen({
      url,
      parentDir: parent,
      name,
      branch: clone.branch.trim(),
      auth: clone.auth,
      username: clone.username.trim(),
      secret: clone.auth === 'ssh' ? '' : clone.secret,
      localBranch: clone.branch.trim() || 'main',
      remoteBranch: ''
    })
    if (!ok) cloneError.value = '克隆成功,但打开仓库失败'
  } catch (err) {
    cloneError.value = err instanceof Error ? err.message : String(err)
    notifyError('克隆仓库', err)
  } finally {
    cloning.value = false
  }
}

function cancelClone(): void {
  panel.value = 'actions'
  cloneError.value = ''
}

// ---------- 创建新仓库 ----------

const newName = ref('')
const parentDir = ref<string | null>(null)
const createNameInput = ref<HTMLInputElement | null>(null)

async function startCreate(): Promise<void> {
  panel.value = 'create'
  parentDir.value = null
  newName.value = ''
  await nextTick()
  createNameInput.value?.focus()
}

async function pickParentDir(): Promise<void> {
  const dir = await api.selectVaultDialog()
  if (dir) parentDir.value = dir
}

async function confirmCreate(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  let parent = parentDir.value
  if (!parent) {
    parent = await api.selectVaultDialog()
    if (!parent) return
    parentDir.value = parent
  }
  await createVaultAt(parent, name)
}

function cancelCreate(): void {
  newName.value = ''
  parentDir.value = null
  panel.value = 'actions'
}

// ---------- 项目 Git 设置 ----------

const gitPath = ref<string | null>(null)
const gitForm = reactive({
  url: '',
  auth: 'token' as PluginAuthMode,
  username: '',
  localBranch: 'main',
  remoteBranch: '',
  secret: ''
})
const gitHasSecret = ref(false)
const savingGit = ref(false)
const gitError = ref('')

function openGitEditor(path: string): void {
  const remote = remoteOf(path)
  gitPath.value = path
  gitForm.url = remote?.url ?? ''
  gitForm.auth = remote?.auth ?? 'token'
  gitForm.username = remote?.username ?? ''
  gitForm.localBranch = remote?.localBranch || 'main'
  gitForm.remoteBranch = remote?.remoteBranch ?? ''
  gitForm.secret = ''
  gitHasSecret.value = remote?.hasSecret ?? false
  gitError.value = ''
  panel.value = 'git'
}

async function saveGit(): Promise<void> {
  if (!gitPath.value || savingGit.value) return
  gitError.value = ''
  const url = gitForm.url.trim()
  if (!url) {
    gitError.value = '请填写仓库地址'
    return
  }
  if (!gitForm.localBranch.trim()) {
    gitError.value = '本地分支是必填项'
    return
  }
  savingGit.value = true
  try {
    await saveVaultGitRemote(gitPath.value, {
      url,
      auth: gitForm.auth,
      username: gitForm.username.trim(),
      localBranch: gitForm.localBranch.trim(),
      remoteBranch: gitForm.remoteBranch.trim(),
      // 输入框留空 = 保持原密钥;undefined 而不是空串,空串的语义是「清除」
      secret: gitForm.secret || undefined
    })
    await refreshGitRemotes()
    pushNotice('项目 Git 设置已保存', { title: 'Git 远端' })
    panel.value = 'actions'
  } catch (err) {
    gitError.value = err instanceof Error ? err.message : String(err)
    notifyError('保存 Git 设置', err)
  } finally {
    savingGit.value = false
  }
}

async function clearGit(): Promise<void> {
  if (!gitPath.value) return
  try {
    await saveVaultGitRemote(gitPath.value, null)
    await refreshGitRemotes()
    pushNotice('已移除该项目的 Git 远端配置(本地仓库与远端内容不受影响)', {
      title: 'Git 远端'
    })
    panel.value = 'actions'
  } catch (err) {
    gitError.value = err instanceof Error ? err.message : String(err)
    notifyError('移除 Git 设置', err)
  }
}

const gitProjectName = computed(() => (gitPath.value ? basename(gitPath.value) : ''))

async function onSkipChange(): Promise<void> {
  await setSkipVaultPicker(skipPicker.value)
}
</script>

<template>
  <div class="vault-picker">
    <!-- 左:最近仓库列表。与 Obsidian 一样,左边是项目,右边是动作 -->
    <aside class="vault-picker-sidebar">
      <div class="vault-picker-list">
        <button
          v-for="v in recentVaults"
          :key="v"
          class="vault-row"
          :title="v"
          :class="{ 'vault-row-active': gitPath === v && panel === 'git' }"
          @click="openVault(v)"
        >
          <FolderOpen :size="16" class="vault-row-icon" />
          <span class="vault-row-main">
            <span class="vault-row-name">{{ basename(v) }}</span>
            <span class="vault-row-path"><bdi>{{ remoteOf(v)?.url || v }}</bdi></span>
          </span>
          <span
            v-if="remoteOf(v)"
            class="vault-row-git"
            :class="{ 'vault-row-git-missing': !remoteOf(v)?.hasSecret && remoteOf(v)?.auth !== 'ssh' }"
            :title="`已配置 Git 远端：${remoteOf(v)?.url}`"
          >
            <GitBranch :size="13" />
          </span>
          <span
            class="vault-row-action"
            data-action="git-open"
            title="项目 Git 设置"
            @click.stop="openGitEditor(v)"
          >
            <Settings2 :size="14" />
          </span>
          <span class="vault-row-action" title="从列表移除" @click.stop="forgetVault(v)">
            <X :size="14" />
          </span>
        </button>

        <div v-if="recentVaults.length === 0" class="vault-picker-empty">
          还没有打开过仓库
        </div>
      </div>

      <div class="vault-picker-sidebar-foot">
        共 {{ recentVaults.length }} 个仓库
      </div>
    </aside>

    <!-- 右:标题与动作 / 当前表单 -->
    <main class="vault-picker-main">
      <div class="vault-picker-panel">
        <header class="vault-picker-hero">
          <span class="vault-picker-logo" v-html="iconSvg"></span>
          <h1 class="vault-picker-title">iMark</h1>
          <p v-if="panel === 'actions'" class="vault-picker-subtitle">
            选择一个仓库开始,或新建一个
          </p>
        </header>

        <!-- 动作列表(Obsidian 的左右结构里右侧那三行) -->
        <div v-if="panel === 'actions'" class="vault-picker-actions">
          <section class="vault-picker-action">
            <div class="vault-picker-action-text">
              <h2>从 Git 克隆仓库</h2>
              <p>拉取远端仓库到本地作为新项目,并自动为该仓库配置远程同步。</p>
            </div>
            <button class="vault-btn vault-btn-primary" data-action="start-clone" @click="startClone">
              <FolderGit2 :size="15" />
              克隆
            </button>
          </section>

          <section class="vault-picker-action">
            <div class="vault-picker-action-text">
              <h2>打开文件夹作为仓库</h2>
              <p>选择一个已有 Markdown 笔记的文件夹。</p>
            </div>
            <button class="vault-btn" @click="openVaultViaDialog()">
              <FolderOpen :size="15" />
              打开
            </button>
          </section>

          <section class="vault-picker-action">
            <div class="vault-picker-action-text">
              <h2>创建新仓库</h2>
              <p>在一个位置下新建空文件夹,并作为仓库打开。</p>
            </div>
            <button class="vault-btn" @click="startCreate">
              <FolderPlus :size="15" />
              创建
            </button>
          </section>
        </div>

        <!-- 克隆表单 -->
        <div v-else-if="panel === 'clone'" class="vault-picker-form">
          <label class="vault-field">
            <span>仓库地址</span>
            <input
              ref="cloneUrlInput"
              v-model="clone.url"
              class="vault-input"
              data-field="clone-url"
              placeholder="https://host/组/仓库.git 或 git@host:组/仓库.git"
              spellcheck="false"
              @keydown.esc.prevent="cancelClone"
            />
          </label>

          <div class="vault-field-row">
            <label class="vault-field">
              <span>分支</span>
              <input
                v-model="clone.branch"
                class="vault-input"
                data-field="clone-branch"
                placeholder="留空 = 远端默认分支"
                spellcheck="false"
              />
            </label>
          </div>

          <div class="vault-field-row">
            <label class="vault-field">
              <span>文件夹名</span>
              <input
                v-model="clone.name"
                class="vault-input"
                data-field="clone-name"
                placeholder="仓库名称"
                @input="nameEdited = true"
                @keydown.enter.prevent="confirmClone"
                @keydown.esc.prevent="cancelClone"
              />
            </label>
            <label class="vault-field">
              <span>克隆到</span>
              <button
                class="vault-input vault-input-button"
                data-field="clone-parent"
                @click="pickCloneParent"
              >
                {{ clone.parentDir ? basename(clone.parentDir) : '选择位置…' }}
              </button>
            </label>
          </div>

          <p v-if="cloneTargetPath" class="vault-picker-target-path" :title="cloneTargetPath">
            {{ cloneTargetPath }}
          </p>

          <div class="vault-field-row">
            <label class="vault-field">
              <span>认证方式</span>
              <select
                class="vault-input"
                data-field="clone-auth"
                :value="clone.auth"
                @change="clone.auth = ($event.target as HTMLSelectElement).value as PluginAuthMode"
              >
                <option value="token">访问令牌</option>
                <option value="password">账号密码</option>
                <option value="ssh">SSH(本机密钥)</option>
              </select>
            </label>
          </div>

          <template v-if="clone.auth !== 'ssh'">
            <div class="vault-field-row">
              <label v-if="clone.auth === 'password'" class="vault-field">
                <span>账号</span>
                <input
                  v-model="clone.username"
                  class="vault-input"
                  data-field="clone-username"
                  placeholder="用户名"
                />
              </label>
              <label class="vault-field">
                <span>{{ clone.auth === 'password' ? '密码' : '访问令牌' }}</span>
                <input
                  v-model="clone.secret"
                  class="vault-input"
                  data-field="clone-secret"
                  type="password"
                  :placeholder="clone.auth === 'password' ? '私有仓库需要' : '私有仓库需要;公开仓库可留空'"
                  @keydown.enter.prevent="confirmClone"
                />
              </label>
            </div>
            <p class="vault-picker-hint">
              令牌只用于本次克隆,并加密保存给「远程同步」使用;不会写进仓库。
            </p>
          </template>
          <p v-else class="vault-picker-hint">SSH 使用本机密钥,无需填写令牌。</p>

          <p v-if="cloneError" class="vault-picker-error">{{ cloneError }}</p>

          <div class="vault-picker-form-actions">
            <button
              class="vault-btn vault-btn-primary"
              data-action="clone-submit"
              :disabled="cloning"
              @click="confirmClone"
            >
              <Loader2 v-if="cloning" :size="15" class="vault-spin" />
              <FolderGit2 v-else :size="15" />
              {{ cloning ? '正在克隆…' : '克隆并打开' }}
            </button>
            <button class="vault-btn" :disabled="cloning" @click="cancelClone">取消</button>
          </div>
        </div>

        <!-- 新建仓库表单 -->
        <div v-else-if="panel === 'create'" class="vault-picker-form">
          <div class="vault-picker-form-head">
            <h2>创建新仓库</h2>
          </div>

          <div class="vault-field-row">
            <label class="vault-field">
              <span>仓库名称</span>
              <input
                ref="createNameInput"
                v-model="newName"
                class="vault-input"
                placeholder="仓库名称"
                @keydown.enter.prevent="confirmCreate"
                @keydown.esc.prevent="cancelCreate"
              />
            </label>
            <label class="vault-field">
              <span>位置</span>
              <button class="vault-input vault-input-button" @click="pickParentDir">
                {{ parentDir ? basename(parentDir) : '选择位置…' }}
              </button>
            </label>
          </div>
          <p class="vault-picker-hint">
            将在 <code>{{ parentDir ?? '所选位置' }}</code> 下创建同名文件夹
          </p>

          <div class="vault-picker-form-actions">
            <button class="vault-btn vault-btn-primary" @click="confirmCreate">
              <FolderPlus :size="15" />
              创建并打开
            </button>
            <button class="vault-btn" @click="cancelCreate">取消</button>
          </div>
        </div>

        <!-- 项目 Git 设置 -->
        <div v-else class="vault-picker-form">
          <div class="vault-picker-form-head">
            <h2>{{ gitProjectName }}</h2>
            <span class="vault-picker-git-path" :title="gitPath ?? ''">{{ gitPath }}</span>
          </div>

          <label class="vault-field">
            <span>仓库地址</span>
            <input
              v-model="gitForm.url"
              class="vault-input"
              data-field="git-url"
              placeholder="https://host/组/仓库.git 或 git@host:组/仓库.git"
              spellcheck="false"
            />
          </label>

          <div class="vault-field-row">
            <label class="vault-field">
              <span>本地分支</span>
              <input
                v-model="gitForm.localBranch"
                class="vault-input"
                data-field="git-branch"
                placeholder="main"
              />
            </label>
            <label class="vault-field">
              <span>远端分支</span>
              <input
                v-model="gitForm.remoteBranch"
                class="vault-input"
                placeholder="留空 = 同名"
              />
            </label>
          </div>

          <div class="vault-field-row">
            <label class="vault-field">
              <span>认证方式</span>
              <select
                class="vault-input"
                data-field="git-auth"
                :value="gitForm.auth"
                @change="gitForm.auth = ($event.target as HTMLSelectElement).value as PluginAuthMode"
              >
                <option value="token">访问令牌</option>
                <option value="password">账号密码</option>
                <option value="ssh">SSH(本机密钥)</option>
              </select>
            </label>
            <label v-if="gitForm.auth === 'password'" class="vault-field">
              <span>账号</span>
              <input
                v-model="gitForm.username"
                class="vault-input"
                data-field="git-username"
                placeholder="用户名"
              />
            </label>
          </div>

          <label v-if="gitForm.auth !== 'ssh'" class="vault-field">
            <span>{{ gitForm.auth === 'password' ? '密码' : '访问令牌' }}</span>
            <input
              v-model="gitForm.secret"
              class="vault-input"
              data-field="git-secret"
              type="password"
              :placeholder="
                gitHasSecret
                  ? '已保存,留空表示不修改'
                  : gitForm.auth === 'password'
                    ? '必填(私有仓库)'
                    : '私有仓库需要访问令牌'
              "
            />
          </label>

          <p v-if="gitError" class="vault-picker-error">{{ gitError }}</p>

          <div class="vault-picker-form-actions">
            <button
              class="vault-btn vault-btn-primary"
              data-action="git-save"
              :disabled="savingGit"
              @click="saveGit"
            >
              {{ savingGit ? '保存中…' : '保存' }}
            </button>
            <button class="vault-btn" data-action="git-clear" @click="clearGit">
              <X :size="14" />
              移除远端配置
            </button>
            <button class="vault-btn" @click="panel = 'actions'">返回</button>
          </div>
        </div>

        <label v-if="panel === 'actions'" class="vault-picker-skip">
          <input v-model="skipPicker" type="checkbox" @change="onSkipChange" />
          启动时直接打开上次使用的仓库
        </label>
      </div>
    </main>
  </div>
</template>
