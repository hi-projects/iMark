/**
 * 一次性清理 v1 插件数据。
 *
 * 这次改造是硬切：v1 的 `manifest.json` 包、`window.imark`、restricted/render 层
 * 全部删除，旧配置/密钥/安装记录**不做转换**。没有迁移器，也没有旧 ID 映射；
 * 用户升级后三款官方扩展按全新安装处理。
 *
 * 清理只在 `settings.legacyDataCleared < 2` 时执行一次，写完标记后不再扫描。
 * 这里失败只记日志并继续启动 —— 旧数据删不掉不该拦着编辑器打开。
 */

import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot } from '../dataDir'
import { deleteSecretKeys, listSecretKeys } from '../secrets'
import { loadSettings, saveSettings } from '../settings'
import { extensionDataRoot, extensionsRoot, isValidExtensionId } from './paths'

/** 清理逻辑的版本号；写进 settings.legacyDataCleared，避免每次启动重复扫描 */
export const LEGACY_CLEARED_VERSION = 2

/** v1 的日志目录；v2 用 `logs/extensions/` */
function legacyLogsRoot(): string {
  return join(dataRoot(), 'logs', 'plugins')
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** `installed.json` 是不是 v1 形状（`{version:1, plugins}`） */
async function hasLegacyInstalledFile(): Promise<boolean> {
  const path = join(extensionsRoot(), 'installed.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  const file = parsed as Record<string, unknown>
  if (file.version === 2) return false
  return Array.isArray(file.plugins) || Boolean(file.plugins && typeof file.plugins === 'object')
}

/**
 * 删掉 v1 的插件目录。
 *
 * - `installed.json` 是 v1 形状 → 整个 `plugins/` 删除。里面不可能有 v2 数据
 *   （v1 与 v2 的安装目录同名不同格式，混装没有意义）；
 * - 没有登记表但目录里有 `manifest.json`（旧包）/ 没有 `package.json` 的残留，
 *   逐个删除。用户手动拷进来的 v2 目录有 `package.json`，不受影响。
 */
async function removeLegacyPluginTree(): Promise<void> {
  const root = extensionsRoot()
  if (await hasLegacyInstalledFile()) {
    await rm(root, { recursive: true, force: true })
    return
  }
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    const legacyManifest = await exists(join(dir, 'manifest.json'))
    const v2Manifest = await exists(join(dir, 'package.json'))
    if (legacyManifest && !v2Manifest) await rm(dir, { recursive: true, force: true })
  }
}

/** v1 的扩展状态目录用裸插件名（无 publisher 前缀）；v2 的 ID 一定带一个点 */
async function removeLegacyExtensionData(): Promise<void> {
  let names: string[]
  try {
    names = await readdir(extensionDataRoot())
  } catch {
    return
  }
  for (const name of names) {
    if (isValidExtensionId(name)) continue
    await rm(join(extensionDataRoot(), name), { recursive: true, force: true })
  }
}

/**
 * v1 密钥的 key 形如 `<pluginId>:<field>…`，pluginId 不含点；v2 一定有 publisher.name。
 *
 * `@` 开头的是主进程自己的命名空间（`@market:` / `@market-user:`，见 market/config.ts），
 * 不属于插件，必须原样保留 —— 否则升级会顺手把市场登录态删掉。
 */
async function removeLegacySecrets(): Promise<void> {
  const keys = await listSecretKeys()
  const legacy = keys.filter(key => {
    const sep = key.indexOf(':')
    if (sep <= 0) return true
    const prefix = key.slice(0, sep)
    if (prefix.startsWith('@')) return false
    return !isValidExtensionId(prefix)
  })
  if (legacy.length > 0) await deleteSecretKeys(legacy)
}

/**
 * 执行一次性清理。返回是否真的动了磁盘（供日志与验收使用）。
 */
export async function cleanupLegacyExtensionData(): Promise<boolean> {
  const settings = await loadSettings()
  if (settings.legacyDataCleared >= LEGACY_CLEARED_VERSION) return false
  try {
    await removeLegacyPluginTree()
    await removeLegacyExtensionData()
    await removeLegacySecrets()
    await rm(legacyLogsRoot(), { recursive: true, force: true })
    // 旧配置/状态都挂在 settings.plugins 下；直接清空，不尝试读取或转换
    await saveSettings({ plugins: {}, legacyDataCleared: LEGACY_CLEARED_VERSION })
  } catch (err) {
    console.error('[iMark] 清理旧插件数据失败（继续启动）:', err)
  }
  return true
}
