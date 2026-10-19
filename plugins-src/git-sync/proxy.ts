/**
 * 本机代理探测 —— 给 git 的网络操作找一条能出去的路。
 *
 * 为什么需要这一层:Windows 的「系统代理」是 WinINET 的设置,浏览器会读,
 * 而 git 用的 libcurl **不读它**。于是会出现一个很迷惑的状态:
 * 浏览器能打开 GitHub,插件的「测试连接」却一律超时。
 * 这里把同一份设置查出来,通过 `-c http.proxy=…` 显式交给 git。
 *
 * 只依赖 Node 内置模块(插件独立打包,除 Node 与注入的 imk 外什么都 require 不到)。
 */

import { execFile } from 'node:child_process'
import { connect } from 'node:net'

/** 一次探测的结果 */
export interface DetectedProxy {
  /** 交给 git 的代理地址,如 http://127.0.0.1:7890 */
  url: string
  /** 人类可读的来源(日志与报错里用),如「Windows 系统代理」 */
  source: string
  /** 不经过代理的地址(NO_PROXY 语义) */
  bypass: string[]
}

export type ProxyMode = 'auto' | 'manual' | 'off'

const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 给 `host:port` 补上协议;系统代理项里通常没有协议前缀 */
function withScheme(hostPort: string, fallback: 'http' | 'socks5'): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostPort)) return hostPort
  return `${fallback}://${hostPort}`
}

/**
 * 手动填写的代理地址:补协议、校验协议白名单、去掉多余的根斜杠。
 * 无法识别时返回 null(调用方据此给出「地址填错了」的提示,而不是静默直连)。
 */
export function normalizeProxyUrl(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(withScheme(text, 'http'))
  } catch {
    return null
  }
  // curl 认的是 socks5,不认 socks://;顺手归一
  if (url.protocol.toLowerCase() === 'socks:') url.protocol = 'socks5:'
  const allowed = ['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']
  if (!allowed.includes(url.protocol.toLowerCase()) || !url.hostname) return null
  const out = url.toString()
  return url.pathname === '/' && !url.search && !url.hash ? out.slice(0, -1) : out
}

/**
 * 解析 `reg query` 的输出。值与类型之间是空白分隔,而 REG_SZ 的值本身可能带空格
 * (ProxyOverride 就是 `;` 分隔的一串),所以只按「名字 + 类型」切第一刀。
 */
export function parseRegQuery(output: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s*(.*)$/i.exec(line)
    if (m?.[1]) values.set(m[1].toLowerCase(), (m[2] ?? '').trim())
  }
  return values
}

/**
 * 把 Windows 的 ProxyServer 值解成给 git 的 URL。
 *
 * 两种写法都要认:
 *   - `127.0.0.1:7890`(所有协议共用一个)
 *   - `http=127.0.0.1:7890;https=127.0.0.1:7891`(按协议分开)
 */
export function parseWindowsProxyServer(
  server: string,
  scheme: 'http' | 'https'
): string | null {
  const raw = String(server ?? '').trim()
  if (!raw) return null
  if (!raw.includes('=')) return normalizeProxyUrl(withScheme(raw, 'http'))

  const entries = new Map<string, string>()
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim()
    if (key && value) entries.set(key, value)
  }
  // 先按当前协议找,再退回 http / https,最后才用 socks(混合端口通常也能走 SOCKS)
  for (const key of [scheme, 'http', 'https', 'socks'] as const) {
    const value = entries.get(key)
    if (value) return normalizeProxyUrl(withScheme(value, key === 'socks' ? 'socks5' : 'http'))
  }
  return null
}

/** NO_PROXY / no_proxy 的写法:逗号或空白分隔 */
export function parseNoProxy(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** Windows 的 ProxyOverride:`;` 分隔,`<local>` 表示本机地址,`*.x` 表示子域 */
export function parseProxyOverride(value: unknown): string[] {
  const out: string[] = []
  for (const raw of String(value ?? '').split(';')) {
    let item = raw.trim()
    if (!item) continue
    if (/^<local>$/i.test(item)) {
      out.push('localhost', '127.0.0.1', '::1')
      continue
    }
    if (item === '*') {
      out.push('*')
      continue
    }
    if (item.startsWith('*.')) item = item.slice(1)
    out.push(item)
  }
  return out
}

/** 回环地址永远不该交给代理:代理客户端通常也连不到「它自己所在机器的回环」之外 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '0:0:0:0:0:0:0:1' ||
    /^127\./.test(h) ||
    h.endsWith('.localhost')
  )
}

function matchesNoProxy(hostname: string, entries: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  for (const raw of entries) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    // 去掉可选的端口(`host:8080`);IPv6 里有多个冒号,那一段不切
    if (!entry.includes('[') && (entry.match(/:/g)?.length ?? 0) === 1) {
      entry = entry.slice(0, entry.indexOf(':'))
    }
    if (!entry) continue
    // Windows 的 ProxyOverride 允许通配(`10.*`、`172.2*`):按 glob 匹配。
    // NO_PROXY 本身没有这层语义,所以判断必须在插件里做完。
    if (entry.includes('*')) {
      const pattern = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      if (new RegExp(`^${pattern}$`, 'i').test(host)) return true
      continue
    }
    entry = entry.replace(/^\./, '')
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

/** 这个地址是不是 HTTP(S);是的话返回协议,否则(SSH / 本地路径)返回 null */
export function httpSchemeOf(rawUrl: string): 'http' | 'https' | null {
  let url: URL
  try {
    url = new URL(String(rawUrl ?? '').trim())
  } catch {
    return null
  }
  if (url.protocol === 'http:') return 'http'
  if (url.protocol === 'https:') return 'https'
  return null
}

/**
 * 这个远端地址实际该走哪个代理;null 表示直连。
 *
 * 三种情况不代理:非 HTTP(S)(SSH 由 ssh 自己连)、回环地址、命中 NO_PROXY。
 */
export function proxyForUrl(rawUrl: string, proxy: DetectedProxy | null): string | null {
  if (!proxy) return null
  if (!httpSchemeOf(rawUrl)) return null
  let url: URL
  try {
    url = new URL(String(rawUrl).trim())
  } catch {
    return null
  }
  if (isLoopbackHost(url.hostname)) return null
  if (matchesNoProxy(url.hostname, proxy.bypass)) return null
  return proxy.url
}

function envProxyKeys(scheme: 'http' | 'https'): string[] {
  // https 额外回退到 HTTP_PROXY:Clash 这类客户端的混合端口同时服务两种协议,
  // 而用户可能只设了 HTTP_PROXY。显式 -c http.proxy 会覆盖 libcurl 自己的选择。
  return scheme === 'https'
    ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
    : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
}

/** 环境变量里的代理(这是 git/libcurl 本来就会读的;读出来是为了报告来源与统一处理) */
export function proxyFromEnvironment(
  scheme: 'http' | 'https',
  env: NodeJS.ProcessEnv = process.env
): DetectedProxy | null {
  for (const key of envProxyKeys(scheme)) {
    const url = normalizeProxyUrl(env[key])
    if (url) {
      return {
        url,
        source: `环境变量 ${key}`,
        bypass: parseNoProxy(env.NO_PROXY ?? env.no_proxy)
      }
    }
  }
  return null
}

function queryRegistry(key: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      'reg.exe',
      ['query', key],
      { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout ?? ''))
    )
  })
}

/** Windows 系统代理(浏览器用的就是它) */
export async function windowsSystemProxy(scheme: 'http' | 'https'): Promise<DetectedProxy | null> {
  if (process.platform !== 'win32') return null
  const output = await queryRegistry(WINDOWS_INTERNET_SETTINGS)
  if (!output) return null
  const values = parseRegQuery(output)
  const enabled = (values.get('proxyenable') ?? '').trim().toLowerCase()
  if (!/^(0x)?1$/.test(enabled)) return null
  const url = parseWindowsProxyServer(values.get('proxyserver') ?? '', scheme)
  if (!url) return null
  // ProxyOverride 与 NO_PROXY 可能同时存在,两边都算数
  const bypass = [
    ...parseProxyOverride(values.get('proxyoverride') ?? ''),
    ...parseNoProxy(process.env.NO_PROXY ?? process.env.no_proxy)
  ]
  // ProxyOverride 写成 * 等于「全部直连」,这时不应再把流量交给代理
  if (bypass.includes('*')) return null
  return { url, source: 'Windows 系统代理', bypass }
}

/** 自动模式:先看显式环境变量,再读 Windows 系统代理 */
export async function detectSystemProxy(scheme: 'http' | 'https'): Promise<DetectedProxy | null> {
  return proxyFromEnvironment(scheme) ?? (await windowsSystemProxy(scheme))
}

/** 代理端口是否真的有人监听 —— 「检测本机代理」用它区分「配置了」和「能连上」 */
export function probeProxy(url: string, timeoutMs = 1500): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return Promise.resolve(false)
  }
  const protocol = parsed.protocol.toLowerCase()
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === 'https:'
      ? 443
      : protocol.startsWith('socks')
        ? 1080
        : 80
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise(resolve => {
    const socket = connect({ host, port })
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
