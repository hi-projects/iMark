/**
 * 插件宿主:配置归一化、启停生命周期、动作调度、状态广播、保存握手,以及
 * **外部插件的加载 / 安装 / 升级 / 卸载**。
 *
 * 与改造前最大的区别:插件不再是「编译进应用的固定清单」,而是磁盘上可增删的目录。
 * 由此带来三条必须守住的纪律:
 *
 * 1. **任何插件的失败都不能影响应用启动**。插件的代码是第三方的,
 *    `onEnable` 里一个未捕获的异常就足以让 `app.whenReady()` 整个 reject。
 *    所以所有「宿主 → 插件」的调用都过 `safeCall()`:try/catch + 超时 + 失败计数熔断。
 * 2. **磁盘是权威**。installed.json 只记录来源信息,启用态与配置仍在 settings.plugins。
 * 3. **升级是原子的**。先把新版本加载起来,成功了才删旧目录;失败就回滚,
 *    绝不出现「升级失败导致插件彻底没了」。
 */

import { existsSync } from 'node:fs'
import { rm, rename } from 'node:fs/promises'
import { IPC } from '@shared/ipc-channels'
import type { ImkApi, PluginContext, PluginRuntime } from '@shared/pluginApi'
import {
  descriptorFromManifest,
  type PluginManifest,
  type PluginPermission
} from '@shared/pluginPackage'
import {
  secretKey,
  targetSecretSlot,
  type PluginConfigEntry,
  type PluginDescriptor,
  type PluginField,
  type PluginInstallInfo,
  type PluginSource,
  type PluginState,
  type PluginTarget,
  type PluginView
} from '@shared/plugins'
import { getSettings, getSettingsSync, saveSettings } from '../settings'
import { deleteSecretsByPrefix, secretHints, setSecret } from '../secrets'
import { getMainWindow } from '../window'
import { createImkApi } from './api'
import { checkAgainstCapability, createCapabilityRuntime } from './capabilities'
import {
  activateStaged,
  cleanupOldDirs,
  getRecord,
  listInstalledIds,
  oldDir,
  pluginDir,
  readPluginManifest,
  removePluginDir,
  removeRecord,
  setRecord,
  type InstalledRecord
} from './installed'
import { builtinPlugins } from './registry'
import { forgetScriptRuntime, loadScriptRuntime } from './script'

/** 让渲染层保存脏文档的等待上限:超时就按磁盘现状继续,不阻塞同步 */
const FLUSH_TIMEOUT = 2000
/** 单次插件调用的超时:插件卡住不能把宿主一起拖住 */
const CALL_TIMEOUT = 10_000
/** 连续失败多少次就熔断 */
const MAX_FAILURES = 3
/** 每个插件保留的日志行数 */
const MAX_LOGS = 50
/** 错误详情截断长度(一次堆栈可能有几十 KB,不能原样进 IPC 与界面) */
const MAX_DETAIL = 4096

export interface InstallMeta {
  version: string
  integrity: string
  mainSha256: string | null
  publisher: string | null
  source: PluginSource
  registryUrl: string | null
  installedAt: number
  grantedPermissions: PluginPermission[]
}

interface Entry {
  id: string
  descriptor: PluginDescriptor
  /** 外部插件才有清单;内置核心插件为 null */
  manifest: PluginManifest | null
  dir: string | null
  meta: PluginInstallInfo | null
  /** 先占位、加载成功后再填 —— 脚本插件的工厂需要拿到 api,而 api 又需要 entry 本身 */
  runtime: PluginRuntime
  api: ImkApi | null
  config: Record<string, unknown>
  state: PluginState
  /** 连续失败次数(成功一次即清零) */
  failures: number
  /** 已被宿主熔断:只有用户在设置里显式重新启停才会恢复 */
  disabledByHost: boolean
  /** 安装/升级期间暂挂:不跑任何生命周期,也不接受动作 */
  suspended: boolean
  logs: string[]
  loadError?: string
}

let host: PluginHost | null = null

export class PluginHost {
  private entries = new Map<string, Entry>()
  private pendingFlush: (() => void) | null = null

  /**
   * 应用启动时调用(settings 已载入)。
   *
   * provision 是「补装内置兜底包」的回调,时机很讲究:它必须排在**扫描之后、启用之前**。
   * 排在扫描之前的话,补装进来的插件会被随后的扫描再加载一遍 —— 届时 onEnable 已经跑过、
   * 定时器已经挂上,第二次加载会把第一份 entry 顶掉并留下一个没人管的定时器(表现为同步跑两次)。
   * 补装只挑「宿主里还没有这个 id」的装,所以放在扫描后面天然只会补上缺的那几个。
   */
  async init(provision?: (host: PluginHost) => Promise<void>): Promise<void> {
    const settings = await getSettings()
    await cleanupOldDirs()

    // ---- 外部插件:以磁盘为准 ----
    for (const id of await listInstalledIds()) {
      const manifest = await readPluginManifest(id)
      if (!manifest) {
        console.error(`[iMark] 插件目录 ${id} 缺少合法的 manifest.json,已跳过`)
        continue
      }
      const record = await getRecord(id)
      try {
        this.loadExternal(id, manifest, record)
      } catch (err) {
        // 单个插件坏掉只影响它自己,应用照常启动
        this.registerBroken(id, manifest, record, err)
      }
    }

    // ---- 内置核心插件(目前为空,机制保留给将来的官方内置能力) ----
    for (const plugin of builtinPlugins) {
      const stored = settings.plugins[plugin.id]
      this.entries.set(plugin.id, {
        id: plugin.id,
        descriptor: plugin.descriptor,
        manifest: null,
        dir: null,
        meta: null,
        runtime: plugin.runtime,
        api: null,
        config: normalizeConfig(plugin.descriptor.fields, stored),
        state: {
          enabled: stored?.enabled ?? false,
          status: 'idle',
          lastRunAt: null,
          lastMessage: ''
        },
        failures: 0,
        disabledByHost: false,
        suspended: false,
        logs: []
      })
    }

    // ---- 补装内置兜底包(只补缺的;全新用户默认不启用兜底插件) ----
    if (provision) {
      try {
        await provision(this)
      } catch (err) {
        // 兜底包补装失败不该拦住整个应用:用户仍然可以照常写作
        console.error('[iMark] 内置插件补装失败:', err)
      }
    }

    for (const entry of this.entries.values()) {
      if (entry.state.enabled && !entry.loadError) await this.enable(entry.id, 'startup')
    }
    await this.broadcast()
  }

  async list(): Promise<PluginView[]> {
    const out: PluginView[] = []
    for (const entry of this.entries.values()) {
      const secretValues = await secretHints(secretKeysOf(entry))
      const view: PluginView = {
        descriptor: entry.descriptor,
        config: entry.config,
        secrets: secretValues,
        state: { ...entry.state },
        ...(entry.manifest ? { kind: entry.manifest.kind } : {}),
        ...(entry.meta ? { source: entry.meta.source, installed: entry.meta } : {}),
        ...(entry.manifest?.permissions ? { permissions: entry.manifest.permissions } : {}),
        ...(entry.failures > 0 ? { failures: entry.failures } : {}),
        ...(entry.disabledByHost ? { disabledByHost: true } : {}),
        ...(entry.logs.length > 0 ? { logs: [...entry.logs] } : {}),
        ...(entry.loadError ? { loadError: entry.loadError } : {})
      }
      out.push(view)
    }
    return out
  }

  /** 保存启用态与配置;启停或配置变化都会驱动插件生命周期 */
  async save(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void> {
    const entry = this.require(id)
    const enabled = patch.enabled ?? entry.state.enabled
    const config = normalizeConfig(entry.descriptor.fields, {
      enabled,
      config: { ...entry.config, ...(patch.config ?? {}) }
    })
    const enabledChanged = enabled !== entry.state.enabled
    const configChanged = JSON.stringify(config) !== JSON.stringify(entry.config)

    entry.config = config
    entry.state.enabled = enabled
    // 用户显式重新启用 = 解除熔断(这是熔断后唯一的恢复路径)
    if (enabled && enabledChanged) {
      entry.disabledByHost = false
      entry.failures = 0
    }
    await this.persist(entry)

    if (enabledChanged) {
      if (enabled) await this.enable(id, 'enable')
      else await this.disable(id, 'disable')
    } else if (configChanged) {
      await this.safeCall(entry, 'onConfigChange', () =>
        entry.runtime.onConfigChange?.(config, this.contextFor(entry))
      )
    }
    await this.broadcast()
  }

  async setSecretValue(
    id: string,
    fieldKey: string,
    targetId: string | null,
    value: string | null
  ): Promise<void> {
    const entry = this.require(id)
    const field = entry.descriptor.fields.find(f => f.key === fieldKey)
    if (!field) throw new Error(`未知字段:${fieldKey}`)
    if (field.kind !== 'password' && !field.targetSecret) {
      throw new Error(`字段 ${fieldKey} 不接受密钥`)
    }
    if (field.kind === 'targets' && value !== null && !targetId) {
      throw new Error('目标列表的密钥必须指定目标')
    }
    await setSecret(secretKey(id, fieldKey, targetId ?? undefined), value)
    await this.broadcast()
  }

  async runAction(id: string, actionId: string, targetId?: string): Promise<{ ok: boolean; message: string; detail?: string }> {
    const entry = this.require(id)
    if (entry.loadError) return { ok: false, message: `插件加载失败:${entry.loadError}` }
    if (entry.suspended) return { ok: false, message: '插件正在安装/升级,请稍候' }
    if (!entry.state.enabled) return { ok: false, message: '插件未启用' }
    if (entry.disabledByHost) {
      return { ok: false, message: '插件已被停用(连续运行失败),请在插件设置里关闭后重新启用' }
    }
    const { actions, targetActions } = entry.descriptor
    const known = targetId
      ? (targetActions ?? []).some(a => a.id === actionId)
      : actions.some(a => a.id === actionId)
    if (!known) return { ok: false, message: `未知动作:${actionId}` }

    // 界面上只有「状态卡」一处显示结果,所以动作跑完必须把结果写进状态;
    // 插件自己没写(没调用 setState)的话,这里兜底写一次,避免结果无处可见。
    const beforeRunAt = entry.state.lastRunAt
    const ctx = this.contextFor(entry)
    let result: { ok: boolean; message: string; detail?: string } = {
      ok: false,
      message: '插件没有响应'
    }
    const succeeded = await this.safeCall(entry, `动作 ${actionId}`, async () => {
      result = (await entry.runtime.runAction?.(actionId, ctx, targetId)) ?? {
        ok: false,
        message: `插件未实现动作:${actionId}`
      }
    })
    if (!succeeded) {
      result = { ok: false, message: entry.state.lastMessage, ...(entry.state.lastDetail ? { detail: entry.state.lastDetail } : {}) }
    }
    if (entry.state.lastRunAt === beforeRunAt && (result.message || result.detail)) {
      entry.state = {
        ...entry.state,
        status: result.ok ? 'ok' : 'error',
        lastRunAt: Date.now(),
        lastMessage: result.message,
        ...(result.detail !== undefined ? { lastDetail: result.detail } : {})
      }
    }
    await this.broadcast()
    return result
  }

  // ---------- 安装 / 升级 / 卸载 ----------

  /**
   * 把暂存目录安装就位。
   *
   * 顺序是刻意的:旧目录先 rename 走(不是删),新版本加载成功后才真正删掉旧目录;
   * 加载失败则把旧目录 rename 回来。这样任何一步失败都不会出现「插件没了」。
   */
  async install(id: string, stagedDir: string, meta: InstallMeta): Promise<void> {
    const previous = this.entries.get(id) ?? null
    const previousMeta = previous?.meta ?? null
    // 必须在 unregister 之前取出来:它是同一个对象的引用,disable 会把 enabled 清掉
    const wasEnabled = previous?.state.enabled ?? false
    const hadPrevious = existsSync(pluginDir(id))
    const backup = oldDir(id)

    await this.unregister(id)
    if (hadPrevious) {
      await rm(backup, { recursive: true, force: true })
      await rename(pluginDir(id), backup)
    }

    try {
      await activateStaged(id, stagedDir)
    } catch (err) {
      if (hadPrevious) await rename(backup, pluginDir(id)).catch(() => {})
      if (previous) await this.restore(previous, wasEnabled)
      throw err instanceof Error ? err : new Error(String(err))
    }

    const record: InstalledRecord = {
      id,
      version: meta.version,
      kind: (await readPluginManifest(id))?.kind ?? 'script',
      integrity: meta.integrity,
      mainSha256: meta.mainSha256,
      publisher: meta.publisher,
      source: meta.source,
      registryUrl: meta.registryUrl,
      installedAt: meta.installedAt,
      grantedPermissions: meta.grantedPermissions
    }

    try {
      const manifest = await readPluginManifest(id)
      if (!manifest) throw new Error('插件包缺少合法的 manifest.json')
      const problems = checkAgainstCapability(manifest)
      if (problems.length > 0) throw new Error(problems.join(';'))
      this.loadExternal(id, manifest, record)
    } catch (err) {
      // 新版本起不来:回滚到旧目录并恢复旧运行时
      await rm(pluginDir(id), { recursive: true, force: true })
      if (hadPrevious) await rename(backup, pluginDir(id)).catch(() => {})
      if (previous) await this.restore(previous, wasEnabled, previousMeta)
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`插件加载失败,已恢复到上一个版本:${reason}`)
    }

    await rm(backup, { recursive: true, force: true }).catch(() => {})
    await setRecord(record)

    // 恢复原有启用态:升级不该把用户开着的插件关掉
    if (wasEnabled) await this.enable(id, 'upgrade')
    await this.broadcast()
  }

  /**
   * 卸载:停用 → 移除运行时 → 删目录 → 清密钥 → 清登记 →(可选)清配置。
   *
   * **密钥一律删除,不受 `removeConfig` 影响,这是有意的。**
   * 配置是偏好(留着,重装回来省得重填),密钥是凭据。凭据的危险在于
   * id 是可以被别人重新认领的:今天卸载的 `git-sync`,明天可能是另一个人发布的
   * 同名插件 —— 它会直接读出这里残留的访问令牌。所以插件一走,它名下的密钥
   * 就必须跟着走,宁可让用户重填一次。
   */
  async uninstall(id: string, options: { removeConfig: boolean }): Promise<void> {
    await this.unregister(id)
    await removePluginDir(id)
    await removeRecord(id)
    // 用前缀删除而不是逐个 secretKeysOf:认证方式切换留下的 #password 槽位也要一起清掉
    await deleteSecretsByPrefix(`${id}:`)

    if (options.removeConfig) {
      const settings = await getSettings()
      if (settings.plugins[id]) {
        const plugins = { ...settings.plugins }
        delete plugins[id]
        await saveSettings({ plugins })
      }
    }
    await this.broadcast()
  }

  /** 读源码预览:返回包内某个文件的文本(渲染层「查看源码」用) */
  installedMeta(id: string): PluginInstallInfo | null {
    return this.entries.get(id)?.meta ?? null
  }

  /** 该插件是否已安装(有目录且有合法清单) */
  isInstalled(id: string): boolean {
    return this.entries.has(id)
  }

  /** 让某个插件暂停响应(安装前用):不跑生命周期,也不接受动作 */
  async suspend(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.suspended = true
    if (entry.state.enabled) await this.disable(id, 'suspend')
  }

  async resume(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.suspended = false
    if (entry.state.enabled) await this.enable(id, 'resume')
  }

  // ---------- 保存握手 ----------

  flushDocument(): Promise<void> {
    const win = getMainWindow()
    if (!win || win.webContents.isDestroyed()) return Promise.resolve()
    return new Promise<void>(resolve => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        this.pendingFlush = null
        resolve()
      }
      this.pendingFlush = done
      win.webContents.send(IPC.PluginFlushDoc)
      setTimeout(done, FLUSH_TIMEOUT)
    })
  }

  handleFlushDone(): void {
    this.pendingFlush?.()
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state.enabled) await this.disable(entry.id, 'quit')
    }
  }

  private async enable(id: string, reason: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.loadError || entry.suspended) return
    if (!entry.state.enabled) entry.state.enabled = true
    void reason
    await this.safeCall(entry, 'onEnable', () => entry.runtime.onEnable?.(this.contextFor(entry)))
  }

  private async disable(id: string, reason: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.state.enabled = false
    void reason
    await this.safeCall(entry, 'onDisable', () => entry.runtime.onDisable?.(this.contextFor(entry)))
  }

  // ---------- 内部 ----------

  /**
   * 加载一个外部插件并登记为可用的 entry(不启用)。
   * 抛出的异常由调用方决定是「回滚」还是「登记为坏插件」。
   */
  private loadExternal(id: string, manifest: PluginManifest, record: InstalledRecord | null): void {
    // 保留用户已有的启用态与配置 —— 这就是「零迁移」的全部秘密:字段 key 没变,
    // normalizeConfig 用新字段表重读旧配置即可,连升级后新增/删除字段都是自洽的。
    const stored = this.storedFor(id)
    const entry: Entry = {
      id,
      descriptor: descriptorFromManifest(manifest),
      manifest,
      dir: pluginDir(id),
      meta: metaOf(record),
      runtime: {},
      api: null,
      config: normalizeConfig(manifest.fields, stored),
      state: {
        enabled: stored?.enabled ?? false,
        status: 'idle',
        lastRunAt: null,
        lastMessage: ''
      },
      failures: 0,
      disabledByHost: false,
      suspended: false,
      logs: []
    }

    this.entries.set(id, entry)
    entry.api = this.apiFor(entry)
    try {
      entry.runtime =
        manifest.kind === 'script'
          ? loadScriptRuntime(entry.dir as string, manifest, entry.api)
          : createCapabilityRuntime(manifest, entry.api)
    } catch (err) {
      this.entries.delete(id)
      throw err
    }
    void this.persist(entry)
  }

  /** 加载失败也要在设置界面里可见、可卸载,否则用户没有任何办法收拾它 */
  private registerBroken(
    id: string,
    manifest: PluginManifest,
    record: InstalledRecord | null,
    err: unknown
  ): void {
    const message = err instanceof Error ? err.message : String(err)
    this.entries.set(id, {
      id,
      descriptor: descriptorFromManifest(manifest),
      manifest,
      dir: pluginDir(id),
      meta: metaOf(record),
      runtime: {},
      api: null,
      config: normalizeConfig(manifest.fields, this.storedFor(id)),
      state: {
        enabled: false,
        status: 'error',
        lastRunAt: Date.now(),
        lastMessage: '插件加载失败',
        lastDetail: message.slice(0, MAX_DETAIL)
      },
      failures: 0,
      disabledByHost: false,
      suspended: false,
      logs: [],
      loadError: message
    })
  }

  /**
   * 回滚后恢复一个插件的运行时(升级失败路径)。
   *
   * `enabled` 必须由调用方传进来,**不能读 `entry.state.enabled`**:传进来的这个
   * `entry` 就是 `unregister()` 里 `disable()` 改过的同一个对象,此刻它已经是 false 了 ——
   * 照着它恢复,会让「升级失败」顺带把用户一直开着的插件悄悄关掉,而且界面上
   * 只留一句「已恢复到上一个版本」,用户根本想不到插件已经不跑了。
   *
   * 恢复的也不只是登记:传了 `enabled` 就**真的把它跑起来**(onEnable)。只把标志位
   * 置真而不跑生命周期,界面写着「已启用」而定时器根本没起,比直接关掉更难排查。
   */
  private async restore(
    entry: Entry,
    enabled: boolean,
    meta?: PluginInstallInfo | null
  ): Promise<void> {
    const id = entry.id
    if (!entry.dir || !entry.manifest) return
    try {
      const manifest = (await readPluginManifest(id)) ?? entry.manifest
      this.loadExternal(id, manifest, null)
      const restored = this.entries.get(id)
      if (restored) {
        // loadExternal 会把状态重置成 idle、失败计数清零,这里把「为什么是红的」
        // 连同熔断的账一起接回来:回滚不该顺手豁免掉之前已经攒下的失败次数
        restored.failures = entry.failures
        restored.disabledByHost = entry.disabledByHost
        restored.state.status = 'error'
        restored.state.lastMessage = '插件升级失败,已恢复到上一个版本'
        restored.state.lastRunAt = Date.now()
        if (meta) restored.meta = meta
      }
      if (enabled) await this.enable(id, 'rollback')
    } catch {
      /* 恢复也失败就只能作罢,至少账是清楚的 */
    }
  }

  /** 移除一个 entry 并停掉它(不碰磁盘) */
  private async unregister(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.state.enabled) await this.disable(id, 'unregister')
    this.entries.delete(id)
    if (entry.dir) forgetScriptRuntime(entry.dir)
  }

  /**
   * 同步读用户存的启用态与配置。
   * 这里刻意不走 `await getSettings()`:install/loadExternal 是同步路径
   * (加载脚本插件要立即拿到 api),而 settings 的模块级缓存此时必定已就绪
   * (init 的第一句就是 `await getSettings()`)。
   */
  private storedFor(id: string): PluginConfigEntry | undefined {
    return getSettingsSync()?.plugins[id]
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`未知插件:${id}`)
    return entry
  }

  private contextFor(entry: Entry): PluginContext {
    return {
      pluginId: entry.id,
      getConfig: <T,>() => entry.config as T,
      setState: patch => {
        entry.state = { ...entry.state, ...patch }
        void this.broadcast()
      },
      flushDocument: () => this.flushDocument(),
      isEnabled: () => entry.state.enabled,
      isDisabledByHost: () => entry.disabledByHost
    }
  }

  /** 造注入给插件的 API(含密钥作用域校验) */
  private apiFor(entry: Entry): ImkApi {
    return createImkApi(this.contextFor(entry), {
      pluginId: entry.id,
      pluginName: entry.descriptor.name,
      pluginVersion: entry.descriptor.version,
      dir: entry.dir ?? '',
      permissions: entry.manifest?.permissions ?? [],
      validateSecretTarget: (fieldKey, targetId) => this.assertSecretTarget(entry, fieldKey, targetId),
      log: line => {
        entry.logs.push(line)
        if (entry.logs.length > MAX_LOGS) entry.logs.splice(0, entry.logs.length - MAX_LOGS)
        console.log(`[plugin:${entry.id}] ${line}`)
      }
    })
  }

  /**
   * 密钥作用域校验。插件永远拿不到也传不了自己的 id,所以只要 id 字符集不含 ':'
   * (见 shared/pluginPackage.ts 的校验规则),它就无法越到别的插件的命名空间。
   */
  private assertSecretTarget(entry: Entry, fieldKey: string, targetId?: string): void {
    const field = entry.descriptor.fields.find(f => f.key === fieldKey)
    if (!field) throw new Error(`未声明的字段:${fieldKey}`)
    if (field.kind === 'password' && !field.targetSecret) {
      if (targetId) throw new Error(`字段 ${fieldKey} 不是目标级密钥`)
      return
    }
    if (!field.targetSecret) throw new Error(`字段 ${fieldKey} 不接受密钥`)
    if (!targetId) throw new Error(`字段 ${fieldKey} 的密钥必须指定目标`)
    const targets = (entry.config[fieldKey] as PluginTarget[] | undefined) ?? []
    const known = targets.some(
      t => t.id === targetId || targetSecretSlot(t) === targetId
    )
    if (!known) throw new Error(`目标 ${targetId} 不在当前配置的「${field.label}」里`)
  }

  /**
   * 包住每一次「宿主 → 插件」的调用。
   * 没有它,一个坏 main.js 的 onEnable 抛异常就会让整个应用起不来。
   */
  private async safeCall(entry: Entry, label: string, fn: () => unknown): Promise<boolean> {
    if (entry.suspended || entry.loadError) return false
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} 超时(超过 ${CALL_TIMEOUT / 1000} 秒)`)),
            CALL_TIMEOUT
          )
        })
      ])
      entry.failures = 0
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error && err.stack ? err.stack : message
      entry.failures += 1
      entry.state = {
        ...entry.state,
        status: 'error',
        lastRunAt: Date.now(),
        lastMessage: `${label} 失败`,
        lastDetail: stack.slice(0, MAX_DETAIL)
      }
      console.error(`[iMark] 插件 ${entry.id} ${label} 失败:`, err)
      if (entry.failures >= MAX_FAILURES) {
        entry.disabledByHost = true
        entry.state = {
          ...entry.state,
          enabled: false,
          lastMessage: `连续 ${entry.failures} 次失败,已自动停用(在设置里重新启用可恢复)`
        }
        // 熔断要落盘,否则重启后又自己跑起来了 —— 「绝不自动恢复」得跨会话成立
        void this.persist(entry)
      }
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async persist(entry: Entry): Promise<void> {
    const settings = await getSettings()
    const next: PluginConfigEntry = { enabled: entry.state.enabled, config: entry.config }
    await saveSettings({ plugins: { ...settings.plugins, [entry.id]: next } })
  }

  private async broadcast(): Promise<void> {
    const win = getMainWindow()
    if (!win || win.webContents.isDestroyed()) return
    win.webContents.send(IPC.PluginStatus, await this.list())
  }
}

/** 登记表记录 → 下发给渲染层的来源信息(只暴露展示需要的字段) */
function metaOf(record: InstalledRecord | null): PluginInstallInfo | null {
  if (!record) return null
  return {
    version: record.version,
    installedAt: record.installedAt,
    integrity: record.integrity,
    publisher: record.publisher,
    source: record.source
  }
}

/** 该插件涉及的全部密钥 key(password 字段 + targets 字段的每个目标) */
function secretKeysOf(entry: Entry): string[] {
  const keys: string[] = []
  for (const field of entry.descriptor.fields) {
    if (field.kind === 'password') {
      keys.push(secretKey(entry.id, field.key))
    } else if (field.targetSecret) {
      const targets = (entry.config[field.key] as PluginTarget[] | undefined) ?? []
      for (const t of targets) keys.push(secretKey(entry.id, field.key, targetSecretSlot(t)))
    }
  }
  return keys
}

/**
 * 按字段表归一化配置:只保留声明过的 key,类型不符就落回默认值。
 * 这样手改 settings.json 或插件升级改字段都不会让主进程拿到脏数据。
 */
export function normalizeConfig(
  fields: PluginField[],
  stored: PluginConfigEntry | undefined
): Record<string, unknown> {
  const raw = (stored?.config ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = raw[field.key]
    switch (field.kind) {
      case 'number': {
        const n = typeof value === 'number' ? value : Number(value)
        let num = Number.isFinite(n) ? n : (field.default as number)
        if (field.min !== undefined) num = Math.max(field.min, num)
        if (field.max !== undefined) num = Math.min(field.max, num)
        out[field.key] = num
        break
      }
      case 'boolean':
        out[field.key] = typeof value === 'boolean' ? value : Boolean(field.default)
        break
      case 'select': {
        const allowed = (field.options ?? []).map(o => o.value)
        out[field.key] = typeof value === 'string' && allowed.includes(value) ? value : field.default
        break
      }
      case 'targets': {
        const list = Array.isArray(value) ? value : (field.default as PluginTarget[])
        out[field.key] = (list as unknown[])
          .filter(t => t && typeof t === 'object')
          .map((t, i) => {
            const o = t as Partial<PluginTarget> & { branch?: unknown }
            // 旧版本只有一个 branch:两个分支都填它(本地分支现在是必填);
            // 更旧的 name(远端名)已废弃;旧的 username 只会是被预填的 'oauth2',视为空
            const legacy = typeof o.branch === 'string' ? o.branch : ''
            const localBranch = typeof o.localBranch === 'string' ? o.localBranch : ''
            const rawUser = typeof o.username === 'string' ? o.username : ''
            const auth: PluginTarget['auth'] =
              o.auth === 'password' || o.auth === 'ssh' || o.auth === 'token' ? o.auth : 'token'
            return {
              id: typeof o.id === 'string' && o.id ? o.id : `t${Date.now().toString(36)}${i}`,
              url: typeof o.url === 'string' ? o.url : '',
              remoteBranch: typeof o.remoteBranch === 'string' ? o.remoteBranch : legacy,
              localBranch: localBranch || legacy,
              auth,
              username: rawUser === 'oauth2' ? '' : rawUser
            } satisfies PluginTarget
          })
        break
      }
      default: {
        // text / password:密钥字段这里存空串占位,真实值在 secrets.json
        out[field.key] = typeof value === 'string' ? value : (field.default as string)
      }
    }
  }
  return out
}

export async function initPluginHost(
  provision?: (host: PluginHost) => Promise<void>
): Promise<PluginHost> {
  host = new PluginHost()
  await host.init(provision)
  return host
}

export function getPluginHost(): PluginHost | null {
  return host
}
