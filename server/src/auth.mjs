/**
 * 账号与令牌。
 *
 * 三件事,都用 node:crypto 就够:
 *   - 口令用 scrypt(N=16384,r=8,p=1,64 字节)存,盐随机 16 字节。
 *     不存明文、不存可逆加密;参数写进存储串里,以后调参不会让老口令失效。
 *   - 令牌 32 字节随机 base64url,**只存 sha256** —— 数据库泄露也换不回令牌本身。
 *   - 比较一律走 timingSafeEqual。
 *
 * 还有一件事这里**没做**:口令找回、邮箱验证、二次验证。自托管的定位是
 * 「小圈子里的扩展分发」,做一半的账号体系比不做更危险 —— README 里明说了。
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { HttpError } from './http.mjs'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 64

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/

export function normalizeUsername(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  if (!USERNAME_RE.test(name)) {
    throw new HttpError(
      400,
      '用户名只能用 2–32 个小写字母、数字与 . _ -,且必须以字母或数字开头',
      'bad_username'
    )
  }
  return name
}

export function checkPassword(raw) {
  const password = String(raw ?? '')
  if (password.length < 8) throw new HttpError(400, '密码至少 8 位', 'weak_password')
  if (password.length > 200) throw new HttpError(400, '密码太长了', 'weak_password')
  return password
}

/** → `scrypt$N$r$p$<salt-b64>$<hash-b64>` */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  try {
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = scryptSync(password, salt, expected.byteLength, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    })
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function newToken() {
  return randomBytes(32).toString('base64url')
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** 令牌在列表里的公开标识:hash 的前 16 位。它只是用来指认一条记录,不是凭据 */
export function tokenId(token) {
  return tokenHash(token).slice(0, 16)
}

/**
 * 按 IP 的失败计数。
 *
 * **只够自托管用。**它挡得住对着登录接口硬猜口令的脚本,挡不住分布式撞库;
 * 而且进程一重启就清零。公开部署必须换成真正的限流组件(前置网关或专门的中间件),
 * 这一点在 README 里写明了,不假装这里有防线。
 */
export class RateLimiter {
  constructor({ limit = 10, windowMs = 5 * 60 * 1000 } = {}) {
    this.limit = limit
    this.windowMs = windowMs
    this.buckets = new Map()
  }

  /** 记录一次失败;返回 true 表示这个 IP 已经被挡住 */
  fail(ip) {
    const now = Date.now()
    const bucket = this.buckets.get(ip)
    if (!bucket || now > bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs })
      return false
    }
    bucket.count += 1
    return bucket.count > this.limit
  }

  succeed(ip) {
    this.buckets.delete(ip)
  }

  isBlocked(ip) {
    const bucket = this.buckets.get(ip)
    if (!bucket) return false
    if (Date.now() > bucket.resetAt) {
      this.buckets.delete(ip)
      return false
    }
    return bucket.count > this.limit
  }
}
