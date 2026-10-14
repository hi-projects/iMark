import { IPC } from '@shared/ipc-channels'
import {
  secretKey,
  targetSecretSlot,
  type PluginConfigEntry,
  type PluginField,
  type PluginTarget,
  type PluginView
} from '@shared/plugins'
import type { PluginActionResult } from '@shared/plugins'
import { getSettings, saveSettings } from '../settings'
import { secretHints, setSecret } from '../secrets'
import { getMainWindow } from '../window'
import { builtinPlugins } from './registry'
import type { MainPlugin, PluginContext } from './types'

/** 让渲染层保存脏文档的等待上限:超时就按磁盘现状继续,不阻塞同步 */
const FLUSH_TIMEOUT = 2000

interface Entry {
  plugin: MainPlugin
  config: Record<string, unknown>
  state: {
    enabled: boolean
    status: 'idle' | 'running' | 'ok' | 'error'
    lastRunAt: number | null
    lastMessage: string
    lastDetail?: string
  }
}

let host: PluginHost | null = null

export class PluginHost {
  private entries = new Map<string, Entry>()
  private pendingFlush: (() => void) | null = null

  /** 应用启动时调用(settings 已载入):归一化配置并启动已启用的插件 */
  async init(): Promise<void> {
    const settings = await getSettings()
    for (const plugin of builtinPlugins) {
      const stored = settings.plugins[plugin.id]
      this.entries.set(plugin.id, {
        plugin,
        config: normalizeConfig(plugin.descriptor.fields, stored),
        state: {
          enabled: stored?.enabled ?? false,
          status: 'idle',
          lastRunAt: null,
          lastMessage: ''
        }
      })
    }
    for (const entry of this.entries.values()) {
      if (entry.state.enabled) {
        await entry.plugin.onEnable?.(this.contextFor(entry))
      }
    }
    await this.broadcast()
  }

  async list(): Promise<PluginView[]> {
    const out: PluginView[] = []
    for (const entry of this.entries.values()) {
      out.push({
        descriptor: entry.plugin.descriptor,
        config: entry.config,
        secrets: await secretHints(secretKeysOf(entry)),
        state: { ...entry.state }
      })
    }
    return out
  }

  /** 保存启用态与配置;启停或配置变化都会驱动插件生命周期 */
  async save(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<void> {
    const entry = this.require(id)
    const enabled = patch.enabled ?? entry.state.enabled
    const config = normalizeConfig(entry.plugin.descriptor.fields, {
      enabled,
      config: { ...entry.config, ...(patch.config ?? {}) }
    })
    const enabledChanged = enabled !== entry.state.enabled
    const configChanged = JSON.stringify(config) !== JSON.stringify(entry.config)

    entry.config = config
    entry.state.enabled = enabled
    await this.persist(entry)

    const ctx = this.contextFor(entry)
    if (enabledChanged) {
      if (enabled) await entry.plugin.onEnable?.(ctx)
      else await entry.plugin.onDisable?.(ctx)
    } else if (configChanged) {
      await entry.plugin.onConfigChange?.(config, ctx)
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
    const field = entry.plugin.descriptor.fields.find(f => f.key === fieldKey)
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

  async runAction(id: string, actionId: string, targetId?: string): Promise<PluginActionResult> {
    const entry = this.require(id)
    if (!entry.state.enabled) return { ok: false, message: '插件未启用' }
    if (!entry.plugin.runAction) return { ok: false, message: '该插件没有可执行动作' }
    const { actions, targetActions } = entry.plugin.descriptor
    const known = targetId
      ? (targetActions ?? []).some(a => a.id === actionId)
      : actions.some(a => a.id === actionId)
    if (!known) return { ok: false, message: `未知动作:${actionId}` }
    // 界面上只有「状态卡」一处显示结果,所以动作跑完必须把结果写进状态;
    // 插件自己没写(没调用 setState)的话,这里兜底写一次,避免结果无处可见。
    const beforeRunAt = entry.state.lastRunAt
    const result = await entry.plugin.runAction(actionId, this.contextFor(entry), targetId)
    if (entry.state.lastRunAt === beforeRunAt && (result.message || result.detail)) {
      entry.state = {
        ...entry.state,
        status: result.ok ? 'ok' : 'error',
        lastRunAt: Date.now(),
        lastMessage: result.message,
        lastDetail: result.detail
      }
    }
    await this.broadcast()
    return result
  }

  /**
   * 请渲染层把当前脏文档落盘。挂起期间若渲染层回执则立即结束,
   * 超时/无窗口则按磁盘现状继续(不阻塞同步)。
   */
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

  /** 渲染层保存流程结束后的回执 */
  handleFlushDone(): void {
    this.pendingFlush?.()
  }

  /** 应用退出前调用:释放定时器与子进程 */
  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state.enabled) await entry.plugin.onDisable?.(this.contextFor(entry))
    }
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`未知插件:${id}`)
    return entry
  }

  private contextFor(entry: Entry): PluginContext {
    return {
      pluginId: entry.plugin.id,
      getConfig: <T,>() => entry.config as T,
      setState: patch => {
        entry.state = { ...entry.state, ...patch }
        void this.broadcast()
      },
      flushDocument: () => this.flushDocument(),
      isEnabled: () => entry.state.enabled
    }
  }

  private async persist(entry: Entry): Promise<void> {
    const settings = await getSettings()
    const next: PluginConfigEntry = { enabled: entry.state.enabled, config: entry.config }
    await saveSettings({ plugins: { ...settings.plugins, [entry.plugin.id]: next } })
  }

  private async broadcast(): Promise<void> {
    const win = getMainWindow()
    if (!win || win.webContents.isDestroyed()) return
    win.webContents.send(IPC.PluginStatus, await this.list())
  }
}

/** 该插件涉及的全部密钥 key(password 字段 + targets 字段的每个目标) */
function secretKeysOf(entry: Entry): string[] {
  const keys: string[] = []
  for (const field of entry.plugin.descriptor.fields) {
    if (field.kind === 'password') {
      keys.push(secretKey(entry.plugin.id, field.key))
    } else if (field.targetSecret) {
      const targets = (entry.config[field.key] as PluginTarget[] | undefined) ?? []
      for (const t of targets) keys.push(secretKey(entry.plugin.id, field.key, targetSecretSlot(t)))
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

export async function initPluginHost(): Promise<PluginHost> {
  host = new PluginHost()
  await host.init()
  return host
}

export function getPluginHost(): PluginHost | null {
  return host
}
