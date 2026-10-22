/**
 * 迷你 HTTP 层:路由 + JSON 读写 + 统一错误信封。
 *
 * 只有几百行,却换掉了整个 express 依赖树 —— 这个服务端的路由需求就是这么小:
 * 十来条路径、没有中间件体系、没有模板、没有静态资源(图标由 blob 现取)。
 * 依赖为零的另一个好处是它能在任何一台装了 Node 的机器上直接 `node index.mjs` 跑起来,
 * 不需要 npm install —— 自托管插件市场的门槛应该低到这个程度。
 */

/** 请求体上限:**默认 1 MiB**。发布插件走的是一条单独放宽到 12 MiB 的路径 */
export const DEFAULT_BODY_LIMIT = 1024 * 1024

/**
 * 统一的错误类型。抛出它 = 返回对应状态码与 code;
 * 抛出别的东西 = 500,且**只把消息原样带出去**(自托管场景下使用者就是运维,看不出更糟)。
 */
export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message)
    this.status = status
    this.code = code
  }
}

const CORS_HEADERS = {
  // 客户端是 Electron 主进程(没有 Origin),这几行是给浏览器里的调试页留的。
  // 只回显本机来源:这个服务端默认监听 127.0.0.1,不该被任意网页当后端用。
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '600'
}

function isLocalOrigin(origin) {
  if (!origin) return false
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch {
    return false
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    ...extraHeaders
  })
  res.end(body)
}

export function sendBytes(res, status, buf, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.byteLength,
    ...extraHeaders
  })
  res.end(buf)
}

/** 读请求体,超过 limit 直接 413(不是先读完再判断 —— 那等于没有上限) */
export function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (declared > limit) {
      reject(new HttpError(413, `请求体过大(上限 ${Math.floor(limit / 1024 / 1024)} MiB)`, 'too_large'))
      req.destroy()
      return
    }
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.byteLength
      if (size > limit) {
        reject(new HttpError(413, `请求体过大(上限 ${Math.floor(limit / 1024 / 1024)} MiB)`, 'too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit)
  if (buf.byteLength === 0) throw new HttpError(400, '请求体为空', 'empty_body')
  let parsed
  try {
    parsed = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON', 'bad_json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象', 'bad_json')
  }
  return parsed
}

/** 把一个路径模板切成段:'/packages/:id/versions/:v' → ['packages', ':id', 'versions', ':v'] */
function segments(pattern) {
  return pattern.split('/').filter(Boolean)
}

/**
 * @param opts.authenticate  (req) => Promise<{ user } | null>|null
 *   每个请求都会先跑一次;**返回 null 表示匿名**,不是错误 —— 需要登录的路由
 *   自己在处理函数里 `requireUser(auth)`,这样「公开读、登录写」不需要两套路由表。
 */
export function createRouter(opts = {}) {
  const routes = []

  function add(method, pattern, handler, options = {}) {
    routes.push({
      method,
      parts: segments(pattern),
      handler,
      // 每条路由可以单独放宽体积上限(发布插件需要)
      limit: options.limit
    })
  }

  /**
   * 匹配一条路由。路径段逐段比较,`:name` 段捕获到 params。
   * 不做正则、不支持通配 —— 路由表就这么点大,复杂度留在这里换不来任何东西。
   */
  function match(method, pathname) {
    const parts = segments(decodeURIComponent(pathname))
    for (const route of routes) {
      if (route.method !== method) continue
      if (route.parts.length !== parts.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < parts.length; i += 1) {
        const p = route.parts[i]
        if (p.startsWith(':')) params[p.slice(1)] = parts[i]
        else if (p !== parts[i]) {
          ok = false
          break
        }
      }
      if (ok) return { route, params }
    }
    return null
  }

  return {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),

    /** 返回给 http.createServer 的请求处理器 */
    handler() {
      return async (req, res) => {
        const origin = req.headers.origin
        if (isLocalOrigin(origin)) {
          res.setHeader('access-control-allow-origin', origin)
          for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v)
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        const url = new URL(req.url, 'http://localhost')
        const hit = match(req.method, url.pathname)
        if (!hit) {
          sendJson(res, 404, { error: { code: 'not_found', message: `没有这个接口:${req.method} ${url.pathname}` } })
          return
        }

        try {
          const auth = opts.authenticate ? await opts.authenticate(req) : null
          await hit.route.handler({ req, res, params: hit.params, query: url.searchParams, auth })
        } catch (err) {
          if (err instanceof HttpError) {
            sendJson(res, err.status, { error: { code: err.code, message: err.message } })
            return
          }
          // 未预期的异常:打全栈到服务端日志,只回一句笼统的话
          console.error('[market] 未处理的异常:', err)
          sendJson(res, 500, { error: { code: 'internal', message: '服务端内部错误' } })
        }
      }
    }
  }
}

/** 把 '?page=2' 这类参数读成整数并夹在范围内 */
export function intParam(query, name, fallback, min, max) {
  const raw = query.get(name)
  const n = raw === null ? NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
