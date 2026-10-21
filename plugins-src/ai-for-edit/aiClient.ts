/**
 * AI 服务的 HTTP 客户端。
 *
 * 只做四件事：读配置与密钥、把地址归一成可请求的接口、发一次非流式请求、
 * 把响应/错误翻成能直接展示给用户的中文。文档正文不在这里处理。
 *
 * 刻意用 Node 的全局 fetch（node main 有完整 Node）。restricted 层的 net.fetch
 * 有 30 秒硬超时且默认禁止本机地址，这两条都会卡住整篇美化与本地 Ollama。
 */

export type Provider = 'openai' | 'anthropic' | 'azure'

/**
 * 读配置与密钥的最小接口。
 *
 * 扩展侧用 `workspace.getConfiguration('imark.ai-for-edit')` 与 `context.secrets`
 * 实现它；这样 aiClient 不依赖宿主 API 的具体形状，也方便在测试里替换。
 */
export interface AiConfigSource {
  /** 读一个短键（endpoints / timeoutSec / generatePrompt / beautifyPrompt） */
  get(key: string): unknown
  /** 读某个地址的 API 密钥；槽位是 `endpoints:<endpointId>` */
  getSecret(key: string): Promise<string | undefined>
}

/**
 * 设置页里的一行服务地址。
 *
 * id 既用于把「测试连接」结果对回那一行，也用于读取这一行自己的密钥
 * （secrets 的槽位是 `endpoints:<id>`）。
 */
export interface AiEndpoint {
  id: string
  url: string
  /** 该地址使用的模型；Azure 可以留空（部署名在路径里） */
  model: string
  /** 只在这一行使用；读取失败/未配置时为空串 */
  apiKey: string
}

export interface AiConfig {
  /** 按设置页里的顺序逐个尝试；空地址已被过滤 */
  endpoints: AiEndpoint[]
  /** 单个地址的请求超时（毫秒），已夹取到 5–90 秒 */
  timeoutMs: number
  /** 设置页里的「生成提示词」；已被 trim，空串由调用方拒绝 */
  generatePrompt: string
  /** 设置页里的「美化提示词」；已被 trim，空串由调用方拒绝 */
  beautifyPrompt: string
}

/** 状态卡上的一句话模型说明：一个模型就写名字，多个就写「首个 等」 */
export function modelSummary(endpoints: AiEndpoint[]): string {
  const models = [...new Set(endpoints.map(endpoint => endpoint.model.trim()).filter(Boolean))]
  if (models.length === 0) return '默认模型'
  return models.length === 1 ? models[0]! : `${models[0]} 等`
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
  /** 成功的是第几个地址（0 起）；日志与「测试连接」用它说清楚回退到了哪一个 */
  endpointIndex: number
  elapsedMs: number
  truncated: boolean
  finishReason: string | null
  /** 服务端返回的上下文缓存用量；服务不支持或本次未命中/未写入时没有这个字段 */
  cache?: CacheStats
}

/** 服务端上下文缓存：命中读取的 token 与写入缓存的 token（仅 Anthropic 有写入值） */
export interface CacheStats {
  read: number
  write: number
}

/** 单次请求的可选行为；目前只有「是否给稳定上下文加缓存标记」 */
export interface ChatRequestOptions {
  /**
   * Anthropic：给 system（文档 + 参考文件）打 `cache_control`。
   * OpenAI 兼容服务（含 DeepSeek）无需这个标记 —— 它们按请求前缀自动缓存；
   * 打开它也不会发送额外字段，靠的是 system 始终排在最前面的稳定结构。
   */
  cacheSystem?: boolean
}

/** 随一条消息发送的图片；目前只用于扫描件 PDF 的页面 */
export interface ChatImage {
  mediaType: 'image/jpeg' | 'image/png'
  /** 不带 `data:` 前缀的 base64 */
  data: string
  /** 图片前的一句文字说明，帮助模型把图片和参考文件对应起来 */
  caption?: string
}

/** 对话历史里的一条；只允许用户与助手两种角色 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** 图片只随当前用户消息发送；历史里不保存图片 */
  images?: ChatImage[]
}

/** 单次响应最多读 4 MiB：正常聊天响应远小于这个数，超出基本可以当成异常 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TIMEOUT_MS = 90_000
const MIN_TIMEOUT_MS = 5_000

export async function readAiConfig(
  source: AiConfigSource,
  timeoutCap?: number
): Promise<AiConfig> {
  const rows = readEndpoints(source.get('endpoints'))
  if (rows.length === 0) throw new AiError('请先在插件设置里填写 AI 服务地址')

  const rawTimeout = Number(source.get('timeoutSec'))
  let timeoutSec = Number.isFinite(rawTimeout) ? Math.round(rawTimeout) : 60
  timeoutSec = Math.min(Math.max(timeoutSec, MIN_TIMEOUT_MS / 1000), MAX_TIMEOUT_MS / 1000)
  let timeoutMs = timeoutSec * 1000
  if (timeoutCap !== undefined) timeoutMs = Math.min(timeoutMs, timeoutCap)

  // 提示词由设置页原样提供；是否为空、是否过长由 main.ts 在调用前判断，
  // 这样测试连接/对话不会因为提示词问题被牵连。
  const generatePrompt = textValue(source.get('generatePrompt')).trim()
  const beautifyPrompt = textValue(source.get('beautifyPrompt')).trim()

  // 密钥是**每个地址一份**的：槽位就是地址卡片的 id。读取失败必须整体报错，
  // 不能悄悄不带密钥去请求 —— 那样用户看到的是 401，而不是「密钥读不出来」。
  const endpoints: AiEndpoint[] = []
  for (const row of rows) {
    let apiKey = ''
    try {
      apiKey = (await source.getSecret(`endpoints:${row.id}`)) ?? ''
    } catch (err) {
      throw new AiError('读取 API 密钥失败', errorText(err))
    }
    endpoints.push({ ...row, apiKey })
  }

  return { endpoints, timeoutMs, generatePrompt, beautifyPrompt }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 从设置页的地址列表里读出「有地址」的行，顺序保持不变 */
function readEndpoints(value: unknown): Omit<AiEndpoint, 'apiKey'>[] {
  if (!Array.isArray(value)) return []
  const out: Omit<AiEndpoint, 'apiKey'>[] = []
  for (const [i, item] of value.entries()) {
    if (!item || typeof item !== 'object') continue
    const row = item as Partial<AiEndpoint>
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    if (!url) continue
    out.push({
      id: typeof row.id === 'string' && row.id ? row.id : `e${i}`,
      url,
      model: typeof row.model === 'string' ? row.model.trim() : ''
    })
  }
  return out
}

const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * 把用户填的地址归一成最终请求地址。
 *
 * 只补协议：没有协议时本地地址补 http、其它补 https。**不再补接口路径** ——
 * 地址按用户填的路径原样请求，少写 `/v1/chat/completions` 时由服务端返回 404，
 * 而不是被插件猜着改写。自定义网关的路径因此也不会被改坏。
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
  }

  // 去掉末尾斜杠即可；接口路径（/v1/chat/completions、/v1/messages 等）必须由用户填全
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

/**
 * 多轮对话版：system 是文档上下文与角色说明，messages 是历史 + 这次的问题。
 *
 * 地址按设置页里的顺序逐个尝试：前一个连接失败、超时或返回 HTTP 错误时换下一个。
 * 全部失败时只保留一条错误，正文说明「所有地址都不可用」，明细逐个列出原因。
 */
export async function requestChat(
  cfg: AiConfig,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options: ChatRequestOptions = {}
): Promise<AiResult> {
  if (cfg.endpoints.length === 0) throw new AiError('请先在插件设置里填写 AI 服务地址')

  const failures: { index: number; label: string; error: AiError }[] = []
  for (const [index, endpoint] of cfg.endpoints.entries()) {
    if (signal?.aborted) throw new AiError('请求已取消')
    try {
      return await requestChatAt(cfg, endpoint, index, system, messages, signal, options)
    } catch (err) {
      // 用户取消不是「这个地址不可用」，不该继续试下一个
      if (signal?.aborted) throw new AiError('请求已取消')
      const error =
        err instanceof AiError ? err : new AiError('连接 AI 服务失败', describeFetchError(err))
      failures.push({ index, label: describeEndpoint(endpoint.url), error })
    }
  }

  // 只有一个地址时保留原来的错误文案（401/404/超时等），不要包一层「所有地址」
  if (failures.length === 1) throw failures[0]!.error
  throw new AiError(
    `所有 AI 服务地址都不可用（已尝试 ${failures.length} 个）`,
    failures
      .map(f => `第 ${f.index + 1} 个（${f.label}）：${f.error.message}`)
      .join('\n')
  )
}

/** 对单个地址发一次请求；超时按地址单独计算 */
async function requestChatAt(
  cfg: AiConfig,
  endpoint: AiEndpoint,
  endpointIndex: number,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options: ChatRequestOptions = {}
): Promise<AiResult> {
  const resolved = resolveEndpoint(endpoint.url)
  // 模型跟着地址走：某个地址没填模型只影响它自己，后面的地址照常尝试。
  // Azure 的部署名在路径里，模型可以留空。
  if (resolved.provider !== 'azure' && !endpoint.model) {
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
      headers: buildHeaders(resolved.provider, endpoint.apiKey),
      body: JSON.stringify(
        buildBody(resolved.provider, endpoint.model, system, messages, options)
      ),
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
    if (!res.ok) {
      const summary = summarizeError(body)
      const error = httpError(res.status, summary)
      // 带图片的请求被 400/422 拒绝，最常见的原因是模型不支持视觉输入。
      // 原始错误仍然保留在 detail 里，避免把「请求体里别的字段不合法」误诊。
      if (
        messagesHaveImages(messages) &&
        (res.status === 400 || res.status === 422)
      ) {
        throw new AiError(
          `模型可能不支持图片输入（HTTP ${res.status}）`,
          `本次请求包含扫描页图片。可以在插件设置里关闭「把扫描页作为图片发送」后重试，或换用支持视觉的模型。${
            summary ? `服务返回：${summary}` : ''
          }`
        )
      }
      throw error
    }

    const parsed = parseResponse(resolved.provider, body)
    return {
      ...parsed,
      provider: resolved.provider,
      model: endpoint.model || 'Azure 部署',
      endpointDisplay: resolved.display,
      endpointIndex,
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

/** 错误明细里对某个地址的称呼；地址本身不合法时退回原文 */
function describeEndpoint(raw: string): string {
  try {
    return resolveEndpoint(raw).display
  } catch {
    return raw.trim() || '(空地址)'
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
  messages: ChatMessage[],
  options: ChatRequestOptions
): Record<string, unknown> {
  const turns = messages
    .filter(message => message.content.length > 0 || (message.images?.length ?? 0) > 0)
    .map(message => buildTurn(provider, message))
  if (provider === 'anthropic') {
    // Anthropic 的 prompt caching 是显式的：把稳定的 system（当前文档 + 参考
    // 文件）标成一个缓存断点。多轮对话里文档不变时，后续轮次按缓存读取计费。
    // 只有对话打开 cacheSystem；美化/生成每次都换正文，标了也命不中，反而多付写入费。
    const systemContent = options.cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system
    return {
      model,
      system: systemContent,
      messages: turns,
      // Anthropic 必填；8192 足够整篇笔记，真被截断时调用方会拒绝写回
      max_tokens: 8192
    }
  }
  // OpenAI 兼容服务（DeepSeek 等）按请求前缀自动缓存：system 放最前、文档与
  // 附件保持稳定，后续轮次就能命中，不需要也不能加 cache_control。
  const all = [{ role: 'system', content: system }, ...turns]
  // Azure 的模型由路径里的部署名决定，body 里不再重复
  if (provider === 'azure') return { messages: all, stream: false }
  return { model, messages: all, stream: false }
}

/**
 * 一条消息在请求体里的形状。
 *
 * 没有图片时保持原来的纯字符串 content —— 一些 OpenAI 兼容网关对 content
 * 数组的支持并不完整，不能因为加了功能就把所有请求都换成数组。带图片时才
 * 按各家的多模态格式拆成 content parts。
 */
function buildTurn(
  provider: Provider,
  message: ChatMessage
): { role: 'user' | 'assistant'; content: unknown } {
  const images = message.role === 'user' ? message.images ?? [] : []
  if (images.length === 0) {
    return { role: message.role, content: message.content }
  }

  if (provider === 'anthropic') {
    const blocks: Record<string, unknown>[] = []
    if (message.content) blocks.push({ type: 'text', text: message.content })
    for (const image of images) {
      if (image.caption) blocks.push({ type: 'text', text: image.caption })
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data
        }
      })
    }
    return { role: message.role, content: blocks }
  }

  const parts: Record<string, unknown>[] = []
  if (message.content) parts.push({ type: 'text', text: message.content })
  for (const image of images) {
    if (image.caption) parts.push({ type: 'text', text: image.caption })
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mediaType};base64,${image.data}` }
    })
  }
  return { role: message.role, content: parts }
}

function messagesHaveImages(messages: ChatMessage[]): boolean {
  return messages.some(message => (message.images?.length ?? 0) > 0)
}

interface ParsedResponse {
  text: string
  truncated: boolean
  finishReason: string | null
  cache?: CacheStats
}

/**
 * 从响应的 usage 里读上下文缓存用量。各家的字段不一样：
 * - Anthropic：`cache_read_input_tokens`（命中）/ `cache_creation_input_tokens`（写入）
 * - DeepSeek：`prompt_cache_hit_tokens`（自动缓存，命中部分便宜很多）
 * - OpenAI：`prompt_tokens_details.cached_tokens`
 * 服务不支持或本次没有命中/写入时返回 undefined，而不是 0，方便日志区分。
 */
function readCacheStats(usage: unknown): CacheStats | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const details =
    record.prompt_tokens_details && typeof record.prompt_tokens_details === 'object'
      ? (record.prompt_tokens_details as Record<string, unknown>)
      : null

  const pick = (...values: unknown[]): number => {
    let best = 0
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value) && value > best) best = value
    }
    return Math.round(best)
  }

  const read = pick(
    record.cache_read_input_tokens,
    record.prompt_cache_hit_tokens,
    details?.cached_tokens
  )
  const write = pick(record.cache_creation_input_tokens)
  if (read === 0 && write === 0) return undefined
  return { read, write }
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
    return {
      text,
      truncated: stop === 'max_tokens',
      finishReason: stop,
      cache: readCacheStats(root.usage)
    }
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
  return {
    text,
    truncated: finish === 'length',
    finishReason: finish,
    cache: readCacheStats(root.usage)
  }
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
