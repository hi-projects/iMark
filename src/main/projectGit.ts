/**
 * 项目级 Git 远端与密钥。
 *
 * 这份配置属于**项目**,不属于「远程同步」扩展:克隆仓库、项目行上的 Git 设置、
 * 以及扩展的定时同步都读同一份。
 *
 * 纪律:
 * - 元数据(地址/认证方式/分支)进 settings.projectGit,可被渲染层看到;
 * - 密钥只进 main 的 secrets.json(键前缀 `project-git:`),渲染层只拿 `hasSecret`;
 * - 扩展宿主通过 `imark.project.getGitSecret()` 按需取一次明文,不广播。
 */

import { createHash } from 'node:crypto'
import { resolve as resolvePath, sep } from 'node:path'
import type {
  ProjectGitRemoteConfig,
  VaultGitRemote,
  VaultGitRemoteInput
} from '@shared/types'
import type { PluginAuthMode } from '@shared/plugins'
import { getSecret, setSecret } from './secrets'
import { loadSettings, saveSettings } from './settings'

/** 项目级密钥的键前缀。与扩展前缀分开,卸载扩展不会连带删掉项目密钥。 */
const SECRET_PREFIX = 'project-git'

/** 与设置里其他按仓库索引的键保持一致(Windows/macOS 折叠大小写) */
export function projectGitKey(root: string): string {
  const absolute = resolvePath(root)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? absolute.toLowerCase()
    : absolute
}

/**
 * 项目远端的稳定 id。
 *
 * 密钥键按它生成,必须对同一个仓库永远相同 —— 否则每次保存都会留下一条读不到
 * 的新密钥,旧密钥也清不掉。
 */
function projectId(root: string): string {
  const digest = createHash('sha256').update(projectGitKey(root)).digest('hex')
  return `vault-${digest.slice(0, 12)}`
}

/** 项目级密钥键:token / ssh 用 `<id>`,账号密码用 `<id>:password` */
export function projectGitSecretKey(root: string, auth: PluginAuthMode): string {
  const suffix = auth === 'password' ? ':password' : ''
  return `${SECRET_PREFIX}:${projectId(root)}${suffix}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAuth(value: unknown): PluginAuthMode {
  return value === 'password' || value === 'ssh' ? value : 'token'
}

function normalizeConfig(raw: unknown): ProjectGitRemoteConfig | null {
  if (!isRecord(raw)) return null
  const url = text(raw.url).trim()
  if (!url) return null
  return {
    url,
    auth: normalizeAuth(raw.auth),
    username: text(raw.username).trim(),
    localBranch: text(raw.localBranch).trim() || 'main',
    remoteBranch: text(raw.remoteBranch).trim()
  }
}

async function readStored(root: string): Promise<ProjectGitRemoteConfig | null> {
  const settings = await loadSettings()
  return normalizeConfig(settings.projectGit?.[projectGitKey(root)])
}

/**
 * 写项目配置。
 *
 * 走一条串行队列:选择页会同时读多个仓库,克隆与设置保存也可能挨着发生。
 * `saveSettings` 的合并只到顶层,两个并发的「读整个 projectGit → 改一项 → 写回」
 * 会互相覆盖,所以必须串起来。
 */
let writeChain: Promise<unknown> = Promise.resolve()

function queueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  // 失败不能卡住后面的写;错误仍由调用方拿到
  writeChain = run.catch(() => undefined)
  return run
}

function writeStored(root: string, config: ProjectGitRemoteConfig | null): Promise<void> {
  return queueWrite(async () => {
    const settings = await loadSettings()
    const all = { ...(settings.projectGit ?? {}) }
    const key = projectGitKey(root)
    if (config) all[key] = config
    else delete all[key]
    await saveSettings({ projectGit: all })
  })
}

/** 读某个仓库的项目远端;没有配置返回 null。 */
export async function readProjectGitRemote(root: string): Promise<VaultGitRemote | null> {
  const config = await readStored(root)
  if (!config) return null
  const secret = await getSecret(projectGitSecretKey(root, config.auth))
  return { ...config, hasSecret: Boolean(secret) }
}

/**
 * 给扩展宿主用:在元数据之外带一次明文密钥。
 * 认证方式为 SSH 或尚未保存时 `secret` 为空串。
 */
export async function readProjectGitRemoteSecret(
  root: string
): Promise<(VaultGitRemote & { secret: string }) | null> {
  const config = await readStored(root)
  if (!config) return null
  const secret =
    config.auth === 'ssh' ? null : await getSecret(projectGitSecretKey(root, config.auth))
  return { ...config, hasSecret: Boolean(secret), secret: secret ?? '' }
}

/** 批量读:返回 `仓库路径 → 远端 | null`;读不出来的项按 null 处理 */
export async function readProjectGitRemotes(
  paths: string[]
): Promise<Record<string, VaultGitRemote | null>> {
  const out: Record<string, VaultGitRemote | null> = {}
  for (const path of paths) {
    try {
      out[path] = await readProjectGitRemote(path)
    } catch {
      out[path] = null
    }
  }
  return out
}

/**
 * 写 / 清除某个仓库的项目远端。
 *
 * `secret` 的三种状态:
 * - `undefined`:只改地址、分支、认证方式,已保存的密钥原样保留;
 * - 空串:清掉当前认证方式的密钥;
 * - 非空:写入 / 覆盖。
 *
 * 切到 SSH 时把两种槽位的旧密钥都清掉 —— 否则会留着一条用户以为还在用的令牌。
 */
export async function setProjectGitRemote(
  root: string,
  input: VaultGitRemoteInput | null
): Promise<void> {
  if (input === null) {
    await writeStored(root, null)
    await clearSecrets(root, 'token')
    await clearSecrets(root, 'password')
    return
  }

  const url = input.url.trim()
  if (!url) throw new Error('仓库地址不能为空')
  if (/[\u0000-\u001f\u007f]/.test(url)) throw new Error('仓库地址里有控制字符')
  const localBranch = input.localBranch.trim() || 'main'
  if (/[\\/]/.test(localBranch) || /\s/.test(localBranch)) {
    throw new Error('本地分支名不能包含空白或路径分隔符')
  }
  const auth = normalizeAuth(input.auth)
  await writeStored(root, {
    url,
    auth,
    username: text(input.username).trim(),
    localBranch,
    remoteBranch: text(input.remoteBranch).trim()
  })

  if (auth === 'ssh') {
    await clearSecrets(root, 'token')
    await clearSecrets(root, 'password')
    return
  }
  if (input.secret !== undefined) {
    await setSecret(projectGitSecretKey(root, auth), input.secret || null)
    // 换认证方式时清掉另一种槽位,避免旧密钥被误认为仍然有效
    await clearSecrets(root, auth === 'password' ? 'token' : 'password')
  }
}

async function clearSecrets(root: string, auth: PluginAuthMode): Promise<void> {
  try {
    await setSecret(projectGitSecretKey(root, auth), null)
  } catch {
    /* 清不掉也不影响配置本身 */
  }
}

/**
 * 重命名 / 移动仓库目录后,把项目 Git 配置与密钥一起迁到新路径。
 *
 * 配置按绝对路径索引(settings.projectGit 的键、secrets 里按路径哈希的键)。
 * 目录改名后旧键永远读不到,表现就是「仓库改名后 Git 设置消失」。被改名
 * 目录**下面**的项目(前缀匹配)一起搬;只改大小写时键不变,直接返回。
 */
export async function moveProjectGit(from: string, to: string): Promise<void> {
  const fromKey = projectGitKey(from)
  const toKey = projectGitKey(to)
  if (fromKey === toKey) return
  const prefix = fromKey.endsWith(sep) ? fromKey : `${fromKey}${sep}`
  await queueWrite(async () => {
    const settings = await loadSettings()
    const all = { ...(settings.projectGit ?? {}) }
    const moves: Array<{ oldKey: string; newKey: string }> = []
    for (const key of Object.keys(all)) {
      if (key !== fromKey && !key.startsWith(prefix)) continue
      moves.push({ oldKey: key, newKey: toKey + key.slice(fromKey.length) })
    }
    if (moves.length === 0) return
    for (const { oldKey, newKey } of moves) {
      all[newKey] = all[oldKey]
      delete all[oldKey]
    }
    await saveSettings({ projectGit: all })
    /*
     * 密钥键是路径的哈希,不跟着搬的话:配置还在、地址也对,但令牌读不到
     * (设置页显示「无令牌」,同步直接鉴权失败)。
     */
    for (const { oldKey, newKey } of moves) {
      for (const auth of ['token', 'password'] as const) {
        const secret = await getSecret(projectGitSecretKey(oldKey, auth))
        if (!secret) continue
        await setSecret(projectGitSecretKey(newKey, auth), secret)
        await setSecret(projectGitSecretKey(oldKey, auth), null)
      }
    }
  })
}
