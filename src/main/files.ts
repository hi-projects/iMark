import { randomBytes } from 'node:crypto'
import {
  mkdir,
  readFile as fsRead,
  readdir,
  rename,
  stat,
  unlink,
  writeFile as fsWrite
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { shell } from 'electron'
import { isManagedImageName } from '@shared/imageAssets'
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

/**
 * 原子写:先写临时文件再 rename,失败时清理临时文件(二进制内容直接传 Uint8Array)。
 *
 * 临时名带 PID + 随机后缀:多个实例会同时写同一份 settings.json / installed.json,
 * 共用一个固定名的话,一个实例的 rename 可能搬走另一个实例刚写的中间文件。
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.imark-tmp`
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

/** 查找引用时视为「笔记」的扩展名(与仓库文件树一致) */
const NOTE_EXTS = new Set(['md', 'markdown', 'mdown', 'txt'])

/**
 * 回收正文里已经不再引用的粘贴图片(移到系统回收站)。
 *
 * 只在文档**成功写盘之后**调用:草稿阶段用户可能撤销刚才的删除,也可能直接关掉
 * 不保存 —— 那时图片都该留着。落盘之后正文里的引用才算数。
 *
 * 两道保险:
 * 1. 只认 `saveImageAsset` 生成的文件名(见 shared/imageAssets),`assets/` 里
 *    用户自己放的文件不碰;
 * 2. 同目录的笔记共用 `assets/` 是常见做法,保存后扫一遍同目录的笔记:只要还有
 *    一份提到这个文件名就保留。(子目录里用 `../assets/…` 引用的情形扫不到 ——
 *    宁可少删,不可错删。)
 *
 * 文件不存在(重复保存、用户手动删过)不算失败;回收单个文件失败也不抛出,
 * 不能因为清理资产而让一次已经成功的保存变成失败。
 */
export async function trashUnreferencedImageAssets(
  docPath: string,
  names: string[]
): Promise<void> {
  if (typeof docPath !== 'string' || !docPath || !isAbsolute(docPath)) {
    throw new Error('文档路径无效')
  }
  if (!Array.isArray(names)) return

  // 只接受裸文件名:带目录的分段一律忽略,防止渲染层传进 `../../x` 之类的路径
  const candidates = [...new Set(names)].filter(
    name => typeof name === 'string' && !/[/\\]/.test(name) && isManagedImageName(name)
  )
  if (!candidates.length) return

  const docDir = dirname(docPath)
  const assetsDir = join(docDir, 'assets')

  let notes: string[]
  try {
    notes = (await readdir(docDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && NOTE_EXTS.has(extname(entry.name).slice(1).toLowerCase()))
      .map(entry => join(docDir, entry.name))
  } catch {
    // 目录都读不了,就别在这里冒险删东西
    return
  }

  // 当前文档也在扫描范围里:刚写进去的正文如果还有别处提到这个文件名
  // (引用式图片、HTML <img> 等),同样保留
  const stillReferenced = new Set<string>()
  for (const note of notes) {
    if (stillReferenced.size === candidates.length) break
    let text = ''
    try {
      text = await fsRead(note, 'utf8')
    } catch {
      continue
    }
    for (const name of candidates) {
      if (!stillReferenced.has(name) && text.includes(name)) stillReferenced.add(name)
    }
  }

  for (const name of candidates) {
    if (stillReferenced.has(name)) continue
    try {
      await shell.trashItem(join(assetsDir, name))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[iMark] 回收图片资产失败', name, err)
      }
    }
  }
}
