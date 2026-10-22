/**
 * 市场 HTTP 客户端 —— 全部请求都在主进程里发。
 *
 * 渲染层的 CSP 是 `connect-src 'self' ws:`,它根本发不出外部请求;
 * 这不是需要绕开的限制,而是一道**好事**:插件市场要下载的是一段将要执行的代码,
 * 让渲染层(那儿还跑着插件的 CSS 和笔记内容)碰网络没有任何必要。
 *
 * 用 Electron 的 `net.fetch` 而不是全局 fetch:它走 Chromium 的网络栈,
 * 因此会遵守系统代理设置、证书存储与 HTTP 缓存 —— 用 node:http 就得自己重造这些。
 */

import { net } from 'electron'
import { EXTENSION_LIMITS } from '@shared/extensionPackage'

export type MarketFailure =
  /** 连不上(服务未启动、地址写错、断网) */
  | 'offline'
  /** 请求超时 */
  | 'timeout'
  /** 401/403 */
  | 'unauthorized'
  | 'not-found'
  /** 4xx/5xx 的其他情况 */
  | 'server'
  /** 返回的不是我们认识的 JSON */
  | 'bad-response'

export class MarketError extends Error {
  readonly kind: MarketFailure
  readonly status: number | null

  constructor(kind: MarketFailure, message: string, status: number | null = null) {
    super(message)
    this.name = 'MarketError'
    this.kind = kind
    this.status = status
  }
}

/** JSON 请求的默认超时;发布另给一个长超时(8 MiB 要慢慢传) */
const JSON_TIMEOUT = 5000
export const PUBLISH_TIMEOUT = 60_000

/**
 * 是否真的在线。`net.isOnline()` 只反映「有没有网络接口」,
 * 它说不在线时直接短路可以避免一次没必要的 5 秒等待。
 */
function offline(): boolean {
  try {
    return !net.isOnline()
  } catch {
    // app 还没 ready 时会抛;那就别拦,让它去请求然后超时
    return false
  }
}

/**
 * 把一次网络失败翻译成人话。
 *
 * 这里的难点是 **`net.fetch` 抛出来的是一个普通的 `Error`**,`message` 就是
 * 光秃秃的 `net::ERR_CONNECTION_REFUSED`(实测:没有 `cause`,没有 `code`,
 * `name` 也只是 `Error`)。所以只能按 message 里的 Chromium 错误码来分。
 * 直接用 Node 的 `ECONNREFUSED` 那套判断在这里**一条都命中不了**,
 * 用户会看到一句夹着英文错误码的话 —— 那等于没翻译。
 */
function describeNetworkError(url: string, err: unknown): MarketError {
  const host = safeHost(url)
  const name = (err as Error)?.name
  const raw = (err as Error)?.message ?? String(err)
  // Node 栈会把它塞在 code / cause.code 里;Chromium 栈直接写在 message 里
  const nodeCode = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code
  const code = nodeCode ?? /net::(ERR_[A-Z0-9_]+)/.exec(raw)?.[1] ?? null

  switch (code) {
    case 'ECONNREFUSED':
    case 'ERR_CONNECTION_REFUSED':
      return new MarketError('offline', `无法连接插件市场： ${host}`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ERR_NAME_NOT_RESOLVED':
    case 'ERR_NAME_RESOLUTION_FAILED':
      return new MarketError('offline', `找不到主机 ${host}:请检查地址是否写对`)
    case 'ERR_INTERNET_DISCONNECTED':
    case 'ERR_NETWORK_CHANGED':
      return new MarketError('offline', '当前处于离线状态,无法访问插件市场')
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
    case 'ETIMEDOUT':
      return new MarketError('timeout', `连接 ${host} 超时`)
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_CONNECTION_ABORTED':
    case 'ERR_EMPTY_RESPONSE':
      return new MarketError('offline', `与 ${host} 的连接被中断了`)
    case 'ERR_UNSAFE_PORT':
      return new MarketError('offline', `${host} 用的是浏览器内核禁止访问的端口,换一个端口试试`)
    default:
      break
  }

  if (code?.startsWith('ERR_CERT') || code?.startsWith('ERR_SSL')) {
    return new MarketError('offline', `${host} 的 HTTPS 证书有问题,已拒绝连接`)
  }
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_CERT_AUTHORITY_INVALID'
  ) {
    return new MarketError('offline', `${host} 的 HTTPS 证书有问题,已拒绝连接`)
  }
  // AbortSignal.timeout 触发:两种运行时给的形状不同,都得认
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ERR_ABORTED' || code === 'ABORT_ERR') {
    return new MarketError('timeout', `连接 ${host} 超时`)
  }
  if (code) return new MarketError('offline', `连接 ${host} 失败(${code})`)
  return new MarketError('offline', `连接 ${host} 失败:${raw}`)
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 把相对路径接到注册表地址上;已经是绝对地址时原样返回 */
export function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmed}${path.startsWith('/') ? '' : '/'}${path}`
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  token?: string | null
  timeoutMs?: number
  /** 响应的最大字节数;发布/下载用得到 */
  maxBytes?: number
}

async function send(url: string, opts: RequestOptions): Promise<Response> {
  if (offline()) throw new MarketError('offline', '当前处于离线状态,无法访问插件市场')

  const timeout = opts.timeoutMs ?? JSON_TIMEOUT
  let res: Response
  try {
    res = await net.fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeout)
    })
  } catch (err) {
    throw describeNetworkError(url, err)
  }
  if (!res.ok) throw await httpError(res, url)
  return res
}

/** 把状态码翻成人话。服务端返回的 `error.message` 是中文,优先用它 */
async function httpError(res: Response, url: string): Promise<MarketError> {
  let serverMessage: string | null = null
  let code: string | null = null
  try {
    const data = (await res.json()) as { error?: { message?: string; code?: string } }
    serverMessage = data?.error?.message ?? null
    code = data?.error?.code ?? null
  } catch {
    /* 不是 JSON 就算了 */
  }
  const host = safeHost(url)
  if (res.status === 401 || res.status === 403) {
    return new MarketError(
      'unauthorized',
      serverMessage ?? (res.status === 401 ? '需要登录后才能进行这个操作' : `没有权限(${code ?? 403})`),
      res.status
    )
  }
  if (res.status === 404) {
    return new MarketError('not-found', serverMessage ?? '服务端没有这个资源', 404)
  }
  // Chromium 的域名解析失败**不会抛异常**,而是合成一个空 body、没有 content-type
  // 的 502 响应(实测:同一次运行里 ERR_CONNECTION_REFUSED 是抛出来的,而
  // no-such-host.invalid 是一份 502)。少了这一段,`describeNetworkError` 里那条
  // 「找不到主机」的分支就永远走不到 —— 用户把市场地址里的域名敲错一个字母,
  // 得到的会是「xxx 返回了 502」,一句把「你自己写错了」说成「对面服务器坏了」的话。
  //
  // 判据是「不是 JSON」。我们自己的服务端连错误都回 JSON(error.message),
  // 所以真的 5xx 不会被这里吞掉;能被吞掉的只有「对面根本不是我们的服务端」。
  if (res.status === 502 && serverMessage === null) {
    return new MarketError(
      'offline',
      `连不上 ${host}:域名解析不了(检查一下地址是不是写错了),或者链路上有代理/网关拦着`
    )
  }
  return new MarketError('server', serverMessage ?? `${host} 返回了 ${res.status}`, res.status)
}

export async function getJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(url, opts)
  return parseJson<T>(res)
}

export async function postJson<T>(url: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await send(url, { ...opts, method: 'POST', body })
  return parseJson<T>(res)
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (text.length > EXTENSION_LIMITS.envelopeBytes * 2) {
    // 一个接口不该回这么大的正文;真回了说明对面不是我们的服务端
    throw new MarketError('bad-response', '服务端返回的内容异常地大')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new MarketError('bad-response', '服务端返回的不是合法 JSON —— 地址可能指向了别的服务')
  }
}

export interface DownloadResult {
  body: unknown
  /** 响应头里声明的 integrity(可能为空) */
  integrity: string | null
  /** 响应头里声明的版本号(可能为空) */
  version: string | null
}

/**
 * 下载一份插件信封。
 *
 * **先看 content-length 再读**:上限之外的东西不该被读进内存,
 * 一个几 GB 的响应能把主进程直接拖垮。没有 content-length 时靠读完之后的再验。
 */
export async function downloadEnvelope(
  url: string,
  { token, onBytes }: { token?: string | null; onBytes?: (received: number, total: number | null) => void } = {}
): Promise<DownloadResult> {
  if (offline()) throw new MarketError('offline', '当前处于离线状态,无法访问插件市场')

  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT)
    })
  } catch (err) {
    throw describeNetworkError(url, err)
  }
  if (!res.ok) throw await httpError(res, url)

  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > EXTENSION_LIMITS.envelopeBytes) {
    throw new MarketError(
      'bad-response',
      `插件包过大(${(declared / 1024 / 1024).toFixed(1)} MiB,上限 ${EXTENSION_LIMITS.envelopeBytes / 1024 / 1024} MiB)`
    )
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > EXTENSION_LIMITS.envelopeBytes) {
    throw new MarketError(
      'bad-response',
      `插件包过大(${(buf.byteLength / 1024 / 1024).toFixed(1)} MiB,上限 ${EXTENSION_LIMITS.envelopeBytes / 1024 / 1024} MiB)`
    )
  }
  onBytes?.(buf.byteLength, declared || null)

  let body: unknown
  try {
    body = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new MarketError('bad-response', '下载到的不是合法的插件包(JSON 解析失败)')
  }
  return {
    body,
    integrity: res.headers.get('x-imk-integrity'),
    version: res.headers.get('x-imk-version')
  }
}

/**
 * 下载图标,转成 `data:` URL 交给渲染层。
 *
 * 为什么要绕这一圈:CSP 的 `img-src` 是 `'self' imark: data: https:` ——
 * 一个 `http://127.0.0.1:8787/...` 的图标 URL 会被浏览器直接拦掉。
 * 与其放宽 CSP(那等于给渲染层开一个外部图片通道),不如让图标跟着正文一起
 * 从主进程过一遍:顺便还能限制大小、校验格式。
 */
export async function downloadIcon(url: string): Promise<string | null> {
  if (offline()) return null
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(JSON_TIMEOUT) })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'image/png' && type !== 'image/svg+xml') return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > EXTENSION_LIMITS.iconBytes) return null
    // 魔数校验:content-type 是服务端说的,魔数是字节自己说的
    if (type === 'image/png' && !(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
      return null
    }
    if (type === 'image/svg+xml' && !/<svg[\s>]/i.test(buf.subarray(0, 512).toString('utf8'))) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
