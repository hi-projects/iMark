/**
 * 命令探测：只回答“本机有没有这个命令”，绝不执行它去解析附件。
 *
 * 结果作为提示交给 Agent，让它决定用 Read、Bash、Python 还是别的工具；
 * 失败/缺失也写进提示，避免 Agent 盲目尝试。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface ToolInventory {
  available: string[]
  missing: string[]
  checkedAt: number
}

const CANDIDATES = [
  'pdftotext',
  'pdfinfo',
  'pdfimages',
  'pdftoppm',
  'mutool',
  'tesseract',
  'python',
  'python3',
  'node',
  'mineru',
  'marker_single',
  'docling',
  'pandoc',
  'libreoffice',
  'soffice',
  'gs',
  'magick',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'mkdir',
  'cp',
  'mv',
  'echo',
  'grep',
  'sed',
  'file',
  'where',
  'which'
] as const

const CACHE_MS = 10 * 60 * 1000

function runWhere(name: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'where' : 'which'
  return new Promise(resolve => {
    execFile(
      command,
      [name],
      { timeout: 2000, windowsHide: true, maxBuffer: 64 * 1024 },
      err => resolve(!err)
    )
  })
}

function scanPath(name: string): boolean {
  const path = process.env.PATH ?? ''
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const dir of path.split(process.platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      if (existsSync(join(dir, `${name}${ext}`))) return true
    }
  }
  return false
}

export class Inventory {
  private cached: ToolInventory | null = null

  async detect(force = false): Promise<ToolInventory> {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < CACHE_MS) {
      return this.cached
    }
    const results = await Promise.all(
      CANDIDATES.map(async name => {
        const found = (await runWhere(name)) || scanPath(name)
        return { name, found }
      })
    )
    const inventory: ToolInventory = {
      available: results.filter(item => item.found).map(item => item.name),
      missing: results.filter(item => !item.found).map(item => item.name),
      checkedAt: Date.now()
    }
    this.cached = inventory
    return inventory
  }

  promptLine(inventory: ToolInventory): string {
    const available = inventory.available.length > 0 ? inventory.available.join(', ') : '（无）'
    const missing = inventory.missing.length > 0 ? inventory.missing.join(', ') : '（无）'
    return `可用命令：${available}\n未找到命令：${missing}`
  }
}
