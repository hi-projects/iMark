/**
 * 已安装插件的磁盘布局与登记表。
 *
 * userData/plugins/
 *   installed.json     登记表(只存**来源**信息,启用态与配置仍在 settings.plugins)
 *   .staging/          解包暂存区(安装/升级时先解到这里,再整体 rename 就位)
 *   <id>/              插件目录 —— **磁盘是权威**
 *     manifest.json
 *     main.js
 *     ...
 *   <id>.old/          升级/回滚期间的旧版本暂存(成功后删除)
 *
 * 「磁盘是权威」的含义:一个目录只要有合法的 manifest.json 就算已安装,
 * 哪怕 installed.json 里没有记录(比如用户手动拷进去的),也会以 source:'local' 合成一条记录。
 * 反过来,记录存在但目录没了,就以目录为准把记录清掉。
 */

import { app } from 'electron'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  validateManifest,
  type PluginKind,
  type PluginManifest,
  type PluginPermission
} from '@shared/pluginPackage'
import type { PluginSource } from '@shared/plugins'
import { writeFileAtomic } from '../files'

/** 登记表里的一条记录(与 PluginInstallInfo 同构,多存了 id 与授权快照) */
export interface InstalledRecord {
  id: string
  version: string
  kind: PluginKind
  /** 整包 integrity */
  integrity: string
  /** 入口文件的 sha256(script 插件才有),便于比对「跑的是不是这一份代码」 */
  mainSha256: string | null
  publisher: string | null
  source: PluginSource
  /** 从哪个市场装的(便于升级时知道去哪儿问新版本) */
  registryUrl: string | null
  installedAt: number
  grantedPermissions: PluginPermission[]
}

interface InstalledFile {
  version: 1
  plugins: Record<string, InstalledRecord>
}

export function pluginsRoot(): string {
  return join(app.getPath('userData'), 'plugins')
}

export function pluginDir(id: string): string {
  return join(pluginsRoot(), id)
}

export function stagingRoot(): string {
  return join(pluginsRoot(), '.staging')
}

export function oldDir(id: string): string {
  return join(pluginsRoot(), `${id}.old`)
}

function installedPath(): string {
  return join(pluginsRoot(), 'installed.json')
}

let cache: InstalledFile | null = null

export async function loadInstalled(): Promise<InstalledFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(installedPath(), 'utf8')) as Partial<InstalledFile>
    const plugins =
      parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins)
        ? (parsed.plugins as Record<string, InstalledRecord>)
        : {}
    cache = { version: 1, plugins }
  } catch {
    // 文件不存在或已损坏:按空登记表处理(目录仍然是权威,会以 local 合成记录)
    cache = { version: 1, plugins: {} }
  }
  return cache
}

async function persist(file: InstalledFile): Promise<void> {
  cache = file
  await mkdir(pluginsRoot(), { recursive: true })
  await writeFileAtomic(installedPath(), JSON.stringify(file, null, 2))
}

export async function getRecord(id: string): Promise<InstalledRecord | null> {
  const file = await loadInstalled()
  return file.plugins[id] ?? null
}

export async function setRecord(record: InstalledRecord): Promise<void> {
  const file = await loadInstalled()
  await persist({ version: 1, plugins: { ...file.plugins, [record.id]: record } })
}

export async function removeRecord(id: string): Promise<void> {
  const file = await loadInstalled()
  const plugins = { ...file.plugins }
  delete plugins[id]
  await persist({ version: 1, plugins })
}

/** 磁盘上实际存在的插件 id(排除暂存区与 .old 残留) */
export async function listInstalledIds(): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await readdir(pluginsRoot())
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (name.endsWith('.old')) continue
    try {
      const s = await stat(join(pluginsRoot(), name))
      if (s.isDirectory()) out.push(name)
    } catch {
      /* 读不到就跳过 */
    }
  }
  return out
}

/** 读插件目录里的 manifest.json 并校验;不合法就返回 null(等于没装) */
export async function readPluginManifest(id: string): Promise<PluginManifest | null> {
  try {
    const raw = JSON.parse(await readFile(join(pluginDir(id), 'manifest.json'), 'utf8'))
    const result = validateManifest(raw)
    return result.ok && result.value ? result.value : null
  } catch {
    return null
  }
}

/**
 * 清理 `.old` 残留。升级成功、或上次升级中途崩溃后,残留目录没有保留价值;
 * 但**不碰**任何正常插件目录。
 */
export async function cleanupOldDirs(): Promise<void> {
  let entries: string[] = []
  try {
    entries = await readdir(pluginsRoot())
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.old')) continue
    await rm(join(pluginsRoot(), name), { recursive: true, force: true }).catch(() => {})
  }
}

/** 删除一个插件目录(缺省容忍失败) */
export async function removePluginDir(id: string): Promise<void> {
  await rm(pluginDir(id), { recursive: true, force: true })
}

/**
 * 把相对路径拼到基目录下,并确认结果没跑出去。
 * 这是**兜底**防线:包里的每个路径在 validateEnvelope 里已经过 isSafeRelPath,
 * 但解包这一步是真正碰文件系统的地方,值得再过一次 —— 双保险的成本只有一行。
 */
export function safeJoin(base: string, relPath: string): string {
  const root = resolve(base)
  const full = resolve(root, relPath)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`非法路径:${relPath}`)
  }
  return full
}

/** 把「插件自己声明出来的路径」限制在它的安装目录内 */
export function resolveInside(id: string, relPath: string): string {
  return safeJoin(pluginDir(id), relPath)
}

/** 为一次安装开一个独有的暂存目录(带随机后缀,并发安装同一插件也不会互相踩) */
export function newStagingDir(id: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return join(stagingRoot(), `${id}.${stamp}`)
}

/** 清掉整个暂存区(安装失败时用;不碰任何正式插件目录) */
export async function cleanupStaging(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** 就位:把暂存目录 rename 成正式目录(同盘 rename 是原子的) */
export async function activateStaged(id: string, stagedDir: string): Promise<void> {
  await mkdir(pluginsRoot(), { recursive: true })
  await rm(pluginDir(id), { recursive: true, force: true })
  await rename(stagedDir, pluginDir(id))
}
