/**
 * AI 服务的 HTTP 客户端。
 *
 * 只做四件事：读配置与密钥、把地址归一成可请求的接口、发一次非流式请求、
 * 把响应/错误翻成能直接展示给用户的中文。文档正文不在这里处理。
 *
 * 刻意用 Node 的全局 fetch（node main 有完整 Node）。restricted 层的 net.fetch
 * 有 30 秒硬超时且默认禁止本机地址，这两条都会卡住整篇美化与本地 Ollama。
 */

import type { ImkApi } from '@shared/pluginApi'

export type Provider = 'openai' | 'anthropic' | 'azure'

export interface AiConfig {
  endpoint: string
  model: string
  apiKey: string
  /** 已夹取到 5–90 秒 */
  timeoutMs: number
}

/** 带「给用户看的一句话 + 给日志看的明细」的错误；code 用于两层之间传分类 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'AiError'
  }
}

export interface ResolvedEndpoint {
  url: URL
  provider: Provider
  /** 不含查询串的展示地址（日志与状态用） */
  display: string
}

export interface AiResult {
  text: string
  provider: Provider
  model: string
  endpointDisplay: string
  elapsedMs: number
  truncated: boolean
  finishReason: string | null
}

/** 对话历史里的一条；只允许用户与助手两种角色 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 单次响应最多读 4 MiB：正常聊天响应远小于这个数，超出基本可以当成异常 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TIMEOUT_MS = 90_000
const MIN_TIMEOUT_MS = 5_000

export async function readAiConfig(imk: ImkApi, timeoutCap?: number): Promise<AiConfig> {
  const raw = imk.getConfig<Record<string, unknown>>()
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : ''
  if (!endpoint) throw new AiError('请先在插件设置里填写 AI 服务地址')

  const model = typeof raw.model === 'string' ? raw.model.trim() : ''

  const rawTimeout = Number(raw.timeoutMs)
  let timeoutMs = Number.isFinite(rawTimeout) ? Math.round(rawTimeout) : 60_000
  timeoutMs = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
  if (timeoutCap !== undefined) timeoutMs = Math.min(timeoutMs, timeoutCap)

  if (!imk.secrets) {
    throw new AiError('插件没有读取密钥的权限，无法读取 API 密钥', '请在插件设置里重新启用它，或重新安装。')
  }
  let apiKey = ''
  try {
    apiKey = (await imk.secrets.get('apiKey')) ?? ''
  } catch (err) {
    throw new AiError('读取 API 密钥失败', errorText(err))
  }

  return { endpoint, model, apiKey, timeoutMs }
}

const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * 把用户填的地址归一成最终请求地址。
 *
 * 只做**可预期**的补全：没有协议时本地地址补 http、其它补 https；空路径补常见的
 * 接口尾段；已经带 `/completions` 或 `/messages` 的地址原样使用。自定义网关路径
 * 不会被猜着改 —— 猜错的表现是 404，比“看起来改了但其实没改”更难查。
 */
export function resolveEndpoint(raw: string): ResolvedEndpoint {
  let text = raw.trim()
  if (!text) throw new AiError('请先在插件设置里填写 AI 服务地址')

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const local = LOCAL_HOST_RE.test(text) || PRIVATE_HOST_RE.test(text)
    text = `${local ? 'http' : 'https'}://${text}`
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new AiError('AI 服务地址不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiError('AI 服务地址只支持 http / https')
  }
  if (url.username || url.password) {
    throw new AiError('AI 服务地址不能包含用户名或密码', '请把凭据填在「API 密钥」里。')
  }
  url.hash = ''

  const host = url.hostname.toLowerCase()
  const provider = detectProvider(host, url.pathname)
  let path = url.pathname.replace(/\/+$/, '')

  if (provider === 'azure') {
    if (!/\/deployments\//i.test(path)) {
      throw new AiError(
        'Azure 地址不完整',
        '应形如 https://<资源名>.openai.azure.com/openai/deployments/<部署名>/chat/completions?api-version=...'
      )
    }
    if (!url.searchParams.get('api-version')) {
      throw new AiError(
        'Azure 地址缺少 api-version',
        '请在地址后面加上 ?api-version=2024-06-01（以你的资源支持的版本为准）。'
      )
    }
  } else if (provider === 'anthropic') {
    // 兼容把 Anthropic 兼容基地址直接粘进来的写法：
    //   https://api.deepseek.com/anthropic  →  /anthropic/v1/messages
    if (path === '') path = '/v1/messages'
    else if (/\/anthropic$/i.test(path)) path += '/v1/messages'
    else if (!/\/messages$/i.test(path)) path += '/messages'
  } else {
    if (path === '') path = '/v1/chat/completions'
    else if (!/\/completions$/i.test(path)) path += '/chat/completions'
  }

  url.pathname = path
  return { url, provider, display: `${url.origin}${url.pathname}` }
}

function detectProvider(host: string, pathname: string): Provider {
  if (
    host === 'api.anthropic.com' ||
    /\/messages\/?$/i.test(pathname) ||
    /\/anthropic(\/|$)/i.test(pathname)
  ) {
    return 'anthropic'
  }
  // Azure 的两种常见资源域名；自定义域名的网关只能按 OpenAI 兼容处理
  if (host.endsWith('.openai.azure.com') || host.endsWith('.cognitiveservices.azure.com')) {
    return 'azure'
  }
  return 'openai'
}

/**
 * 发一次聊天请求。正文与提示词由调用方给，这里只负责传输与解析。
 *
 * `signal` 用于「插件被停用 / 配置被改」时取消在途请求；超时另外用一个内部
 * controller 控制，两者都会 abort 同一份 fetch。
 */
export async function callAi(
  cfg: AiConfig,
  system: string,
  user: string,
  signal?: AbortSignal
): Promise<AiResult> {
  return requestChat(cfg, system, [{ role: 'user', content: user }], signal)
}

/** 多轮对话版：system 是文档上下文与角色说明，messages 是历史 + 这次的问题 */
export async function requestChat(
  cfg: AiConfig,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<AiResult> {
  const resolved = resolveEndpoint(cfg.endpoint)
  if (resolved.provider !== 'azure' && !cfg.model) {
    throw new AiError('请先在插件设置里填写模型名')
  }

  const started = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, cfg.timeoutMs)
  const onAbort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const res = await fetch(resolved.url.toString(), {
      method: 'POST',
      headers: buildHeaders(resolved.provider, cfg.apiKey),
      body: JSON.stringify(buildBody(resolved.provider, cfg.model, system, messages)),
      // 不自动跟随：自定义认证头不能被带到另一个 host 上
      redirect: 'manual',
      signal: controller.signal
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '(未提供)'
      await discardBody(res)
      throw new AiError(
        `AI 服务返回重定向（HTTP ${res.status}）`,
        `请直接填写最终地址：${location}`
      )
    }

    const body = await readTextCapped(res, MAX_RESPONSE_BYTES)
    if (!res.ok) throw httpError(res.status, summarizeError(body))

    const parsed = parseResponse(resolved.provider, body)
    return {
      ...parsed,
      provider: resolved.provider,
      model: cfg.model || 'Azure 部署',
      endpointDisplay: resolved.display,
      elapsedMs: Date.now() - started
    }
  } catch (err) {
    if (err instanceof AiError) throw err
    if (timedOut) {
      throw new AiError(
        `AI 服务在 ${Math.round(cfg.timeoutMs / 1000)} 秒内没有响应`,
        '可以在插件设置里调大「请求超时」，或换一个更快的模型。'
      )
    }
    if (signal?.aborted) throw new AiError('请求已取消')
    throw new AiError('连接 AI 服务失败', describeFetchError(err))
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function buildHeaders(provider: Provider, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json'
  }
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  const key = apiKey.trim()
  if (!key) return headers
  if (provider === 'anthropic') headers['x-api-key'] = key
  else if (provider === 'azure') headers['api-key'] = key
  else headers.authorization = `Bearer ${key}`
  return headers
}

function buildBody(
  provider: Provider,
  model: string,
  system: string,
  messages: ChatMessage[]
): Record<string, unknown> {
  const turns = messages
    .filter(message => message.content.length > 0)
    .map(message => ({ role: message.role, content: message.content }))
  if (provider === 'anthropic') {
    return {
      model,
      system,
      messages: turns,
      // Anthropic 必填；8192 足够整篇笔记，真被截断时调用方会拒绝写回
      max_tokens: 8192
    }
  }
  const all = [{ role: 'system', content: system }, ...turns]
  // Azure 的模型由路径里的部署名决定，body 里不再重复
  if (provider === 'azure') return { messages: all, stream: false }
  return { model, messages: all, stream: false }
}

interface ParsedResponse {
  text: string
  truncated: boolean
  finishReason: string | null
}

function parseResponse(provider: Provider, body: string): ParsedResponse {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new AiError('AI 服务返回的不是 JSON', clip(body))
  }
  const root = (json ?? {}) as Record<string, unknown>

  if (provider === 'anthropic') {
    const stop = typeof root.stop_reason === 'string' ? root.stop_reason : null
    if (stop === 'refusal') throw new AiError('模型拒绝了这次请求')
    const blocks = Array.isArray(root.content) ? root.content : []
    const parts: string[] = []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const item = block as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    }
    const text = parts.join('')
    if (!text.trim()) throw new AiError('AI 没有返回文本内容', summarizeError(body))
    return { text, truncated: stop === 'max_tokens', finishReason: stop }
  }

  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = (choices[0] ?? null) as Record<string, unknown> | null
  const message = (choice?.message ?? null) as Record<string, unknown> | null
  const refusal = typeof message?.refusal === 'string' ? message.refusal : ''
  if (refusal) throw new AiError('模型拒绝了这次请求', refusal)

  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  if (finish === 'content_filter') throw new AiError('内容被 AI 服务的安全策略拦截')

  const text = contentToString(message?.content ?? choice?.text)
  if (!text.trim()) throw new AiError('AI 没有返回文本内容', summarizeError(body))
  // length = 输出达到上限。调用方必须把它当成失败：半篇文档不能写回磁盘
  return { text, truncated: finish === 'length', finishReason: finish }
}

function contentToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part)
    } else if (part && typeof part === 'object') {
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

async function readTextCapped(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (text.length > limit) throw new AiError('AI 服务返回内容过大')
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new AiError('AI 服务返回内容过大')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    /* 连接已经断了也无所谓：这只是一次失败请求的收尾 */
  }
}

function httpError(status: number, summary: string): AiError {
  const suffix = summary ? `：${summary}` : ''
  if (status === 401 || status === 403) {
    return new AiError('认证失败，请检查 API 密钥', `HTTP ${status}${suffix}`)
  }
  if (status === 404) {
    return new AiError('接口地址不对（404），请确认服务地址与模型名', `HTTP 404${suffix}`)
  }
  if (status === 429) {
    return new AiError('请求过于频繁或额度不足（429）', `HTTP 429${suffix}`)
  }
  if (status >= 500) {
    return new AiError(`AI 服务暂时不可用（HTTP ${status}）`, suffix)
  }
  return new AiError(`AI 服务返回 HTTP ${status}`, suffix)
}

function summarizeError(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const error = json.error
    if (typeof error === 'string') return clip(error)
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string') return clip(message)
    }
    if (typeof json.message === 'string') return clip(json.message)
  } catch {
    /* 不是 JSON：按普通文本截断 */
  }
  return clip(text)
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean
}

function describeFetchError(err: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const message = (cur as { message?: unknown }).message
    if (typeof message === 'string' && message && !parts.includes(message)) parts.push(message)
    // fetch 失败的 cause 有时是 AggregateError（多个地址/协议各报一条）
    const nested = (cur as { errors?: unknown }).errors
    if (Array.isArray(nested)) {
      for (const inner of nested) {
        const text = (inner as { message?: unknown } | null)?.message
        if (typeof text === 'string' && text && !parts.includes(text)) parts.push(text)
      }
    }
    cur = (cur as { cause?: unknown }).cause
  }
  const text = parts.join(' → ') || String(err)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return `域名解析失败：${clip(text)}`
  if (/ECONNREFUSED/i.test(text)) return `连接被拒绝，请确认服务已启动、端口正确：${clip(text)}`
  if (/CERT|self.signed|self-signed|unable to verify/i.test(text)) return `证书校验失败：${clip(text)}`
  if (/ECONNRESET|socket hang up/i.test(text)) return `连接被重置：${clip(text)}`
  return clip(text)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
