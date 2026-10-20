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

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { rm, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { ImkApi, PluginContext, PluginRuntime } from '@shared/pluginApi'
import {
  descriptorFromManifest,
  type PluginMainMode,
  type PluginManifest,
  type PluginPermission
} from '@shared/pluginPackage'
import {
  commandAvailable,
  secretKey,
  targetSecretSlot,
  type PluginActionPayload,
  type PluginActionResult,
  type PluginConfigEntry,
  type PluginContrib,
  type PluginContribInvoke,
  type PluginContribsSnapshot,
  type PluginDescriptor,
  type PluginEditorInsert,
  type PluginEndpoint,
  type PluginEvent,
  type PluginEventMap,
  type PluginField,
  type PluginInstallInfo,
  type PluginLogEntry,
  type PluginLogLevel,
  type PluginNotice,
  type PluginNoticeLevel,
  type PluginOperation,
  type PluginSource,
  type PluginState,
  type PluginTarget,
  type PluginView
} from '@shared/plugins'
import { dataRoot } from '../dataDir'
import { setKeybindingDropReporter, setPluginCommands } from '../menu'
import { getSettings, getSettingsSync, onSettingsChanged, saveSettings } from '../settings'
import { deleteSecretsByPrefix, secretHints, setSecret } from '../secrets'
import { getMainWindow, hasEditor } from '../window'
import { createImkApi } from './api'
import { ContribRegistry, type ContribKind } from './contrib'
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
import { readDevSource, watchDevSource } from './dev'
import { builtinPlugins } from './registry'
import { forgetScriptRuntime, loadScriptRuntime } from './script'
import { forgetLimits, invokeOp } from './gate'
import type { OpContext } from './ops'
import type { PluginHello } from '@shared/pluginRpc'
import {
  createRestrictedRuntime,
  disposeRestrictedRuntime,
  hasRestrictedRuntime,
  installRestrictedIpc,
  restrictedPluginRuntime,
  unregisterRestrictedRuntime,
  type RestrictedRuntime
} from './restrictedRuntime'
import { clearPluginStorage, closeRestrictedPage, setPluginRoot } from './restrictedPage'
import { installRendererBridge } from './rendererBridge'
import {
  createRenderRuntime,
  initRenderLayer,
  injectRenderLayer,
  isRenderLayerLoaded,
  markAllRenderLayersUnloaded,
  sendToRenderLayer,
  unloadRenderLayer
} from './renderLayer'

/** 让渲染层保存脏文档的等待上限:超时就按磁盘现状继续,不阻塞同步 */
const FLUSH_TIMEOUT = 2000
/** 生命周期调用(onEnable/onDisable/onConfigChange)的超时:插件卡住不能把宿主一起拖住 */
const CALL_TIMEOUT = 10_000
/**
 * 用户主动发起的动作(runAction)的超时。
 *
 * 动作可能真的在跑 git / 网络(例如 git-sync 的「测试连接」一次 `ls-remote` 允许 30 秒),
 * 10 秒会把正常的慢操作误判成宿主超时。仍然有上限,避免一个坏动作永远占着界面。
 */
const ACTION_TIMEOUT = 120_000
/** 连续失败多少次就熔断 */
const MAX_FAILURES = 3
/** 每个插件在内存里保留的日志条数(磁盘文件另存完整历史) */
const MAX_LOGS = 50
/** 设置页「调试」模块保留几条最近操作 */
const MAX_RECENT_OPS = 3
/** 启动时从磁盘日志读回尾巴的字节上限(超出只读最后一段;不完整的首行会被丢掉) */
const LOG_TAIL_BYTES = 256 * 1024

/** 完整插件日志:数据根/logs/plugins/<id>.log(插件 id 已由清单校验为安全文件名) */
function pluginLogFile(id: string): string {
  return join(dataRoot(), 'logs', 'plugins', `${id}.log`)
}

/** 最近 3 条操作的持久化副本;完整版仍在 .log 文件里 */
function pluginRecentFile(id: string): string {
  return join(dataRoot(), 'logs', 'plugins', `${id}.recent.json`)
}

function isPluginOperation(v: unknown): v is PluginOperation {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.at === 'number' &&
    typeof o.action === 'string' &&
    (o.status === 'ok' || o.status === 'partial' || o.status === 'error') &&
    typeof o.message === 'string' &&
    (o.detail === undefined || typeof o.detail === 'string')
  )
}

/** 读回上次留下的最近操作;文件不存在/损坏/被手改都当空的 */
function readRecentOps(id: string): PluginOperation[] {
  try {
    const parsed = JSON.parse(readFileSync(pluginRecentFile(id), 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPluginOperation).slice(0, MAX_RECENT_OPS)
  } catch {
    return []
  }
}

/** 磁盘日志里一条记录的首行:`2026-10-19 19:56:55 [操作] 正文…`;多行明细跟在后面 */
const LOG_HEADER = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[(debug|info|warn|error|操作)\] ?([\s\S]*)$/

/**
 * 读回磁盘日志的尾巴 —— 设置页「插件日志」显示的就是它。
 *
 * **必须重启后也读回来**。「调试」模块里的最近操作是落盘后重新读的(`.recent.json`),
 * 日志尾巴如果每次启动都从空开始,用户就会看到「明明插过三次表,日志只有一条启动信息」
 * (2026-10-20 实测:三次操作留在 .recent.json 里,日志页却只剩本次运行的 `已就绪`)。
 *
 * 正文可能带换行(操作摘要的明细),所以不能一行一条:只有带时间戳头的行开启新记录,
 * 其余行并进上一条。文件从中间截断时,第一条不完整的行会因为匹配不上头而被丢掉。
 */
function readLogTail(id: string): PluginLogEntry[] {
  let text: string
  try {
    const file = pluginLogFile(id)
    const size = statSync(file).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, buf.length, start)
    } finally {
      closeSync(fd)
    }
    text = buf.toString('utf8')
  } catch {
    // 文件不存在是第一次启动的常态,不是错误
    return []
  }

  const entries: PluginLogEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = LOG_HEADER.exec(line)
    if (m) {
      entries.push({
        at: new Date(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6])
        ).getTime(),
        level: m[7] === '操作' ? 'operation' : (m[7] as PluginLogLevel),
        message: m[8] ?? ''
      })
    } else if (entries.length > 0) {
      // 多行正文 / 末尾空行;末尾空行由下面的 trimEnd 去掉
      entries[entries.length - 1]!.message += `\n${line}`
    }
  }
  return entries.slice(-MAX_LOGS).map(e => ({ ...e, message: e.message.trimEnd() }))
}

/** 日志行的时间戳(本地时间) */
function logStamp(at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 插件给的级别只有四档;未知值按 info 收下,日志不该因为错别字丢掉 */
function asLogLevel(level: string): PluginLogLevel {
  return level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
    ? level
    : 'info'
}

/**
 * 当前正在执行的动作(node main)。
 *
 * **不能**用 `entry.currentAction` 给操作归属:它是整个插件共享的一个字段。
 * 后台同步与用户动作并发时,后台那一轮结束时 `currentAction` 还是用户动作的名字,
 * 日志就会把「推送失败」记成「测试全部远端」(2026-10-18 实测)。
 *
 * AsyncLocalStorage 让标签跟着**异步调用链**走:动作里发起的 setState(即使经过
 * await/定时器)都带着自己的标签,onEnable 里创建的定时器则没有标签 —— 记成后台任务。
 */
const actionScope = new AsyncLocalStorage<{ action: string }>()

/**
 * 一次状态写入该记在谁名下。
 *
 * - `explicit`:调用方明确知道是哪个动作(宿主在 runAction 的兜底里传);
 * - `scoped`:`actionScope` 里的标签(node main 的异步调用链);
 * - `currentAction`:restricted 的 setState 经 IPC 过来,跨不过 AsyncLocalStorage,
 *   只能沿用原来的共享字段(这类插件的并发归属仍有局限);
 * - 都没有 = 后台任务。
 */
export function operationLabelFor(
  explicit: string | null,
  scoped: string | null,
  current: string | null,
  mainMode: PluginMainMode | null
): string {
  return explicit ?? scoped ?? (mainMode === 'node' ? null : current) ?? '后台任务'
}
/** 错误详情截断长度(一次堆栈可能有几十 KB,不能原样进 IPC 与界面) */
const MAX_DETAIL = 4096
/**
 * 状态广播的合并窗口。
 *
 * 插件在 onEnable 里连着 setState 三次、或者在一个循环里推进度,每一次都推整份
 * PluginView[] 是纯浪费 —— 渲染层一帧也只画一次。攒齐一个窗口再发。
 * 50ms 是"人感觉不到"与"别攒太久"之间的取值:再长,状态栏的进度就会看出滞后。
 */
const BROADCAST_COALESCE_MS = 50
/** 通知限流:每个插件每 60 秒最多几条 */
const NOTICE_WINDOW_MS = 60_000
const NOTICE_PER_WINDOW = 10
/** 单条通知的文字上限(它是画在右下角的气泡,不是日志) */
const NOTICE_TEXT_MAX = 200

export interface InstallMeta {
  version: string
  integrity: string
  mainSha256: string | null
  renderSha256: string | null
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
  /** 来自 `--plugin-dev=<目录>`:代码取自作者指定的目录,不落进插件安装目录 */
  dev: boolean
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
  logs: PluginLogEntry[]
  /** 最近几次已结束的操作(新的在前,最多 MAX_RECENT_OPS 条) */
  recentOps: PluginOperation[]
  /** 正在执行的动作名;由 runAction 设置,用来给操作记录一个可读的来源 */
  currentAction: string | null
  loadError?: string
  /**
   * 插件通过 API 注册的界面贡献点(命令/状态栏/右键菜单)。
   * 清单里声明的那部分不在这里 —— 它随 manifest 走,合并成快照时才读(见 contrib.ts)。
   */
  contrib: ContribRegistry
  /**
   * 插件通过 `imark.on()` 订阅的宿主事件。
   * 与 contrib 同理:带在 entry 上,重载即清空 —— 旧代码的闭包绝不能再被调用。
   */
  listeners: Map<PluginEvent, Set<(payload: unknown) => void>>
  /** 通知限流用的时间窗口(近 1 分钟内发出的时间戳) */
  noticeTimes: number[]
  /**
   * node main 的 render → main 消息监听器。
   * restricted main 走隐藏页的 bridge,不用这个表。
   */
  renderListeners: Set<(channel: string, data: unknown) => void>
  /**
   * **已生效**的权限 = 用户装的时候同意的 ∩ 清单现在声明的。
   *
   * restricted main 的权限是真门禁:`InstalledRecord.grantedPermissions` 记的是用户
   * 实际同意过的,而清单是**插件自己说了算、且可以随升级变化**的。只看清单,一个升级版
   * 就能凭空拿到新权限;只看记录,插件把权限从清单里删掉之后旧授权还在。
   *
   * node main 的权限是告知 + API 塑形(它本来就有完整 Node);capability 的权限用于
   * 安装披露。`source:'local'`/dev 没有确认流程,视为 granted = declared。
   */
  grants: PluginPermission[]
  /** restricted main 的隐藏页运行时(其它层为 null) */
  restricted: RestrictedRuntime | null
  /** main 层模式;没有 main 层时为 null */
  mainMode: PluginMainMode | null
  /** 是否有 render 层 */
  hasRender: boolean
  /** 用户是否为这个插件放开了「允许访问本机地址」 */
  allowLocalNet: boolean
  /**
   * 这一轮「启用」的生命周期跑过没有(`disable()` 清零)。
   *
   * 有它才能让 enable() 幂等 —— 而幂等是必需的,不是洁癖:同一个 entry 上
   * onEnable 跑两遍的路径真实存在(补装内置包时 `save()` 启用一次、启动循环
   * 再启用一次;升级安装时 `install()` 恢复启用态一次、启动循环又一次)。
   * 一个在 onEnable 里 `setInterval` 的插件会因此**双份定时器**,现象是
   * 「每隔一段时间重复推送两次」这种要从头查起才能定位的问题。
   */
  enabledRun: boolean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把 main 层与 render 层组合成一个 `PluginRuntime`。
 *
 * 顺序是刻意的:
 *   - 启用:main 先起,render 才可能向 main 发消息;
 *   - 停用:render 先收,避免 render 在 main 已销毁后继续发消息;
 *   - 动作:**有 main 走 main**,main 没实现就返回"未实现",不回退到 render ——
 *     一个动作只有一个权威执行者。需要 render 处理的动作由 main 主动转发。
 */
function createCompositeRuntime(main: PluginRuntime, render: PluginRuntime): PluginRuntime {
  return {
    async onEnable(ctx) {
      await main.onEnable?.(ctx)
      await render.onEnable?.(ctx)
    },
    async onDisable(ctx) {
      await render.onDisable?.(ctx)
      await main.onDisable?.(ctx)
    },
    async onConfigChange(config, ctx) {
      await main.onConfigChange?.(config, ctx)
      await render.onConfigChange?.(config, ctx)
    },
    async runAction(actionId, ctx, targetId, payload) {
      if (main.runAction) return main.runAction(actionId, ctx, targetId, payload)
      return { ok: false, message: `插件的 main 层没有实现动作:${actionId}` }
    }
  }
}

let host: PluginHost | null = null

export class PluginHost {
  private entries = new Map<string, Entry>()
  private pendingFlush: (() => void) | null = null
  /** 开发模式下每个插件目录的 fs.watch 停止函数(id → 停止),退出时要关掉 */
  private devWatchers = new Map<string, () => void>()
  /** 合并广播的待发定时器(见 scheduleBroadcast) */
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null
  /** 上一次同步给原生菜单的贡献点快照(见 syncMenu) */
  private menuSig = ''
  /** init() 跑完了吗 —— 在那之前收不到任何事件,也不该往外广播 */
  private initialized = false

  /**
   * 应用启动时调用(settings 已载入)。
   *
   * provision 是「补装内置兜底包」的回调,时机很讲究:它必须排在**扫描之后、启用之前**。
   * 排在扫描之前的话,补装进来的插件会被随后的扫描再加载一遍 —— 届时 onEnable 已经跑过、
   * 定时器已经挂上,第二次加载会把第一份 entry 顶掉并留下一个没人管的定时器(表现为同步跑两次)。
   * 补装只挑「宿主里还没有这个 id」的装,所以放在扫描后面天然只会补上缺的那几个。
   */
  async init(
    provision?: (host: PluginHost) => Promise<void>,
    devDirs: readonly string[] = []
  ): Promise<void> {
    const settings = await getSettings()
    await cleanupOldDirs()

    // restricted 的通道先装上:隐藏页一建起来就可能开口说话,晚一步那次调用就是
    // "没有处理器"的静默失败(页面那边表现为一个永远不返回的 Promise)
    installRendererBridge()
    installRestrictedIpc({
      opContext: pluginId => {
        const entry = this.entries.get(pluginId)
        // 只给启用中的插件受理 —— 页面的生命周期与启用态是一回事,
        // 没启用还有页面在跑说明它已经不该存在了
        if (!entry || !entry.state.enabled) return null
        return this.opContextFor(entry)
      },
      onGone: (pluginId, reason) => {
        const entry = this.entries.get(pluginId)
        if (entry) {
          this.emitLog(entry, 'warn', `插件页面结束了:${reason}(下次调用会尝试重建)`)
        }
      }
    })

    // 渲染层每次报到(首次启动 + 页面重载)都重新注入所有已启用的 render 层。
    // 页面重载后渲染层里的插件会话全没了 —— 不重注入就等于插件悄悄消失。
    initRenderLayer(() => {
      void this.loadRenderLayersOnReady()
    })

    // 换了仓库/主题要告诉插件。挂在 saveSettings 上而不是某一条 IPC 上:
    // 改设置的路径不止一条,挂在其中一条会让另外几条静默漏掉。
    onSettingsChanged((next, prev) => {
      if (next.vaultPath !== prev.vaultPath) {
        void this.emit('vault:change', { vaultPath: next.vaultPath })
        // 仓库开没开也是命令可用性的一部分(when: 'vault'),emit 不管这件事
        this.contextChanged()
      }
      if (next.theme !== prev.theme) {
        void this.emit('theme:change', { theme: next.theme })
      }
    })

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
        dev: false,
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
        logs: readLogTail(plugin.descriptor.id),
        recentOps: readRecentOps(plugin.descriptor.id),
        currentAction: null,
        contrib: new ContribRegistry(),
        listeners: new Map(),
        enabledRun: false,
        noticeTimes: [],
        renderListeners: new Set(),
        grants: [],
        restricted: null,
        mainMode: null,
        hasRender: false,
        allowLocalNet: false
      })
    }

    // ---- 补装内置兜底包(只补缺的;全新用户默认不启用兜底插件) ----
    if (provision) {
      try {
        await provision(this)
      } catch (err) {
        // 兜底包补装失败不该拦住整个应用:用户仍然可以照常写作
        console.error('[iMark] 插件补装失败:', err)
      }
    }

    // ---- 开发模式(--plugin-dev=<目录>)----
    // 放在补装**之后**:补装会跳过「宿主里已经有这个 id」的插件,所以一个正在被
    // 开发的插件不会在开发机上被兜底包顶掉;反过来,兜底包不会被开发目录挤掉,
    // 也就不会出现"关掉开发参数后插件整个不见了"。
    await this.enableDevSources(devDirs)

    for (const entry of this.entries.values()) {
      if (entry.state.enabled && !entry.loadError) await this.enable(entry.id, 'startup')
    }
    this.initialized = true
    // 被摘掉的快捷键要写进插件日志:作者只会看到"我的快捷键没反应",而这句日志
    // 能直接告诉他被谁占着。上报口注册在这儿(而不是在 syncMenu 里自己记),
    // 是因为摘除动作发生在 buildAppMenu() 里 —— 启动那一次(宿主还没机会接上)
    // 同样得能说出来,否则开局就撞车的插件永远等不到这句话。
    setKeybindingDropReporter(d => {
      const entry = this.entries.get(d.pluginId)
      if (entry) {
        this.emitLog(
          entry,
          'warn',
          `快捷键 ${d.keybinding} 已被「${d.takenBy}」占用,命令「${d.commandId}」不再绑定快捷键(仍可从命令面板执行)`
        )
      }
    })
    await this.broadcast()
  }

  // ---------- 开发模式 ----------

  /**
   * 加载 `--plugin-dev=<目录>` 指定的插件目录,并盯住它们做热重载。
   *
   * **不绕过任何校验**:清单照样过 validateManifest,加载失败照样登记成坏插件
   * (在设置页里可见、可读错误),权限照样注入强制。唯一的区别是代码取自作者
   * 指定的目录而不是安装目录,且应用从不"安装"它。
   */
  private async enableDevSources(dirs: readonly string[]): Promise<void> {
    for (const dir of dirs) {
      const source = await readDevSource(dir)
      if (!source.ok) {
        console.error(`[iMark] 开发插件加载失败(${dir}):${source.error}`)
        continue
      }
      const id = source.manifest.id
      this.mountDev(id, dir, source.manifest)
      const entry = this.entries.get(id)
      if (entry?.loadError) {
        console.error(`[iMark] 开发插件 ${id} 加载失败(改好文件会自动重试):${entry.loadError}`)
      } else {
        console.log(`[iMark] 开发模式:${id} ← ${dir}`)
      }

      const stop = watchDevSource(dir, () => {
        void this.reloadDev(id, dir)
      })
      this.devWatchers.set(id, stop)
    }
  }

  /**
   * 挂载一个开发目录。已存在同 id 的 entry 先摘掉,所以改代码不会叠出第二个实例。
   *
   * 加载失败不抛给调用方:调用方是「启动」或「文件刚变」,两者都不该被一个
   * 半成品插件打断。失败登记成坏插件 —— 在设置页里能看到具体错误,而作者
   * 改好文件后下一次重载会自动接上。
   */
  private async mountDev(id: string, dir: string, manifest: PluginManifest): Promise<void> {
    const previous = this.entries.get(id)
    if (previous && !previous.dev) {
      // 同一个 id 既装着又从开发目录加载:开发目录赢,但必须说出来 ——
      // 否则"我改的代码没生效"会变成一场对着已安装那份旧代码的徒劳排查
      console.warn(
        `[iMark] 开发插件 ${id} 覆盖了已安装的那一份(代码取自 ${dir},不是安装目录)`
      )
    }
    // 启用态要在摘除**之前**取,而且要一直记着。
    //
    // 开发插件的「启用」表达的是作者的意图,不是「上一次加载成功」的副产品。
    // registerBroken 会把 enabled 写成 false,如果下一次重载照读它,那么作者改掉一个
    // 拼写错误之后,插件会以一句「已重载」的姿态**永远不再启用** —— 而反复地改-存-看
    // 正是开发模式存在的全部理由。所以这个意图要跨过一次失败保留下来。
    // 第一次加载(没有上一份 entry)时才回落到默认值:开发插件本来就该一启动就跑起来;
    // 用户之后在设置页关掉它,settings 里就有了记录,那时不再自动打开。
    const previousEnabled = previous?.state.enabled
    const wantEnabled = previousEnabled ?? this.storedFor(id) === undefined

    await this.unregister(id)
    try {
      this.loadExternal(id, manifest, null, dir)
    } catch (err) {
      this.registerBroken(id, manifest, null, err, dir)
      // 坏插件也得记住这个意图,否则下一次重载又读回 false,意图就丢了
      const broken = this.entries.get(id)
      if (broken) broken.state.enabled = wantEnabled
      return
    }
    const entry = this.entries.get(id)
    if (entry) entry.state.enabled = wantEnabled
  }

  /**
   * 重新加载一个开发目录。
   *
   * 先摘后挂:摘的时候会跑 onDisable 并清掉 require 缓存,所以插件自己挂的定时器
   * 会停、新加载拿到的一定是新代码。加载失败就登记成坏插件并**继续盯着** ——
   * 作者此刻正在编辑器里敲一个还没写完的半成品,报错是要看的,重试是要自动的。
   */
  private async reloadDev(id: string, dir: string): Promise<void> {
    const source = await readDevSource(dir)
    if (!source.ok) {
      console.error(`[iMark] 开发插件重新加载失败(${dir}):${source.error}`)
      return
    }
    // 启用态要在摘除**之前**取:unregister 里的 disable() 会把同一个对象改掉
    const wasEnabled = this.entries.get(id)?.state.enabled ?? true
    await this.mountDev(id, dir, source.manifest)
    const entry = this.entries.get(id)
    if (entry?.loadError) {
      console.error(`[iMark] 开发插件 ${id} 重载失败(改好文件会自动重试):${entry.loadError}`)
    } else {
      console.log(`[iMark] 开发插件 ${id} 已重载`)
    }
    if (entry && wasEnabled && !entry.loadError) await this.enable(id, 'dev-reload')
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
        ...(entry.mainMode ? { mainMode: entry.mainMode } : {}),
        ...(entry.hasRender ? { hasRender: true } : {}),
        ...(entry.manifest?.capability ? { capability: entry.manifest.capability } : {}),
        ...(entry.meta ? { source: entry.meta.source, installed: entry.meta } : {}),
        // restricted 显示**已生效**的权限(用户同意的 ∩ 清单声明的)—— 那才是它真正拿得到的。
        // node/capability 显示的仍是清单声明:对它们而言权限是"告知/披露"。
        ...(entry.manifest?.permissions
          ? { permissions: entry.mainMode === 'restricted' ? entry.grants : entry.manifest.permissions }
          : {}),
        ...(entry.dev ? { dev: true } : {}),
        ...(entry.mainMode === 'restricted' ? { allowLocalNet: entry.allowLocalNet } : {}),
        ...(entry.failures > 0 ? { failures: entry.failures } : {}),
        ...(entry.disabledByHost ? { disabledByHost: true } : {}),
        ...(entry.logs.length > 0
          ? { logs: entry.logs.map(line => ({ ...line })) }
          : {}),
        ...(entry.recentOps.length > 0
          ? { recentOps: entry.recentOps.map(op => ({ ...op })) }
          : {}),
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
      // config:change 是**只发给这个插件自己**的:告诉 A 插件「B 刚被改了配置」
      // 既没用又泄露用户装了谁。所以这里不走 emit(那个是广播),直接投给 entry。
      // 用 imark.on 订阅的插件与写 onConfigChange 的插件拿到的是同一件事,
      // 只是前者是阶段二才有的新写法。
      await this.emitTo(entry, 'config:change', { config })
    }
    await this.broadcast()
  }

  /**
   * 用户是否为这个插件放开「允许访问本机地址」。
   *
   * 落进 settings 的 plugins[id].allowLocalNet(不是插件自己的 config —— 那是插件
   * 说了算的地方,而这是一个**用户对插件的授权**),下一次网络请求立刻按新值判定。
   */
  async setNetAccess(id: string, allow: boolean): Promise<void> {
    const entry = this.require(id)
    entry.allowLocalNet = allow === true
    const settings = await getSettings()
    const current = settings.plugins[id] ?? { enabled: entry.state.enabled, config: entry.config }
    await saveSettings({
      plugins: { ...settings.plugins, [id]: { ...current, allowLocalNet: entry.allowLocalNet } }
    })
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
    if ((field.kind === 'targets' || field.kind === 'endpoints') && value !== null && !targetId) {
      throw new Error('目标列表的密钥必须指定目标')
    }
    await setSecret(secretKey(id, fieldKey, targetId ?? undefined), value)
    await this.broadcast()
  }

  async runAction(
    id: string,
    actionId: string,
    targetId?: string,
    payload?: PluginActionPayload
  ): Promise<{ ok: boolean; message: string; detail?: string; editor?: PluginEditorInsert }> {
    const entry = this.require(id)
    if (entry.loadError) return { ok: false, message: `插件加载失败:${entry.loadError}` }
    if (entry.suspended) return { ok: false, message: '插件正在安装/升级,请稍候' }
    if (!entry.state.enabled) return { ok: false, message: '插件未启用' }
    if (entry.disabledByHost) {
      return { ok: false, message: '插件已被停用(连续运行失败),请在插件设置里关闭后重新启用' }
    }
    const { actions, targetActions, lineMenu } = entry.descriptor
    // 行首菜单的动作只声明在 lineMenu 里(它不进设置页),所以这里要把两处都算上
    const known = targetId
      ? (targetActions ?? []).some(a => a.id === actionId)
      : actions.some(a => a.id === actionId) || (lineMenu ?? []).some(i => i.action === actionId)
    if (!known) return { ok: false, message: `未知动作:${actionId}` }

    // 操作记录里显示按钮名,而不是内部 id(targetActions 与 lineMenu 也要算上)
    const actionLabel = targetId
      ? (targetActions ?? []).find(a => a.id === actionId)?.label ?? actionId
      : actions.find(a => a.id === actionId)?.label ??
        (lineMenu ?? []).find(i => i.action === actionId)?.label ??
        actionId

    // 界面上只有「状态卡」一处显示结果,所以动作跑完必须把结果写进状态;
    // 插件自己没写(没调用 setState)的话,这里兜底写一次,避免结果无处可见。
    const beforeRunAt = entry.state.lastRunAt
    const ctx = this.contextFor(entry)
    let result: PluginActionResult = {
      ok: false,
      message: '插件没有响应'
    }
    entry.currentAction = actionLabel
    try {
      // 把动作体放进异步作用域:插件在动作里调用的 setState(哪怕经过 await)
      // 都按这个动作记账,不会被并发跑完的后台任务顶替。
      const succeeded = await actionScope.run({ action: actionLabel }, () =>
        this.safeCall(
          entry,
          `动作 ${actionId}`,
          async () => {
            result = (await entry.runtime.runAction?.(actionId, ctx, targetId, payload)) ?? {
              ok: false,
              message: `插件未实现动作:${actionId}`
            }
          },
          ACTION_TIMEOUT
        )
      )
      if (!succeeded) {
        // 失败与熔断的兜底**刻意不带 editor**:渲染层拿不到插入指令,文档就一个字符都不会变
        result = {
          ok: false,
          message: entry.state.lastMessage,
          ...(entry.state.lastDetail ? { detail: entry.state.lastDetail } : {})
        }
      }
      if (entry.state.lastRunAt === beforeRunAt && (result.message || result.detail)) {
        // 插件可以明确给一个状态(如「已排队」= running);没给才按 ok 推断
        const status =
          result.status === 'running' ||
          result.status === 'partial' ||
          result.status === 'idle' ||
          result.status === 'ok' ||
          result.status === 'error'
            ? result.status
            : result.ok
              ? 'ok'
              : 'error'
        this.applyState(
          entry,
          {
            status,
            lastRunAt: Date.now(),
            lastMessage: result.message,
            ...(result.detail !== undefined ? { lastDetail: result.detail } : {})
          },
          actionLabel
        )
      }
      await this.broadcast()
      return result
    } finally {
      entry.currentAction = null
    }
  }

  // ---------- render 层 ----------

  /**
   * 渲染层就绪 / 重新就绪:重新注入所有已启用的 render 层。
   *
   * 每个插件单独 `safeCall` —— 一个插件注入失败不该连累其他插件;
   * 页面重载后的旧会话已经不存在,所以先把"已加载"标记整体清掉。
   */
  private renderLayersLoading = false

  private async loadRenderLayersOnReady(): Promise<void> {
    // 同一次就绪只跑一遍:并发进来会把同一个插件注入两次(两个会话、两遍 onEnable)
    if (this.renderLayersLoading) return
    this.renderLayersLoading = true
    try {
      markAllRenderLayersUnloaded()
      for (const entry of this.entries.values()) {
        if (!entry.manifest?.render) continue
        if (!entry.state.enabled || entry.disabledByHost || entry.suspended || entry.loadError) continue
        await this.safeCall(entry, '加载 render 层', () =>
          injectRenderLayer({
            id: entry.id,
            dir: entry.dir ?? '',
            manifest: entry.manifest as PluginManifest,
            config: entry.config
          })
        )
      }
      await this.broadcast()
    } finally {
      this.renderLayersLoading = false
    }
  }

  /** render → main 的一条消息(IPC 收到;失败只记日志,消息不重发) */
  async handleRenderMessage(o: unknown): Promise<void> {
    const msg = o as { pluginId?: unknown; channel?: unknown; data?: unknown } | null
    const id = typeof msg?.pluginId === 'string' ? msg.pluginId : ''
    const entry = this.entries.get(id)
    if (!entry || !entry.manifest?.render || !entry.state.enabled) return
    const channel = typeof msg?.channel === 'string' ? msg.channel : ''
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(channel)) {
      this.logLine(entry, 'warn', 'render 层发来的消息通道名非法,已丢弃')
      return
    }
    let size = 0
    try {
      size = JSON.stringify(msg?.data ?? null).length
    } catch {
      this.logLine(entry, 'warn', 'render 层发来的消息不是可 JSON 化的数据,已丢弃')
      return
    }
    if (size > 256 * 1024) {
      this.logLine(entry, 'warn', 'render 层发来的消息超过 256 KiB,已丢弃')
      return
    }
    const data = msg?.data ?? null
    if (entry.mainMode === 'restricted' && entry.restricted) {
      try {
        await entry.restricted.call('renderMessage', [channel, data], CALL_TIMEOUT)
      } catch (err) {
        this.logLine(entry, 'warn', `render 的消息没有送达受限 main:${errorMessage(err)}`)
      }
      return
    }
    if (entry.mainMode === 'node') {
      if (entry.renderListeners.size === 0) {
        this.logLine(entry, 'warn', 'render 层发来一条消息,但 node main 没有注册 render.onMessage')
        return
      }
      for (const handler of [...entry.renderListeners]) {
        await this.safeCall(entry, `render.onMessage(${channel})`, () => handler(channel, data))
      }
      return
    }
    this.logLine(entry, 'warn', 'render 层发来一条消息,但这个插件没有 main 层,消息被丢弃')
  }

  /** render 层更新状态卡 —— 走与插件 API 相同的 `state.set` 校验与广播 */
  async applyRenderState(o: unknown): Promise<void> {
    const msg = o as { pluginId?: unknown; patch?: unknown } | null
    const id = typeof msg?.pluginId === 'string' ? msg.pluginId : ''
    const entry = this.entries.get(id)
    if (!entry || !entry.manifest?.render || !entry.state.enabled) return
    await invokeOp(this.opContextFor(entry), 'state.set', msg?.patch, {
      source: 'render',
      audit: line => this.logFromPlugin(entry, line)
    })
  }

  /** render 层写一行日志(与插件 API 的 log 同义) */
  logRenderLayer(o: unknown): void {
    const msg = o as { pluginId?: unknown; level?: unknown; message?: unknown } | null
    const id = typeof msg?.pluginId === 'string' ? msg.pluginId : ''
    const entry = this.entries.get(id)
    if (!entry || !entry.manifest?.render) return
    const level = ['debug', 'info', 'warn', 'error'].includes(String(msg?.level))
      ? (msg?.level as 'debug' | 'info' | 'warn' | 'error')
      : 'info'
    this.logLine(entry, level, String(msg?.message ?? '').slice(0, 2000))
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

    const installedManifest = await readPluginManifest(id)
    const record: InstalledRecord = {
      id,
      version: meta.version,
      mainMode: installedManifest?.main?.mode ?? null,
      hasRender: Boolean(installedManifest?.render),
      capability: installedManifest?.capability ?? null,
      integrity: meta.integrity,
      mainSha256: meta.mainSha256,
      renderSha256: meta.renderSha256,
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
    // 开发模式的插件不占安装目录里的任何位置,「卸载」它没有意义;而它**可能**
    // 顶着与某个已安装插件相同的 id —— 那种情况下照常执行会把安装目录里那份
    // 真正装着的插件删掉,而界面上还在跑的是开发目录那一份,没人会想到发生了这件事。
    if (this.entries.get(id)?.dev) {
      throw new Error('这是以开发模式(--plugin-dev)加载的插件,不在已安装列表里,无需卸载')
    }
    await this.unregister(id)
    await removePluginDir(id)
    await removeRecord(id)
    // 用前缀删除而不是逐个 secretKeysOf:认证方式切换留下的 #password 槽位也要一起清掉
    await deleteSecretsByPrefix(`${id}:`)
    // 沙箱插件还会在磁盘上留下两样东西:它的**分区数据**(localStorage / IndexedDB /
    // 缓存,落在 profile 的 Partitions/imk-plugin-<id>/)与窗口几何。卸载就该清干净 ——
    // 留着的话,同一个 id 被别的作者重新发布时,新的插件能读到上一家的残留。
    await clearPluginStorage(id)

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
    // 先停监听:否则退出过程中正在跑的一次重载会把插件又拉起来,
    // 而 shutdown 已经走过了它的名字
    for (const stop of this.devWatchers.values()) stop()
    this.devWatchers.clear()
    for (const entry of this.entries.values()) {
      if (entry.state.enabled) await this.disable(entry.id, 'quit')
    }
  }

  private async enable(id: string, reason: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.loadError || entry.suspended) return
    if (!entry.state.enabled) entry.state.enabled = true
    // 幂等:同一轮启用里 onEnable 只跑一次(见 Entry.enabledRun 的说明)。
    // 注意这一句在置位 state.enabled **之后**、在 safeCall **之前** ——
    // 前者保证"已经是启用态"这件事先落实,后者保证 onEnable 抛异常时也不会
    // 因为「没跑成功」而被下一条路径再跑一遍(重试是 disable→enable 的事)
    if (entry.enabledRun) return
    entry.enabledRun = true
    void reason
    if (entry.restricted) {
      // restricted main 的生命周期跑在**隐藏执行页**里,所以得先把页面拉起来。
      // 页面起不来(入口不在包里、CSP 拦了…)算一次失败,与其它失败一起计数熔断。
      const started = await this.safeCall(entry, '启动插件页面', () => entry.restricted?.start())
      if (!started) return
      this.sendHello(entry)
    }
    await this.safeCall(entry, 'onEnable', () => entry.runtime.onEnable?.(this.contextFor(entry)))
  }

  private async disable(id: string, reason: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.state.enabled = false
    entry.enabledRun = false
    void reason
    await this.safeCall(entry, 'onDisable', () => entry.runtime.onDisable?.(this.contextFor(entry)))
    if (entry.restricted) {
      // 顺序:先让它说完再见(onDisable 已经跑完),再关页面。
      // 定时器与挂起的调用在 dispose 里清干净 —— 停用之后不该还有任何回调进来
      disposeRestrictedRuntime(id)
      forgetLimits(id)
      await closeRestrictedPage(id, reason)
    }
    // 停用 = 这次运行注册的一切都作废。
    //
    // 不清的话有一个很难查的后果:插件在 onEnable 里 `imk.on('document:save', fn)`,
    // 用户关掉再打开,onEnable 又跑一遍 —— 这一次注册的 fn 与上一次那个是**两个不同的
    // 闭包**,Set 会同时留着,于是每次保存事件都被投递两遍。作者只会看到"我的
    // 钩子被调了两次",而代码里明明只写了一遍。
    //
    // 清空而不是要求作者自己注销,是因为宿主给的注册函数大多被丢在一边(返回值很少
    // 有人接),要求注销等于要求每个作者写对同一件容易忘的事。契约改成一句话:
    // **onEnable 里注册,onDisable 之后一律不在**。清单里声明的那部分不受影响 ——
    // 它每次都是从 manifest 重新算出来的,与运行时无关。
    entry.listeners.clear()
    entry.contrib.resetApi()
    entry.renderListeners.clear()
  }

  // ---------- 内部 ----------

  /**
   * 加载一个外部插件并登记为可用的 entry(不启用)。
   * 抛出的异常由调用方决定是「回滚」还是「登记为坏插件」。
   */
  private loadExternal(
    id: string,
    manifest: PluginManifest,
    record: InstalledRecord | null,
    dirOverride?: string
  ): void {
    // 保留用户已有的启用态与配置 —— 这就是「零迁移」的全部秘密:字段 key 没变,
    // normalizeConfig 用新字段表重读旧配置即可,连升级后新增/删除字段都是自洽的。
    const stored = this.storedFor(id)
    const entry: Entry = {
      id,
      descriptor: descriptorFromManifest(manifest),
      manifest,
      dir: dirOverride ?? pluginDir(id),
      dev: dirOverride !== undefined,
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
      logs: readLogTail(id),
      recentOps: readRecentOps(id),
      currentAction: null,
      contrib: new ContribRegistry(),
      listeners: new Map(),
      noticeTimes: [],
      renderListeners: new Set(),
      enabledRun: false,
      grants: effectiveGrantsOf(manifest, record, dirOverride !== undefined),
      restricted: null,
      mainMode: manifest.main?.mode ?? null,
      hasRender: Boolean(manifest.render),
      allowLocalNet: this.storedFor(id)?.allowLocalNet === true
    }

    this.entries.set(id, entry)
    try {
      // node main 与 capability 需要主进程侧的 imk 对象;restricted 由 preload 塑形。
      if (entry.mainMode === 'node' || manifest.capability) {
        entry.api = this.apiFor(entry)
      }

      let mainRuntime: PluginRuntime | null = null
      if (entry.mainMode === 'node') {
        mainRuntime = loadScriptRuntime(entry.dir as string, manifest, entry.api as ImkApi)
      } else if (entry.mainMode === 'restricted') {
        const runtime = createRestrictedRuntime({
          pluginId: id,
          name: manifest.name,
          dir: entry.dir as string,
          entry: manifest.main?.entry ?? 'main.js',
          permissions: entry.grants,
          hasRender: entry.hasRender
        })
        entry.restricted = runtime
        mainRuntime = restrictedPluginRuntime(runtime, CALL_TIMEOUT, ACTION_TIMEOUT)
        setPluginRoot(id, entry.dir as string, manifest.name)
      } else if (manifest.capability) {
        mainRuntime = createCapabilityRuntime(manifest, entry.api as ImkApi)
      }

      const renderRuntime = manifest.render
        ? createRenderRuntime({
            id,
            dir: entry.dir as string,
            manifest,
            getConfig: () => entry.config
          })
        : null

      entry.runtime =
        mainRuntime && renderRuntime
          ? createCompositeRuntime(mainRuntime, renderRuntime)
          : (mainRuntime ?? renderRuntime ?? {})
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
    err: unknown,
    dirOverride?: string
  ): void {
    const message = err instanceof Error ? err.message : String(err)
    this.entries.set(id, {
      id,
      descriptor: descriptorFromManifest(manifest),
      manifest,
      dir: dirOverride ?? pluginDir(id),
      dev: dirOverride !== undefined,
      meta: metaOf(record),
      runtime: {},
      api: null,
      config: normalizeConfig(manifest.fields, this.storedFor(id)),
      state: {
        enabled: false,
        status: 'error',
        lastRunAt: Date.now(),
        lastMessage: '插件加载失败'
      },
      failures: 0,
      disabledByHost: false,
      suspended: false,
      logs: readLogTail(id),
      recentOps: readRecentOps(id),
      currentAction: null,
      contrib: new ContribRegistry(),
      listeners: new Map(),
      noticeTimes: [],
      renderListeners: new Set(),
      enabledRun: false,
      grants: effectiveGrantsOf(manifest, record, dirOverride !== undefined),
      restricted: null,
      mainMode: manifest.main?.mode ?? null,
      hasRender: Boolean(manifest.render),
      allowLocalNet: this.storedFor(id)?.allowLocalNet === true,
      loadError: message
    })
    const broken = this.entries.get(id)
    if (broken) this.emitLog(broken, 'error', `加载失败:${message.slice(0, MAX_DETAIL)}`)
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
        this.applyState(restored, {
          status: 'error',
          lastMessage: '插件升级失败，已恢复到上一个版本',
          lastRunAt: Date.now()
        })
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
    // 窗口必须在**目录被动过之前**关掉:升级会先把插件目录 rename 走,
    // 页面还开着的话再点一下就是 404,半旧半新的状态最难查
    if (entry.restricted || hasRestrictedRuntime(id)) {
      await closeRestrictedPage(id, 'unregister')
      unregisterRestrictedRuntime(id)
    }
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
        this.applyState(entry, patch)
      },
      flushDocument: () => this.flushDocument(),
      isEnabled: () => entry.state.enabled,
      isDisabledByHost: () => entry.disabledByHost
    }
  }

  /**
   * 造一次能力调用的现场。
   *
   * node main 与沙箱两条路用的是**同一个**构造:差别只在 `api.ts` 那边直接调用
   * (`invokeOp` 出来的薄壳),沙箱这边经 IPC。能力的实现只有一份(ops.ts)。
   */
  private opContextFor(entry: Entry): OpContext {
    const runtime = entry.restricted
    return {
      pluginId: entry.id,
      pluginName: entry.descriptor.name,
      dir: entry.dir ?? '',
      config: entry.config,
      grants: entry.grants,
      allowLocalNet: entry.allowLocalNet,
      log: (level, message) => this.logLine(entry, level, message),
      notify: (message, level) => this.notify(entry, message, level),
      setState: patch => {
        this.applyState(entry, patch)
      },
      flushDocument: () => this.flushDocument(),
      // **不能**用 entry.restricted !== null 判断:页面启动失败时对象可能还在,
      // 而能力形态是由清单决定的。用错了会让 restricted 误走 node 的 git 白名单豁免。
      isRestricted: entry.mainMode === 'restricted',
      hasRender: entry.hasRender,
      sendToRenderLayer: (channel, data) => {
        if (!entry.hasRender) {
          throw new Error('这个插件没有 render 层,消息无处投递')
        }
        if (!isRenderLayerLoaded(entry.id)) {
          throw new Error('render 层还没就绪,消息暂时无法投递')
        }
        sendToRenderLayer(entry.id, channel, data)
      },
      notifyFileChanged: filePath => {
        const win = getMainWindow()
        if (win && !win.webContents.isDestroyed()) win.webContents.send(IPC.FileExternalChange, filePath)
      },
      registerCommand: cmd => {
        const result = entry.contrib.addCommand(cmd, () => this.invokeRestrictedContrib(entry, cmd.id))
        if (!result.ok) return result.errors
        this.scheduleBroadcast()
        return []
      },
      removeCommand: id => {
        entry.contrib.removeCommand(id)
        this.scheduleBroadcast()
      },
      setStatusItem: item => {
        const { problems } = entry.contrib.setStatusItem(
          item,
          item ? () => this.invokeRestrictedContrib(entry, item.id) : undefined
        )
        if (problems.length === 0) this.scheduleBroadcast()
        return problems
      },
      addMenuItem: item => {
        const { problems } = entry.contrib.addMenuItem(item, () =>
          this.invokeRestrictedContrib(entry, item.id)
        )
        if (problems.length === 0) this.scheduleBroadcast()
        return problems
      },
      schedule: {
        every: (ms, name) => {
          if (!runtime) throw new Error('node main 请直接用自己的定时器')
          runtime.scheduleEvery(ms, name)
        },
        clear: name => runtime?.scheduleClear(name)
      },
      validateSecretTarget: (fieldKey, targetId) => this.assertSecretTarget(entry, fieldKey, targetId)
    }
  }

  /**
   * restricted main 的条目被执行:桥回隐藏页,由作者在那边的 `runAction` 或
   * `commands.register(cmd, run)` 里处理(见 preload/plugin.ts)。
   */
  private async invokeRestrictedContrib(entry: Entry, itemId: string): Promise<unknown> {
    const runtime = entry.restricted
    if (!runtime) throw new Error('插件不在')
    return runtime.call('runAction', [itemId, null, null], CALL_TIMEOUT)
  }

  /** 页面起来后补一份"我是谁、现在什么样"(restricted 的一切都以它开场) */
  private sendHello(entry: Entry): void {
    const runtime = entry.restricted
    if (!runtime) return
    const settings = getSettingsSync()
    runtime.send('hello', {
      pluginId: entry.id,
      name: entry.descriptor.name,
      version: entry.descriptor.version,
      permissions: entry.grants,
      theme: settings?.theme ?? 'dark',
      vaultPath: settings?.vaultPath ?? null,
      config: entry.config,
      mode: 'restricted',
      hasRender: entry.hasRender
    } satisfies PluginHello)
  }

  /**
   * 统一的状态写入。
   *
   * 状态的正文只保存一段文本(lastMessage):明细不再挂回状态,而是进操作日志 ——
   * 否则设置页会先显示摘要、再显示一条几乎一样的明细。lastDetail 仍然接收,
   * 但只用于日志与「摘要为空」时的兜底。
   *
   * targetResults 是唯一的结构化例外:它是「每一行目标自己的结果」,没有一段文字
   * 能同时表达(逐行文本只能读、不能给卡片上色),所以按目标 id 单独存一份。
   */
  private applyState(entry: Entry, patch: Partial<PluginState>, actionOverride?: string): void {
    const prev = entry.state
    // 收尾的 patch(lastRunAt)必须自带结果文本;没有就留空,绝不继承上一轮的 ——
    // 并发时那正是把两个操作的正文缝在一起的入口。
    const summary = (
      patch.lastMessage ??
      (patch.lastRunAt != null ? '' : prev.lastMessage) ??
      ''
    ).trim()
    const detail = patch.lastDetail
    // 按目标合并,而不是整体替换:单目标动作(如「测试连接」)只报告自己那一行,
    // 不能把其他远端已有的结果一起抹掉。
    const targetResults =
      patch.targetResults === undefined
        ? prev.targetResults
        : { ...prev.targetResults, ...patch.targetResults }
    entry.state = {
      ...prev,
      ...patch,
      targetResults,
      lastMessage: summary || detail || '',
      lastDetail: undefined
    }
    if (
      patch.lastRunAt != null &&
      patch.lastRunAt !== prev.lastRunAt &&
      entry.state.status !== 'running'
    ) {
      const status =
        entry.state.status === 'partial' ? 'partial' : entry.state.status === 'ok' ? 'ok' : 'error'
      this.recordOperation(entry, {
        at: patch.lastRunAt,
        action: operationLabelFor(
          actionOverride ?? null,
          actionScope.getStore()?.action ?? null,
          entry.currentAction,
          entry.mainMode
        ),
        status,
        message: entry.state.lastMessage,
        ...(detail && detail !== entry.state.lastMessage ? { detail } : {})
      })
    }
    void this.broadcast()
  }

  /** 记一条操作结果:内存里留最近 3 条(并落一份 JSON),完整版走统一日志 */
  private recordOperation(entry: Entry, op: PluginOperation): void {
    entry.recentOps.unshift(op)
    if (entry.recentOps.length > MAX_RECENT_OPS) entry.recentOps.length = MAX_RECENT_OPS
    const label = op.status === 'ok' ? '成功' : op.status === 'partial' ? '部分失败' : '失败'
    const body = [op.message, op.detail].filter(Boolean).join('\n\n')
    // 与插件自己 log() 的行走同一个入口:内存尾巴与磁盘日志由此天然一致。
    // 多行明细保留换行 —— 设置页逐条渲染,不再把它压成一行字符串。
    this.emitLog(entry, 'operation', `${op.action} · ${label}${body ? `\n${body}` : ''}`, op.at)
    try {
      const file = pluginRecentFile(entry.id)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(entry.recentOps), 'utf8')
    } catch (err) {
      console.error('[iMark] 写最近操作记录失败:', err)
    }
  }

  /**
   * 写一条日志:**内存尾巴 + 主进程控制台 + 磁盘文件**,三条路只此一个入口。
   *
   * 所有来源(插件 log、宿主操作摘要、宿主警告/审计)都必须走这里 —— 否则就会
   * 出现「磁盘上有、设置页没有」或「设置页有、磁盘没有」这类对不上的现象。
   * 内存与磁盘用的是同一份字段,只是磁盘多一个时间戳前缀。
   */
  private emitLog(entry: Entry, level: PluginLogLevel, message: string, at = Date.now()): void {
    const text = message.replace(/\r\n/g, '\n').trimEnd()
    entry.logs.push({ at, level, message: text })
    if (entry.logs.length > MAX_LOGS) entry.logs.splice(0, entry.logs.length - MAX_LOGS)
    const label = level === 'operation' ? '操作' : level
    console.log(`[plugin:${entry.id}] [${label}] ${text}`)
    this.appendPluginLog(entry, label, text, at)
  }

  /** 追加一条到插件日志文件;日志写不进去绝不能反过来影响插件 */
  private appendPluginLog(entry: Entry, label: string, text: string, at: number): void {
    try {
      const file = pluginLogFile(entry.id)
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${logStamp(at)} [${label}] ${text}\n`, 'utf8')
    } catch (err) {
      console.error('[iMark] 写插件日志失败:', err)
    }
  }

  /** 打开完整日志前先保证文件存在(设置页的小图标用它) */
  ensureLogFile(id: string): string {
    // 只接受已登记插件:这个 id 会拼进文件路径,不能拿渲染层传来的任意字符串
    if (!this.entries.has(id)) throw new Error(`未知插件：${id}`)
    const file = pluginLogFile(id)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, '', 'utf8')
    return file
  }

  /**
   * 写插件日志(级别与正文分开的来源:沙箱 log op、render 层日志、能力审计)。
   * 不认识的级别按 info 收下 —— 日志不该因为一个错别字而丢掉。
   */
  private logLine(entry: Entry, level: string, message: string): void {
    this.emitLog(entry, asLogLevel(level), message)
  }

  /**
   * node main 的 `api.log` 与宿主审计送来的是**整行**(已经带 `[level]` 前缀)。
   * 拆出级别再走统一入口,否则宿主会再包一层,变成 `[warn] [info] ...`。
   */
  private logFromPlugin(entry: Entry, line: string): void {
    const m = /^\[(debug|info|warn|error)\]\s*([\s\S]*)$/.exec(line)
    if (m) this.emitLog(entry, m[1] as PluginLogLevel, m[2]!)
    else this.emitLog(entry, 'warn', line)
  }

  /** 造注入给 node main 插件的 API(含密钥作用域校验) */
  private apiFor(entry: Entry): ImkApi {
    return createImkApi(this.contextFor(entry), {
      pluginId: entry.id,
      pluginName: entry.descriptor.name,
      pluginVersion: entry.descriptor.version,
      dir: entry.dir ?? '',
      // 注意传的是 **grants** 而不是清单里声明的:权限的判定口径只有一处
      permissions: entry.grants,
      opContext: this.opContextFor(entry),
      validateSecretTarget: (fieldKey, targetId) => this.assertSecretTarget(entry, fieldKey, targetId),
      log: line => this.logFromPlugin(entry, line),
      contrib: entry.contrib,
      listeners: entry.listeners,
      render: entry.hasRender
        ? {
            send: async (channel: string, data: unknown): Promise<void> => {
              const result = await invokeOp(
                this.opContextFor(entry),
                'render.send',
                { channel, data },
                {
                  source: 'node',
                  audit: line => this.logFromPlugin(entry, line)
                }
              )
              if (!result.ok) throw new Error(`[${result.error.code}] ${result.error.message}`)
            },
            onMessage: (handler: (channel: string, data: unknown) => void): (() => void) => {
              entry.renderListeners.add(handler)
              return () => {
                entry.renderListeners.delete(handler)
              }
            }
          }
        : null,
      // 贡献点变了要立刻让界面看到 —— 命令刚注册完就该出现在面板里。
      // 走 schedule 而不是 broadcast:插件常在 onEnable 里连着注册十几条,
      // 每一条都推一次整份快照是没有意义的。
      contribChanged: () => this.scheduleBroadcast()
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
  private async safeCall(
    entry: Entry,
    label: string,
    fn: () => unknown,
    timeoutMs = CALL_TIMEOUT
  ): Promise<boolean> {
    if (entry.suspended || entry.loadError) return false
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} 超时(超过 ${Math.round(timeoutMs / 1000)} 秒)`)),
            timeoutMs
          )
        })
      ])
      entry.failures = 0
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error && err.stack ? err.stack : message
      entry.failures += 1
      this.applyState(entry, {
        status: 'error',
        lastRunAt: Date.now(),
        lastMessage: `${label} 失败`,
        lastDetail: stack.slice(0, MAX_DETAIL)
      })
      console.error(`[iMark] 插件 ${entry.id} ${label} 失败:`, err)
      if (entry.failures >= MAX_FAILURES) {
        entry.disabledByHost = true
        // 这里走的是「直接改状态」而不是 disable():所以也要把启用标记一起清掉,
        // 否则用户在设置里重新启用时 enable() 会以为「早就跑过了」而直接返回 ——
        // 界面显示已启用,插件其实一次都没跑起来
        entry.enabledRun = false
        // 熔断也要关窗:一个已经"连续失败被停用"的插件,它的窗口还挂在屏幕上
        // 是最说不通的状态(而且那个页面还在跑着没人管的代码)
        if (entry.restricted) {
          disposeRestrictedRuntime(entry.id)
          void closeRestrictedPage(entry.id, 'circuit-breaker')
        }
        // render 层还可能活在主窗口里:扩展/会话也必须收掉,
        // 否则界面上会留着一个"已停用"插件的装饰与行为(熔断路径不经过 disable())
        if (entry.hasRender) void unloadRenderLayer(entry.id)
        entry.renderListeners.clear()
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
    // 立即广播会顺带取消待发的那一次:同一份快照没理由推两遍
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    const snapshot = this.contribSnapshot()
    this.syncMenu(snapshot)
    const win = getMainWindow()
    if (!win || win.webContents.isDestroyed()) return
    // 贡献点是纯内存拼装、立刻就好;list() 要读密钥掩码,是这里唯一的重活。
    // 先发轻的那条,渲染层的按钮就不会等在一次磁盘读取后面才出现。
    win.webContents.send(IPC.PluginContrib, {
      contribs: snapshot,
      context: this.commandContext()
    } satisfies PluginContribsSnapshot)
    win.webContents.send(IPC.PluginStatus, await this.list())
  }

  /**
   * 把贡献点里的命令同步进原生菜单 —— 那里是快捷键唯一能生效的地方。
   *
   * 只在快照**真的变了**时重建:菜单重建要动整个应用菜单,而这函数挂在广播路径上,
   * 广播会被插件的每次 setState 触发。不快照比较的话,一个每 100ms 报进度的插件
   * 就会每 100ms 重建一次菜单。
   */
  private syncMenu(snapshot: PluginContrib[]): void {
    const ctx = this.commandContext()
    // 签名里**必须带上上下文**:菜单项的灰/亮是按它算的,而「有没有文档 / 有没有仓库」
    // 变了并不会让贡献点快照变一个字。只比快照的话,打开文档之后那条 when:'editor'
    // 的命令会一直灰着 —— 直到用户碰巧启用/停用了某个插件才"自己好了"。
    const sig = JSON.stringify({ snapshot, ctx })
    if (sig === this.menuSig) return
    this.menuSig = sig
    setPluginCommands(
      snapshot.map(c => ({
        pluginId: c.pluginId,
        pluginName: c.pluginName,
        commands: c.commands.map(cmd => ({
          id: cmd.id,
          label: cmd.label,
          keybinding: cmd.keybinding,
          available: commandAvailable(cmd.when, ctx)
        }))
      }))
    )
  }

  /**
   * 高频路径(插件 setState)专用的合并广播。
   *
   * 与 broadcast() 分开,是因为两者的语义不同:上面那个是"这次变更必须让界面看到"
   * (启停、安装、动作结束),调用方在 await 它;这个是"插件在刷状态",
   * 攒起来发一次就够。混成一个的话,要么处处滞后,要么白白高频。
   */
  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      void this.broadcast()
    }, BROADCAST_COALESCE_MS)
  }

  /**
   * 当前**启用中**插件的全部界面贡献点。
   *
   * 只收启用的:关掉的插件不该在界面上留东西(与行首「+」菜单现在的行为一致)。
   * 这条快照很小、变化也少(启停/重载时才变),所以整份替换而不是增量 ——
   * 增量就得处理"渲染层漏收一条"怎么恢复,不值当。
   */
  private contribSnapshot(): PluginContrib[] {
    const out: PluginContrib[] = []
    for (const entry of this.entries.values()) {
      if (!entry.state.enabled || entry.loadError) continue
      out.push({
        pluginId: entry.id,
        pluginName: entry.descriptor.name,
        ...entry.contrib.merge(entry.manifest)
      })
    }
    return out
  }

  /** 渲染层挂着时主动要一次(首次挂载不必等下一次变更) */
  async contributions(): Promise<PluginContrib[]> {
    return this.contribSnapshot()
  }

  /**
   * 「有没有文档 / 有没有仓库」变了 —— 命令的可用性跟着变,要重新说一遍。
   *
   * 这两件事没有对应的插件事件可蹭(document:change 是内容变了,不是"开没开"),
   * 而不只是命令面板 —— 原生菜单里那条命令的灰/亮也是按这个算的。
   * 重发的原因:下发给渲染层的是 `{贡献点, 上下文}` 两份,可用性由渲染层用后者算 ——
   * 上下文不更新,命令面板里就会一直停在上一次的灰亮状态。
   */
  contextChanged(): void {
    if (!this.initialized) return
    void this.broadcast()
  }

  /** 有文档开着吗 / 开着仓库吗 —— 命令可用性判定的输入 */
  commandContext(): { hasEditor: boolean; hasVault: boolean } {
    return {
      hasEditor: hasEditor(),
      hasVault: Boolean(getSettingsSync()?.vaultPath)
    }
  }

  /**
   * 执行一次界面贡献点(命令面板 / 状态栏 / 右键菜单都走这里)。
   *
   * 三条路共用这一个入口,是因为它们要做的事完全一样:找到那条条目 → 检查它现在
   * 还该不该可用 → 转成一次 runAction。分开写三遍的话,"命令被停用的插件点到了"
   * 这类边界会在其中两条上漏掉。
   */
  async invokeContrib(invoke: PluginContribInvoke): Promise<PluginActionResult> {
    const entry = this.entries.get(invoke.pluginId)
    if (!entry) return { ok: false, message: '插件已不在' }
    if (!entry.state.enabled) return { ok: false, message: `${entry.descriptor.name} 未启用` }

    const merged = entry.contrib.merge(entry.manifest)
    const pool =
      invoke.from === 'status'
        ? merged.statusItem && merged.statusItem.id === invoke.itemId
          ? [merged.statusItem]
          : []
        : invoke.from === 'command'
          ? merged.commands
          : merged.menus
    const item = pool.find(i => i.id === invoke.itemId)
    if (!item) return { ok: false, message: `未找到条目「${invoke.itemId}」` }

    // 执行前再判一次可用性:渲染层画灰只是提示,这里才是真的闸门
    if ('when' in item && !commandAvailable(item.when, this.commandContext())) {
      return { ok: false, message: `「${item.label}」在当前状态下不可用` }
    }
    if (!item.action) {
      // API 注册的条目可以只带一个回调、不指向 action —— 那种情况下由 register 时
      // 存下的 handler 直接跑(见 api.ts 的 commands.register / ui.statusItem)。
      // 种类必须是**这条条目自己的那一种**:三张表的 id 各管各的(见 ContribKind)
      const kind: ContribKind = invoke.from === 'command' ? 'command' : invoke.from === 'status' ? 'status' : 'menu'
      const handler = entry.contrib.handlerFor(kind, invoke.itemId)
      if (!handler) return { ok: false, message: `「${item.label}」没有可执行的动作` }
      const done = await this.safeCall(entry, `contrib:${invoke.itemId}`, () =>
        handler({
          filePath: invoke.filePath ?? null,
          line: invoke.line ?? null,
          hasVault: this.commandContext().hasVault
        })
      )
      await this.broadcast()
      return done
        ? { ok: true, message: `${item.label} 已执行` }
        : { ok: false, message: `${item.label} 执行失败,详情见插件日志` }
    }

    return this.runAction(entry.id, item.action, undefined, {
      editor: invoke.filePath
        ? { line: invoke.line ?? 1, lineText: '', filePath: invoke.filePath }
        : undefined
    })
  }

  /**
   * 把一件宿主里发生的事告诉所有订阅了它的插件。
   *
   * 逐个插件 safeCall,所以一个坏插件卡住不会连累其它插件;超时与熔断复用同一套。
   * 事件是**单向通知**,没有返回值 —— 插件改不了宿主的行为,这也是"没有取消保存
   * 这种能力"的实现方式(不是靠文档里写一句"请不要").
   */
  async emit<E extends PluginEvent>(event: E, payload: PluginEventMap[E]): Promise<void> {
    for (const entry of this.entries.values()) {
      await this.emitTo(entry, event, payload)
    }
  }

  /** 只投给一个插件(用于 config:change 这类"与别人无关"的事件) */
  private async emitTo<E extends PluginEvent>(
    entry: Entry,
    event: E,
    payload: PluginEventMap[E]
  ): Promise<void> {
    if (!entry.state.enabled || entry.loadError) return
    // 沙箱插件用自己的事件通道(它是页面里的回调,不是主进程里的闭包)。
    // 事件名的映射表是**显式**的:没有映射的事件就是"沙箱插件不支持它",
    // 而不是"看着像支持、实际永远收不到"(preload 那边会对未知事件名报警告)。
    if (entry.restricted) {
      const mapped = RESTRICTED_EVENT_MAP[event]
      if (mapped) entry.restricted.send(mapped.type, mapped.payload(payload))
      return
    }
    const handlers = entry.listeners.get(event)
    if (!handlers || handlers.size === 0) return
    for (const handler of handlers) {
      await this.safeCall(entry, `on:${event}`, () => handler(payload))
    }
  }

  /**
   * 插件往右下角发一条通知(限流)。
   *
   * 限流不是防坏插件(它本来就能画自己的界面),是防**好心办坏事**:
   * 一个"文件变动就提醒"的插件在批量操作时会刷出几百条气泡,把界面糊住。
   * 超限时返回 false 并写进插件日志 —— 作者能从日志里看到"我发太多了",
   * 而不是对着一个不出现的通知猜。
   */
  private notify(entry: Entry, message: string, level: PluginNoticeLevel): boolean {
    const now = Date.now()
    entry.noticeTimes = entry.noticeTimes.filter(t => now - t < NOTICE_WINDOW_MS)
    if (entry.noticeTimes.length >= NOTICE_PER_WINDOW) {
      this.emitLog(
        entry,
        'warn',
        `一分钟内通知超过 ${NOTICE_PER_WINDOW} 条,这一条被丢弃(通知是给用户看的,不是日志)`
      )
      return false
    }
    entry.noticeTimes.push(now)

    const win = getMainWindow()
    if (!win || win.webContents.isDestroyed()) {
      // 没有窗口时通知没地方可画。最常见的是插件在 onEnable 里就发了一条 ——
      // 那时应用可能还没建窗。留一句日志,免得作者对着一个不出现的通知反复猜
      this.emitLog(entry, 'warn', '界面还没就绪,这条通知被丢掉了')
      return false
    }
    const notice: PluginNotice = {
      pluginId: entry.id,
      pluginName: entry.descriptor.name,
      message: String(message).slice(0, NOTICE_TEXT_MAX),
      level,
      at: now
    }
    win.webContents.send(IPC.PluginNotice, notice)
    return true
  }

}

/**
 * 宿主事件 → 沙箱插件页事件的映射。
 *
 * `document:change` 的节流由**渲染层**做(最快约 400ms 一次)才发过来 —— 所以
 * "一个隐藏页面被高频叫醒"这件事不会发生:它的粒度是"用户在写字",不是"每一次按键"。
 * 页面上认不出的事件名会由 preload 报一条警告(写错了不该是静默的)。
 */
const RESTRICTED_EVENT_MAP: Partial<{
  [E in PluginEvent]: {
    type: 'config' | 'theme' | 'vault' | 'doc-saved' | 'file-open' | 'doc-changed'
    payload(p: PluginEventMap[E]): unknown
  }
}> = {
  'config:change': { type: 'config', payload: p => p },
  'theme:change': { type: 'theme', payload: p => p },
  'vault:change': { type: 'vault', payload: p => p },
  'document:save': { type: 'doc-saved', payload: p => p },
  'file:open': { type: 'file-open', payload: p => p },
  'document:change': { type: 'doc-changed', payload: p => p }
}

/** 登记表记录 → 下发给渲染层的来源信息(只暴露展示需要的字段) */
function metaOf(record: InstalledRecord | null): PluginInstallInfo | null {
  if (!record) return null
  return {
    version: record.version,
    installedAt: record.installedAt,
    integrity: record.integrity,
    publisher: record.publisher,
    source: record.source,
    mainMode: record.mainMode,
    hasRender: record.hasRender,
    capability: record.capability,
    mainSha256: record.mainSha256,
    renderSha256: record.renderSha256
  }
}

/**
 * 有效权限规则(见 Entry.grants 的说明):
 * - 无 main(capability):清单声明即能力所需权限,用于安装披露;
 * - node main:清单声明;权限是告知 + API 塑形,不做交集;
 * - restricted main:dev/local 视为 granted = declared;market/bundled 取
 *   「用户同意过的 ∩ 清单现在声明的」—— 那才是它真正拿得到的。
 */
function effectiveGrantsOf(
  manifest: PluginManifest | null,
  record: InstalledRecord | null,
  isDev = false
): PluginPermission[] {
  const declared = [...(manifest?.permissions ?? [])]
  if (declared.length === 0) return []
  if (!manifest?.main) return declared
  if (manifest.main.mode === 'node') return declared
  if (isDev || !record || record.source === 'local') return declared
  const granted = record.grantedPermissions ?? []
  return declared.filter(p => granted.includes(p))
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
            const o = t as Partial<PluginTarget>
            const auth: PluginTarget['auth'] =
              o.auth === 'password' || o.auth === 'ssh' || o.auth === 'token' ? o.auth : 'token'
            return {
              id: typeof o.id === 'string' && o.id ? o.id : `t${Date.now().toString(36)}${i}`,
              url: typeof o.url === 'string' ? o.url : '',
              remoteBranch: typeof o.remoteBranch === 'string' ? o.remoteBranch : '',
              localBranch: typeof o.localBranch === 'string' ? o.localBranch : '',
              auth,
              username: typeof o.username === 'string' ? o.username : ''
            } satisfies PluginTarget
          })
        break
      }
      case 'endpoints': {
        const list = Array.isArray(value) ? value : (field.default as PluginEndpoint[])
        out[field.key] = (list as unknown[])
          .filter(t => t && typeof t === 'object')
          .map((t, i) => {
            const o = t as Partial<PluginEndpoint>
            return {
              id: typeof o.id === 'string' && o.id ? o.id : `e${Date.now().toString(36)}${i}`,
              url: typeof o.url === 'string' ? o.url : '',
              model: typeof o.model === 'string' ? o.model : ''
            } satisfies PluginEndpoint
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
  provision?: (host: PluginHost) => Promise<void>,
  devDirs: readonly string[] = []
): Promise<PluginHost> {
  host = new PluginHost()
  await host.init(provision, devDirs)
  return host
}

export function getPluginHost(): PluginHost | null {
  return host
}
