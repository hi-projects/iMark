import { randomBytes } from 'node:crypto'
import { mkdir, readFile as fsRead, rename, stat, unlink, writeFile as fsWrite } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
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

/** 原子写:先写临时文件再 rename,失败时清理临时文件(二进制内容直接传 Uint8Array) */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
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

/**
 * 剪贴板图片允许落盘的格式。**只认这份表里的 MIME**:扩展名由这里决定,而不是
 * 从剪贴板带来的文件名里取 —— 否则一个改了扩展名的文件就能让 `assets/` 里出现
 * 任意后缀,而 `imark://` 协议是按扩展名决定 content-type 的。
 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/** 单张图片上限。32 MiB 装不下 4K 截图转成的 BMP,所以留到 64 MiB */
const IMAGE_MAX_BYTES = 64 * 1024 * 1024

function imageStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 把一张剪贴板图片存进 `dirname(docPath)/assets/`,返回相对文档目录的引用路径。
 *
 * 为什么用 docPath 而不是主进程的 currentDocPath():粘贴发生在哪份文档上,图片就该
 * 落在哪份文档旁。渲染层的 `appStore.filePath` 是同步更新的(Save As 立刻生效),
 * 而主进程那份镜像要等 watcher 过 IPC,切换文件的瞬间可能还是旧的。
 *
 * 文件名带随机后缀而不是只靠时间戳:同一秒里连续粘贴两张图是常见操作,不能撞名。
 */
export async function saveImageAsset(
  docPath: string,
  mime: string,
  data: Uint8Array
): Promise<string> {
  if (typeof docPath !== 'string' || !docPath || !isAbsolute(docPath)) {
    throw new Error('文档路径无效')
  }
  const ext = IMAGE_EXT[mime]
  if (!ext) throw new Error('剪贴板里不是受支持的图片格式')
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('图片内容为空')
  if (data.byteLength > IMAGE_MAX_BYTES) throw new Error('图片超过 64 MiB，无法粘贴')

  const assetsDir = join(dirname(docPath), 'assets')
  await mkdir(assetsDir, { recursive: true })

  // 随机后缀撞名的概率极低,但「极低」不是「不会」—— 真撞了就换一个再试。
  const base = `image-${imageStamp(new Date())}`
  let name = ''
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${randomBytes(4).toString('hex')}.${ext}`
    const taken = await stat(join(assetsDir, candidate)).then(
      () => true,
      () => false
    )
    if (!taken) {
      name = candidate
      break
    }
  }
  if (!name) throw new Error('无法为图片生成不冲突的文件名')

  await writeFileAtomic(join(assetsDir, name), data)
  // Markdown 里统一用 `/`;Windows 上 `joinPath(docDir, rel)` 会把它和反斜杠拼在一起,
  // Node 与浏览器都认,仓库换平台也不用改正文。
  return `assets/${name}`
}
