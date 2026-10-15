/**
 * 注册、登录、令牌管理。
 *
 * 令牌分两种,但存储上只有一种 —— 登录返回的与新签发的是同一个东西,
 * 区别只在用途:客户端把长期令牌填进「开发者令牌」,用来发布。
 * 少一种类型就少一类「这个令牌能不能干那件事」的判断。
 */

import { HttpError, readJson, sendJson } from '../http.mjs'
import {
  checkPassword,
  hashPassword,
  newToken,
  normalizeUsername,
  tokenHash,
  tokenId,
  verifyPassword
} from '../auth.mjs'

/** 演示/自托管环境里允许的第一个用户直接成为管理员 */
function maybeFirstAdmin(data) {
  return Object.keys(data.users).length === 0
}

export function register(router, app) {
  const { store, limiter } = app

  /** 客户端 IP:默认监听回环,所以 x-forwarded-for 只在明确配置了代理时才可信 */
  const ipOf = req =>
    (app.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) ||
    req.socket.remoteAddress ||
    'unknown'

  /**
   * 限流键是 **IP + 用户名**,不是光看 IP。
   *
   * 只看 IP 的话,任何人对着某个用户名连试 11 次就能让**同一个出口 IP 下的所有人**
   * 登录不了整整 5 分钟 —— 攻击者用一次简单的锁门,就能把限流变成拒绝服务。
   * 加上用户名之后,被挡住的是「这个 IP 猜这个账号」这一种行为,
   * 换个账号、换个 IP 都照常。代价是攻击者可以轮换用户名绕过它 ——
   * 但那已经不是登录接口能解决的问题了,该由网关的按 IP 限流来接。
   */
  const keyOf = (req, username, fallback) =>
    `${ipOf(req)}|${username ?? fallback ?? ''}`

  router.post('/api/v1/auth/register', async ({ req, res }) => {
    const body = await readJson(req)
    const gate = keyOf(req, String(body.username ?? '').trim().toLowerCase())
    if (limiter.isBlocked(gate)) {
      throw new HttpError(429, '尝试次数过多,请 5 分钟后再试', 'rate_limited')
    }
    const username = normalizeUsername(body.username)
    const password = checkPassword(body.password)

    const isAdmin = await store.readJson('users.json', { users: {} }).then(maybeFirstAdmin)
    const created = await store.update('users.json', { users: {} }, data => {
      if (data.users[username]) {
        throw new HttpError(409, `用户名「${username}」已被占用`, 'user_exists')
      }
      data.users[username] = {
        username,
        password: hashPassword(password),
        isAdmin,
        createdAt: Date.now()
      }
      return true
    })
    if (created) limiter.succeed(gate)

    const token = await issueToken(username, '登录令牌')
    sendJson(res, 201, { user: { username, isAdmin }, token })
  })

  router.post('/api/v1/auth/login', async ({ req, res }) => {
    const body = await readJson(req)
    const username = String(body.username ?? '').trim().toLowerCase()
    const password = String(body.password ?? '')
    const gate = keyOf(req, username)
    if (limiter.isBlocked(gate)) {
      throw new HttpError(429, '尝试次数过多,请 5 分钟后再试', 'rate_limited')
    }

    const data = await store.readJson('users.json', { users: {} })
    const user = data.users[username]
    // 用户不存在与口令错误回同一句话:不告诉对方「这个用户名是存在的」
    if (!user || !verifyPassword(password, user.password)) {
      limiter.fail(gate)
      throw new HttpError(401, '用户名或密码不正确', 'bad_credentials')
    }
    limiter.succeed(gate)
    const token = await issueToken(username, '登录令牌')
    sendJson(res, 200, { user: { username, isAdmin: Boolean(user.isAdmin) }, token })
  })

  router.get('/api/v1/auth/me', async ({ res, auth }) => {
    const user = app.requireUser(auth)
    const data = await store.readJson('users.json', { users: {} })
    sendJson(res, 200, {
      username: user,
      isAdmin: Boolean(data.users[user]?.isAdmin),
      tokens: await listTokens(user)
    })
  })

  router.post('/api/v1/auth/tokens', async ({ req, res, auth }) => {
    const user = app.requireUser(auth)
    const body = await readJson(req)
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '发布令牌'
    const token = await issueToken(user, label || '发布令牌')
    // 明文**只在这一刻**返回一次,服务端只留 sha256
    sendJson(res, 201, { token, label, id: tokenId(token) })
  })

  router.delete('/api/v1/auth/tokens/:id', async ({ params, res, auth }) => {
    const user = app.requireUser(auth)
    const removed = await store.update('tokens.json', { tokens: {} }, data => {
      for (const [hash, rec] of Object.entries(data.tokens)) {
        if (hash.slice(0, 16) === params.id && rec.user === user) {
          delete data.tokens[hash]
          return true
        }
      }
      return false
    })
    if (!removed) throw new HttpError(404, '没有这个令牌', 'not_found')
    sendJson(res, 200, { ok: true })
  })

  async function issueToken(username, label) {
    const token = newToken()
    await store.update('tokens.json', { tokens: {} }, data => {
      data.tokens[tokenHash(token)] = {
        user: username,
        label,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      }
    })
    return token
  }

  async function listTokens(username) {
    const data = await store.readJson('tokens.json', { tokens: {} })
    return Object.entries(data.tokens)
      .filter(([, rec]) => rec.user === username)
      .map(([hash, rec]) => ({
        id: hash.slice(0, 16),
        label: rec.label,
        createdAt: rec.createdAt,
        lastUsedAt: rec.lastUsedAt
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }
}

/** 供 app.requireUser 使用的校验:token 表里找得到就是合法,顺带刷新 lastUsedAt */
export async function verifyToken(store, token) {
  const hash = tokenHash(token)
  const data = await store.readJson('tokens.json', { tokens: {} })
  const rec = data.tokens[hash]
  if (!rec) return null
  // 每小时才写一次:每次请求都写会把 tokens.json 变成热点文件
  if (Date.now() - (rec.lastUsedAt ?? 0) > 3600_000) {
    rec.lastUsedAt = Date.now()
    await store
      .update('tokens.json', { tokens: {} }, d => {
        if (d.tokens[hash]) d.tokens[hash].lastUsedAt = Date.now()
      })
      .catch(() => undefined)
  }
  return rec.user
}

/** 从 `Authorization: Bearer <token>` 里取出令牌;没有就返回 null */
export function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))
  return m ? m[1].trim() : null
}
