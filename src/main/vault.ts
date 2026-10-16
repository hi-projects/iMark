import * as fs from 'node:fs'
import * as path from 'node:path'
import { shell } from 'electron'
import type { VaultNode } from '@shared/types'

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.obsidian', '.vscode'])
const FILE_EXTS = new Set(['md', 'markdown', 'mdown', 'txt'])

/** 递归列出仓库文件树:只含 md 家族文件与文件夹,跳过隐藏/构建目录与符号链接 */
export async function listVault(root: string): Promise<VaultNode> {
  async function walk(dir: string, name: string): Promise<VaultNode> {
    const node: VaultNode = { name, path: dir, type: 'dir', children: [] }
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      /* 目录不可读时按空处理 */
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        node.children!.push(await walk(full, entry.name))
      } else if (entry.isFile() && FILE_EXTS.has(path.extname(entry.name).slice(1).toLowerCase())) {
        node.children!.push({ name: entry.name, path: full, type: 'file' })
      }
    }
    node.children!.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        : a.type === 'dir'
          ? -1
          : 1
    )
    return node
  }
  return walk(root, path.basename(root) || root)
}

/** 新建空文件(wx:已存在时失败) */
export async function createVaultFile(p: string, content = ''): Promise<void> {
  await fs.promises.writeFile(p, content, { flag: 'wx', encoding: 'utf8' })
}

export async function createVaultDir(p: string): Promise<void> {
  await fs.promises.mkdir(p)
}

/**
 * 大小写不敏感的文件系统(Windows、默认配置的 macOS)。
 * 这些系统上 access('NOTE.md') 对 note.md 也成立,所以「只改大小写」的重命名
 * 会被下面的存在性检查误判成"目标已存在"而拒绝 —— 得放行。
 * Linux 上不能这么做:note.md 与 NOTE.md 是两个文件,放行就等于静默覆盖。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** 重命名/移动;目标已存在时拒绝,避免静默覆盖 */
export async function renameVaultPath(from: string, to: string): Promise<void> {
  try {
    await fs.promises.access(to)
    const sameFile =
      CASE_INSENSITIVE_FS && path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()
    if (!sameFile) throw new Error(`目标已存在:${path.basename(to)}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await fs.promises.rename(from, to)
}

/** 删除(移到系统回收站,与 Obsidian 行为一致) */
export async function trashVaultPath(p: string): Promise<void> {
  await shell.trashItem(p)
}
