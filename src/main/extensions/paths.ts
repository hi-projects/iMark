/**
 * 扩展系统的磁盘布局。
 *
 * 与 v1 一样，“磁盘是权威”：`plugins/<id>/package.json` 存在且合法，扩展就算已安装。
 * 区别只是 v1 用 `manifest.json`，v2 用 `package.json`；旧目录由一次性清理删除。
 */

import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { dataRoot } from '../dataDir'

/** 与 extensionPackage 的 publisher/name 规则一致；目录名就是 `<publisher>.<name>` */
const ID_SEGMENT = /^[a-z0-9][a-z0-9-]{1,63}$/
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}\.[a-z0-9][a-z0-9-]{1,63}$/

export function isValidExtensionId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export function isValidPublisherSegment(value: string): boolean {
  return ID_SEGMENT.test(value)
}

export function extensionsRoot(): string {
  return join(dataRoot(), 'plugins')
}

export function extensionDir(id: string): string {
  if (!isValidExtensionId(id)) throw new Error(`非法扩展 ID：${id}`)
  return join(extensionsRoot(), id)
}

export function stagingRoot(): string {
  return join(extensionsRoot(), '.staging')
}

export function installedPath(): string {
  return join(extensionsRoot(), 'installed.json')
}

/** 扩展数据（globalState、storageUri）的根 */
export function extensionDataRoot(): string {
  return join(dataRoot(), 'extensions-data')
}

export function extensionStorageDir(id: string): string {
  if (!isValidExtensionId(id)) throw new Error(`非法扩展 ID：${id}`)
  return join(extensionDataRoot(), id)
}

/** 扩展自己的日志（宿主 stdout/stderr、output channel 之外的持久记录） */
export function extensionLogsRoot(): string {
  return join(dataRoot(), 'logs', 'extensions')
}

export function extensionLogPath(id: string): string {
  if (!isValidExtensionId(id)) throw new Error(`非法扩展 ID：${id}`)
  return join(extensionLogsRoot(), `${id}.log`)
}

/** 解包/安装的暂存目录：带随机后缀，同 ID 并发安装也不会互相踩 */
export function newStagingDir(id: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return join(stagingRoot(), `${id}.${stamp}`)
}

/**
 * 把包内相对路径拼到基目录下，并确认结果没跑出去。
 *
 * `validateEnvelope()` 已经把路径过了一遍 `isSafeRelPath`，但解包是真正碰文件系统的
 * 地方，值得再过一次 —— 双保险只有一行成本。
 */
export function safeJoin(base: string, relPath: string): string {
  const root = resolve(base)
  const full = resolve(root, relPath)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`非法路径：${relPath}`)
  }
  return full
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}
