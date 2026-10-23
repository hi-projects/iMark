/**
 * 市场配置:注册表地址、开发者令牌、登录状态。
 *
 * **令牌必须待在 secrets.json 里,绝不能进 Settings。**
 * Settings 会通过 `settings:get` 整份交给渲染层,而开发者令牌是一把能代表你
 * 发布的长期凭据 —— 它不该出现在那个通道上。渲染层只被告知「你登录成了谁」,
 * 不被允许知道「凭证是什么」。
 *
 * 令牌按**注册表地址**分开存放(键里带地址),于是:
 *   - 换到一个新的自建服务端,不会把上一个服务端的令牌顺手带过去;
 *   - 换回来时,之前登录的凭据还在 —— 这比「一改地址就清空」更符合直觉,
 *     因为用户改地址往往只是想看看另一台机器上有什么。
 */

import type { MarketAuthStatus } from '@shared/market'
import { getSettings, saveSettings } from '../settings'
import { getSecret, isEncryptionAvailable, setSecret } from '../secrets'

/**
 * 令牌在 secrets.json 里的键前缀。
 *
 * 用 `@` 开头是**为了避开扩展密钥的命名空间**:扩展密钥的键是
 * `<扩展id>:<字段>[:<目标>]`,而扩展 id 只允许 `[a-z0-9._-]` 开头。
 * 卸载扩展时按 `<id>:` 前缀批量删密钥,任何一个合法 id 都匹配不到 `@market:`,
 * 所以市场令牌不可能被某个扩展的卸载误删。
 */
const TOKEN_PREFIX = '@market:'
const USER_PREFIX = '@market-user:'

/**
 * 把用户输入的地址规范化成**身份键**:协议 + 主机 + 去掉尾部斜杠的路径。
 *
 * 规范化是必要的:同一个服务端会被写成 `http://127.0.0.1:8787`、
 * `http://127.0.0.1:8787/`、`HTTP://127.0.0.1:8787` 三种样子,
 * 不归一的话每换一种写法就等于换了一个注册表,登录状态会莫名其妙地丢。
 * 非法地址返回 null。
 */
export function registryKey(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.host) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

/** 当前注册表地址(已规范化);未配置或写错了都返回空串 */
export async function getRegistryUrl(): Promise<string> {
  const settings = await getSettings()
  return registryKey(settings.marketUrl) ?? ''
}

/**
 * 写注册表地址。传空串表示「不使用市场」。
 * 非法地址**抛错**而不是静默存下 —— 存下去的话,后面每次请求都会失败在一句
 * 与「地址写错了」无关的报错上,用户很难把两件事联系起来。
 */
export async function setRegistryUrl(raw: string): Promise<string> {
  const trimmed = raw.trim()
  if (!trimmed) {
    await saveSettings({ marketUrl: '' })
    return ''
  }
  const key = registryKey(trimmed)
  if (!key) throw new Error('市场地址必须是 http:// 或 https:// 开头的完整地址')
  await saveSettings({ marketUrl: key })
  return key
}

// ---------- 令牌 ----------

/**
 * 取当前注册表的开发者令牌。
 * **返回值只能是主进程内部用的** —— 它会出现在 registry/publish 的 Authorization 头里,
 * 没有任何一条 IPC 通道把它送出去。
 */
export async function getDevToken(): Promise<string | null> {
  const registry = await getRegistryUrl()
  if (!registry) return null
  return getSecret(TOKEN_PREFIX + registry)
}

/**
 * 记下一次登录。用户名与令牌**写在同一个文件、同一个地方**,
 * 因为它们必须同生同灭:分成两处存早晚会出现「settings 说登录着,令牌却没了」。
 */
export async function setSession(token: string, username: string): Promise<void> {
  const registry = await getRegistryUrl()
  if (!registry) throw new Error('请先填写市场地址')
  await setSecret(TOKEN_PREFIX + registry, token)
  await setSecret(USER_PREFIX + registry, username)
}

export async function clearSession(): Promise<void> {
  const registry = await getRegistryUrl()
  if (!registry) return
  await setSecret(TOKEN_PREFIX + registry, null)
  await setSecret(USER_PREFIX + registry, null)
}

/** 服务端说这枚令牌不认了(401)时调用 —— 本地凭证已经没有意义,留着只会反复失败 */
export async function invalidateSession(): Promise<void> {
  await clearSession()
}

/**
 * 登录状态。**不做网络请求**:离线也要能正确显示「上次登录的是 dev」,
 * 而不是每次都摆一个「未登录」。令牌是否仍然有效,由真正用到它的操作去发现。
 */
export async function authStatus(): Promise<MarketAuthStatus> {
  const registry = await getRegistryUrl()
  const token = registry ? await getSecret(TOKEN_PREFIX + registry) : null
  const user = registry && token ? await getSecret(USER_PREFIX + registry) : null
  return {
    registry,
    loggedIn: Boolean(token),
    user,
    // safeStorage 不可用时令牌是明文落盘的,这一点必须让用户知道
    secureStorage: isEncryptionAvailable(),
    // 注意这是「**还需要**警告一次」而不是「是明文」——用户关掉之后不该再弹
    plainHttp: await shouldWarnPlainHttp()
  }
}

// ---------- 明文 http 的一次性警告 ----------

/** 回环地址上的明文是可接受的(数据不出本机);其余地方的明文要提醒一次 */
export function isLoopback(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (name === 'localhost' || name === '::1') return true
  return /^127\./.test(name)
}

function needsPlainHttpWarning(registry: string): boolean {
  try {
    const url = new URL(registry)
    return url.protocol === 'http:' && !isLoopback(url.hostname)
  } catch {
    return false
  }
}

/** 这个地址是否还需要弹一次「你在用明文」的提示 */
export async function shouldWarnPlainHttp(): Promise<boolean> {
  const registry = await getRegistryUrl()
  if (!registry || !needsPlainHttpWarning(registry)) return false
  const settings = await getSettings()
  return !settings.marketWarnedPlainHttp.includes(registry)
}

/** 用户看过了,不再提 —— 这是一次性的知情提示,不是每次操作都要按的确认框 */
export async function acknowledgePlainHttp(): Promise<void> {
  const registry = await getRegistryUrl()
  if (!registry) return
  const settings = await getSettings()
  if (settings.marketWarnedPlainHttp.includes(registry)) return
  await saveSettings({ marketWarnedPlainHttp: [...settings.marketWarnedPlainHttp, registry] })
}
