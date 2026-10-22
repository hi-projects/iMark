/**
 * Agent 产物目录 `prepared/` 的只读访问。
 *
 * 插件不解析附件；这里只读取 Agent 自己写出的文件，用于预览/应用。所有路径必须
 * 落在本会话 prepared/ 内，symlink 与路径穿越都拒绝。
 */

import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtifactInfo } from './types'
import type { ArtifactPreview } from './protocol'
import { MAX_PREVIEW_IMAGE, MAX_PREVIEW_TEXT } from './protocol'

const MAX_SCAN_FILES = 200
const MAX_SCAN_DEPTH = 3
const MAX_APPLY_BYTES = 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp'
}

const TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.log',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.tex',
  '.bib',
  '.sql'
])

export function artifactKind(name: string): ArtifactInfo['kind'] {
  const ext = extname(name).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (IMAGE_MIME[ext]) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'other'
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export class ArtifactStore {
  constructor(private readonly preparedDirOf: (sessionId: string) => string) {}

  async scan(sessionId: string): Promise<ArtifactInfo[]> {
    const root = this.preparedDirOf(sessionId)
    const out: ArtifactInfo[] = []
    await this.walk(root, root, 0, out)
    out.sort((a, b) => a.path.localeCompare(b.path))
    return out
  }

  async preview(sessionId: string, relativePath: string): Promise<ArtifactPreview> {
    const full = await this.resolveSafe(sessionId, relativePath)
    const info = await lstat(full)
    const kind = artifactKind(full)
    if (kind === 'markdown' || kind === 'text') {
      const truncated = info.size > MAX_PREVIEW_TEXT
      const buffer = await readFile(full)
      const text = buffer.subarray(0, MAX_PREVIEW_TEXT).toString('utf8')
      return { kind, text, truncated }
    }
    if (kind === 'image') {
      if (info.size > MAX_PREVIEW_IMAGE) throw new Error('图片超过预览上限（8 MB）')
      const buffer = await readFile(full)
      const ext = extname(full).toLowerCase()
      return {
        kind,
        dataBase64: buffer.toString('base64'),
        mime: IMAGE_MIME[ext] ?? 'application/octet-stream'
      }
    }
    return { kind: 'other' }
  }

  async readText(sessionId: string, relativePath: string): Promise<string> {
    const full = await this.resolveSafe(sessionId, relativePath)
    const info = await lstat(full)
    if (info.size > MAX_APPLY_BYTES) throw new Error('产物超过应用上限（1 MB）')
    const kind = artifactKind(full)
    if (kind === 'image' || kind === 'other') throw new Error('只有 Markdown/文本产物能写入文档')
    return (await readFile(full)).toString('utf8')
  }

  private async walk(
    root: string,
    dir: string,
    depth: number,
    out: ArtifactInfo[]
  ): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await this.walk(root, full, depth + 1, out)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      const rel = relative(root, full).split(sep).join('/')
      out.push({
        path: rel,
        name: entry.name,
        size: info.size,
        kind: artifactKind(entry.name)
      })
    }
  }

  private async resolveSafe(sessionId: string, relativePath: string): Promise<string> {
    if (typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('产物路径为空')
    if (relativePath.includes('\u0000') || isAbsolute(relativePath)) throw new Error('产物路径无效')
    const root = resolve(this.preparedDirOf(sessionId))
    const candidate = resolve(root, relativePath.replace(/\\/g, '/'))
    if (!inside(root, candidate)) throw new Error('产物路径越界')
    const direct = await lstat(candidate)
    if (direct.isSymbolicLink()) throw new Error('产物不能是符号链接')
    const real = await realpath(candidate)
    if (!inside(await realpath(root), real)) throw new Error('产物路径越界')
    const info = await lstat(real)
    if (!info.isFile()) throw new Error('产物不是文件')
    return real
  }
}
