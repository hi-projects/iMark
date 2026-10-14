import { readFile as fsRead, rename, unlink, writeFile as fsWrite } from 'node:fs/promises'
import type { ReadResult } from '@shared/types'

/** 读文件:剥 BOM、探测行尾、统一为 LF 返回 */
export async function readFileContent(path: string): Promise<ReadResult> {
  let raw = await fsRead(path, 'utf8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  const crlfCount = (raw.match(/\r\n/g) ?? []).length
  const lfCount = (raw.match(/(?<!\r)\n/g) ?? []).length
  const eol: 'LF' | 'CRLF' = crlfCount > lfCount ? 'CRLF' : 'LF'
  return { content: raw.replace(/\r\n/g, '\n'), eol }
}

/** 原子写:先写临时文件再 rename,失败时清理临时文件 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.imark-tmp`
  try {
    await fsWrite(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    try {
      await unlink(tmp)
    } catch {
      /* 清理失败可忽略 */
    }
    throw err
  }
}
