/**
 * 已安装扩展的登记表（`plugins/installed.json`）。
 *
 * 两条原则：
 * - **磁盘是权威**：目录里有合法的 `package.json` 就算已安装。用户手动拷进来的
 *   目录会以 `source: 'local'` 出现在列表里，而不是“登记表里没有所以看不见”。
 * - **登记表只存来源**：版本、integrity、安装时间、市场地址。启用态与配置在
 *   `settings.extensions`；密钥在 secrets.json；状态在 extensions-data。
 *
 * 登记表版本号不匹配时按空表处理；目录扫描会把磁盘上仍然有效的扩展重新登记。
 */

import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  entryFileOf,
  extensionIdOf,
  stableStringify,
  validateManifest,
  type ExtensionManifest
} from '@shared/extensionPackage'
import type { ExtensionRecord } from '@shared/extensions'
import { writeFileAtomic } from '../files'
import {
  extensionDir,
  extensionsRoot,
  installedPath,
  isValidExtensionId,
  newStagingDir,
  safeJoin,
  sha256
} from './paths'

interface InstalledFile {
  version: 1
  extensions: Record<string, ExtensionRecord>
}

let cache: InstalledFile | null = null

function empty(): InstalledFile {
  return { version: 1, extensions: {} }
}

export async function loadInstalled(): Promise<InstalledFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(installedPath(), 'utf8')) as Partial<InstalledFile>
    const raw =
      parsed.version === 1 &&
      parsed.extensions &&
      typeof parsed.extensions === 'object' &&
      !Array.isArray(parsed.extensions)
        ? (parsed.extensions as Record<string, ExtensionRecord>)
        : {}
    const extensions: Record<string, ExtensionRecord> = {}
    for (const [id, record] of Object.entries(raw)) {
      if (!isValidExtensionId(id) || !record || typeof record !== 'object') continue
      extensions[id] = record
    }
    cache = { version: 1, extensions }
  } catch {
    cache = empty()
  }
  return cache
}

async function persist(file: InstalledFile): Promise<void> {
  cache = file
  await mkdir(extensionsRoot(), { recursive: true })
  await writeFileAtomic(installedPath(), JSON.stringify(file, null, 2))
}

export async function getRecord(id: string): Promise<ExtensionRecord | null> {
  return (await loadInstalled()).extensions[id] ?? null
}

export async function setRecord(record: ExtensionRecord): Promise<void> {
  const file = await loadInstalled()
  await persist({ version: 1, extensions: { ...file.extensions, [record.id]: record } })
}

export async function removeRecord(id: string): Promise<void> {
  const file = await loadInstalled()
  if (!file.extensions[id]) return
  const extensions = { ...file.extensions }
  delete extensions[id]
  await persist({ version: 1, extensions })
}

/** 只给测试/清理用：让下一次读取重新解析磁盘 */
export function invalidateInstalledCache(): void {
  cache = null
}

/** 读磁盘上的 `package.json` 并校验；不合法返回 null（等同于没装） */
export async function readManifestAt(dir: string): Promise<ExtensionManifest | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const result = validateManifest(raw)
    return result.ok && result.value ? result.value : null
  } catch {
    return null
  }
}

async function mainShaOf(dir: string, manifest: ExtensionManifest): Promise<string | null> {
  const entry = entryFileOf(manifest)
  if (!entry) return null
  try {
    return sha256(await readFile(safeJoin(dir, entry)))
  } catch {
    return null
  }
}

/**
 * 扫描磁盘，合并登记表。
 *
 * 返回的 Map 已经过一致性处理：目录消失的记录被清掉；目录存在但登记表没记录
 * （或版本对不上）的，以 `local` 合成一条。扫描结果会写回登记表 —— 这样
 * “用户手放的扩展”卸载时也能走同一条删除路径。
 */
export async function scanInstalled(): Promise<Map<string, ExtensionManifest>> {
  const manifests = new Map<string, ExtensionManifest>()
  let names: string[] = []
  try {
    names = await readdir(extensionsRoot())
  } catch {
    // 数据根还没建：空扩展目录
    cache = empty()
    return manifests
  }

  const file = await loadInstalled()
  const next: Record<string, ExtensionRecord> = {}
  let changed = false

  for (const name of names) {
    if (!isValidExtensionId(name)) continue
    const dir = join(extensionsRoot(), name)
    try {
      const info = await lstat(dir)
      // 符号链接拒绝：扩展目录由安装器整目录替换，跟随链接会把内容写到用户没预期的地方
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    const manifest = await readManifestAt(dir)
    if (!manifest) continue
    if (extensionIdOf(manifest) !== name) {
      console.warn(`[iMark] 扩展目录 ${name} 的清单 ID 不匹配（${extensionIdOf(manifest)}），已跳过`)
      continue
    }
    manifests.set(name, manifest)

    const existing = file.extensions[name]
    if (existing && existing.version === manifest.version && existing.publisher === manifest.publisher) {
      next[name] = existing
      continue
    }

    changed = true
    const installedAt = await stat(dir).then(
      s => Math.round(s.mtimeMs),
      () => Date.now()
    )
    next[name] = {
      id: name,
      publisher: manifest.publisher,
      name: manifest.name,
      version: manifest.version,
      main: entryFileOf(manifest),
      activationEvents: manifest.activationEvents ?? [],
      capabilities: manifest.capabilities ?? {},
      // 手放目录没有信封 integrity；用清单的哈希当标识，至少能发现“目录被换过”
      integrity: sha256(stableStringify(manifest)),
      mainSha256: await mainShaOf(dir, manifest),
      installedAt,
      source: existing?.source === 'bundled' || existing?.source === 'market' ? existing.source : 'local',
      registryUrl: existing?.registryUrl ?? null
    }
  }

  for (const id of Object.keys(file.extensions)) {
    if (!manifests.has(id)) changed = true
  }

  if (changed) {
    await persist({ version: 1, extensions: next })
  } else {
    cache = { version: 1, extensions: next }
  }
  return manifests
}

export async function removeExtensionDir(id: string): Promise<void> {
  if (!isValidExtensionId(id)) return
  await rm(extensionDir(id), { recursive: true, force: true })
}

/** 清掉升级/安装中断留下的 `.old-*` 目录；不碰任何正常扩展目录 */
export async function cleanupOldDirs(): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(extensionsRoot())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.includes('.old-')) continue
    await rm(join(extensionsRoot(), name), { recursive: true, force: true }).catch(() => {})
  }
}

/** 为一次安装开一个独有的暂存目录 */
export function stagingDirFor(id: string): string {
  return newStagingDir(id)
}

/**
 * 就位：把暂存目录 rename 成正式目录（同盘 rename 是原子的）。
 * 旧目录先改名保留，失败时能回滚。
 */
export async function activateStaged(id: string, stagedDir: string): Promise<void> {
  await mkdir(extensionsRoot(), { recursive: true })
  const dir = extensionDir(id)
  const old = `${dir}.old-${Date.now().toString(36)}`
  let movedOld = false
  try {
    await rename(dir, old)
    movedOld = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    await rename(stagedDir, dir)
  } catch (err) {
    if (movedOld) await rename(old, dir).catch(() => {})
    throw err
  }
  if (movedOld) await rm(old, { recursive: true, force: true }).catch(() => {})
}

/** 删除安装中断留下的暂存目录 */
export async function cleanupStaging(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
