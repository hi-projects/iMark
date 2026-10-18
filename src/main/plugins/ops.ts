/**
 * **唯一权威的能力表** —— restricted main 与 node main 共同的家底。
 *
 * 改造前,能力就是 `api.ts` 直接造出来的那些闭包(`imk.vault.read` 就是函数本身);
 * 受限层要的是同一批能力,却隔着一条 IPC。于是只剩两条路:在 IPC 处理里再抄一份
 * (两份实现迟早分家,而分家的后果是**权限判定在其中一份上漏掉**),或者把能力抽成
 * 一张表、两条传输共用(就是这里)。
 *
 * 每一项声明四件事:
 *   - `perm`      —— 要哪个权限;`null` = 不要权限(不碰用户数据的东西,理由见 api.ts)
 *   - `timeoutMs` —— 超过就 E_TIMEOUT。超时是必须的:一个卡住的 op 会占住整条通道
 *   - `limit`     —— 频率/并发(闸门见 gate.ts)
 *   - `run`       —— 真正干活的那段
 *
 * **node main 插件也过这张表**:`api.ts` 从本表生成方法,每个方法内部再走一次
 * `invokeOp`。它本来就有完整 Node 能力,这层挡不住存心作恶的插件 ——
 * 它挡的是**误用**(参数写错、路径跑出仓库)与**审计**(被拒的调用会留在插件日志里,
 * 设置界面看得见"哪一步被拒")。
 */

import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PluginPermission } from '@shared/pluginPackage'
import type {
  PluginCommand,
  PluginMenuItem,
  PluginState,
  PluginStatusItem
} from '@shared/plugins'
import { getSettings, getSettingsSync } from '../settings'
import { getSecret, hasSecret } from '../secrets'
import { isGitAvailable, redactUrl, runGit, summarize } from '../git'
import { trashVaultPath } from '../vault'
import { currentDocPath } from '../window'

/**
 * 一次能力调用的现场。由 host.ts 造,ops 只管用。
 *
 * 这里**没有一个通用通道**:界面贡献点的注册、窗口、调度器都是显式方法。
 * 图省事塞一个 `invoke(name, ...)` 的话,ops 就退化成了转发层,
 * 而"哪些能力存在"这件事会散到各处 —— 那正是本表要收拢的东西。
 */
export interface OpContext {
  pluginId: string
  pluginName: string
  /** 插件目录(纯后台/内置插件为空串) */
  dir: string
  config: Record<string, unknown>
  /** **已生效**的权限 = 用户装的时候同意的 ∩ 清单现在声明的(见 host.ts 的 effectiveGrants) */
  grants: readonly PluginPermission[]
  /** 用户是否为这个插件放开了「允许访问本机/内网地址」(默认 false) */
  allowLocalNet: boolean
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /** 右下角通知;返回 false 表示被限流丢掉 */
  notify(message: string, level: 'info' | 'success' | 'warn' | 'error'): boolean
  setState(patch: Partial<PluginState>): void
  /** 让渲染层先把脏文档落盘 */
  flushDocument(): Promise<void>
  /** 这个 main 层是不是 restricted(个别能力只给受限层/只给 node 层) */
  readonly isRestricted: boolean
  /** 这个插件有没有 render 层 */
  readonly hasRender: boolean
  /**
   * 把一条消息送给这个插件的 render 层。
   * 没有 render 层、或 render 层还没就绪时抛错(由能力表归一成结构化失败)。
   */
  sendToRenderLayer(channel: string, data: unknown): void
  /** 让某个文件在渲染层重新加载(插件刚改过它) */
  notifyFileChanged(filePath: string): void
  /** 界面贡献点:注册的动作由宿主桥接回插件(manifest 声明的走 runAction) */
  registerCommand(cmd: PluginCommand): string[]
  removeCommand(id: string): void
  setStatusItem(item: PluginStatusItem | null): string[]
  addMenuItem(item: PluginMenuItem): string[]
  /** 宿主调度的定时器(主进程 Node 定时器不受渲染层节流影响) */
  schedule: { every(ms: number, name: string): void; clear(name: string): void }
  validateSecretTarget(fieldKey: string, targetId?: string): void
}

export interface OpDef {
  perm: PluginPermission | null
  timeoutMs: number
  /** 参数上限(字节)。不填用 RPC_MAX_ARGS_BYTES */
  maxArgsBytes?: number
  /** 频率限制:`'60/60000'` = 每 60 秒最多 60 次 */
  limit?: string
  /** 并发上限(只有挂很久的网络类 op 用得上) */
  maxConcurrent?: number
  /** 只给 **restricted main**(它有隐藏执行页,比如宿主调度器) */
  restrictedOnly?: boolean
  /**
   * 第三参数是**过不了 JSON 的那一半现场信息**(现在只有撤销信号)。
   * 沙箱那条路上它是空的:AbortSignal 不能序列化,插件那一侧也没有"取消"这个动作。
   */
  run(ctx: OpContext, args: unknown, run: OpRunOptions): Promise<unknown>
}

/** op 运行时拿得到的、不能经 JSON 传的现场信息 */
export interface OpRunOptions {
  /**
   * 调用方撤销时触发(见 gate.ts:`AbortSignal.any([调用方的, 超时的])`)。
   * 只有长命子进程类的 op 用得上 —— 今天只有 `git.run`。
   */
  signal: AbortSignal
}

/** op 内部抛的错:带错误码,由 gate.ts 归一后交给插件 */
export class OpError extends Error {
  constructor(
    readonly code:
      | 'E_BAD_ARGS'
      | 'E_PERMISSION'
      | 'E_TIMEOUT'
      | 'E_BUSY'
      | 'E_UNKNOWN_OP'
      | 'E_FAILED'
      | 'E_INTERNAL',
    message: string,
    readonly detail?: string
  ) {
    super(message)
  }
}

// ---------- 参数读数(所有 op 的参数都是 unknown,统一在这里收口) ----------

function asObject(args: unknown, op: string): Record<string, unknown> {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new OpError('E_BAD_ARGS', `${op} 的参数必须是一个对象`)
  }
  return args as Record<string, unknown>
}

function asString(v: unknown, where: string, maxLen = 4096): string {
  if (typeof v !== 'string') throw new OpError('E_BAD_ARGS', `${where} 必须是字符串`)
  if (v.length > maxLen) throw new OpError('E_BAD_ARGS', `${where} 太长(超过 ${maxLen} 字符)`)
  return v
}

/** 可选的字符串参数:undefined/null 都当"没给" */
function optString(v: unknown, where: string, maxLen = 4096): string | undefined {
  if (v === undefined || v === null) return undefined
  return asString(v, where, maxLen)
}

// ---------- 仓库路径的安全关卡(§3.8) ----------

/** 读写单个仓库文件的上限 */
const VAULT_FILE_MAX = 1024 * 1024

/**
 * 把插件给的**相对路径**变成一个安全的绝对路径。
 *
 * 五道关,少一道就漏:
 *   1. 长度、`\0`、反斜杠、绝对路径(含 Windows 盘符)一律拒 —— 反斜杠在 Windows 上
 *      是分隔符、在别处是普通字符,放进来就是两套语义
 *   2. 逐段先 `decodeURIComponent`(挡 `%2e%2e`)再拒 `''` / `.` / `..`
 *   3. 拒任何以 `.git` 开头的段 —— `.git/config` 里可能内嵌 token,
 *      而"读仓库里的文件"绝不该包含它
 *   4. `safeJoin` 拼出来之后再确认没跑出去(纯字符串的兜底)
 *   5. 对**已存在的目录**做 realpath 校验 —— 挡"仓库内的符号链接指向 ~/.ssh"
 *
 * 第 5 步是关键:前四步全是字符串层面的,而符号链接是磁盘上的事实。
 *
 * @param rel   插件的相对路径;传 `''` 表示仓库根
 * @param mode  'existing' 要求目标存在(否则报"读不到");'dir' 还额外要求它是目录
 */
export async function resolveVaultPath(
  rel: unknown,
  mode: 'any' | 'existing' | 'dir' = 'any'
): Promise<string> {
  const raw = rel === undefined || rel === null || rel === '' ? '' : asString(rel, 'path', 512)
  if (raw.includes('\0')) throw new OpError('E_BAD_ARGS', '路径里不能有 \\0')
  if (raw.includes('\\')) throw new OpError('E_BAD_ARGS', '路径请用正斜杠 / 分隔')
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new OpError('E_BAD_ARGS', '只接受仓库内的**相对**路径,不接受绝对路径')
  }

  const segments: string[] = []
  for (const part of raw.split('/')) {
    if (part === '') continue // 容忍头尾与重复的 /
    let decoded = part
    try {
      decoded = decodeURIComponent(part)
    } catch {
      /* 不是合法转义就按原样 */
    }
    if (decoded === '' || decoded === '.' || decoded === '..') {
      throw new OpError('E_BAD_ARGS', `路径里不允许出现「${decoded || '空'}」这样的段`)
    }
    if (decoded.startsWith('.git')) {
      throw new OpError('E_PERMISSION', '仓库里的 .git 目录不对外开放(它可能含有凭据)')
    }
    segments.push(decoded)
  }

  const root = getSettingsSync()?.vaultPath
  if (!root) throw new OpError('E_FAILED', '当前没有打开仓库')
  const base = resolve(root)
  const full = resolve(join(base, ...segments))
  assertInside(base, full, '路径跑出了仓库')

  if (mode !== 'any') {
    // realpath 把符号链接展开成真实位置 —— 只有它能把"仓库里有个链接指向 ~/.ssh"翻出来
    let realRoot: string
    try {
      realRoot = await realpath(base)
    } catch {
      throw new OpError('E_FAILED', '读不到仓库目录')
    }
    try {
      const real = await realpath(full)
      assertInside(realRoot, real, '这个路径指向仓库外面(可能是个符号链接)')
      if (mode === 'dir' && !(await stat(real)).isDirectory()) {
        throw new OpError('E_BAD_ARGS', '这不是一个目录')
      }
    } catch (err) {
      if (err instanceof OpError) throw err
      throw new OpError('E_FAILED', `读不到:${raw || '(仓库根)'}`)
    }
  } else {
    // 目标还不存在(写文件):至少要保证**已存在的父目录**没被链接出去
    try {
      const realParent = await realpath(dirname(full))
      const realRoot = await realpath(base)
      assertInside(realRoot, realParent, '这个路径指向仓库外面(可能是个符号链接)')
    } catch (err) {
      if (err instanceof OpError) throw err
      /* 父目录不存在:交给实际写盘去报错 */
    }
  }
  return full
}

function assertInside(base: string, target: string, message: string): void {
  const b = base.endsWith(sep) ? base : base + sep
  if (target !== base && !target.startsWith(b)) throw new OpError('E_PERMISSION', message)
}

/**
 * `git.run` 的工作目录:接受仓库内的**绝对**路径,也接受**相对**路径。
 *
 * 这里比 `vault:*` 宽松一档,原因很具体:node main 插件(git-sync)一直传的是
 * `settings.vaultPath` 那个**绝对**路径 —— 它本来就有完整 Node 能力,给它一句
 * 「路径请用正斜杠 / 分隔」既拦不住什么,又会把既有插件当场打断(实测:验收
 * 套跑出来的第一条回归)。要守住的是**范围**(必须在仓库里),不是写法。
 */
async function resolveGitCwd(raw: unknown): Promise<string> {
  const root = getSettingsSync()?.vaultPath
  if (!root) throw new OpError('E_FAILED', '当前没有打开仓库')
  const base = resolve(root)
  if (typeof raw === 'string' && raw !== '' && (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw))) {
    const full = resolve(raw)
    assertInside(base, full, 'git 的工作目录必须在当前仓库里')
    // realpath 那一道照旧:仓库里放一个指向 ~/.ssh 的链接不该成为一条后门
    const realBase = await realpath(base).catch(() => base)
    const realFull = await realpath(full).catch(() => full)
    assertInside(realBase, realFull, 'git 的工作目录指向仓库外面(可能是个符号链接)')
    return realFull
  }
  return resolveVaultPath(raw ?? '', 'dir')
}

/** 展示给插件看的相对路径(统一正斜杠) */
function relToVault(full: string): string {
  const root = getSettingsSync()?.vaultPath
  if (!root) return full
  return resolve(full) === resolve(root) ? '' : relative(resolve(root), full).split(sep).join('/')
}

// ---------- net.fetch 的地址策略(§3.8) ----------

/** 内网/本机/链路本地/云元数据地址 —— 默认一律拒 */
export function isPrivateHost(host: string, address?: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  const ip = (address ?? h).toLowerCase()
  if (ip.includes(':')) {
    // IPv6:回环 ::1 / 未指定 ::、链路本地 fe80::/10、唯一本地 fc00::/7
    if (ip === '::1' || ip === '::') return true
    if (/^fe[89ab]/.test(ip)) return true
    if (/^f[cd]/.test(ip)) return true
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateHost(mapped[1]!)
    return false
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // 链路本地 + 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

/** 一次请求/响应的体积上限 */
const NET_MAX_REQUEST = 4 * 1024 * 1024
const NET_MAX_RESPONSE = 8 * 1024 * 1024
/** 手动跟随的重定向上限(自动跟随是经典 SSRF 洞:策略只在第一跳查过) */
const NET_MAX_REDIRECTS = 5
/** 只回传这几个响应头(其余可能带内部信息) */
const NET_ALLOWED_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified']

/**
 * fetcher 可注入 —— 验收 harness 用它把"第二跳转向元数据地址"这类场景造出来。
 *
 * 默认用的是 **Node 的 fetch(undici)**,不是 Electron 的 net:前者根本不带 cookie
 * 罐子,也就谈不上蹭到默认 session 里的市场登录态。这比"另开一个内存 session"
 * 更彻底 —— 那种做法依赖"我记得把它设对",而这种做法是结构上就没有。
 */

export type NetFetch = (url: string, init: RequestInit) => Promise<Response>

let netFetchImpl: NetFetch = (url, init) => fetch(url, init)

/** 仅验收 harness 使用 */
export function setNetFetchImpl(fn: NetFetch): void {
  netFetchImpl = fn
}

async function assertHostAllowed(url: URL, allowLocal: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpError('E_BAD_ARGS', '只允许 http / https 地址')
  }
  if (allowLocal) return
  const host = url.hostname
  const deny = (): never => {
    throw new OpError(
      'E_PERMISSION',
      `${host} 是本机/内网地址。确实需要的话,请在「设置 → 插件」里为它打开「允许访问本机地址」。`
    )
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (isPrivateHost(host)) deny()
    return
  }
  // 域名要先解析成地址再判 —— 一个指向 127.0.0.1 的域名与直接写 IP 是一回事
  const { lookup } = await import('node:dns/promises')
  let addresses: string[]
  try {
    addresses = (await lookup(host, { all: true })).map(r => r.address)
  } catch {
    throw new OpError('E_FAILED', `解析不了域名:${host}`)
  }
  if (addresses.some(a => isPrivateHost(host, a))) deny()
}

async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new OpError('E_FAILED', `响应超过 ${Math.round(limit / 1024 / 1024)} MiB 上限`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

// ---------- git 参数校验(§3.8) ----------

/**
 * 危险的 git 参数 —— **沙箱下**它们等价于任意命令执行:
 *   `-c core.sshCommand=…` / `-c core.pager=…` 会执行任意程序;
 *   `--upload-pack=` / `--receive-pack=` 同上;
 *   `ext::` 传输协议的字面含义就是"执行这个命令"。
 *
 * **只对沙箱插件生效。** `imark.git`(沙箱那条路)的能力表里就是写着"有白名单"的(README §五),
 * 而脚本插件本来就有完整 Node:`child_process` 一行就能做同样的事,拦它不增加任何安全性,
 * 却会把正当用法一起打断 —— 这两条都实测踩到过:
 *   1. 宿主自己发给它的 `credentialArgs()` 是 `-c credential.helper=…`,身份兜底是
 *      `-c user.name=…` —— 于是**用访问令牌的上传整个用不了**(报错还挂着"沙箱插件只放开了
 *      常用读写命令",让人以为是沙箱的锅);
 *   2. `ls-remote`(「测试连接」用的)与 `symbolic-ref` 也不在白名单里。
 * 用户在安装确认框里对脚本插件看到的是"完整权限",这里再假装有一条门禁反而是撒谎。
 */
const GIT_DENY_ARG = /^(-c|-C|--exec.*|--upload-pack.*|--receive-pack.*|--upload_pack.*|--receive_pack.*)/i
const GIT_DENY_URL = /^(ext|file|fd)::/i

/** 允许的子命令白名单。**白名单而不是黑名单**:git 的命令面太大,列不全 */
const GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'add', 'rm', 'mv', 'commit', 'push', 'pull', 'fetch',
  'clone', 'init', 'branch', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'tag',
  'remote', 'rev-parse', 'ls-files', 'cat-file', 'hash-object', 'describe', 'shortlog',
  'blame', 'config', 'restore', 'reset', 'clean',
  // 只读的两个:问远端有哪些分支(「测试连接」就是它)、读写 HEAD 指向的分支名
  'ls-remote', 'symbolic-ref'
])

export function assertGitArgs(args: unknown, isRestricted: boolean): void {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
    throw new OpError('E_BAD_ARGS', 'git.run 的参数必须是字符串数组')
  }
  if (!isRestricted) return
  const list = args as string[]
  const sub = list.find(a => !a.startsWith('-'))
  if (!sub || !GIT_SUBCOMMANDS.has(sub)) {
    throw new OpError(
      'E_BAD_ARGS',
      `不允许的 git 子命令${sub ? `「${sub}」` : '(没给子命令)'}。受限 main 只放开了常用读写命令。`
    )
  }
  for (const a of list) {
    if (GIT_DENY_ARG.test(a)) {
      throw new OpError('E_BAD_ARGS', `不允许的 git 参数「${a}」(它能变成任意命令执行)`)
    }
    if (GIT_DENY_URL.test(a)) {
      throw new OpError('E_BAD_ARGS', `不允许的 git 传输协议「${a}」`)
    }
  }
}

/**
 * 子进程的环境变量。**只给 node main** —— 对 restricted 来说它和 `-c` 是同一个口子
 * (`GIT_SSH_COMMAND` / `GIT_EXTERNAL_DIFF` / `GIT_PAGER` 都能变成"执行任意程序"),
 * 而受限那条路本来也没有凭据可注入(credentialArgs / credentialEnv 不给它)。
 */
function normalizeGitEnv(raw: unknown, isRestricted: boolean): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (isRestricted) {
    throw new OpError('E_BAD_ARGS', 'git.run 的 env 只对脚本插件开放(它能用来挂执行外部程序的钩子)')
  }
  const obj = asObject(raw, 'git.run.env')
  const keys = Object.keys(obj)
  if (keys.length > 32) throw new OpError('E_BAD_ARGS', 'git.run 的 env 最多 32 个变量')
  const out: Record<string, string> = {}
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new OpError('E_BAD_ARGS', `不合法的环境变量名「${k}」`)
    }
    const v = obj[k]
    if (typeof v !== 'string') throw new OpError('E_BAD_ARGS', `环境变量「${k}」的值必须是字符串`)
    if (Buffer.byteLength(v) > 8192) throw new OpError('E_BAD_ARGS', `环境变量「${k}」的值超过 8 KiB`)
    out[k] = v
  }
  return out
}

// ---------- 状态补丁的白名单 ----------

const STATE_STATUS = ['idle', 'running', 'ok', 'partial', 'error']

function normalizeStatePatch(patch: unknown): Partial<PluginState> {
  const p = asObject(patch, 'state.set')
  const out: Partial<PluginState> = {}
  if (p.status !== undefined) {
    if (!STATE_STATUS.includes(String(p.status))) {
      throw new OpError('E_BAD_ARGS', `status 只能是 ${STATE_STATUS.join(' / ')}`)
    }
    out.status = p.status as PluginState['status']
  }
  if (p.lastMessage !== undefined) out.lastMessage = asString(p.lastMessage, 'lastMessage', 500)
  if (p.lastDetail !== undefined) out.lastDetail = asString(p.lastDetail, 'lastDetail', 4096)
  return out
}

// ---------- 表 ----------

const OPS: Record<string, OpDef> = {
  // ---------- 不要权限的那几个(理由见 api.ts 的 ui 段) ----------

  'plugin.info': {
    perm: null,
    timeoutMs: 1000,
    run: async ctx => ({ id: ctx.pluginId, name: ctx.pluginName, dir: ctx.dir })
  },

  'config.get': {
    perm: null,
    timeoutMs: 1000,
    run: async ctx => ctx.config
  },

  'state.set': {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      ctx.setState(normalizeStatePatch(args))
      return null
    }
  },

  /**
   * main 层 → render 层的一条消息。
   *
   * 不要权限:它不碰任何用户数据,只是把数据从同一插件的另一半送过去。
   * 但仍然限流、限体积、校验通道名 —— 一个失控的插件不该能靠消息把对面淹掉。
   */
  'render.send': {
    perm: null,
    timeoutMs: 2000,
    limit: '120/60000',
    run: async (ctx, args) => {
      if (!ctx.hasRender) {
        throw new OpError('E_FAILED', '这个插件没有 render 层,消息无处投递')
      }
      const a = asObject(args, 'render.send')
      const channel = asString(a.channel, 'channel', 64)
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(channel)) {
        throw new OpError('E_BAD_ARGS', 'channel 只能包含字母、数字与 . _ -(≤64 字符)')
      }
      const data = a.data ?? null
      let size = 0
      try {
        size = JSON.stringify(data).length
      } catch {
        throw new OpError('E_BAD_ARGS', '消息必须是可 JSON 化的数据')
      }
      if (size > 256 * 1024) {
        throw new OpError('E_BAD_ARGS', '单条消息不能超过 256 KiB')
      }
      ctx.sendToRenderLayer(channel, data)
      return null
    }
  },

  log: {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      const a = asObject(args, 'log')
      const level = String(a.level ?? 'info')
      if (!['debug', 'info', 'warn', 'error'].includes(level)) {
        throw new OpError('E_BAD_ARGS', `不认识的日志级别:${level}`)
      }
      const parts = Array.isArray(a.parts) ? a.parts : []
      // 参数是任意 JS 值,过一遍结构化克隆之外的东西会直接抛,所以只收能 JSON 化的
      const text = parts
        .map(p => (typeof p === 'string' ? p : safeJson(p)))
        .join(' ')
        .slice(0, 8192)
      ctx.log(level as 'debug' | 'info' | 'warn' | 'error', text)
      return null
    }
  },

  'ui.notify': {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      const a = asObject(args, 'ui.notify')
      const message = asString(a.message, 'message', 200)
      const level = String(a.level ?? 'info')
      if (!['info', 'success', 'warn', 'error'].includes(level)) {
        throw new OpError('E_BAD_ARGS', `不认识的通知级别:${level}`)
      }
      // 返回 Boolean 而不是抛:限流是**正常结果**(作者该知道它发生了),但调用方
      // 不该为它写 try/catch
      return ctx.notify(message, level as 'info' | 'success' | 'warn' | 'error')
    }
  },

  'ui.statusItem': {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      const item = (asObject(args, 'ui.statusItem').item ?? null) as PluginStatusItem | null
      const problems = ctx.setStatusItem(item)
      if (problems.length > 0) ctx.log('warn', `状态栏条目被拒:${problems.join(';')}`)
      return problems
    }
  },

  'command.register': {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      const problems = ctx.registerCommand(asObject(args, 'command.register').command as PluginCommand)
      if (problems.length > 0) ctx.log('warn', `命令注册失败:${problems.join(';')}`)
      return problems
    }
  },

  'command.remove': {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      ctx.removeCommand(asString(asObject(args, 'command.remove').id, 'id', 100))
      return null
    }
  },

  'menu.item': {
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      const problems = ctx.addMenuItem(asObject(args, 'menu.item').item as PluginMenuItem)
      if (problems.length > 0) ctx.log('warn', `右键菜单条目被拒:${problems.join(';')}`)
      return problems
    }
  },

  'document.flush': {
    perm: null,
    timeoutMs: 5000,
    run: async ctx => {
      await ctx.flushDocument()
      return null
    }
  },

  'schedule.every': {
    restrictedOnly: true,
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      const a = asObject(args, 'schedule.every')
      ctx.schedule.every(Number(a.ms), asString(a.name, 'name', 64))
      return null
    }
  },

  'schedule.clear': {
    restrictedOnly: true,
    perm: null,
    timeoutMs: 1000,
    run: async (ctx, args) => {
      ctx.schedule.clear(asString(asObject(args, 'schedule.clear').name, 'name', 64))
      return null
    }
  },

  // ---------- 仓库 ----------

  'vault.path': {
    perm: 'vault:read',
    timeoutMs: 2000,
    run: async () => (await getSettings()).vaultPath ?? null
  },

  'vault.exists': {
    perm: 'vault:read',
    timeoutMs: 2000,
    run: async (_ctx, args) => {
      const p = asObject(args, 'vault.exists').path
      if (p === undefined || p === null || p === '') return Boolean(getSettingsSync()?.vaultPath)
      try {
        await resolveVaultPath(p, 'existing')
        return true
      } catch {
        return false
      }
    }
  },

  'vault.read': {
    perm: 'vault:read',
    timeoutMs: 10_000,
    run: async (_ctx, args) => {
      const full = await resolveVaultPath(asObject(args, 'vault.read').path, 'existing')
      const s = await stat(full)
      if (!s.isFile()) throw new OpError('E_BAD_ARGS', '这是一个目录,不是文件')
      if (s.size > VAULT_FILE_MAX) {
        throw new OpError('E_FAILED', `文件超过 ${VAULT_FILE_MAX / 1024 / 1024} MiB 上限`)
      }
      return { path: relToVault(full), text: await readFile(full, 'utf8') }
    }
  },

  'vault.list': {
    perm: 'vault:read',
    timeoutMs: 10_000,
    run: async (_ctx, args) => {
      const full = await resolveVaultPath(asObject(args, 'vault.list').path, 'dir')
      const entries = await readdir(full, { withFileTypes: true })
      return entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({ name: e.name, dir: e.isDirectory() }))
    }
  },

  'vault.write': {
    perm: 'vault:write',
    timeoutMs: 10_000,
    limit: '60/60000',
    run: async (ctx, args) => {
      const a = asObject(args, 'vault.write')
      const text = asString(a.text, 'text', VAULT_FILE_MAX)
      const full = await resolveVaultPath(a.path, 'any')
      // 写**当前打开的那个文件**是竞态:先让编辑器落盘,写完再让它重新加载。
      // 默认不拒绝 —— 那会让"插件改当前这篇笔记"这种最自然的用法不可用;
      // 作者传 force 表示"我知道会覆盖编辑器里还没保存的内容"
      const editing = currentDocPath() === full
      if (editing && a.force !== true) await ctx.flushDocument()
      await writeFile(full, text, 'utf8')
      if (editing) ctx.notifyFileChanged(full)
      return { path: relToVault(full) }
    }
  },

  'vault.remove': {
    perm: 'vault:write',
    timeoutMs: 10_000,
    limit: '60/60000',
    run: async (_ctx, args) => {
      const full = await resolveVaultPath(asObject(args, 'vault.remove').path, 'existing')
      await trashVaultPath(full)
      return null
    }
  },

  // ---------- 密钥 ----------

  'secrets.get': {
    perm: 'secrets',
    timeoutMs: 5000,
    run: async (ctx, args) => {
      const a = asObject(args, 'secrets.get')
      const fieldKey = asString(a.fieldKey, 'fieldKey', 100)
      const targetId = optString(a.targetId, 'targetId', 100)
      ctx.validateSecretTarget(fieldKey, targetId)
      return getSecret(secretKeyOf(ctx.pluginId, fieldKey, targetId))
    }
  },

  'secrets.has': {
    perm: 'secrets',
    timeoutMs: 5000,
    run: async (ctx, args) => {
      const a = asObject(args, 'secrets.has')
      const fieldKey = asString(a.fieldKey, 'fieldKey', 100)
      const targetId = optString(a.targetId, 'targetId', 100)
      ctx.validateSecretTarget(fieldKey, targetId)
      return hasSecret(secretKeyOf(ctx.pluginId, fieldKey, targetId))
    }
  },

  // ---------- 网络 ----------

  'net.fetch': {
    perm: 'network',
    timeoutMs: 30_000,
    limit: '60/60000',
    maxConcurrent: 4,
    run: async (ctx, args) => {
      const a = asObject(args, 'net.fetch')
      const method = String(a.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new OpError('E_BAD_ARGS', `不支持的请求方法:${method}`)
      }
      const body = optString(a.body, 'body', NET_MAX_REQUEST)
      if (body && Buffer.byteLength(body, 'utf8') > NET_MAX_REQUEST) {
        throw new OpError('E_BAD_ARGS', `请求体超过 ${NET_MAX_REQUEST / 1024 / 1024} MiB 上限`)
      }
      // cookie 一律剥掉:带上宿主的 cookie 就等于替用户发请求
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(asObject(a.headers ?? {}, 'headers'))) {
        const lower = k.toLowerCase()
        if (lower === 'cookie' || lower === 'set-cookie') continue
        if (typeof v === 'string') headers[k] = v
      }

      let url = asString(a.url, 'url', 2048)
      for (let hop = 0; hop <= NET_MAX_REDIRECTS; hop++) {
        const parsed = new URL(url)
        await assertHostAllowed(parsed, ctx.allowLocalNet)
        const res = await netFetchImpl(url, {
          method,
          headers,
          ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
          redirect: 'manual'
        })
        const location = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && location) {
          // 每一跳都重查策略:自动跟随的话,第一跳合法、第二跳指向 169.254.169.254
          // 就是一条现成的 SSRF(而且响应会原样回到插件手里)
          url = new URL(location, url).toString()
          continue
        }
        const buf = await readCapped(res, NET_MAX_RESPONSE)
        const outHeaders: Record<string, string> = {}
        for (const name of NET_ALLOWED_HEADERS) {
          const v = res.headers.get(name)
          if (v !== null) outHeaders[name] = v
        }
        return {
          status: res.status,
          ok: res.ok,
          url,
          headers: outHeaders,
          body: buf.toString('utf8'),
          bodyBytes: buf.byteLength
        }
      }
      throw new OpError('E_FAILED', `重定向超过 ${NET_MAX_REDIRECTS} 次`)
    }
  },

  // ---------- git ----------

  'git.available': {
    perm: 'git',
    timeoutMs: 5000,
    run: async () => isGitAvailable()
  },

  'git.run': {
    perm: 'git',
    timeoutMs: 120_000,
    run: async (ctx, args, run) => {
      const a = asObject(args, 'git.run')
      assertGitArgs(a.args, ctx.isRestricted)
      const list = a.args as string[]
      // env 与 signal 都是"插件与 git 之间"的东西:凭据经环境变量进子进程(别自己拼命令行),
      // signal 让「停用插件 / 关应用」能把正在跑的 git 真的杀掉,而不是留着跑到超时
      const env = normalizeGitEnv(a.env, ctx.isRestricted)
      const cwd = await resolveGitCwd(a.cwd)
      const timeoutMs = a.timeoutMs === undefined ? 60_000 : Math.min(Number(a.timeoutMs) || 60_000, 120_000)
      const result = await runGit(list, { cwd, timeoutMs, env, signal: run.signal })
      return {
        ok: result.ok,
        code: result.code,
        // 输出一律脱敏:token 可能在 URL 里被回显
        stdout: summarize(redactUrl(result.stdout), 40),
        stderr: summarize(redactUrl(result.stderr), 40),
        aborted: result.aborted
      }
    }
  },

  'git.redact': {
    perm: 'git',
    timeoutMs: 1000,
    run: async (_ctx, args) => redactUrl(asString(asObject(args, 'git.redact').text, 'text', 8192))
  },

  'git.summarize': {
    perm: 'git',
    timeoutMs: 1000,
    run: async (_ctx, args) => {
      const a = asObject(args, 'git.summarize')
      const maxLines = a.maxLines === undefined ? 12 : Math.min(Number(a.maxLines) || 12, 100)
      return summarize(asString(a.text, 'text', 64 * 1024), maxLines)
    }
  }
}

/** op 名字 → 定义(不存在的返回 null,由 gate 报 E_UNKNOWN_OP) */
export function getOp(name: unknown): OpDef | null {
  if (typeof name !== 'string') return null
  return Object.prototype.hasOwnProperty.call(OPS, name) ? OPS[name]! : null
}

/** 表里全部 op 名(作者文档与验收用) */
export function opNames(): string[] {
  return Object.keys(OPS)
}

/** op → 需要的权限;`null` 表示不要权限 */
export function opPermissions(): Record<string, PluginPermission | null> {
  const out: Record<string, PluginPermission | null> = {}
  for (const [name, def] of Object.entries(OPS)) out[name] = def.perm
  return out
}

// ---------- 小工具 ----------

function secretKeyOf(pluginId: string, fieldKey: string, targetId?: string): string {
  return targetId ? `${pluginId}:${fieldKey}:${targetId}` : `${pluginId}:${fieldKey}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 2000) ?? String(value)
  } catch {
    return String(value)
  }
}
