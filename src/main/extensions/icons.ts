/**
 * 读取已安装扩展包内的图标。
 *
 * 图标路径来自清单(`icon`),与 `main` 一样是包内相对路径。文件读到之后走与
 * 市场图标相同的体积/格式校验,再转成 data URL 交给渲染层 —— 渲染层拿不到
 * 扩展目录,也不应该拿到。
 */

import { readFile } from 'node:fs/promises'
import { iconFileOf } from '@shared/extensionPackage'
import { iconDataUrl } from '../iconData'
import { readManifestAt } from './installedStore'
import { extensionDir, isValidExtensionId, safeJoin } from './paths'

const TYPE_BY_EXT: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png'
}

export async function extensionIconDataUrl(id: unknown): Promise<string | null> {
  if (!isValidExtensionId(id)) return null
  const dir = extensionDir(id)
  const manifest = await readManifestAt(dir)
  if (!manifest) return null

  const name = iconFileOf(manifest)
  if (!name) return null
  const type = TYPE_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()]
  if (!type) return null

  try {
    return iconDataUrl(await readFile(safeJoin(dir, name)), type)
  } catch {
    return null
  }
}
