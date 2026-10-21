import { safeStorage } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './files'
import { dataRoot } from './dataDir'

/**
 * 插件密钥(token 等)存储。
 *
 * - 默认用 Electron safeStorage 加密(Windows 走 DPAPI,绑定当前用户),磁盘上只落 base64 密文;
 * - 每条记录自带 enc 标记,所以「加密可用性发生变化」时旧记录仍能正确读回;
 * - safeStorage 不可用时降级为明文存储并在返回里标记,由 UI 提示用户;
 * - 渲染层**永远拿不到明文**(API 只回「是否已配置」)。
 */

interface SecretEntry {
  /** 是否加密存储 */
  enc: boolean
  /** enc ? base64 密文 : 明文 */
  v: string
}

interface SecretFile {
  version: 1
  entries: Record<string, SecretEntry>
}

let cache: SecretFile | null = null

function secretsPath(): string {
  return join(dataRoot(), 'secrets.json')
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

async function load(): Promise<SecretFile> {
  if (cache) return cache
  try {
    const raw = await readFile(secretsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SecretFile>
    cache = {
      version: 1,
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
    }
  } catch {
    cache = { version: 1, entries: {} }
  }
  return cache
}

async function persist(file: SecretFile): Promise<void> {
  cache = file
  try {
    await mkdir(dirname(secretsPath()), { recursive: true })
    await writeFileAtomic(secretsPath(), JSON.stringify(file, null, 2))
  } catch {
    /* 落盘失败不影响本次会话 */
  }
}

/**
 * 给界面看的掩码:abc123… → `ab****23`。
 * 注意这是**有意**把首尾各 2 个字符交给渲染层(便于用户辨认是哪把令牌);
 * 明文本身仍然只留在主进程。太短的令牌整体打码,一个字符都不露。
 */
export function maskSecret(value: string): string {
  const n = value.length
  if (n >= 8) return `${value.slice(0, 2)}****${value.slice(-2)}`
  if (n >= 4) return `${value.slice(0, 1)}****${value.slice(-1)}`
  return '****'
}

/** 掩码缓存:每次状态广播都要算,避免反复解密 */
const hintCache = new Map<string, string>()

/** 批量取「掩码」:'' 表示未配置 */
export async function secretHints(keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    let hint = hintCache.get(key)
    if (hint === undefined) {
      const value = await getSecret(key)
      hint = value ? maskSecret(value) : ''
      hintCache.set(key, hint)
    }
    out[key] = hint
  }
  return out
}

export async function hasSecret(key: string): Promise<boolean> {
  const file = await load()
  return Boolean(file.entries[key]?.v)
}

export async function getSecret(key: string): Promise<string | null> {
  const file = await load()
  const entry = file.entries[key]
  if (!entry?.v) return null
  if (!entry.enc) return entry.v
  try {
    return safeStorage.decryptString(Buffer.from(entry.v, 'base64'))
  } catch {
    // 换机器/换用户后 DPAPI 解不开,视为未配置,由 UI 提示重新填写
    return null
  }
}

/** value 为 null 时删除该密钥 */
export async function setSecret(key: string, value: string | null): Promise<void> {
  const file = await load()
  const entries = { ...file.entries }
  if (value === null || value === '') {
    delete entries[key]
  } else if (encryptionAvailable()) {
    entries[key] = { enc: true, v: safeStorage.encryptString(value).toString('base64') }
  } else {
    entries[key] = { enc: false, v: value }
  }
  await persist({ version: 1, entries })
  hintCache.delete(key)
}

/**
 * 删除某个插件名下的全部密钥(卸载时用)。
 *
 * 用前缀删除而不是逐个 key:插件可能改过认证方式,留下 `<id>:<field>:<target>#password`
 * 这类当前配置里已不存在的槽位,按配置推算的 key 列表会漏掉它们。
 *
 * 必须逐个 `hintCache.delete()`:这个缓存是「掩码」的缓存,不清的话下一次状态广播
 * 会把已经删掉的密钥的旧掩码又显示出来。
 */
export async function deleteSecretsByPrefix(prefix: string): Promise<number> {
  const file = await load()
  const entries = { ...file.entries }
  let removed = 0
  for (const key of Object.keys(entries)) {
    if (!key.startsWith(prefix)) continue
    delete entries[key]
    hintCache.delete(key)
    removed += 1
  }
  if (removed > 0) await persist({ version: 1, entries })
  return removed
}

/**
 * 列出全部密钥键。
 *
 * 只有主进程的一次性清理会用到：它需要按「键前缀是不是合法扩展 ID」挑出 v1 残留，
 * 而不是按某份配置推算槽位。渲染层没有、也不该有对应通道 —— 键名本身会泄露
 * 用户配置过哪些插件/远端。
 */
export async function listSecretKeys(): Promise<string[]> {
  const file = await load()
  return Object.keys(file.entries)
}

/** 按键批量删除;不在列表里的条目原样保留。返回实际删除数 */
export async function deleteSecretKeys(keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0
  const file = await load()
  const entries = { ...file.entries }
  let removed = 0
  for (const key of keys) {
    if (!(key in entries)) continue
    delete entries[key]
    hintCache.delete(key)
    removed += 1
  }
  if (removed > 0) await persist({ version: 1, entries })
  return removed
}

/** 批量查询「是否已配置」,供 PluginView.secrets 使用 */
export async function hasSecrets(keys: string[]): Promise<Record<string, boolean>> {
  const file = await load()
  const out: Record<string, boolean> = {}
  for (const key of keys) out[key] = Boolean(file.entries[key]?.v)
  return out
}

export function isEncryptionAvailable(): boolean {
  return encryptionAvailable()
}
