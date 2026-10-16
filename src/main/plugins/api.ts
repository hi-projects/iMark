/**
 * `ImkApi` 的主进程实现 —— 宿主注入给脚本插件的那一个对象。
 *
 * 两条纪律:
 * 1. 每个命名空间都 Object.freeze,整个对象也 freeze。插件改不动 API 对象本身,
 *    否则一个插件能把 API 篡改掉影响后来加载的插件。
 * 2. 权限是**注入强制**的:没声明就拿不到对应的命名空间(是 undefined,不是空壳)。
 *    现在这条覆盖 vault / secrets / git 三个。
 *
 * `vault` 一度是无条件注入的,理由是「path() 与 exists() 泄漏不了什么」。这个理由
 * 站不住的地方在于它**不一致**:同一个插件,声明 `git` 才有 imk.git,而 vault 白拿。
 * 权限表一旦有例外,作者就得逐个去猜哪个是真的、哪个只是装饰,而「猜权限」这种
 * 经验会一路带到他下一个插件里。要么都是门禁,要么都不是。
 *
 * 剩下的词表(vault:write / network / shell / settings)仍是**声明性说明** ——
 * 脚本插件本来就有完整 Node 能力,挡不住 fs/net,列出来是为了让安装者知道自己在
 * 同意什么。详见 shared/pluginPackage.ts 的注释与 README 的「要如实说明的边界」。
 */

import { existsSync } from 'node:fs'
import { inspect } from 'node:util'
import type {
  ImkApi,
  ImkGitApi,
  ImkGitOptions,
  ImkLogLevel,
  ImkSecretsApi,
  PluginContext
} from '@shared/pluginApi'
import {
  PLUGIN_EVENTS,
  secretKey,
  type PluginCommand,
  type PluginEvent,
  type PluginEventMap,
  type PluginMenuItem,
  type PluginPermission,
  type PluginStatusItem
} from '@shared/plugins'
import type {
  ImkCommandContext,
  ImkCommandsApi,
  ImkNoticeLevel,
  ImkUiApi
} from '@shared/pluginApi'
import { credentialArgs, credentialEnv, isGitAvailable, redactUrl, runGit, summarize } from '../git'
import { getSecret, hasSecret } from '../secrets'
import { getSettings } from '../settings'
import type { ContribRegistry } from './contrib'

export interface ApiDeps {
  pluginId: string
  pluginName: string
  pluginVersion: string
  /** 插件的安装目录(内置核心插件为空串) */
  dir: string
  permissions: PluginPermission[]
  /**
   * 校验 (fieldKey, targetId) 确实是本插件声明过的密钥位置。
   * 由宿主实现 —— 只有它同时看得到描述符字段表与当前配置里的目标列表。
   * 不合法时抛异常。
   */
  validateSecretTarget(fieldKey: string, targetId?: string): void
  /** 写进该插件的日志缓冲与主进程控制台 */
  log(line: string): void
  /** 该插件的界面贡献点登记表(命令/状态栏/右键菜单) */
  contrib: ContribRegistry
  /** 该插件的宿主事件订阅表 */
  listeners: Map<PluginEvent, Set<(payload: unknown) => void>>
  /** 往右下角发一条通知(宿主负责限流);返回 false 表示被限流丢掉 */
  notify(message: string, level: ImkNoticeLevel): boolean
  /** 贡献点变了:让宿主重算快照并下发 */
  contribChanged(): void
}

function formatArgs(args: unknown[]): string {
  return args
    .map(a => (typeof a === 'string' ? a : inspect(a, { depth: 3, breakLength: 120 })))
    .join(' ')
}

export function createImkApi(ctx: PluginContext, deps: ApiDeps): ImkApi {
  const has = (p: PluginPermission): boolean => deps.permissions.includes(p)

  const log = (level: ImkLogLevel, ...args: unknown[]): void => {
    deps.log(`[${level}] ${formatArgs(args)}`)
  }

  const vault: ImkApi['vault'] = has('vault:read')
    ? Object.freeze({
        path: async (): Promise<string | null> => {
          const { vaultPath } = await getSettings()
          return vaultPath ?? null
        },
        exists: async (p?: string): Promise<boolean> => {
          if (p) return existsSync(p)
          const { vaultPath } = await getSettings()
          return Boolean(vaultPath) && existsSync(vaultPath as string)
        }
      })
    : undefined

  const secrets: ImkSecretsApi | undefined = has('secrets')
    ? Object.freeze({
        get: async (fieldKey: string, targetId?: string): Promise<string | null> => {
          deps.validateSecretTarget(fieldKey, targetId)
          return getSecret(secretKey(deps.pluginId, fieldKey, targetId))
        },
        has: async (fieldKey: string, targetId?: string): Promise<boolean> => {
          deps.validateSecretTarget(fieldKey, targetId)
          return hasSecret(secretKey(deps.pluginId, fieldKey, targetId))
        }
      })
    : undefined

  const git: ImkGitApi | undefined = has('git')
    ? Object.freeze({
        available: () => isGitAvailable(),
        run: (args: string[], opts: ImkGitOptions) => runGit(args, opts),
        credentialArgs: (token: string) => credentialArgs(token),
        credentialEnv: (user: string, token: string) => credentialEnv(user, token),
        redact: (text: string) => redactUrl(text),
        summarize: (text: string, maxLines?: number) => summarize(text, maxLines)
      })
    : undefined

  /**
   * 界面槽位。
   *
   * **刻意不要权限。** 给右下角发一条通知、在状态栏占一个位置,都不触碰用户的任何
   * 数据 —— 为一件事多要一项权限,只会训练用户闭眼点同意,把真正该读的权限提示
   * 一起稀释掉。权限留给「碰得到用户东西」的能力(文件、密钥、网络、git)。
   *
   * 唯一的例外是插件自己的**窗口**(阶段三的 `ui` 权限):钓鱼窗口是真实风险,
   * 值得如实告知。这里的三样东西都画在宿主自己的界面里,做不了那种事。
   */
  const ui: ImkUiApi = Object.freeze({
    notify: (message: string, level: ImkNoticeLevel = 'info'): void => {
      deps.notify(String(message ?? ''), level)
    },
    statusItem: (item: PluginStatusItem | null, onClick?: () => unknown): void => {
      const { problems } = deps.contrib.setStatusItem(
        item ?? null,
        onClick ? () => onClick() : undefined
      )
      if (problems.length > 0) log('warn', '状态栏条目被拒:', problems.join(';'))
      else deps.contribChanged()
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
