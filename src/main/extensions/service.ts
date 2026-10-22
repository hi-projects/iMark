/**
 * ExtensionService：main 侧扩展系统的总装。
 *
 * 它是唯一同时知道「装了哪些扩展」「用户怎么分组」「哪个宿主在跑」「界面上
 * 应该出现什么」的地方。几件事刻意只在这里发生：
 *
 * - **安装记录 / 启用态 / 配置 / 密钥 / 状态 / 日志** 的读写；
 * - **HostPlanner**：`extensionHost.mode` / `affinity` 变化时只重启受影响的宿主；
 * - **激活事件**：`*`、`onStartupFinished`、`onCommand:`、`onLanguage:`、
 *   `onWebviewPanel:`，依赖先激活，同一扩展并发激活合并；
 * - **路由**：命令、webview 消息、编辑器 RPC、UI 请求都在这里按扩展归属校验；
 * - **崩溃策略**：按宿主组重启，1s/2s/4s 退避，60 秒三次后停止自动重启。
 *
 * 纪律：
 * - main 永远不 require 扩展入口；扩展代码只在 `extensionHostProcess.js` 里跑。
 * - 密钥明文只从 `secrets.ts` 读给宿主，绝不进入 renderer / webview。
 * - 文档真身在 renderer；这里只是镜像，编辑请求带版本号，不连续就拒绝。
 * - 宿主发来的每条消息都带扩展 ID，与宿主组的成员表不符就丢弃。
 */

import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { descriptorFromManifest, entryFileOf } from '@shared/extensionPackage'
import type {
  ExtensionCommandInvocation,
  ExtensionContextKeys,
  ExtensionContributionsSnapshot,
  ExtensionHostGroupView,
  ExtensionHostMode,
  ExtensionHostSettings,
  ExtensionHostSettingsPatch,
  ExtensionInstallInfo,
  ExtensionPreference,
  ExtensionRecord,
  ExtensionRuntimeInfo,
  ExtensionRuntimeStatus,
  ExtensionStatusSnapshot,
  ExtensionView
} from '@shared/extensions'
import type {
  DocumentStateDto,
  EditorRequestDto,
  ExtensionHostInitPayload,
  HostActivatedMessage,
  HostActivationReason,
  HostDeactivatedMessage,
  HostErrorDto,
  HostExtensionInit,
  HostToMainMessage,
  MainToRendererMessage,
  MainToHostMessage,
  RendererToMainMessage,
  StatusBarItemDto,
  ThemeDto,
  WorkspaceFolderDto
} from '@shared/extensionProtocol'
import {
  targetSecretSlot,
  type PluginEndpoint,
  type PluginField,
  type PluginStatus,
  type PluginTarget,
  type PluginTargetResult
} from '@shared/plugins'
import { deleteSecretsByPrefix, getSecret, secretHints, setSecret } from '../secrets'
import { getSettingsSync, loadSettings, onSettingsChanged, saveSettings } from '../settings'
import { buildContributions, type ExtensionEntry, type RuntimeCommandRegistration } from './contributions'
import { DocumentRegistry } from './documents'
import { ExtensionHostProcess, type HostProcessState, type HostRequest } from './hostProcess'
import {
  changedHostIds,
  planHosts,
  type HostPlan,
  type HostPlanGroup,
  type HostPlannerExtension
} from './hostPlanner'
import {
  cleanupOldDirs,
  getRecord,
  invalidateInstalledCache,
  removeExtensionDir,
  removeRecord,
  scanInstalled
} from './installedStore'
import {
  installExtensionPackage,
  type InstallExtensionOptions,
  type InstallExtensionOutcome
} from './installer'
import { extensionDir, extensionLogPath } from './paths'
import { ExtensionLogStore } from './logStore'
import { ExtensionStateStore } from './stateStore'
import { WebviewRegistry, type WebviewRecord } from './webviews'
import { WebviewStore, type PersistedWebviewPanel } from './webviewStore'
import { serveWebviewResource } from './webviewResources'

// ---------- 对外选项 ----------

export interface ExtensionServiceOptions {
  /** 留空用 app.getVersion()（验收里可覆盖） */
  appVersion?: string
  /** 设备级 ID；留空按 hostname + userData 派生 */
  machineId?: string
  /** 当前仓库根目录；不注入时读 settings.vaultPath */
  getWorkspaceRoot?: () => string | null
  /** 复用 renderer 的 Markdown 渲染（imark.renderMarkdown） */
  renderMarkdown?: (text: string) => Promise<string>
  /** main → renderer 的发送器；窗口就绪后也可以 setRendererSender() */
  postToRenderer?: (message: MainToRendererMessage) => void
  /** 应用已经占用的快捷键（小写），冲突的扩展快捷键会被标成 dropped */
  reservedKeys?: () => ReadonlySet<string>
  /** 命令执行等待上限；AI 生成这类命令可能跑几分钟 */
  commandTimeoutMs?: number
  /**
   * 贡献点变化时（防抖后）的回调。
   *
   * 原生菜单的快捷键必须挂在菜单项上才会生效，而菜单在主进程；这条回调让
   * 菜单与命令面板永远用同一份快照，不必再让渲染层把命令表回传给主进程。
   */
  onContributions?: (snapshot: ExtensionContributionsSnapshot) => void
}

type InstallRequest = Omit<InstallExtensionOptions, 'appVersion'> & { appVersion?: string }

interface HostRecord {
  hostId: number
  extensionIds: string[]
  process: ExtensionHostProcess | null
  state: HostProcessState
  pid: number | null
  lastError: string | null
  crashTimes: number[]
  restartTimer: NodeJS.Timeout | null
  starting: Promise<void> | null
}

interface ActivationWaiter {
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface DeactivationWaiter {
  resolve(): void
  timer: NodeJS.Timeout
}

interface PendingRendererRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface PendingUiRequest {
  resolve(value: string | string[] | null): void
  timer: NodeJS.Timeout
}

const PLUGIN_STATUSES: readonly PluginStatus[] = ['idle', 'running', 'ok', 'partial', 'error']
const MAX_STATUS_ITEMS_PER_EXTENSION = 5
const MAX_STATUS_ITEMS_TOTAL = 12
const MAX_STATUS_TEXT = 80
const MAX_OPEN_DOCUMENTS = 200

// ---------- 纯工具 ----------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorDto(err: unknown): HostErrorDto {
  if (err instanceof Error) return { message: err.message, stack: err.stack }
  return { message: String(err) }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function arrayDefault(field: PluginField): unknown[] {
  const value = field.default
  return Array.isArray(value) ? value.map(item => ({ ...(item as object) })) : []
}

function normalizeTarget(raw: unknown, index: number): PluginTarget {
  const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const auth = item.auth === 'password' || item.auth === 'ssh' ? item.auth : 'token'
  return {
    id: textOf(item.id) || `t${index + 1}`,
    url: textOf(item.url),
    localBranch: textOf(item.localBranch),
    remoteBranch: textOf(item.remoteBranch),
    auth,
    username: textOf(item.username)
  }
}

function normalizeEndpoint(raw: unknown, index: number): PluginEndpoint {
  const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: textOf(item.id) || `e${index + 1}`,
    url: textOf(item.url),
    model: textOf(item.model)
  }
}

function normalizeTargets(raw: unknown, field: PluginField): PluginTarget[] {
  const list = Array.isArray(raw) ? raw : arrayDefault(field)
  return list.map((item, index) => normalizeTarget(item, index))
}

function normalizeEndpoints(raw: unknown, field: PluginField): PluginEndpoint[] {
  const list = Array.isArray(raw) ? raw : arrayDefault(field)
  return list.map((item, index) => normalizeEndpoint(item, index))
}

/**
 * 把设置里存的值夹回清单声明的形状。
 *
 * 设置文件是纯文本，可能被手改成字符串、负数、越界枚举；这里与设置页使用同一份
 * 结果，保证宿主拿到的配置和界面上看到的一致。
 */
function normalizeFieldValue(field: PluginField, raw: unknown): unknown {
  switch (field.kind) {
    case 'password':
      // 密码字段的值永远在 secrets 里，配置只留空串
      return ''
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false' || raw === '') return false
      return Boolean(field.default)
    case 'number': {
      const fallback = typeof field.default === 'number' ? field.default : 0
      if (raw === undefined || raw === null || raw === '') return fallback
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return fallback
      const min = field.min ?? Number.NEGATIVE_INFINITY
      const max = field.max ?? Number.POSITIVE_INFINITY
      return Math.min(Math.max(n, min), max)
    }
    case 'select': {
      const options = field.options ?? []
      const value = textOf(raw)
      if (options.some(option => option.value === value)) return value
      return textOf(field.default) || options[0]?.value || ''
    }
    case 'targets':
      return normalizeTargets(raw, field)
    case 'endpoints':
      return normalizeEndpoints(raw, field)
    default: {
      if (typeof raw === 'string') return raw
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
      return textOf(field.default)
    }
  }
}

function secretPath(extensionId: string, key: string): string {
  return `${extensionId}:${key}`
}

function shortSecretKey(extensionId: string, key: string): string {
  return key.startsWith(`${extensionId}:`) ? key.slice(extensionId.length + 1) : key
}

/** 设置页要展示的所有密钥槽位（值由 secretHints 换成掩码） */
function secretKeysOf(entry: ExtensionEntry, config: Record<string, unknown>): string[] {
  const keys = new Set<string>()
  for (const field of entry.descriptor.settingsFields) {
    const fullKey = `${entry.id}.${field.key}`
    if (field.kind === 'password') keys.add(secretPath(entry.id, field.key))
    if (!field.targetSecret) continue
    if (field.kind !== 'targets' && field.kind !== 'endpoints') continue
    const value = config[fullKey]
    if (!Array.isArray(value)) continue
    for (const raw of value) {
      const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const id = textOf(item.id)
      if (!id) continue
      const slot =
        field.kind === 'targets'
          ? targetSecretSlot({
              id,
              auth: item.auth === 'password' || item.auth === 'ssh' ? item.auth : 'token'
            })
          : id
      keys.add(secretPath(entry.id, `${field.key}:${slot}`))
    }
  }
  return [...keys]
}

function sanitizeStatusItem(raw: StatusBarItemDto): StatusBarItemDto {
  return {
    id: textOf(raw.id),
    alignment: raw.alignment === 'right' ? 'right' : 'left',
    priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 0,
    text: truncate(textOf(raw.text), MAX_STATUS_TEXT),
    ...(typeof raw.tooltip === 'string' ? { tooltip: truncate(raw.tooltip, 240) } : {}),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(typeof raw.backgroundColor === 'string' ? { backgroundColor: raw.backgroundColor } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    visible: raw.visible !== false
  }
}

function sameHostSettings(a: ExtensionHostSettings, b: ExtensionHostSettings): boolean {
  if (a.mode !== b.mode) return false
  const aKeys = Object.keys(a.affinity)
  const bKeys = Object.keys(b.affinity)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => a.affinity[key] === b.affinity[key])
}

function installInfoOf(record: ExtensionRecord): ExtensionInstallInfo {
  return {
    version: record.version,
    installedAt: record.installedAt,
    integrity: record.integrity,
    mainSha256: record.mainSha256 ?? null,
    publisher: record.publisher ?? null,
    source: record.source,
    registryUrl: record.registryUrl ?? null
  }
}

function entrySignature(entry: ExtensionEntry | undefined): string {
  if (!entry) return ''
  return JSON.stringify({
    version: entry.manifest.version,
    main: entryFileOf(entry.manifest),
    manifest: entry.manifest,
    enabled: entry.enabled
  })
}

// ---------- 服务 ----------

export class ExtensionService {
  private readonly options: ExtensionServiceOptions
  private readonly appVersion: string
  private readonly machineId: string
  private readonly sessionId = randomUUID()
  private readonly logStore = new ExtensionLogStore()
  private readonly stateStore = new ExtensionStateStore()
  private readonly documents = new DocumentRegistry()
  private readonly webviews = new WebviewRegistry()
  private readonly webviewStore = new WebviewStore()
  /** 尚未恢复的持久化面板；恢复完一个就从这里移除，避免把旧记录又写回去 */
  private savedWebviews: PersistedWebviewPanel[] = []

  private readonly entries = new Map<string, ExtensionEntry>()
  private preferences: Record<string, ExtensionPreference> = {}
  private hostSettings: ExtensionHostSettings = { mode: 'isolated', affinity: {} }
  private hostPlan: HostPlan = { groups: [], byExtension: new Map() }
  private readonly hosts = new Map<number, HostRecord>()

  private readonly runtime = new Map<string, ExtensionRuntimeInfo>()
  private readonly statusSnapshots = new Map<string, ExtensionStatusSnapshot>()
  private readonly statusBarItems = new Map<string, Map<string, StatusBarItemDto>>()
  private readonly runtimeCommands = new Map<string, RuntimeCommandRegistration>()
  private readonly declaredCommandOwners = new Map<string, string>()
  private readonly serializers = new Map<string, string>()

  private readonly activated = new Set<string>()
  private readonly wantActive = new Set<string>()
  private readonly activationPromises = new Map<string, Promise<void>>()
  private readonly activationWaiters = new Map<string, ActivationWaiter>()
  private readonly deactivationWaiters = new Map<string, DeactivationWaiter>()

  private context: ExtensionContextKeys = {
    hasEditor: false,
    hasVault: false,
    isDirty: false,
    editorFocus: false,
    editorTextFocus: false,
    resourceLangId: null,
    workspaceFolderCount: 0
  }
  private theme: ThemeDto = { kind: 'light', colors: {} }
  private workspaceFolders: WorkspaceFolderDto[] = []

  private readonly pendingRenderer = new Map<string, PendingRendererRequest>()
  private readonly pendingUi = new Map<string, PendingUiRequest>()
  private rendererSender: ((message: MainToRendererMessage) => void) | null
  private rendererSeq = 0
  private uiSeq = 0
  private rendererReady = false

  private contributionsTimer: NodeJS.Timeout | null = null
  private settingsUnsubscribe: (() => void) | null = null
  private refreshing: Promise<void> | null = null
  private disposing = false
  private startupDone = false

  constructor(options: ExtensionServiceOptions = {}) {
    this.options = options
    this.appVersion = options.appVersion ?? app.getVersion()
    this.machineId =
      options.machineId ??
      createHash('sha256')
        .update(`${hostname()}|${app.getPath('userData')}`)
        .digest('hex')
        .slice(0, 32)
    this.rendererSender = options.postToRenderer ?? null
  }

  // ---------- 生命周期 ----------

  async init(): Promise<void> {
    const settings = await loadSettings()
    this.preferences = settings.extensions ?? {}
    this.hostSettings = settings.extensionHost ?? { mode: 'isolated', affinity: {} }
    this.savedWebviews = await this.webviewStore.load()
    await cleanupOldDirs()
    await this.reloadEntries()

    this.refreshWorkspaceFolders()
    this.settingsUnsubscribe = onSettingsChanged((next, prev) => this.onSettingsChanged(next, prev))
  }

  /**
   * 窗口与编辑器就绪后调用：激活 `*` 与 `onStartupFinished`。
   * 重复调用无副作用；未命中的扩展不 fork 宿主。
   */
  async startup(): Promise<void> {
    if (this.startupDone) return
    this.startupDone = true
    await this.activateEvent('*', 'startup')
    await this.activateEvent('onStartupFinished', 'startupFinished')
    // 面板恢复放在启动激活之后：扩展要先把序列化器注册上，main 才知道怎么重建。
    await this.restoreWebviews()
  }

  async shutdown(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    this.settingsUnsubscribe?.()
    this.settingsUnsubscribe = null
    if (this.contributionsTimer) {
      clearTimeout(this.contributionsTimer)
      this.contributionsTimer = null
    }
    for (const rec of this.hosts.values()) {
      if (rec.restartTimer) clearTimeout(rec.restartTimer)
      rec.restartTimer = null
      rec.process?.kill()
      rec.process = null
      rec.state = 'stopped'
      rec.pid = null
    }
    this.hosts.clear()
    this.failAllWaiters(new Error('扩展系统已关闭'))
    await this.stateStore.flushAll()
    await this.webviewStore.flush()
  }

  setRendererSender(sender: ((message: MainToRendererMessage) => void) | null): void {
    this.rendererSender = sender
  }

  // ---------- webview 资源与恢复 ----------

  /**
   * `imark-webview://` 的入口。token 找回面板记录；HTML 是扩展最后一次写入的内容。
   * 真正的校验在 webviewProtocol 里做（这里只交出 registry 的查表能力）。
   */
  serveWebviewRequest(url: string): Promise<Response> {
    return serveWebviewResource(url, token => {
      const record = this.webviews.findByToken(token)
      if (!record) return null
      return {
        extensionId: record.extensionId,
        root: record.root,
        localResourceRoots: record.localResourceRoots,
        html: record.html
      }
    })
  }

  private postWebviewCreate(record: WebviewRecord): void {
    this.postToRenderer({
      type: 'webview.create',
      panel: {
        ...this.webviews.stateOf(record),
        extensionId: record.extensionId,
        html: record.html,
        token: record.token,
        viewType: record.viewType,
        retainContextWhenHidden: record.retainContextWhenHidden
      }
    })
  }

  /**
   * 上次运行留下的面板。
   *
   * 恢复流程与 VS Code 一致：按 `onWebviewPanel:<viewType>` 激活归属扩展 →
   * 等它注册序列化器 → main 建回记录（沿用 token）→ 渲染层先挂 iframe →
   * 宿主调用 `deserializeWebviewPanel(state)` 重新生成 HTML。
   *
   * 没有序列化器的面板直接丢弃：扩展自己都没说怎么恢复，硬塞一个空页没有意义。
   */
  private async restoreWebviews(): Promise<void> {
    const pending = this.savedWebviews
    this.savedWebviews = []
    for (const saved of pending) {
      const entry = this.entries.get(saved.extensionId)
      if (!entry || !entry.enabled || entry.loadError || !entryFileOf(entry.manifest)) {
        this.webviewStore.forget(saved.panelId)
        continue
      }
      try {
        await this.activateExtension(saved.extensionId, 'webview')
      } catch (err) {
        this.logStore.add(
          saved.extensionId,
          'error',
          `恢复 webview「${saved.viewType}」时激活失败：${errorMessage(err)}`
        )
        this.webviewStore.forget(saved.panelId)
        continue
      }
      if (this.serializers.get(saved.viewType) !== saved.extensionId) {
        this.logStore.add(
          saved.extensionId,
          'warn',
          `面板「${saved.viewType}」没有序列化器，已放弃恢复`
        )
        this.webviewStore.forget(saved.panelId)
        continue
      }
      if (this.webviews.get(saved.panelId)) {
        this.webviewStore.forget(saved.panelId)
        continue
      }
      const record = this.webviews.restore(saved, entry.root)
      this.postWebviewCreate(record)
      this.pushWebviewMessage(saved.extensionId, {
        kind: 'webview.restore',
        panelId: record.panelId,
        viewType: record.viewType,
        state: record.state,
        panel: this.webviews.stateOf(record),
        token: record.token
      })
    }
    this.persistWebviews()
  }

  /**
   * 把「已恢复/新建的面板」与「尚未恢复的旧记录」合并写盘。
   *
   * 不能只写 `webviews.list()`：启动后某个扩展可能在恢复流程之前就新建了面板，
   * 那时直接全量覆盖会把其他还没轮到恢复的面板从磁盘上抹掉。
   */
  private persistWebviews(): void {
    const live = this.webviews.list().map(record => this.webviews.persistedOf(record))
    const liveIds = new Set(live.map(panel => panel.panelId))
    const pending = this.savedWebviews.filter(panel => !liveIds.has(panel.panelId))
    this.webviewStore.replace([...pending, ...live])
  }

  private forgetWebview(panelId: string): void {
    this.savedWebviews = this.savedWebviews.filter(panel => panel.panelId !== panelId)
    this.webviewStore.forget(panelId)
  }

  // ---------- 查询 ----------

  getContributions(): ExtensionContributionsSnapshot {
    const reserved = this.options.reservedKeys?.()
    return buildContributions({
      entries: this.entries.values(),
      context: this.context,
      hostGroups: this.hostGroupsView(),
      statusItems: this.statusBarItems,
      runtimeCommands: this.runtimeCommands,
      ...(reserved ? { reservedKeys: reserved } : {}),
      pidOf: hostId => this.hosts.get(hostId)?.pid ?? null,
      statusOf: id => this.statusSnapshots.get(id)
    })
  }

  listExtensions(): ExtensionView[] {
    return [...this.entries.keys()].sort().map(id => this.buildViewSync(id))
  }

  async getExtensionView(id: string): Promise<ExtensionView | null> {
    return this.entries.has(id) ? this.buildViewSync(id) : null
  }

  async getExtensionViews(): Promise<ExtensionView[]> {
    return [...this.entries.keys()].sort().map(id => this.buildViewSync(id))
  }

  hostGroupsView(): ExtensionHostGroupView[] {
    return this.hostPlan.groups
      .map(group => {
        const rec = this.hosts.get(group.hostId)
        const pid = rec?.pid ?? null
        return {
          hostId: group.hostId,
          extensionIds: [...group.extensionIds],
          pid,
          memoryBytes: this.memoryOf(pid),
          state: this.hostStateOf(rec)
        }
      })
      .sort((a, b) => a.hostId - b.hostId)
  }

  getLogPath(id: string): string | null {
    return this.entries.has(id) ? this.logStorePath(id) : null
  }

  /** 主进程侧把一条事件写进某个扩展的日志（快捷键冲突、菜单重建失败等） */
  addLog(id: string, level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (!this.entries.has(id)) return
    this.logStore.add(id, level, message)
  }

  isActivated(id: string): boolean {
    return this.activated.has(id)
  }

  // ---------- 安装 / 启用 / 配置 ----------

  async installPackage(raw: unknown, options: InstallRequest): Promise<InstallExtensionOutcome> {
    const outcome = await installExtensionPackage(raw, {
      ...options,
      appVersion: options.appVersion ?? this.appVersion
    })
    const runtime = this.runtime.get(outcome.record.id)
    if (runtime) {
      runtime.lastError = null
      runtime.activationFailures = 0
      runtime.autoRestartDisabled = false
    }
    await this.reloadEntries()
    return outcome
  }

  async uninstallExtension(id: string): Promise<void> {
    if (!this.entries.has(id)) throw new Error(`扩展 ${id} 未安装`)
    const dependents = this.dependentsOf(id)
    if (dependents.length > 0) {
      throw new Error(
        `扩展 ${id} 被以下扩展依赖，无法卸载：${dependents
          .map(entry => `${entry.manifest.displayName || entry.id}（${entry.id}）`)
          .join('、')}。请先卸载依赖它的扩展。`
      )
    }
    this.wantActive.delete(id)
    await this.deactivateExtension(id, { removeData: true, forget: true })
    await removeExtensionDir(id)
    await removeRecord(id)
    await deleteSecretsByPrefix(`${id}:`)
    await this.stateStore.remove(id)
    await this.logStore.remove(id)
    await this.reloadEntries()
    await this.removePreference(id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<ExtensionView | null> {
    if (!this.entries.has(id)) throw new Error(`扩展 ${id} 未安装`)
    if (!enabled) {
      const dependents = this.dependentsOf(id).filter(entry => entry.enabled)
      if (dependents.length > 0) {
        throw new Error(
          `扩展 ${id} 被以下已启用的扩展依赖，无法禁用：${dependents
            .map(entry => `${entry.manifest.displayName || entry.id}（${entry.id}）`)
            .join('、')}。请先禁用依赖它的扩展。`
        )
      }
      await this.writePreference(id, current => ({ ...current, enabled: false }))
      return this.getExtensionView(id)
    }

    // 启用一个扩展时把它的依赖链一并启用；缺失依赖直接拒绝，避免留下
    // “已启用但永远激活失败”的状态。
    const toEnable = new Set<string>()
    const visit = (current: string): void => {
      if (toEnable.has(current)) return
      const entry = this.entries.get(current)
      if (!entry) throw new Error(`扩展 ${current} 未安装`)
      toEnable.add(current)
      for (const dependency of entry.manifest.extensionDependencies ?? []) visit(dependency)
    }
    visit(id)
    if (toEnable.size === 1) {
      await this.writePreference(id, current => ({ ...current, enabled: true }))
    } else {
      const settings = await loadSettings()
      const preferences = { ...(settings.extensions ?? {}) }
      for (const extensionId of toEnable) {
        const current = preferences[extensionId] ?? { enabled: true, config: {} }
        preferences[extensionId] = { ...current, enabled: true }
      }
      await saveSettings({ extensions: preferences })
    }
    return this.getExtensionView(id)
  }

  /** 已安装且清单里依赖 `id` 的扩展 */
  private dependentsOf(id: string): ExtensionEntry[] {
    return [...this.entries.values()].filter(
      entry =>
        entry.id !== id && (entry.manifest.extensionDependencies ?? []).includes(id)
    )
  }

  async setExtensionConfig(id: string, config: Record<string, unknown>): Promise<ExtensionView | null> {
    if (!this.entries.has(id)) throw new Error(`扩展 ${id} 未安装`)
    await this.writePreference(id, current => ({ ...current, config: { ...config } }))
    return this.getExtensionView(id)
  }

  async setExtensionSecret(id: string, key: string, value: string | null): Promise<void> {
    if (!this.entries.has(id)) throw new Error(`扩展 ${id} 未安装`)
    const path = key.startsWith(`${id}:`) ? key : secretPath(id, key)
    await setSecret(path, value)
    const shortKey = shortSecretKey(id, path)
    this.pushToExtensionHost(id, { kind: 'secrets.changed', extensionId: id, key: shortKey })
  }

  async setHostSettings(patch: ExtensionHostSettingsPatch): Promise<void> {
    const current = this.hostSettings
    const mode: ExtensionHostMode = patch.mode ?? current.mode
    const affinity = patch.affinity ?? current.affinity
    await saveSettings({ extensionHost: { mode, affinity } })
  }

  async reloadExtension(id: string): Promise<void> {
    if (!this.entries.has(id)) throw new Error(`扩展 ${id} 未安装`)
    this.activationFailuresReset(id)
    this.setRuntimeStatus(id, this.isEnabled(id) ? 'inactive' : 'disabled', {
      lastError: null,
      autoRestartDisabled: false
    })
    const hostId = this.hostPlan.byExtension.get(id)
    if (hostId === undefined) return
    const rec = this.hosts.get(hostId)
    const ids = rec
      ? rec.extensionIds.filter(item => this.wantActive.has(item) || item === id)
      : (this.groupOf(hostId)?.extensionIds ?? []).filter(
          item => this.wantActive.has(item) || item === id
        )
    this.activated.delete(id)
    if (rec) this.stopHostRecord(rec)
    await this.restartHostIds(hostId, ids)
  }

  async reloadHost(hostId: number): Promise<void> {
    const group = this.groupOf(hostId)
    if (!group) throw new Error(`宿主 #${hostId} 不存在`)
    const rec = this.hosts.get(hostId)
    const ids = rec
      ? rec.extensionIds.filter(item => this.wantActive.has(item))
      : group.extensionIds.filter(item => this.wantActive.has(item))
    for (const id of group.extensionIds) {
      this.activationFailuresReset(id)
      const status = this.runtime.get(id)?.status
      if (status === 'crashed' || status === 'crash-loop' || status === 'failed') {
        this.setRuntimeStatus(id, this.isEnabled(id) ? 'inactive' : 'disabled', {
          lastError: null,
          autoRestartDisabled: false
        })
      }
    }
    if (rec) this.stopHostRecord(rec)
    await this.restartHostIds(hostId, ids)
  }

  // ---------- 激活 ----------

  async activateExtension(id: string, reason: HostActivationReason = 'api'): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`扩展 ${id} 未安装`)
    if (!entry.enabled) throw new Error(`扩展 ${id} 已禁用`)
    if (entry.loadError) throw new Error(`扩展 ${id} 加载失败：${entry.loadError}`)
    if (!entryFileOf(entry.manifest)) throw new Error(`扩展 ${id} 没有可执行入口`)
    if (this.runtime.get(id)?.status === 'crash-loop') {
      throw new Error(`扩展 ${id} 连续导致宿主崩溃，已停止自动重启；请在设置页重新加载`)
    }
    if (this.activated.has(id)) return
    if ((this.runtime.get(id)?.activationFailures ?? 0) >= 3) {
      throw new Error(`扩展 ${id} 连续激活失败 3 次，已停止自动重试；请在设置页重新加载`)
    }
    const running = this.activationPromises.get(id)
    if (running) return running
    const promotion = this.doActivate(entry, reason)
    this.activationPromises.set(id, promotion)
    void promotion
      .catch(() => {
        /* 调用方负责处理；这里只避免 finally 链产生未处理拒绝 */
      })
      .finally(() => {
        if (this.activationPromises.get(id) === promotion) this.activationPromises.delete(id)
      })
    return promotion
  }

  private async doActivate(entry: ExtensionEntry, reason: HostActivationReason): Promise<void> {
    const id = entry.id
    for (const dep of entry.manifest.extensionDependencies ?? []) {
      const depEntry = this.entries.get(dep)
      if (!depEntry) throw new Error(`扩展 ${id} 依赖的 ${dep} 未安装`)
      if (!depEntry.enabled) throw new Error(`扩展 ${id} 依赖的 ${dep} 已禁用`)
      if (!depEntry.loadError && entryFileOf(depEntry.manifest)) {
        await this.activateExtension(dep, 'dependency')
      }
    }
    const hostId = this.hostPlan.byExtension.get(id)
    if (hostId === undefined) throw new Error(`扩展 ${id} 没有分配宿主`)
    this.setRuntimeStatus(id, 'activating', { lastError: null, autoRestartDisabled: false })
    try {
      await this.startHost(hostId)
      const rec = this.hosts.get(hostId)
      if (!rec?.process || rec.state !== 'running') {
        throw new Error(`宿主 #${hostId} 没有就绪`)
      }
      if (!rec.extensionIds.includes(id)) throw new Error(`扩展 ${id} 不在宿主 #${hostId} 中`)
      // 在发送 activate 之前就记下“它应该活着”：宿主崩溃重启后要按这个集合重新激活，
      // 不能因为第一次激活还没返回就把它漏掉
      this.wantActive.add(id)
      const waiter = this.waitForActivation(id)
      rec.process.send({ kind: 'activate', extensionId: id, reason })
      await waiter
      this.activated.add(id)
      this.setRuntimeStatus(id, 'active', { lastError: null, activationFailures: 0 })
      this.scheduleContributions()
    } catch (err) {
      const message = errorMessage(err)
      const current = this.runtime.get(id)?.status
      // 宿主整体崩溃/被熔断时不要用 failed 覆盖 crashed —— 两者在设置页的含义不同
      if (current === 'crashed' || current === 'crash-loop') throw err
      const failures = (this.runtime.get(id)?.activationFailures ?? 0) + 1
      this.setRuntimeStatus(id, 'failed', {
        lastError: message,
        activationFailures: failures
      })
      this.logStore.add(id, 'error', `激活失败（第 ${failures} 次）：${message}`)
      throw err
    }
  }

  private async activateEvent(event: string, reason: HostActivationReason): Promise<void> {
    const ids = [...this.entries.values()]
      .filter(
        entry =>
          entry.enabled &&
          !entry.loadError &&
          entryFileOf(entry.manifest) &&
          (entry.manifest.activationEvents ?? []).includes(event)
      )
      .map(entry => entry.id)
      .sort()
    for (const id of ids) {
      try {
        await this.activateExtension(id, reason)
      } catch (err) {
        this.logStore.add(id, 'error', `激活事件 ${event} 失败：${errorMessage(err)}`)
      }
    }
  }

  private waitForActivation(id: string, timeoutMs = 30000): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      const previous = this.activationWaiters.get(id)
      if (previous) {
        clearTimeout(previous.timer)
        previous.reject(new Error('新的激活请求取代了旧的等待'))
      }
      const timer = setTimeout(() => {
        this.activationWaiters.delete(id)
        reject(new Error(`等待扩展 ${id} 激活超时`))
      }, timeoutMs)
      timer.unref?.()
      this.activationWaiters.set(id, { resolve: resolvePromise, reject, timer })
    })
  }

  private async deactivateExtension(
    id: string,
    options: { removeData?: boolean; forget?: boolean } = {}
  ): Promise<void> {
    if (options.forget) this.wantActive.delete(id)
    const hostId = this.hostPlan.byExtension.get(id)
    const rec = hostId !== undefined ? this.hosts.get(hostId) : null
    const running = rec?.process && rec.state === 'running' && rec.extensionIds.includes(id)
    if (running && rec?.process) {
      const waiter = this.waitForDeactivation(id)
      rec.process.send({
        kind: 'deactivate',
        extensionId: id,
        removeData: options.removeData === true
      })
      try {
        await waiter
      } catch (err) {
        this.logStore.add(id, 'error', `停用超时：${errorMessage(err)}`)
      }
    }
    // 停用与重新启用可能交错(用户连点开关、命令在停用途中被调用):如果这段时间里
    // 扩展又有了“应该活着”的标记,这里就不能再擦掉它的注册表/状态,否则刚启动的
    // 宿主会变成“进程活着但命令全没了”的僵尸
    if (this.wantActive.has(id)) {
      this.logStore.add(id, 'info', '停用尚未完成，扩展已被重新激活；保留运行时注册')
      return
    }
    this.activated.delete(id)
    this.clearExtensionRuntime(id)
    this.setRuntimeStatus(id, this.isEnabled(id) ? 'inactive' : 'disabled', { lastError: null })
    this.scheduleContributions()
  }

  private waitForDeactivation(id: string, timeoutMs = 10000): Promise<void> {
    return new Promise<void>(resolvePromise => {
      const previous = this.deactivationWaiters.get(id)
      if (previous) {
        clearTimeout(previous.timer)
        previous.resolve()
      }
      const timer = setTimeout(() => {
        this.deactivationWaiters.delete(id)
        resolvePromise()
      }, timeoutMs)
      timer.unref?.()
      this.deactivationWaiters.set(id, { resolve: resolvePromise, timer })
    })
  }

  // ---------- 宿主进程 ----------

  private groupOf(hostId: number): HostPlanGroup | undefined {
    return this.hostPlan.groups.find(group => group.hostId === hostId)
  }

  private hostStateOf(rec: HostRecord | undefined): ExtensionHostGroupView['state'] {
    const state = rec?.state
    if (state === 'starting' || state === 'running' || state === 'crashed' || state === 'crash-loop') {
      return state
    }
    return 'stopped'
  }

  private computePlan(): HostPlan {
    const extensions: HostPlannerExtension[] = [...this.entries.values()].map(entry => ({
      id: entry.id,
      enabled: entry.enabled && !entry.loadError,
      hasMain: Boolean(entryFileOf(entry.manifest)),
      extensionDependencies: entry.manifest.extensionDependencies ?? [],
      extensionAffinity: entry.manifest.extensionAffinity ?? []
    }))
    return planHosts(extensions, this.hostSettings.mode, this.hostSettings.affinity)
  }

  /**
   * 重算分组，只重启受影响的宿主。
   *
   * `extraChangedIds` 用于“成员没变但代码变了”（升级/重载）的情况：
   * 这些扩展所在的宿主也要重启，并按新分组重新激活。
   */
  private applyHostPlan(extraChangedIds: ReadonlySet<string> = new Set()): void {
    const next = this.computePlan()
    const affected = new Set(changedHostIds(this.hostPlan, next))
    const reactivate = new Set<string>()
    for (const rec of [...this.hosts.values()]) {
      const planChanged = affected.has(rec.hostId)
      const codeChanged = rec.extensionIds.some(id => extraChangedIds.has(id))
      if (!planChanged && !codeChanged) continue
      for (const id of rec.extensionIds) {
        if (this.wantActive.has(id) && this.isEnabled(id)) reactivate.add(id)
      }
      this.stopHostRecord(rec)
    }
    this.hostPlan = next
    this.scheduleContributions()
    const byHost = new Map<number, string[]>()
    for (const id of reactivate) {
      const hostId = next.byExtension.get(id)
      if (hostId === undefined || !this.canActivate(id)) continue
      const list = byHost.get(hostId)
      if (list) list.push(id)
      else byHost.set(hostId, [id])
    }
    for (const [hostId, ids] of byHost) {
      void this.restartHostIds(hostId, ids)
    }
  }

  private async restartHostIds(hostId: number, ids: readonly string[]): Promise<void> {
    const group = this.groupOf(hostId)
    if (!group) return
    const activatable = [...new Set(ids)].filter(
      id => group.extensionIds.includes(id) && this.canActivate(id)
    )
    if (activatable.length === 0) return
    try {
      await this.startHost(hostId)
    } catch (err) {
      this.logStore.add(activatable[0]!, 'error', `重新启动宿主 #${hostId} 失败：${errorMessage(err)}`)
      return
    }
    for (const id of activatable) {
      try {
        await this.activateExtension(id, 'startup')
      } catch (err) {
        this.logStore.add(id, 'error', `重新激活失败：${errorMessage(err)}`)
      }
    }
  }

  private canActivate(id: string): boolean {
    const entry = this.entries.get(id)
    return Boolean(entry && entry.enabled && !entry.loadError && entryFileOf(entry.manifest))
  }

  private async startHost(hostId: number): Promise<HostRecord> {
    const group = this.groupOf(hostId)
    if (!group) throw new Error(`宿主 #${hostId} 不在分组规划里`)
    const ids = group.extensionIds.filter(id => this.canActivate(id))
    if (ids.length === 0) throw new Error(`宿主 #${hostId} 没有可运行的扩展`)
    let rec = this.hosts.get(hostId)
    if (rec?.process && rec.state === 'running') return rec
    if (rec?.starting) {
      await rec.starting
      return rec
    }
    if (rec?.state === 'crash-loop') {
      throw new Error(`宿主 #${hostId} 连续崩溃，已停止自动重启；请手动重新加载`)
    }
    if (!rec) {
      rec = {
        hostId,
        extensionIds: ids,
        process: null,
        state: 'stopped',
        pid: null,
        lastError: null,
        crashTimes: [],
        restartTimer: null,
        starting: null
      }
      this.hosts.set(hostId, rec)
    }
    rec.extensionIds = ids
    const current = rec
    const payload = await this.buildInitPayload(current)
    if (this.hosts.get(hostId) !== current) throw new Error(`宿主 #${hostId} 在启动前被替换`)
    const process = new ExtensionHostProcess(hostId, ids, {
      onMessage: (host, message) => this.onHostMessage(current, host, message),
      onExit: (host, code, killed) => this.onHostExit(current, host, code, killed),
      onStdio: (host, level, line) => this.onHostStdio(current, host, level, line)
    })
    current.process = process
    current.state = 'starting'
    current.pid = process.pid
    current.lastError = null
    const starting = process
      .start(payload)
      .then(() => {
        if (this.hosts.get(hostId) !== current) {
          process.kill()
          return
        }
        current.state = 'running'
        current.pid = process.pid
        current.lastError = null
        for (const id of current.extensionIds) {
          if (!this.wantActive.has(id)) {
            this.setRuntimeStatus(id, 'inactive', { lastError: null })
          }
        }
        this.scheduleContributions()
      })
      .catch(err => {
        if (this.hosts.get(hostId) !== current) throw err
        current.state = 'crashed'
        current.process = null
        current.pid = null
        current.lastError = errorMessage(err)
        this.handleHostCrash(current, current.lastError)
        throw err
      })
    current.starting = starting
    try {
      await starting
    } finally {
      if (current.starting === starting) current.starting = null
    }
    return current
  }

  private async buildInitPayload(rec: HostRecord): Promise<ExtensionHostInitPayload> {
    const extensions: HostExtensionInit[] = []
    for (const id of rec.extensionIds) {
      const entry = this.entries.get(id)
      if (!entry) continue
      await this.stateStore.preload(id)
      const storage = await this.stateStore.ensureStorage(id)
      const state = this.stateStore.snapshotSync(id)
      extensions.push({
        id,
        extensionPath: entry.root,
        manifest: entry.manifest,
        config: this.configFor(entry),
        globalState: state.global,
        workspaceState: state.workspace,
        globalStoragePath: storage,
        logPath: this.logStorePath(id),
        mode: entry.dev ? 'development' : 'production'
      })
    }
    const visible = this.documents.visible.slice(0, MAX_OPEN_DOCUMENTS)
    return {
      hostId: rec.hostId,
      appVersion: this.appVersion,
      environment: {
        language: app.getLocale?.() ?? 'zh-CN',
        uriScheme: 'imark',
        machineId: this.machineId,
        sessionId: this.sessionId
      },
      workspaceFolders: this.workspaceFolders.map(folder => ({ ...folder })),
      theme: { ...this.theme, colors: { ...this.theme.colors } },
      documents: this.documents.list().slice(0, MAX_OPEN_DOCUMENTS).map(doc => ({ ...doc })),
      activeDocumentUri: this.documents.active,
      visibleDocumentUris: visible,
      extensions
    }
  }

  private stopHostRecord(rec: HostRecord): void {
    if (rec.restartTimer) {
      clearTimeout(rec.restartTimer)
      rec.restartTimer = null
    }
    if (this.hosts.get(rec.hostId) === rec) this.hosts.delete(rec.hostId)
    const process = rec.process
    rec.process = null
    rec.state = 'stopped'
    rec.pid = null
    rec.starting = null
    if (process) process.kill()
    for (const id of rec.extensionIds) {
      this.activated.delete(id)
      this.rejectActivationWaiter(id, new Error('宿主已关闭'))
      const waiter = this.deactivationWaiters.get(id)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.deactivationWaiters.delete(id)
        waiter.resolve()
      }
      this.clearExtensionRuntime(id)
      this.setRuntimeStatus(id, this.isEnabled(id) ? 'inactive' : 'disabled', { lastError: null })
    }
    this.scheduleContributions()
  }

  private onHostExit(
    rec: HostRecord,
    host: ExtensionHostProcess,
    code: number,
    killedByMain: boolean
  ): void {
    if (this.hosts.get(rec.hostId) !== rec || rec.process !== host) return
    rec.process = null
    rec.pid = null
    if (killedByMain || this.disposing) {
      rec.state = 'stopped'
      return
    }
    this.handleHostCrash(rec, `宿主进程意外退出（code ${code}）`)
  }

  private handleHostCrash(rec: HostRecord, message: string): void {
    if (this.disposing) return
    if (this.hosts.get(rec.hostId) !== rec) return
    rec.state = 'crashed'
    rec.process = null
    rec.pid = null
    rec.lastError = message
    const now = Date.now()
    rec.crashTimes = rec.crashTimes.filter(at => now - at < 60000)
    rec.crashTimes.push(now)
    const crashLoop = rec.crashTimes.length >= 3
    if (crashLoop) rec.state = 'crash-loop'

    for (const id of rec.extensionIds) {
      this.activated.delete(id)
      this.rejectActivationWaiter(id, new Error(message))
      this.clearExtensionRuntime(id)
      this.setRuntimeStatus(id, crashLoop ? 'crash-loop' : 'crashed', {
        lastError: message,
        ...(crashLoop ? { autoRestartDisabled: true } : {})
      })
      this.logStore.add(id, 'error', `宿主 #${rec.hostId} 异常退出：${message}`)
    }
    this.scheduleContributions()

    if (crashLoop) return
    const delay = 1000 * 2 ** (rec.crashTimes.length - 1)
    if (rec.restartTimer) clearTimeout(rec.restartTimer)
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = null
      void this.restartCrashedHost(rec)
    }, delay)
    rec.restartTimer.unref?.()
  }

  private async restartCrashedHost(rec: HostRecord): Promise<void> {
    if (this.disposing || this.hosts.get(rec.hostId) !== rec) return
    const ids = rec.extensionIds.filter(id => this.wantActive.has(id) && this.canActivate(id))
    try {
      await this.startHost(rec.hostId)
    } catch {
      // startHost 已经排好下一次重试；这里不重复记录
      return
    }
    for (const id of ids) {
      try {
        await this.activateExtension(id, 'startup')
      } catch (err) {
        this.logStore.add(id, 'error', `宿主重启后激活失败：${errorMessage(err)}`)
      }
    }
  }

  private rejectActivationWaiter(id: string, error: Error): void {
    const waiter = this.activationWaiters.get(id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.activationWaiters.delete(id)
    waiter.reject(error)
  }

  private failAllWaiters(error: Error): void {
    for (const waiter of this.activationWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.activationWaiters.clear()
    for (const waiter of this.deactivationWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    this.deactivationWaiters.clear()
    for (const pending of this.pendingRenderer.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRenderer.clear()
    for (const pending of this.pendingUi.values()) {
      clearTimeout(pending.timer)
      pending.resolve(null)
    }
    this.pendingUi.clear()
  }

  private onHostStdio(
    rec: HostRecord,
    _host: ExtensionHostProcess,
    level: 'info' | 'error',
    line: string
  ): void {
    const id = rec.extensionIds.find(item => this.entries.has(item))
    if (id) {
      this.logStore.add(id, level === 'error' ? 'error' : 'info', `[宿主 #${rec.hostId}] ${line}`)
    } else {
      console[level === 'error' ? 'error' : 'log'](`[宿主 #${rec.hostId}] ${line}`)
    }
  }

  // ---------- 宿主消息 ----------

  private onHostMessage(
    rec: HostRecord,
    host: ExtensionHostProcess,
    message: HostToMainMessage
  ): void {
    if (this.hosts.get(rec.hostId) !== rec || rec.process !== host) return
    switch (message.kind) {
      case 'log':
        this.handleHostLog(message)
        return
      case 'status':
        this.handleHostStatus(message)
        return
      case 'activated':
        this.handleActivated(message)
        return
      case 'deactivated':
        this.handleDeactivated(message)
        return
      case 'command.registered':
        if (!rec.extensionIds.includes(message.extensionId)) return
        this.runtimeCommands.set(message.command, {
          extensionId: message.extensionId,
          title: message.title
        })
        this.scheduleContributions()
        return
      case 'command.unregistered': {
        const owner = this.runtimeCommands.get(message.command)
        if (owner?.extensionId === message.extensionId) this.runtimeCommands.delete(message.command)
        this.scheduleContributions()
        return
      }
      case 'state.set':
        if (!rec.extensionIds.includes(message.extensionId)) return
        this.stateStore.set(message.extensionId, message.scope, message.key, message.value)
        return
      case 'output.append':
        this.handleOutputAppend(message.extensionId, message.channel, message.text)
        return
      case 'statusbar':
        this.handleStatusBar(rec, message)
        return
      case 'secrets.changed':
        // 宿主自己 store/delete 时也会发；main 侧 setSecret 已经更新掩码缓存。
        // 这里不把密钥值转发给任何其他进程。
        return
      case 'editor.setDecorations':
        this.handleDecorationNotification(rec, message)
        return
      case 'webview.setHtml':
      case 'webview.postMessage':
      case 'webview.setTitle':
      case 'webview.setPresentation':
      case 'webview.setState':
      case 'webview.dispose':
      case 'webview.serializer.registered':
      case 'webview.serializer.unregistered':
        this.handleWebviewNotification(rec, message)
        return
      default:
        if (host.isRequest(message)) void this.handleHostRequest(rec, host, message)
    }
  }

  private handleDecorationNotification(
    rec: HostRecord,
    message: Extract<HostToMainMessage, { kind: 'editor.setDecorations' }>
  ): void {
    if (!rec.extensionIds.includes(message.extensionId)) return
    void this.requestRenderer({
      op: 'setDecorations',
      uri: message.uri,
      typeId: message.typeId,
      options: message.options,
      ranges: message.ranges
    }).catch(err => {
      this.logStore.add(message.extensionId, 'warn', `设置装饰失败：${errorMessage(err)}`)
    })
  }

  private handleWebviewNotification(
    rec: HostRecord,
    message: Extract<
      HostToMainMessage,
      {
        kind:
          | 'webview.setHtml'
          | 'webview.postMessage'
          | 'webview.setTitle'
          | 'webview.setPresentation'
          | 'webview.setState'
          | 'webview.dispose'
          | 'webview.serializer.registered'
          | 'webview.serializer.unregistered'
      }
    >
  ): void {
    if (!rec.extensionIds.includes(message.extensionId)) return
    switch (message.kind) {
      case 'webview.setHtml': {
        const record = this.webviews.getOwned(message.panelId, message.extensionId)
        if (!record) return
        this.webviews.setHtml(record, message.html)
        this.postToRenderer({ type: 'webview.html', panelId: record.panelId, html: message.html })
        return
      }
      case 'webview.postMessage': {
        const record = this.webviews.getOwned(message.panelId, message.extensionId)
        if (!record) return
        this.postToRenderer({
          type: 'webview.postMessage',
          panelId: record.panelId,
          message: message.message
        })
        return
      }
      case 'webview.setTitle': {
        const record = this.webviews.getOwned(message.panelId, message.extensionId)
        if (!record) return
        this.webviews.setTitle(record, message.title)
        this.postToRenderer({ type: 'webview.update', panel: this.webviews.stateOf(record) })
        this.persistWebviews()
        return
      }
      case 'webview.setPresentation': {
        const record = this.webviews.getOwned(message.panelId, message.extensionId)
        if (!record) return
        this.webviews.setPresentation(record, message)
        this.postToRenderer({ type: 'webview.update', panel: this.webviews.stateOf(record) })
        this.persistWebviews()
        return
      }
      case 'webview.setState': {
        const record = this.webviews.getOwned(message.panelId, message.extensionId)
        if (!record) return
        this.webviews.setState(record, message.state)
        this.persistWebviews()
        return
      }
      case 'webview.dispose': {
        const record = this.webviews.getOwned(message.panelId, message.extensionId)
        if (!record) return
        this.webviews.remove(record.panelId)
        this.postToRenderer({ type: 'webview.dispose', panelId: record.panelId })
        this.forgetWebview(record.panelId)
        return
      }
      case 'webview.serializer.registered':
        this.serializers.set(message.viewType, message.extensionId)
        return
      case 'webview.serializer.unregistered':
        if (this.serializers.get(message.viewType) === message.extensionId) {
          this.serializers.delete(message.viewType)
        }
        return
    }
  }

  private handleHostLog(message: Extract<HostToMainMessage, { kind: 'log' }>): void {
    if (!this.entries.has(message.extensionId)) return
    this.logStore.add(message.extensionId, message.level, message.message)
  }

  private handleOutputAppend(extensionId: string, channel: string, text: string): void {
    if (!this.entries.has(extensionId)) return
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      this.logStore.add(extensionId, 'info', channel ? `[${channel}] ${line}` : line)
    }
  }

  private handleHostStatus(message: Extract<HostToMainMessage, { kind: 'status' }>): void {
    if (!this.entries.has(message.extensionId)) return
    const status = PLUGIN_STATUSES.includes(message.status as PluginStatus)
      ? (message.status as PluginStatus)
      : 'idle'
    const targetResults: Record<string, PluginTargetResult> | undefined = message.targetResults
      ? Object.fromEntries(
          Object.entries(message.targetResults).filter(
            entry => entry[1] === 'ok' || entry[1] === 'error'
          )
        )
      : undefined
    const previous = this.statusSnapshots.get(message.extensionId)
    // 「结束」消息通常不会再带 targetResults（扩展只在逐个远端处理完时上报）。
    // 这里必须沿用上次的结果，否则最后一条 ok/partial 会把设置页的远端卡片颜色抹掉。
    const mergedTargets = targetResults
      ? { ...(previous?.targetResults ?? {}), ...targetResults }
      : previous?.targetResults
    const next: ExtensionStatusSnapshot = {
      status,
      lastRunAt:
        typeof message.lastRunAt === 'number' && Number.isFinite(message.lastRunAt)
          ? message.lastRunAt
          : (previous?.lastRunAt ?? null),
      lastMessage: truncate(message.message ?? '', 4000),
      ...(message.detail !== undefined ? { lastDetail: truncate(message.detail, 8000) } : {}),
      ...(mergedTargets && Object.keys(mergedTargets).length > 0
        ? { targetResults: mergedTargets }
        : {})
    }
    this.statusSnapshots.set(message.extensionId, next)
  }

  private handleActivated(message: HostActivatedMessage): void {
    const waiter = this.activationWaiters.get(message.extensionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.activationWaiters.delete(message.extensionId)
    if (message.ok) waiter.resolve()
    else waiter.reject(new Error(message.error?.message ?? '扩展激活失败'))
  }

  private handleDeactivated(message: HostDeactivatedMessage): void {
    const waiter = this.deactivationWaiters.get(message.extensionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.deactivationWaiters.delete(message.extensionId)
    waiter.resolve()
  }

  private handleStatusBar(
    rec: HostRecord,
    message: Extract<HostToMainMessage, { kind: 'statusbar' }>
  ): void {
    if (!rec.extensionIds.includes(message.extensionId)) return
    let items = this.statusBarItems.get(message.extensionId)
    if (!items) {
      items = new Map()
      this.statusBarItems.set(message.extensionId, items)
    }
    if (message.action === 'dispose') {
      items.delete(message.itemId)
      if (items.size === 0) this.statusBarItems.delete(message.extensionId)
      this.scheduleContributions()
      return
    }
    const item = sanitizeStatusItem(message.item)
    if (!item.id) return
    const exists = items.has(item.id)
    if (!exists) {
      // 没 create 就 update：宿主重连后重放，按 create 处理；超限时静默丢弃
      const perExtensionFull = items.size >= MAX_STATUS_ITEMS_PER_EXTENSION
      if (perExtensionFull || this.totalStatusItems() >= MAX_STATUS_ITEMS_TOTAL) {
        if (message.action === 'create') {
          this.logStore.add(
            message.extensionId,
            'warn',
            perExtensionFull
              ? `状态栏条目超过 ${MAX_STATUS_ITEMS_PER_EXTENSION} 条，忽略「${item.id}」`
              : '状态栏条目已达全局上限，忽略新条目'
          )
        }
        return
      }
    }
    items.set(item.id, item)
    this.scheduleContributions()
  }

  private totalStatusItems(): number {
    let total = 0
    for (const items of this.statusBarItems.values()) total += items.size
    return total
  }

  private clearExtensionRuntime(id: string): void {
    this.statusBarItems.delete(id)
    for (const [command, registration] of [...this.runtimeCommands]) {
      if (registration.extensionId === id) this.runtimeCommands.delete(command)
    }
    for (const [viewType, owner] of [...this.serializers]) {
      if (owner === id) this.serializers.delete(viewType)
    }
    for (const record of this.webviews.removeOf(id)) {
      this.postToRenderer({ type: 'webview.dispose', panelId: record.panelId })
      this.forgetWebview(record.panelId)
    }
    this.scheduleContributions()
  }

  // ---------- 宿主请求 ----------

  private async handleHostRequest(
    rec: HostRecord,
    host: ExtensionHostProcess,
    message: HostRequest
  ): Promise<void> {
    const requestId = message.requestId
    try {
      if (message.extensionId && !rec.extensionIds.includes(message.extensionId)) {
        throw new Error(`扩展 ${message.extensionId} 不属于宿主 #${rec.hostId}`)
      }
      switch (message.kind) {
        case 'command.execute': {
          const value = await this.executeCommand(message.command, message.args, 'code')
          host.respond(requestId, true, value)
          return
        }
        case 'commands.list': {
          host.respond(requestId, true, this.commandIds())
          return
        }
        case 'extension.activate': {
          await this.activateExtension(message.targetExtensionId, 'api')
          host.respond(requestId, true)
          return
        }
        case 'document.flush': {
          host.respond(requestId, true, await this.saveDocument(message.uri))
          return
        }
        case 'message.show': {
          const value = await this.requestUi(id => ({
            type: 'ui.showMessage',
            requestId: id,
            ...(message.extensionId ? { extensionId: message.extensionId } : {}),
            options: {
              level: message.level,
              message: message.message,
              ...(message.detail !== undefined ? { detail: message.detail } : {}),
              items: message.items,
              modal: message.modal
            }
          }))
          host.respond(requestId, true, Array.isArray(value) ? null : value)
          return
        }
        case 'inputBox.show': {
          const value = await this.requestUi(id => ({
            type: 'ui.showInputBox',
            requestId: id,
            ...(message.extensionId ? { extensionId: message.extensionId } : {}),
            options: {
              ...(message.options.title !== undefined ? { title: message.options.title } : {}),
              ...(message.options.prompt !== undefined ? { prompt: message.options.prompt } : {}),
              ...(message.options.placeHolder !== undefined
                ? { placeHolder: message.options.placeHolder }
                : {}),
              ...(message.options.value !== undefined ? { value: message.options.value } : {}),
              ...(message.options.password !== undefined ? { password: message.options.password } : {}),
              ...(message.options.ignoreFocusOut !== undefined
                ? { ignoreFocusOut: message.options.ignoreFocusOut }
                : {})
            }
          }))
          host.respond(requestId, true, Array.isArray(value) ? null : value)
          return
        }
        case 'quickPick.show': {
          const value = await this.requestUi(id => ({
            type: 'ui.showQuickPick',
            requestId: id,
            ...(message.extensionId ? { extensionId: message.extensionId } : {}),
            options: {
              ...(message.options.title !== undefined ? { title: message.options.title } : {}),
              ...(message.options.placeHolder !== undefined
                ? { placeHolder: message.options.placeHolder }
                : {}),
              ...(message.options.canPickMany !== undefined
                ? { canPickMany: message.options.canPickMany }
                : {}),
              ...(message.options.ignoreFocusOut !== undefined
                ? { ignoreFocusOut: message.options.ignoreFocusOut }
                : {}),
              ...(message.options.matchOnDescription !== undefined
                ? { matchOnDescription: message.options.matchOnDescription }
                : {}),
              ...(message.options.matchOnDetail !== undefined
                ? { matchOnDetail: message.options.matchOnDetail }
                : {}),
              items: message.items.map(item => ({
                label: item.label,
                ...(item.description !== undefined ? { description: item.description } : {}),
                ...(item.detail !== undefined ? { detail: item.detail } : {}),
                ...(item.picked !== undefined ? { picked: item.picked } : {})
              }))
            }
          }))
          const picked = message.options.canPickMany
            ? Array.isArray(value)
              ? value
              : value
                ? [value]
                : null
            : Array.isArray(value)
              ? (value[0] ?? null)
              : value
          host.respond(requestId, true, picked)
          return
        }
        case 'configuration.update': {
          if (!message.key.startsWith(`${message.extensionId}.`)) {
            throw new Error(`扩展只能修改自己命名空间下的配置：${message.key}`)
          }
          await this.writePreference(message.extensionId, current => ({
            ...current,
            config: { ...current.config, [message.key]: message.value }
          }))
          host.respond(requestId, true)
          return
        }
        case 'secret.get': {
          host.respond(
            requestId,
            true,
            await getSecret(secretPath(message.extensionId, message.key))
          )
          return
        }
        case 'secret.store': {
          await setSecret(secretPath(message.extensionId, message.key), message.value)
          // 宿主自己会 fire onDidChange；main 只落盘，不能再推一遍
          host.respond(requestId, true)
          return
        }
        case 'secret.delete': {
          await setSecret(secretPath(message.extensionId, message.key), null)
          host.respond(requestId, true)
          return
        }
        case 'editor.applyEdits': {
          const value = await this.requestRenderer(
            {
              op: 'applyEdits',
              uri: message.uri,
              edits: message.edits,
              ...(message.expectedVersion !== undefined
                ? { expectedVersion: message.expectedVersion }
                : {})
            },
            20000
          )
          host.respond(requestId, true, value)
          return
        }
        case 'editor.setSelections': {
          const value = await this.requestRenderer({
            op: 'setSelections',
            uri: message.uri,
            selections: message.selections
          })
          host.respond(requestId, true, value)
          return
        }
        case 'editor.reveal': {
          const value = await this.requestRenderer({
            op: 'reveal',
            uri: message.uri,
            range: message.range,
            revealType: message.revealType
          })
          host.respond(requestId, true, value)
          return
        }
        case 'editor.showDocument': {
          const value = await this.requestRenderer({
            op: 'openDocument',
            uri: message.uri,
            options: message.options
          })
          host.respond(requestId, true, value)
          return
        }
        case 'documents.open': {
          const existed = Boolean(this.documents.get(message.uri))
          const state = await this.documents.ensureFromDisk(message.uri)
          if (!existed) this.broadcastToHosts({ kind: 'document.opened', document: state })
          host.respond(requestId, true, state)
          return
        }
        case 'documents.resync': {
          const state = await this.documents.resync(message.uri)
          host.respond(requestId, true, state)
          return
        }
        case 'workspace.saveAll': {
          const value = await this.requestRenderer(
            { op: 'saveAll', includeUntitled: message.includeUntitled },
            60000
          )
          host.respond(requestId, true, value === true)
          return
        }
        case 'markdown.render': {
          let html: string
          if (this.options.renderMarkdown) {
            html = await this.options.renderMarkdown(message.text)
          } else {
            try {
              // 渲染真身在渲染层：走同一条 request/response 通道，复用正文那份
              // markdown-it（含 KaTeX、Mermaid 与链接校验）。
              html = String(
                await this.requestRenderer({
                  op: 'renderMarkdown',
                  text: message.text,
                  theme: this.theme.kind === 'dark' ? 'dark' : 'light'
                })
              )
            } catch {
              // 渲染层未就绪（无窗口的验收、启动早期）：退回源码，不让调用方拿到空串
              html = message.text
            }
          }
          host.respond(requestId, true, html)
          return
        }
        case 'webview.create': {
          const entry = this.entries.get(message.extensionId)
          if (!entry) throw new Error(`扩展 ${message.extensionId} 未安装`)
          const { record, result } = this.webviews.create(
            message.extensionId,
            entry.root,
            message.options
          )
          host.respond(requestId, true, result)
          this.postWebviewCreate(record)
          this.persistWebviews()
          return
        }
      }
    } catch (err) {
      host.respond(requestId, false, undefined, errorDto(err))
    }
  }

  // ---------- 命令 ----------

  async executeCommand(
    command: string,
    args: readonly unknown[] = [],
    _from: ExtensionCommandInvocation['from'] = 'code'
  ): Promise<unknown> {
    const owner = this.commandOwner(command)
    if (!owner) throw new Error(`未知命令：${command}`)
    await this.activateExtension(owner, 'command')
    const hostId = this.hostPlan.byExtension.get(owner)
    const rec = hostId !== undefined ? this.hosts.get(hostId) : null
    if (!rec?.process || rec.state !== 'running') throw new Error(`扩展 ${owner} 的宿主没有运行`)
    const registration = this.runtimeCommands.get(command)
    if (!registration || registration.extensionId !== owner) {
      throw new Error(`命令「${command}」没有处理器`)
    }
    return rec.process.requestCommand(command, [...args], this.options.commandTimeoutMs ?? 120000)
  }

  private commandOwner(command: string): string | null {
    const runtime = this.runtimeCommands.get(command)
    if (runtime) return runtime.extensionId
    return this.declaredCommandOwners.get(command) ?? null
  }

  private commandIds(): string[] {
    const ids = new Set<string>(this.declaredCommandOwners.keys())
    for (const [command, registration] of this.runtimeCommands) {
      if (this.isEnabled(registration.extensionId)) ids.add(command)
    }
    return [...ids].sort()
  }

  private rebuildDeclaredCommands(): void {
    this.declaredCommandOwners.clear()
    const entries = [...this.entries.values()]
      .filter(entry => entry.enabled && !entry.loadError)
      .sort((a, b) => a.id.localeCompare(b.id))
    for (const entry of entries) {
      for (const command of entry.manifest.contributes?.commands ?? []) {
        if (!this.declaredCommandOwners.has(command.command)) {
          this.declaredCommandOwners.set(command.command, entry.id)
        }
      }
    }
  }

  // ---------- 设置变更 ----------

  private onSettingsChanged(next: Awaited<ReturnType<typeof loadSettings>>, prev: typeof next): void {
    if (this.disposing) return
    const nextHost = next.extensionHost ?? { mode: 'isolated' as const, affinity: {} }
    const hostChanged = !sameHostSettings(this.hostSettings, nextHost)
    this.hostSettings = nextHost
    const { toDeactivate, toActivate, enabledChanged } = this.applyPreferenceChanges(
      next.extensions ?? {}
    )
    for (const id of toDeactivate) void this.deactivateExtension(id, { forget: true })
    if (hostChanged || enabledChanged) this.applyHostPlan()
    // 启动之后才被启用的扩展:onStartupFinished / * 已经过去了，但用户点「启用」
    // 的意图就是让它现在跑起来。不补这一次激活，状态栏、webview 与任何在
    // activate() 里注册的东西都要等到下一次重启或命令触发才出现。
    if (this.startupDone) {
      for (const id of toActivate) {
        const entry = this.entries.get(id)
        const events = entry?.manifest.activationEvents ?? []
        const missedStartup = events.includes('*') || events.includes('onStartupFinished')
        const missedLanguage =
          events.includes('onLanguage:markdown') &&
          this.documents.list().some(doc => doc.languageId === 'markdown')
        if (!entry || !entryFileOf(entry.manifest) || (!missedStartup && !missedLanguage)) continue
        void this.activateExtension(id, missedStartup ? 'startup' : 'language').catch(err => {
          this.logStore.add(id, 'error', `启用后激活失败：${errorMessage(err)}`)
        })
      }
    }
    if (next.vaultPath !== prev.vaultPath) this.refreshWorkspaceFolders()
    this.scheduleContributions()
  }

  private applyPreferenceChanges(nextPrefs: Record<string, ExtensionPreference>): {
    toDeactivate: string[]
    toActivate: string[]
    enabledChanged: boolean
  } {
    const previous = this.preferences
    this.preferences = nextPrefs
    const toDeactivate: string[] = []
    const toActivate: string[] = []
    let enabledChanged = false
    for (const entry of this.entries.values()) {
      const before = entry.enabled
      const preference = nextPrefs[entry.id]
      entry.enabled = preference?.enabled !== false
      if (before !== entry.enabled) {
        enabledChanged = true
        if (!entry.enabled) toDeactivate.push(entry.id)
        if (entry.enabled) toActivate.push(entry.id)
        if (entry.enabled && this.runtime.get(entry.id)?.status === 'disabled') {
          this.setRuntimeStatus(entry.id, 'inactive', { lastError: null, activationFailures: 0 })
        }
        if (!entry.enabled) this.setRuntimeStatus(entry.id, 'disabled')
      }
      if (entry.enabled && before) {
        const beforeConfig = JSON.stringify(previous[entry.id]?.config ?? {})
        const afterConfig = JSON.stringify(preference?.config ?? {})
        if (beforeConfig !== afterConfig) this.pushConfig(entry.id)
      }
    }
    // 声明命令的归属只含启用中的扩展；启用/禁用后必须重算，否则命令面板
    // 里刚出现的命令会因为“没有 owner”而执行失败
    if (enabledChanged) this.rebuildDeclaredCommands()
    return { toDeactivate, toActivate, enabledChanged }
  }

  private async writePreference(
    id: string,
    mutate: (current: ExtensionPreference) => ExtensionPreference
  ): Promise<void> {
    const settings = await loadSettings()
    const preferences = settings.extensions ?? {}
    const current = preferences[id] ?? { enabled: true, config: {} }
    const next = mutate(current)
    await saveSettings({ extensions: { ...preferences, [id]: next } })
  }

  private async removePreference(id: string): Promise<void> {
    const settings = await loadSettings()
    const preferences = { ...(settings.extensions ?? {}) }
    if (!(id in preferences)) return
    delete preferences[id]
    await saveSettings({ extensions: preferences })
  }

  private pushConfig(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.pushToExtensionHost(id, {
      kind: 'configuration.changed',
      extensionId: id,
      values: this.configFor(entry)
    })
  }

  private pushToExtensionHost(id: string, message: MainToHostMessage): void {
    const hostId = this.hostPlan.byExtension.get(id)
    if (hostId === undefined) return
    const rec = this.hosts.get(hostId)
    if (!rec?.process || rec.state !== 'running') return
    if (!rec.extensionIds.includes(id)) return
    rec.process.send(message)
  }

  // ---------- 文档 / 编辑器 / renderer ----------

  handleRendererMessage(message: RendererToMainMessage): void {
    switch (message.type) {
      case 'editor.ready':
        this.handleEditorReady(message.payload)
        return
      case 'editor.documentOpened': {
        this.documents.opened(message.document)
        this.broadcastToHosts({ kind: 'document.opened', document: message.document })
        this.updateContext({
          hasEditor: true,
          resourceLangId: message.document.languageId,
          isDirty: this.anyDirty()
        })
        if (message.document.languageId === 'markdown') {
          void this.activateEvent('onLanguage:markdown', 'language')
        }
        return
      }
      case 'editor.documentChanged': {
        const state = this.documents.changed(message.change)
        if (!state) {
          this.postToRenderer({ type: 'editor.resync', uri: message.change.uri })
          return
        }
        this.broadcastToHosts({ kind: 'document.changed', change: message.change })
        this.updateContext({ isDirty: this.anyDirty() })
        return
      }
      case 'editor.documentClosed':
        this.documents.closed(message.uri)
        this.broadcastToHosts({ kind: 'document.closed', uri: message.uri })
        this.updateContext({
          hasEditor: this.documents.active !== null || this.documents.visible.length > 0,
          isDirty: this.anyDirty()
        })
        return
      case 'editor.documentSaved':
        this.documents.saved(message.uri, message.version)
        this.broadcastToHosts({ kind: 'document.saved', uri: message.uri, version: message.version })
        this.updateContext({ isDirty: this.anyDirty() })
        return
      case 'editor.activeChanged':
        this.documents.setActive(message.uri, message.visible)
        this.broadcastToHosts({
          kind: 'editor.activeChanged',
          uri: message.uri,
          visible: message.visible
        })
        this.updateContext({
          hasEditor: message.uri !== null || message.visible.length > 0,
          resourceLangId: message.uri ? (this.documents.get(message.uri)?.languageId ?? null) : null
        })
        if (message.uri) {
          const active = this.documents.get(message.uri)
          if (active?.languageId === 'markdown') void this.activateEvent('onLanguage:markdown', 'language')
        }
        return
      case 'editor.selectionChanged':
        this.broadcastToHosts({
          kind: 'editor.selectionChanged',
          uri: message.uri,
          selections: message.selections
        })
        return
      case 'editor.contextChanged':
        this.updateContext(message.context)
        return
      case 'editor.themeChanged':
        this.theme = message.theme
        this.broadcastToHosts({ kind: 'theme.changed', theme: message.theme })
        for (const panel of this.webviews.list()) {
          this.postToRenderer({
            type: 'webview.injectTheme',
            panelId: panel.panelId,
            colors: message.theme.colors
          })
        }
        return
      case 'editor.response':
        this.handleEditorResponse(message)
        return
      case 'webview.message': {
        const record = this.webviews.get(message.panelId)
        if (!record) return
        const hostId = this.hostPlan.byExtension.get(record.extensionId)
        const rec = hostId !== undefined ? this.hosts.get(hostId) : null
        if (!rec?.process || rec.state !== 'running') return
        rec.process.send({
          kind: 'webview.message',
          panelId: record.panelId,
          message: message.message
        })
        return
      }
      case 'webview.viewState': {
        const record = this.webviews.get(message.panelId)
        if (!record) return
        this.webviews.setViewState(record, message.visible, message.active)
        this.pushWebviewMessage(record.extensionId, {
          kind: 'webview.viewState',
          panelId: record.panelId,
          visible: message.visible,
          active: message.active
        })
        this.persistWebviews()
        return
      }
      case 'webview.disposed': {
        const record = this.webviews.remove(message.panelId)
        if (!record) return
        this.pushWebviewMessage(record.extensionId, {
          kind: 'webview.disposed',
          panelId: record.panelId
        })
        this.forgetWebview(record.panelId)
        return
      }
      case 'command.execute':
        void this.executeCommand(message.command, message.args ?? [], message.from).catch(err => {
          this.logCommandError(err)
        })
        return
      case 'ui.response':
        this.settleUi(message.requestId, message.value)
        return
      case 'extensions.requestReload':
        void this.reloadExtension(message.extensionId).catch(err => {
          this.postUiError(`重新加载 ${message.extensionId} 失败：${errorMessage(err)}`)
        })
        return
      case 'extensions.setEnabled':
        void this.setEnabled(message.extensionId, message.enabled).catch(err => {
          this.postUiError(`切换启用状态失败：${errorMessage(err)}`)
        })
        return
    }
  }

  private handleEditorReady(payload: {
    documents: DocumentStateDto[]
    activeDocumentUri: string | null
    visibleDocumentUris: string[]
    context: ExtensionContextKeys
    theme: ThemeDto
  }): void {
    this.rendererReady = true
    this.documents.resetFromRenderer(
      payload.documents.slice(0, MAX_OPEN_DOCUMENTS),
      payload.activeDocumentUri,
      payload.visibleDocumentUris
    )
    this.theme = payload.theme
    this.updateContext({
      ...payload.context,
      hasVault: this.workspaceFolders.length > 0,
      workspaceFolderCount: this.workspaceFolders.length,
      hasEditor: payload.activeDocumentUri !== null || payload.visibleDocumentUris.length > 0,
      isDirty: this.anyDirty()
    })
    for (const rec of this.hosts.values()) {
      if (!rec.process || rec.state !== 'running') continue
      for (const doc of this.documents.list().slice(0, MAX_OPEN_DOCUMENTS)) {
        rec.process.send({ kind: 'document.opened', document: { ...doc } })
      }
      rec.process.send({
        kind: 'editor.activeChanged',
        uri: this.documents.active,
        visible: this.documents.visible
      })
      rec.process.send({ kind: 'theme.changed', theme: this.theme })
    }
    this.broadcastWorkspaceFolders()
    this.postToRenderer({
      type: 'extensions.webviewPanels',
      panels: this.webviews.list().map(record => ({
        ...this.webviews.stateOf(record),
        extensionId: record.extensionId,
        html: record.html,
        token: record.token,
        viewType: record.viewType,
        retainContextWhenHidden: record.retainContextWhenHidden
      }))
    })
    this.scheduleContributions()
    if (this.documents.active) {
      const active = this.documents.get(this.documents.active)
      if (active?.languageId === 'markdown') void this.activateEvent('onLanguage:markdown', 'language')
    }
  }

  private handleEditorResponse(message: Extract<RendererToMainMessage, { type: 'editor.response' }>): void {
    const pending = this.pendingRenderer.get(message.requestId)
    if (!pending) return
    this.pendingRenderer.delete(message.requestId)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error ?? '编辑器请求失败'))
  }

  private settleUi(requestId: string, value: string | string[] | null): void {
    const pending = this.pendingUi.get(requestId)
    if (!pending) return
    this.pendingUi.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(value ?? null)
  }

  private requestRenderer(request: EditorRequestDto, timeoutMs = 20000): Promise<unknown> {
    if (!this.rendererSender) return Promise.reject(new Error('编辑器界面尚未就绪'))
    const requestId = `ed-${++this.rendererSeq}`
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pendingRenderer.delete(requestId)
        reject(new Error(`编辑器请求 ${request.op} 超时`))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRenderer.set(requestId, { resolve: resolvePromise, reject, timer })
      this.postToRenderer({ type: 'editor.request', requestId, request })
    })
  }

  private requestUi(
    build: (requestId: string) => MainToRendererMessage,
    timeoutMs = 300000
  ): Promise<string | string[] | null> {
    if (!this.rendererSender) return Promise.resolve(null)
    const requestId = `ui-${++this.uiSeq}`
    return new Promise<string | string[] | null>(resolvePromise => {
      const timer = setTimeout(() => {
        this.pendingUi.delete(requestId)
        resolvePromise(null)
      }, timeoutMs)
      timer.unref?.()
      this.pendingUi.set(requestId, { resolve: resolvePromise, timer })
      this.postToRenderer(build(requestId))
    })
  }

  private postToRenderer(message: MainToRendererMessage): void {
    const sender = this.rendererSender
    if (!sender) return
    try {
      sender(message)
    } catch {
      /* 窗口关闭中：消息丢弃，不等价于扩展失败 */
    }
  }

  private postUiError(message: string): void {
    this.postToRenderer({
      type: 'ui.showMessage',
      requestId: `ui-${++this.uiSeq}`,
      options: { level: 'error', message, items: [], modal: false }
    })
  }

  private logCommandError(err: unknown): void {
    const message = errorMessage(err)
    console.error(`[iMark] 扩展命令执行失败：${message}`)
    this.postUiError(message)
  }

  private async saveDocument(uri: string): Promise<boolean> {
    if (!uri) return false
    try {
      const value = await this.requestRenderer({ op: 'saveDocument', uri }, 30000)
      return value === true || (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true)
    } catch {
      return false
    }
  }

  private anyDirty(): boolean {
    for (const uri of this.documents.visible) {
      if (this.documents.get(uri)?.isDirty) return true
    }
    return false
  }

  private updateContext(patch: Partial<ExtensionContextKeys>): void {
    // Patch 里的 undefined 表示“这次不提这个键”，不能把上下文键真的删掉
    const next: ExtensionContextKeys = { ...this.context }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key] = value
    }
    if (JSON.stringify(next) === JSON.stringify(this.context)) return
    this.context = next
    this.scheduleContributions()
  }

  private broadcastToHosts(message: MainToHostMessage): void {
    for (const rec of this.hosts.values()) {
      if (!rec.process || rec.state !== 'running') continue
      rec.process.send(message)
    }
  }

  private pushWebviewMessage(extensionId: string, message: MainToHostMessage): void {
    const hostId = this.hostPlan.byExtension.get(extensionId)
    const rec = hostId !== undefined ? this.hosts.get(hostId) : null
    if (!rec?.process || rec.state !== 'running') return
    rec.process.send(message)
  }

  // ---------- 工作区 / 主题 ----------

  private refreshWorkspaceFolders(): void {
    const root = this.options.getWorkspaceRoot?.() ?? getSettingsSync()?.vaultPath ?? null
    const folders: WorkspaceFolderDto[] = root
      ? [{ uri: pathToFileURL(root).toString(), name: basename(root) || root }]
      : []
    const changed = JSON.stringify(folders) !== JSON.stringify(this.workspaceFolders)
    this.workspaceFolders = folders
    this.updateContext({
      hasVault: folders.length > 0,
      workspaceFolderCount: folders.length
    })
    if (changed) this.broadcastWorkspaceFolders()
  }

  private broadcastWorkspaceFolders(): void {
    this.broadcastToHosts({
      kind: 'workspaceFolders.changed',
      folders: this.workspaceFolders.map(folder => ({ ...folder }))
    })
  }

  // ---------- 视图 ----------

  private buildViewSync(id: string): ExtensionView {
    const entry = this.entries.get(id)!
    const config = this.configFor(entry)
    const version: ExtensionView = {
      descriptor: entry.descriptor,
      enabled: entry.enabled,
      source: entry.source,
      runtime: this.runtimeInfoFor(id),
      status: this.statusSnapshotFor(id),
      config,
      secrets: {},
      logs: this.logStore.list(id),
      ...(entry.installed ? { installed: entry.installed } : {}),
      ...(entry.dev ? { dev: true } : {}),
      ...(entry.loadError ? { loadError: entry.loadError } : {})
    }
    return version
  }

  /** 设置页需要的掩码是异步解密的；IPC 层用这个版本 */
  async getExtensionViewWithSecrets(id: string): Promise<ExtensionView | null> {
    const entry = this.entries.get(id)
    if (!entry) return null
    const view = this.buildViewSync(id)
    view.secrets = await secretHints(secretKeysOf(entry, view.config))
    return view
  }

  async getExtensionViewsWithSecrets(): Promise<ExtensionView[]> {
    const out: ExtensionView[] = []
    for (const id of [...this.entries.keys()].sort()) {
      const view = await this.getExtensionViewWithSecrets(id)
      if (view) out.push(view)
    }
    return out
  }

  private runtimeInfoFor(id: string): ExtensionRuntimeInfo {
    const info = this.runtime.get(id) ?? this.defaultRuntime(id)
    const hostId = this.hostPlan.byExtension.get(id) ?? null
    const rec = hostId !== null ? this.hosts.get(hostId) : null
    return { ...info, hostId, pid: rec?.pid ?? null }
  }

  private statusSnapshotFor(id: string): ExtensionStatusSnapshot {
    return (
      this.statusSnapshots.get(id) ?? {
        status: 'idle',
        lastRunAt: null,
        lastMessage: ''
      }
    )
  }

  private defaultRuntime(id: string): ExtensionRuntimeInfo {
    return {
      status: this.isEnabled(id) ? 'inactive' : 'disabled',
      hostId: null,
      pid: null,
      lastError: null,
      activationFailures: 0
    }
  }

  private setRuntimeStatus(
    id: string,
    status: ExtensionRuntimeStatus,
    patch: Partial<ExtensionRuntimeInfo> = {}
  ): void {
    const current = this.runtime.get(id) ?? this.defaultRuntime(id)
    this.runtime.set(id, { ...current, ...patch, status })
    this.scheduleContributions()
  }

  private activationFailuresReset(id: string): void {
    const info = this.runtime.get(id)
    if (info) {
      info.activationFailures = 0
      info.lastError = null
      info.autoRestartDisabled = false
    }
  }

  private isEnabled(id: string): boolean {
    return this.entries.get(id)?.enabled === true
  }

  private memoryOf(pid: number | null): number | null {
    if (!pid) return null
    try {
      const metric = app.getAppMetrics().find(item => item.pid === pid)
      return metric ? Math.round(metric.memory.workingSetSize * 1024) : null
    } catch {
      return null
    }
  }

  private logStorePath(id: string): string {
    return extensionLogPath(id)
  }

  private scheduleContributions(): void {
    if (this.contributionsTimer) return
    this.contributionsTimer = setTimeout(() => {
      this.contributionsTimer = null
      if (this.disposing) return
      const snapshot = this.getContributions()
      // 菜单在窗口之前就存在：即使渲染层还没报到，贡献点也要推给菜单
      try {
        this.options.onContributions?.(snapshot)
      } catch (err) {
        console.error(`[iMark] 同步扩展贡献点到菜单失败：${errorMessage(err)}`)
      }
      if (!this.rendererReady) return
      this.postToRenderer({ type: 'extensions.contributions', snapshot })
    }, 40)
    this.contributionsTimer.unref?.()
  }

  // ---------- 扩展记录 ----------

  private async reloadEntries(): Promise<void> {
    if (this.refreshing) return this.refreshing
    let run: Promise<void>
    run = this.doReloadEntries().finally(() => {
      if (this.refreshing === run) this.refreshing = null
    })
    this.refreshing = run
    return run
  }

  private async doReloadEntries(): Promise<void> {
    const previous = new Map(
      [...this.entries].map(([id, entry]) => [id, entrySignature(entry)] as const)
    )
    invalidateInstalledCache()
    const manifests = await scanInstalled()
    const next = new Map<string, ExtensionEntry>()
    for (const [id, manifest] of manifests) {
      const record = await getRecord(id)
      const preference = this.preferences[id]
      const entry: ExtensionEntry = {
        id,
        root: extensionDir(id),
        manifest,
        descriptor: descriptorFromManifest(manifest),
        enabled: preference?.enabled !== false,
        source: record?.source ?? 'local',
        installed: record ? installInfoOf(record) : null,
        dev: false
      }
      next.set(id, entry)
    }
    const changed = new Set<string>()
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      if (previous.get(id) !== entrySignature(next.get(id))) changed.add(id)
    }
    this.entries.clear()
    for (const [id, entry] of next) this.entries.set(id, entry)
    for (const id of [...this.runtime.keys()]) {
      if (!next.has(id)) {
        this.runtime.delete(id)
        this.statusSnapshots.delete(id)
        this.wantActive.delete(id)
        this.activated.delete(id)
      }
    }
    for (const entry of next.values()) {
      if (!this.runtime.has(entry.id)) this.runtime.set(entry.id, this.defaultRuntime(entry.id))
      const info = this.runtime.get(entry.id)!
      if (!entry.enabled) info.status = 'disabled'
      else if (info.status === 'disabled') info.status = 'inactive'
    }
    this.rebuildDeclaredCommands()
    this.applyHostPlan(changed)
    this.scheduleContributions()
  }

  /** 给桥接层/验收用：重新扫描安装目录（升级、手工拷贝目录之后） */
  async refreshInstalled(): Promise<void> {
    await this.reloadEntries()
  }

  private configFor(entry: ExtensionEntry): Record<string, unknown> {
    const stored = this.preferences[entry.id]?.config ?? {}
    const config: Record<string, unknown> = {}
    for (const field of entry.descriptor.settingsFields) {
      const fullKey = `${entry.id}.${field.key}`
      config[fullKey] = normalizeFieldValue(field, stored[fullKey])
    }
    return config
  }
}

// ---------- 单例 ----------

let singleton: ExtensionService | null = null
let initPromise: Promise<ExtensionService> | null = null

export async function initExtensions(
  options: ExtensionServiceOptions = {}
): Promise<ExtensionService> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const service = new ExtensionService(options)
    await service.init()
    singleton = service
    return service
  })()
  return initPromise
}

export function getExtensionService(): ExtensionService | null {
  return singleton
}

export async function shutdownExtensions(): Promise<void> {
  const service = singleton
  singleton = null
  initPromise = null
  if (service) await service.shutdown()
}
