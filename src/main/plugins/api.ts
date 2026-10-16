/**
 * `ImkApi` 的主进程实现 —— 宿主注入给 **trusted 插件**(kind:'script')的那一个对象。
 *
 * 三条纪律:
 * 1. 每个命名空间都 Object.freeze,整个对象也 freeze。插件改不动 API 对象本身,
 *    否则一个插件能把 API 篡改掉影响后来加载的插件。
 * 2. 权限是**注入强制**的:没声明就拿不到对应的命名空间(是 undefined,不是空壳)。
 *    覆盖 vault / secrets / git 三个。
 * 3. **能力实现不在这里** —— 它们在 `ops.ts` 的能力表里,与沙箱插件共用同一份。
 *    这里只做三件事:把方法名映射到 op、把 `{ok:false}` 翻成异常(trusted 插件的
 *    既有写法是 `await imk.vault.read(…)` 然后 catch)、以及把接口形状保持成
 *    `@shared/pluginApi` 里声明的那样。
 *
 * 逐次调用再过一遍 `invokeOp` 是**纵深防御 + 统一审计**:trusted 插件本来就有完整
 * Node 能力,这层挡不住存心作恶的插件;它挡的是参数写错、路径跑出仓库这类误用,
 * 并让"哪一步被拒"留在插件日志里。
 *
 * 一个刻意的例外:**界面贡献点**(命令/状态栏/右键菜单)不走 op。它们的第二个参数
 * 是一个**本地闭包**(作者写的 onClick),过不了序列化边界;沙箱那条路上传的是
 * 一个 id,由宿主桥回页面(见 host.ts 的 invokeSandboxContrib)。校验本身仍然是
 * 共用的一份(contrib.ts),所以两条路不会漂移。
 */

import { inspect } from 'node:util'
import type {
  ImkApi,
  ImkCommandContext,
  ImkCommandsApi,
  ImkGitApi,
  ImkLogLevel,
  ImkNoticeLevel,
  ImkSecretsApi,
  ImkUiApi,
  PluginContext
} from '@shared/pluginApi'
import {
  PLUGIN_EVENTS,
  type PluginCommand,
  type PluginEvent,
  type PluginEventMap,
  type PluginMenuItem,
  type PluginPermission,
  type PluginStatusItem
} from '@shared/plugins'
import { invokeOp } from './gate'
import type { OpContext } from './ops'
import type { ContribRegistry } from './contrib'

export interface ApiDeps {
  pluginId: string
  pluginName: string
  pluginVersion: string
  /** 插件的安装目录(内置核心插件为空串) */
  dir: string
  /** **已生效**的权限(用户同意的 ∩ 清单声明的) */
  permissions: PluginPermission[]
  /** 这次调用的现场(与沙箱插件共用同一份构造,见 host.ts 的 opContextFor) */
  opContext: OpContext
  /**
   * 校验 (fieldKey, targetId) 确实是本插件声明过的密钥位置。
   * 由宿主实现 —— 只有它同时看得到描述符字段表与当前配置里的目标列表。
   */
  validateSecretTarget(fieldKey: string, targetId?: string): void
  /** 写进该插件的日志缓冲与主进程控制台 */
  log(line: string): void
  /** 该插件的界面贡献点登记表(命令/状态栏/右键菜单) */
  contrib: ContribRegistry
  /** 该插件的宿主事件订阅表 */
  listeners: Map<PluginEvent, Set<(payload: unknown) => void>>
  /** 注入界面里的点击回执,按挂载 id 存;停用时由宿主清掉 */
  uiClicks: Map<string, (name: string) => unknown>
  /** 贡献点变了:让宿主重算快照并下发 */
  contribChanged(): void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatArgs(args: unknown[]): string {
  return args
    .map(a => (typeof a === 'string' ? a : inspect(a, { depth: 3, breakLength: 120 })))
    .join(' ')
}

export function createImkApi(ctx: PluginContext, deps: ApiDeps): ImkApi {
  const opCtx = deps.opContext

  /**
   * 跑一个 op 并把结果翻成"返回值或异常"。
   *
   * 翻异常而不是返回 `{ok,error}`:trusted 插件今天写的是
   * `try { await imk.vault.exists(p) } catch {}`,改形状等于把既有插件全部改一遍。
   * 消息里带上错误码,作者至少能看懂是哪一类问题。
   */
  const call = async <T>(op: string, args?: unknown): Promise<T> => {
    const result = await invokeOp(opCtx, op, args, {
      source: 'trusted',
      audit: line => deps.log(line)
    })
    if (result.ok) return result.value as T
    throw new Error(`[${result.error.code}] ${result.error.message}`)
  }

  const log = (level: ImkLogLevel, ...args: unknown[]): void => {
    deps.log(`[${level}] ${formatArgs(args)}`)
  }

  /**
   * `vault` 的形状与 @shared/pluginApi 声明的一致:只有 path / exists。
   * 读写文件是沙箱插件的能力(那个形态下才谈得上"必须经宿主"),
   * trusted 插件直接读磁盘,宿主拦不住,给它加包装只会让人误以为有门禁。
   */
  const vault: ImkApi['vault'] = deps.permissions.includes('vault:read')
    ? Object.freeze({
        path: (): Promise<string | null> => call<string | null>('vault.path'),
        exists: (p?: string): Promise<boolean> => call<boolean>('vault.exists', { path: p })
      })
    : undefined

  const secrets: ImkSecretsApi | undefined = deps.permissions.includes('secrets')
    ? Object.freeze({
        get: (fieldKey: string, targetId?: string): Promise<string | null> =>
          call<string | null>('secrets.get', { fieldKey, targetId }),
        has: (fieldKey: string, targetId?: string): Promise<boolean> =>
          call<boolean>('secrets.has', { fieldKey, targetId })
      })
    : undefined

  const git: ImkGitApi | undefined = deps.permissions.includes('git')
    ? Object.freeze({
        available: (): Promise<boolean> => call<boolean>('git.available'),
        run: (args: string[], opts: { cwd: string; timeoutMs?: number }) =>
          call<Awaited<ReturnType<ImkGitApi['run']>>>('git.run', {
            args,
            cwd: opts?.cwd,
            timeoutMs: opts?.timeoutMs
          }),
        // 下面四个是**纯字符串处理**,不碰任何用户数据也没有权限含义,所以直接实现
        // (它们不走 op 表):走一趟 RPC 只会让 `imk.git.redact(x)` 从同步变成异步,
        // 而既有插件的调用点全是同步写法。
        credentialArgs: (token: string) => credentialArgsOf(token),
        credentialEnv: (user: string, token: string) => credentialEnvOf(user, token),
        redact: (text: string) => redactUrl(String(text)),
        summarize: (text: string, maxLines?: number) => summarize(String(text), maxLines)
      })
    : undefined

  /**
   * 界面槽位。
   *
   * **刻意不要权限。** 给右下角发一条通知、在状态栏占一个位置,都不触碰用户的任何
   * 数据 —— 为一件事多要一项权限,只会训练用户闭眼点同意,把真正该读的权限提示
   * 一起稀释掉。权限留给「碰得到用户东西」的能力(文件、密钥、网络、git)。
   *
   * 唯一的例外是插件自己的**窗口**(沙箱的 `ui` 权限):钓鱼窗口是真实风险,
   * 值得如实告知。这里的三样东西都画在宿主自己的界面里,做不了那种事。
   */
  const ui: ImkUiApi = Object.freeze({
    notify: (message: string, level: ImkNoticeLevel = 'info'): void => {
      void call('ui.notify', { message: String(message ?? ''), level }).catch(() => undefined)
    },
    statusItem: (item: PluginStatusItem | null, onClick?: () => unknown): void => {
      const { problems } = deps.contrib.setStatusItem(
        item ?? null,
        onClick ? () => onClick() : undefined
      )
      if (problems.length > 0) log('warn', `状态栏条目被拒:${problems.join(';')}`)
      else deps.contribChanged()
    },
    // 下面这几个都走能力表(表里有信任形态的校验、参数校验与体积上限),
    // 结果不返回值 —— 它们是"说了就做"的界面动作,失败进日志
    mount: (options: { id: string; html: string; side?: string; title?: string }): void => {
      void call('ui.mount', options).catch(err => log('warn', `挂载界面失败:${messageOf(err)}`))
    },
    update: (id: string, html: string): void => {
      void call('ui.update', { id, html }).catch(err => log('warn', `更新界面失败:${messageOf(err)}`))
    },
    remove: (id: string): void => {
      void call('ui.remove', { id }).catch(err => log('warn', `摘掉界面失败:${messageOf(err)}`))
    },
    injectStyles: (css: string): void => {
      void call('ui.injectStyles', { css }).catch(err => log('warn', `注入样式失败:${messageOf(err)}`))
    },
    /**
     * 注入界面里的点击回执。
     *
     * 注册表挂在 entry 上(由宿主给),而不是这张闭包里:停用插件时要跟着一起清干净 ——
     * 留着的话,那个 id 的下一个主人会莫名其妙地接到上一家的点击。
     */
    onClick: (mountId: string, handler: (name: string) => unknown): (() => void) => {
      deps.uiClicks.set(mountId, handler)
      return () => {
        if (deps.uiClicks.get(mountId) === handler) deps.uiClicks.delete(mountId)
      }
    }
  })

  const commands: ImkCommandsApi = Object.freeze({
    register: (
      cmd: PluginCommand,
      handler?: (ctx: ImkCommandContext) => unknown
    ): (() => void) => {
      const result = deps.contrib.addCommand(
        cmd,
        handler ? ctx => handler({ filePath: ctx.filePath, line: ctx.line, hasVault: ctx.hasVault }) : undefined
      )
      if (!result.ok) {
        // 注册失败的条目**不会**出现在界面上。静默丢掉是最坏的选择 ——
        // 作者会盯着一个"命令怎么没出来"的空白反复试,所以两边都留下痕迹:
        // 插件日志(作者看得到)与控制台(开发时看得到)。
        log('warn', `命令「${cmd?.id ?? '?'}」注册失败:`, result.errors.join(';'))
        return () => {}
      }
      deps.contribChanged()
      return () => {
        deps.contrib.removeCommand(result.value.id)
        deps.contribChanged()
      }
    },
    remove: (id: string): void => {
      deps.contrib.removeCommand(id)
      deps.contribChanged()
    },
    menuItem: (item: PluginMenuItem, onClick?: (ctx: ImkCommandContext) => unknown): (() => void) => {
      const { problems } = deps.contrib.addMenuItem(
        item,
        onClick
          ? ctx => onClick({ filePath: ctx.filePath, line: ctx.line, hasVault: ctx.hasVault })
          : undefined
      )
      if (problems.length > 0) {
        log('warn', `右键菜单条目「${item?.id ?? '?'}」注册失败:`, problems.join(';'))
        return () => {}
      }
      deps.contribChanged()
      return () => {
        deps.contrib.removeMenuItem(item.id)
        deps.contribChanged()
      }
    }
  })

  /**
   * 订阅宿主事件。
   *
   * 事件名先过白名单:插件是 JS,类型在运行时不存在,写错一个字母的话
   * 沉默地永远收不到事件是最难查的一类问题 —— 这里直接拒绝并说明。
   */
  const on = (<E extends PluginEvent>(
    event: E,
    handler: (payload: PluginEventMap[E]) => void
  ): (() => void) => {
    if (!PLUGIN_EVENTS.includes(event)) {
      log('warn', `不认识的事件「${String(event)}」(可用:${PLUGIN_EVENTS.join(' / ')})`)
      return () => {}
    }
    if (typeof handler !== 'function') {
      log('warn', `事件「${String(event)}」的处理函数不是函数`)
      return () => {}
    }
    const set = deps.listeners.get(event) ?? new Set()
    const fn = handler as (payload: unknown) => void
    set.add(fn)
    deps.listeners.set(event, set)
    return () => {
      set.delete(fn)
    }
  }) as ImkApi['on']

  const api: ImkApi = {
    // ---------- PluginContext ----------
    pluginId: ctx.pluginId,
    getConfig: ctx.getConfig,
    setState: ctx.setState,
    flushDocument: ctx.flushDocument,
    isEnabled: ctx.isEnabled,
    isDisabledByHost: ctx.isDisabledByHost,
    // ---------- 扩展能力 ----------
    plugin: Object.freeze({
      id: deps.pluginId,
      name: deps.pluginName,
      version: deps.pluginVersion,
      dir: deps.dir
    }),
    log,
    ui,
    commands,
    on,
    ...(vault ? { vault } : {}),
    ...(secrets ? { secrets } : {}),
    ...(git ? { git } : {})
  }

  return Object.freeze(api)
}

// 凭据 helper 与脱敏工具直接复用 git 模块的纯函数(它们不碰任何状态)
import {
  credentialArgs as credentialArgsOf,
  credentialEnv as credentialEnvOf,
  redactUrl,
  summarize
} from '../git'
