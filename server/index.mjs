#!/usr/bin/env node
/**
 * iMark 扩展市场 —— 自托管服务端。
 *
 * 零依赖:只用 node: 内置模块,所以「跑起来」这件事的成本是
 * `node server/index.mjs`,不需要 npm install、不需要数据库、不需要构建。
 *
 * 环境变量:
 *   IMK_MARKET_PORT   监听端口(默认 8787)
 *   HOST              监听地址(默认 127.0.0.1 —— **默认只对本机开放**)
 *   DATA              数据目录(默认 ./server/data)
 *   ADMIN_TOKEN       管理员令牌(设置了才有管理接口;不设置则没有管理员)
 *   TRUST_PROXY       设为 1 时信任 X-Forwarded-For(仅在真的放在反向代理后面时开)
 *
 * ⚠️ 默认配置是**明文 HTTP + 仅回环**。要对外提供服务,必须在自己前面放一层
 *    TLS 终结(nginx / caddy),并清楚限流与备份要自己负责 —— 见仓库 README。
 */

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { HttpError, createRouter, sendJson } from './src/http.mjs'
import { Store } from './src/store.mjs'
import { RateLimiter } from './src/auth.mjs'
import { bearerOf, register as registerAuth, verifyToken } from './src/routes/auth.mjs'
import { register as registerPackages } from './src/routes/packages.mjs'
import { register as registerAdmin } from './src/routes/admin.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = '1.0.0'

const PORT = Number.parseInt(process.env.IMK_MARKET_PORT ?? '8787', 10)
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA = resolve(process.env.DATA ?? join(HERE, 'data'))
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? null

const store = new Store(DATA)
const limiter = new RateLimiter()

/** 请求上下文里放进去的 `app` —— 路由模块只通过它接触外部世界 */
const app = {
  store,
  limiter,
  version: VERSION,
  trustProxy: process.env.TRUST_PROXY === '1',

  /** 取当前登录用户;没有就 401。**错误文案不区分「没带令牌」与「令牌不对」** */
  requireUser(auth) {
    if (!auth?.user) throw new HttpError(401, '需要登录', 'unauthorized')
    return auth.user
  },

  /** 管理员 = 持有 ADMIN_TOKEN 的那个令牌。没配 ADMIN_TOKEN 就没有管理员 */
  isAdmin(user) {
    return Boolean(ADMIN_TOKEN) && user === '__admin__'
  },

  requireAdmin(auth) {
    if (!this.isAdmin(auth?.user)) throw new HttpError(403, '需要管理员权限', 'forbidden')
  }
}

/** 每个请求跑一次:先看管理员令牌,再看普通令牌 */
async function authenticate(req) {
  const token = bearerOf(req)
  if (!token) return null
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return { user: '__admin__' }
  const user = await verifyToken(store, token)
  return user ? { user } : null
}

const router = createRouter({ authenticate })

router.get('/api/v1/health', ({ res }) => {
  sendJson(res, 200, { ok: true, version: VERSION, time: Date.now() })
})

registerAuth(router, app)
registerPackages(router, app)
registerAdmin(router, app)

const server = createServer(router.handler())

server.listen(PORT, HOST, async () => {
  await store.init()
  console.log(`[market] iMark 扩展市场 ${VERSION}`)
  console.log(`[market] 监听 http://${HOST}:${PORT}`)
  console.log(`[market] 数据目录 ${DATA}`)
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('[market] ⚠️ 监听地址不是回环地址:请确认前面有 TLS 与限流,否则口令是明文传输的')
  }
  if (!ADMIN_TOKEN) {
    console.log('[market] 未设置 ADMIN_TOKEN:没有管理员接口(所有权转移等)可用')
  }
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[market] 端口 ${PORT} 已被占用。换一个:IMK_MARKET_PORT=8788 node server/index.mjs`)
  } else {
    console.error('[market] 服务启动失败:', err)
  }
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[market] 收到 ${signal},关闭中…`)
    server.close(() => process.exit(0))
    // 有连接卡着时不要无限期等
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
