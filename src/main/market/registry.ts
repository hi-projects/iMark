/**
 * 注册表 API 的类型化封装。
 *
 * 这一层只做三件事:拼 URL、带令牌、把服务端返回的 JSON 断言成共享类型。
 * 所有的错误翻译在 http.ts 里,所有的令牌存取在 config.ts 里 —— 于是这个文件
 * 读起来就是一份接口清单,想找「客户端到底会打服务端哪些接口」看它一份就够。
 *
 * **令牌不出这个模块。** 没有任何导出让调用方拿到明文令牌的途径:
 * 需要它的地方(发布)就在本文件里。
 */

import type {
  MarketAuthStatus,
  MarketDetail,
  MarketEntry,
  MarketQuery,
  MarketSearchResult,
  MarketVersionInfo,
  PublishResult
} from '@shared/market'
import { authStatus, clearSession, getDevToken, getRegistryUrl, invalidateSession, registryKey, setSession } from './config'
import { downloadEnvelope, downloadIcon, getJson, postJson, resolveUrl } from './http'

/** 每个需要地址的接口都先过这里,好让「没配置市场地址」是一句人话而不是一个 URL 错误 */
async function base(): Promise<string> {
  const registry = await getRegistryUrl()
  if (!registry) throw new Error('还没有设置插件市场地址 —— 在「发布插件」页填一个，或先用仓库里的 server/ 起一个本机市场')
  return registry
}

// ---------- 浏览 ----------

export async function search(query: MarketQuery): Promise<MarketSearchResult> {
  const registry = await base()
  const params = new URLSearchParams({
    q: query.q,
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort
  })
  if (query.hasMain !== null) params.set('hasMain', String(query.hasMain))
  return getJson<MarketSearchResult>(
    resolveUrl(registry, `/api/v1/search?${params.toString()}`)
  )
}

export async function detail(id: string): Promise<MarketDetail> {
  const registry = await base()
  return getJson<MarketDetail>(
    resolveUrl(registry, `/api/v1/packages/${encodeURIComponent(id)}`)
  )
}

/** 只要最新版那一条(更新检查用,不必把 readme 和版本列表也拖回来) */
export async function latest(id: string): Promise<MarketEntry> {
  const registry = await base()
  return getJson<MarketEntry>(
    resolveUrl(registry, `/api/v1/packages/${encodeURIComponent(id)}/latest`)
  )
}

export async function byAuthor(username: string): Promise<MarketSearchResult> {
  const registry = await base()
  return getJson<MarketSearchResult>(
    resolveUrl(registry, `/api/v1/users/${encodeURIComponent(username)}/packages`)
  )
}

export async function iconDataUrl(id: string): Promise<string | null> {
  const registry = await getRegistryUrl()
  if (!registry) return null
  return downloadIcon(resolveUrl(registry, `/api/v1/packages/${encodeURIComponent(id)}/icon`))
}

// ---------- 下载 ----------

export interface FetchedEnvelope {
  envelope: unknown
  /** 响应头里服务端声称的 integrity;拿到它才能核对下载到的字节 */
  integrity: string | null
  version: string | null
}

/**
 * 取某一个版本的包体。
 *
 * 这里**不校验** —— 校验统一发生在 verifyEnvelope,调用方(installer)拿到字节后
 * 会连同 `integrity` 一起交给它。注册表这一层只负责把字节和它自称的哈希带回来。
 */
export async function fetchEnvelope(
  id: string,
  version: string,
  onBytes?: (received: number, total: number | null) => void
): Promise<FetchedEnvelope> {
  const registry = await base()
  const url = resolveUrl(
    registry,
    `/api/v1/packages/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/download`
  )
  const result = await downloadEnvelope(url, { token: await getDevToken(), onBytes })
  return { envelope: result.body, integrity: result.integrity, version: result.version }
}

export async function versionInfo(id: string, version: string): Promise<MarketVersionInfo & { manifest: unknown }> {
  const registry = await base()
  return getJson<MarketVersionInfo & { manifest: unknown }>(
    resolveUrl(registry, `/api/v1/packages/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`)
  )
}

// ---------- 账号 ----------

interface LoginResponse {
  user: { username: string; isAdmin?: boolean }
  token: string
}

async function adoptSession(data: LoginResponse): Promise<MarketAuthStatus> {
  await setSession(data.token, data.user.username)
  return authStatus()
}

export async function login(username: string, password: string): Promise<MarketAuthStatus> {
  const registry = await base()
  const data = await postJson<LoginResponse>(resolveUrl(registry, '/api/v1/auth/login'), { username, password })
  return adoptSession(data)
}

/**
 * 注册一个新账号并直接登录。
 *
 * 之所以把它做进界面:自托管的第一个用户必须有人来创建,而让用户为此去开一个终端
 * 敲 curl 是没道理的 —— 服务端的注册接口本来就在那儿。(公开注册表上会先在服务端
 * 关掉注册,那时的 400/403 会原样显示出来。)
 */
export async function register(username: string, password: string): Promise<MarketAuthStatus> {
  const registry = await base()
  const data = await postJson<LoginResponse>(resolveUrl(registry, '/api/v1/auth/register'), { username, password })
  return adoptSession(data)
}

export async function logout(): Promise<MarketAuthStatus> {
  await clearSession()
  return authStatus()
}

/**
 * 拿本地令牌去问服务端「我还在吗」。
 *
 * 与 `authStatus()` 的分工:那个只读本地状态(离线也对),这个要联网,
 * 但它能发现「令牌已经在服务端被吊销了」—— 401 时顺手把本地凭证清掉,
 * 免得用户对着一个永远不会成功的登录状态反复点发布。
 */
export async function refreshSession(): Promise<MarketAuthStatus> {
  const registry = await getRegistryUrl()
  const token = await getDevToken()
  if (!registry || !token) return authStatus()
  try {
    const me = await getJson<{ username: string }>(resolveUrl(registry, '/api/v1/auth/me'), { token })
    await setSession(token, me.username)
  } catch (err) {
    if ((err as { kind?: string }).kind === 'unauthorized') await invalidateSession()
    else throw err
  }
  return authStatus()
}

// ---------- 发布 ----------

/**
 * 上传一个已打包的信封。
 *
 * 超时给到 60 秒(http.ts 的 PUBLISH_TIMEOUT):8 MiB 的正文在慢上行链路上
 * 本来就可能要传上一分钟,用 5 秒的默认值会让发布在一个正常的网络里也失败。
 */
export async function publish(envelope: unknown): Promise<PublishResult> {
  const registry = await base()
  const token = await getDevToken()
  if (!token) throw new Error('请先登录后再发布')
  try {
    return await postJson<PublishResult>(resolveUrl(registry, '/api/v1/packages'), envelope, {
      token,
      timeoutMs: 60_000
    })
  } catch (err) {
    if ((err as { kind?: string }).kind === 'unauthorized') await invalidateSession()
    throw err
  }
}

export async function setYanked(id: string, version: string, yanked: boolean): Promise<void> {
  const registry = await base()
  const token = await getDevToken()
  if (!token) throw new Error('请先登录后再操作')
  const action = yanked ? 'yank' : 'unyank'
  await postJson(
    resolveUrl(
      registry,
      `/api/v1/packages/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/${action}`
    ),
    {},
    { token }
  )
}

// ---------- 健康检查 ----------

export interface HealthInfo {
  ok: boolean
  version: string
  time: number
}

/**
 * 「测试连接」按钮用:能不能连上、连上的是不是我们认识的这个服务。
 *
 * 可以传入一个**尚未保存**的地址 —— 用户应该能在把地址写进设置之前先试一下,
 * 否则「填错了 → 保存了 → 打开市场报错 → 再回去改」是个没必要的来回。
 */
export async function health(url?: string): Promise<HealthInfo> {
  let registry: string
  if (url !== undefined) {
    const key = registryKey(url)
    if (!key) throw new Error('市场地址必须是 http:// 或 https:// 开头的完整地址')
    registry = key
  } else {
    registry = await base()
  }
  const info = await getJson<HealthInfo>(resolveUrl(registry, '/api/v1/health'), { timeoutMs: 4000 })
  if (!info?.ok) throw new Error('这个地址上的服务没有响应健康检查,它可能不是 iMark 插件市场')
  return info
}
