/**
 * `ImkApi` 的主进程实现 —— 宿主注入给脚本插件的那一个对象。
 *
 * 两条纪律:
 * 1. 每个命名空间都 Object.freeze,整个对象也 freeze。插件改不动 API 对象本身,
 *    否则一个插件能把 API 篡改掉影响后来加载的插件。
 * 2. 权限是**注入强制**的:没声明 'git' 就拿不到 imk.git(是 undefined,不是空壳)。
 *    其余权限词表是声明性说明 —— 脚本插件本来就有完整 Node 能力,挡不住 fs/net,
 *    列出来是为了让安装者知道自己在同意什么。详见 shared/pluginPackage.ts 的注释。
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
import { secretKey, type PluginPermission } from '@shared/plugins'
import { credentialArgs, credentialEnv, isGitAvailable, redactUrl, runGit, summarize } from '../git'
import { getSecret, hasSecret } from '../secrets'
import { getSettings } from '../settings'

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

  const vault = Object.freeze({
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
    vault,
    log,
    ...(secrets ? { secrets } : {}),
    ...(git ? { git } : {})
  }

  return Object.freeze(api)
}
