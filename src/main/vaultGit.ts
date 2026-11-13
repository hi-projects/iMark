/**
 * 项目级的 Git 远端管理。
 *
 * 「远程同步」扩展的远端本来就按仓库保存(workspace 覆盖层)。仓库选择页现在
 * 直接管理这一份配置:克隆仓库时顺手写进去,之后也能在项目的「Git 设置」里改。
 * **不另存副本** —— 选择页写的、扩展读的是同一个值,不会出现两处不一致。
 *
 * 密钥仍然只落在 main 的 secrets.json 里(按扩展的密钥槽位),
 * 渲染层只拿得到「是否已保存」。
 */

import { createHash } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { VaultGitRemote, VaultGitRemoteInput } from '@shared/types'
import type { PluginAuthMode } from '@shared/plugins'
import { getSecret, setSecret } from './secrets'
import { getExtensionService } from './extensions/service'

/** 扩展 id 与它声明远端列表的完整配置键 */
const EXT_ID = 'imark.git-sync'
const TARGETS_KEY = `${EXT_ID}.targets`

interface StoredTarget {
  id: string
  url: string
  auth: PluginAuthMode
  username: string
  localBranch: string
  remoteBranch: string
}

/** 与扩展服务里 workspaceConfig 的键保持一致(Windows/macOS 折叠大小写) */
function workspaceKey(root: string): string {
  const absolute = resolvePath(root)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? absolute.toLowerCase()
    : absolute
}

/**
 * 项目远端的稳定 id。
 *
 * 密钥槽位按 id 区分,id 必须对同一个仓库永远相同 —— 否则每次保存都会留下
 * 一条读不到的新密钥,旧密钥也清不掉。
 */
function projectTargetId(root: string): string {
  const digest = createHash('sha256').update(workspaceKey(root)).digest('hex')
  return `vault-${digest.slice(0, 12)}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeAuth(value: unknown): PluginAuthMode {
  return value === 'password' || value === 'ssh' ? value : 'token'
}

function normalizeTarget(raw: unknown, root: string): StoredTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const url = text(item.url).trim()
  if (!url) return null
  const id = text(item.id) || projectTargetId(root)
  return {
    id,
    url,
    auth: normalizeAuth(item.auth),
    username: text(item.username),
    localBranch: text(item.localBranch) || 'main',
    remoteBranch: text(item.remoteBranch)
  }
}

/** 扩展的密钥槽位约定:账号密码用 `<id>#password`,其余用 `<id>` */
function secretSlot(id: string, auth: PluginAuthMode): string {
  return auth === 'password' ? `${id}#password` : id
}

function secretPath(id: string, auth: PluginAuthMode): string {
  return `${EXT_ID}:targets:${secretSlot(id, auth)}`
}

/** 读某个仓库的项目远端;没有配置返回 null */
async function readOne(root: string): Promise<VaultGitRemote | null> {
  const service = getExtensionService()
  if (!service) return null
  const raw = await service.readWorkspaceField(EXT_ID, root, TARGETS_KEY)
  const list = Array.isArray(raw) ? raw : []
  const target = normalizeTarget(list[0], root)
  if (!target) return null
  const secret = await getSecret(secretPath(target.id, target.auth))
  return {
    url: target.url,
    auth: target.auth,
    username: target.username,
    localBranch: target.localBranch,
    remoteBranch: target.remoteBranch,
    hasSecret: Boolean(secret)
  }
}

/** 批量读:返回 `仓库路径 → 远端 | null`;读不出来的项按 null 处理 */
export async function readVaultGitRemotes(
  paths: string[]
): Promise<Record<string, VaultGitRemote | null>> {
  const out: Record<string, VaultGitRemote | null> = {}
  for (const path of paths) {
    try {
      out[path] = await readOne(path)
    } catch {
      out[path] = null
    }
  }
  return out
}

/** 某个仓库当前项目远端的稳定 id(克隆后写配置时用) */
export function vaultTargetId(root: string): string {
  return projectTargetId(root)
}

/**
 * 写 / 清除某个仓库的项目远端。
 *
 * `secret` 的三种状态:
 * - `undefined`:只改地址、分支、认证方式,已保存的密钥原样保留;
 * - 空串:清掉当前认证方式的密钥;
 * - 非空:写入 / 覆盖。
 *
 * 切到 SSH 时把两种槽位的旧密钥都清掉 —— 否则设置页里会留着一条用户以为
 * 还在用的令牌。
 */
export async function setVaultGitRemote(
  root: string,
  input: VaultGitRemoteInput | null
): Promise<void> {
  const service = getExtensionService()
  if (!service) throw new Error('扩展服务尚未就绪,请稍后重试')

  const id = projectTargetId(root)
  if (input === null) {
    await service.setWorkspaceField(EXT_ID, root, TARGETS_KEY, undefined)
    await clearSecret(id, 'token')
    await clearSecret(id, 'password')
    return
  }

  const url = input.url.trim()
  if (!url) throw new Error('仓库地址不能为空')
  if (/[\u0000-\u001f\u007f]/.test(url)) throw new Error('仓库地址里有控制字符')
  if (/[\\/]/.test(input.localBranch) || /\s/.test(input.localBranch)) {
    throw new Error('本地分支名不能包含空白或路径分隔符')
  }
  const auth = normalizeAuth(input.auth)
  const target: StoredTarget = {
    id,
    url,
    auth,
    username: text(input.username).trim(),
    localBranch: input.localBranch.trim() || 'main',
    remoteBranch: input.remoteBranch.trim()
  }
  await service.setWorkspaceField(EXT_ID, root, TARGETS_KEY, [target])

  if (auth === 'ssh') {
    await clearSecret(id, 'token')
    await clearSecret(id, 'password')
    return
  }
  if (input.secret !== undefined) {
    await setSecret(secretPath(id, auth), input.secret || null)
    // 换认证方式时清掉另一种槽位,避免旧密钥被误认为仍然有效
    await clearSecret(id, auth === 'password' ? 'token' : 'password')
  }
}

async function clearSecret(id: string, auth: PluginAuthMode): Promise<void> {
  try {
    await setSecret(secretPath(id, auth), null)
  } catch {
    /* 清不掉也不影响配置本身 */
  }
}
