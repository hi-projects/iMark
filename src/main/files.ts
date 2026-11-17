import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile as fsRead,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile as fsWrite
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { shell } from 'electron'
import { isManagedImageName } from '@shared/imageAssets'
import type { ReadResult, VaultNode } from '@shared/types'
import { dataRoot } from './dataDir'
import { listVault } from './vault'

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
 * 从剪贴板带来的文件名里取 —— 否则一个改了扩展名的文件就能让 `.assets/` 里出现
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
 * 图片资产的落点。
 *
 * 仓库内的文档统一用仓库根的 `.assets/`,一个仓库只有一份图片目录;文档不在当前
 * 仓库里(单独打开的外部文件)时才退回它自己目录下的 `.assets/`,行为与仓库内一致。
 *
 * 隐藏目录不会被文件树列出,但 Git 同步按文件系统走,`.assets/` 里的文件照常提交。
 */
function assetsDirFor(
  docPath: string,
  vaultPath: string | null
): { dir: string; vaultRoot: string | null } {
  if (typeof vaultPath === 'string' && vaultPath && isAbsolute(vaultPath)) {
    const rel = relative(vaultPath, docPath)
    const escape = rel === '..' || /^\.\.[\\/]/.test(rel) || isAbsolute(rel)
    if (rel && !escape) return { dir: join(vaultPath, '.assets'), vaultRoot: vaultPath }
  }
  return { dir: join(dirname(docPath), '.assets'), vaultRoot: null }
}

/** 图片引用按文档位置写成相对路径;分隔符统一成 Markdown 用的 `/` */
function assetLink(docPath: string, assetsDir: string, name: string): string {
  const rel = relative(dirname(docPath), assetsDir).split(/[\\/]/).filter(Boolean).join('/')
  return rel ? `${rel}/${name}` : name
}

/**
 * 图片回收区在应用数据目录里,按**图片目录**分桶。
 *
 * 不能直接用系统回收站:保存时删图、用户随后 Ctrl+Z 撤回来,正文能恢复,但系统
 * 回收站里的文件没有反向 API 可以搬回来。放应用自己的回收区里,撤销时能原样恢复;
 * 本地找不回时,过期后再交给系统回收站。
 */
const IMAGE_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function imageTrashDir(assetsDir: string): string {
  const normalized = resolve(assetsDir)
  const key = createHash('sha256')
    .update(
      process.platform === 'win32' || process.platform === 'darwin'
        ? normalized.toLowerCase()
        : normalized
    )
    .digest('hex')
    .slice(0, 16)
  return join(dataRoot(), 'trash', 'images', key)
}

/** 跨盘时 rename 会报 EXDEV,退化成复制 + 删除 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(from, to)
    await unlink(from)
  }
}

/** 把图片从 `.assets/` 移进应用回收区;超过保留期的旧文件转交系统回收站 */
async function trashImageFile(assetsDir: string, name: string): Promise<void> {
  const trashDir = imageTrashDir(assetsDir)
  await mkdir(trashDir, { recursive: true })
  const target = join(trashDir, name)
  await moveFile(join(assetsDir, name), target)
  // 保留期从「进回收区」开始算,而不是图片的创建时间;恢复后再删也不会提前过期
  const now = new Date()
  await utimes(target, now, now).catch(() => {})
  void sweepImageTrash(trashDir)
}

async function sweepImageTrash(trashDir: string): Promise<void> {
  const cutoff = Date.now() - IMAGE_TRASH_RETENTION_MS
  let names: string[]
  try {
    names = await readdir(trashDir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(trashDir, name)
    try {
      const info = await stat(full)
      if (info.isFile() && info.mtimeMs < cutoff) await shell.trashItem(full)
    } catch {
      /* 单个文件清理失败不影响别的东西 */
    }
  }
}

/** 撤销恢复:文件还在回收区就搬回 `.assets/`;目标已存在时什么都不做 */
async function restoreImageFile(assetsDir: string, name: string): Promise<boolean> {
  const target = join(assetsDir, name)
  if (existsSync(target)) return false
  const source = join(imageTrashDir(assetsDir), name)
  if (!existsSync(source)) return false
  await mkdir(assetsDir, { recursive: true })
  await moveFile(source, target)
  return true
}

/**
 * 把一张剪贴板图片存进仓库根的 `.assets/`,返回相对文档目录的引用路径。
 *
 * 为什么用 docPath 而不是主进程的 currentDocPath():粘贴发生在哪份文档上,图片的
 * 相对引用就得按哪份文档算。渲染层的 `appStore.filePath` 是同步更新的(Save As
 * 立刻生效),而主进程那份镜像要等 watcher 过 IPC,切换文件的瞬间可能还是旧的。
 *
 * 文件名带随机后缀而不是只靠时间戳:同一秒里连续粘贴两张图是常见操作,不能撞名。
 */
export async function saveImageAsset(
  docPath: string,
  vaultPath: string | null,
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

  const { dir: assetsDir } = assetsDirFor(docPath, vaultPath)
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
  return assetLink(docPath, assetsDir, name)
}

/** 查找引用时视为「笔记」的扩展名(与仓库文件树一致) */
const NOTE_EXTS = new Set(['md', 'markdown', 'mdown', 'txt'])

/** 展平 `listVault()` 的树,只留下笔记文件 */
function collectVaultNotes(node: VaultNode, out: string[]): void {
  if (node.type === 'file') {
    out.push(node.path)
    return
  }
  for (const child of node.children ?? []) collectVaultNotes(child, out)
}

/**
 * 仓库内的图片是所有笔记共用的,所以要扫整个仓库才能判断「还有没有人引用」。
 *
 * 用 `listVault()` 复用文件树的遍历规则:隐藏目录(`.git`、`.assets` 等)、
 * 构建目录和非笔记文件都不进来。仓库读不出来时返回 null —— 宁可少删。
 */
async function vaultNotePaths(root: string): Promise<string[] | null> {
  try {
    const out: string[] = []
    collectVaultNotes(await listVault(root), out)
    return out
  } catch {
    return null
  }
}

/**
 * 回收正文里已经不再引用的粘贴图片(移到应用回收区,撤销可恢复)。
 *
 * 只在文档**成功写盘之后**调用:草稿阶段用户可能撤销刚才的删除,也可能直接关掉
 * 不保存 —— 那时图片都该留着。落盘之后正文里的引用才算数。
 *
 * 两道保险:
 * 1. 只认 `saveImageAsset` 生成的文件名(见 shared/imageAssets),`.assets/` 里
 *    用户自己放的文件不碰;
 * 2. 图片按仓库共用,所以扫仓库里的所有笔记:只要还有一份提到这个文件名就保留
 *    (可能来自别的目录,引用路径是 `../.assets/…`)。仓库外的文档退回扫同目录。
 *
 * 文件不存在(重复保存、用户手动删过)不算失败;回收单个文件失败也不抛出,
 * 不能因为清理资产而让一次已经成功的保存变成失败。
 */
export async function trashUnreferencedImageAssets(
  docPath: string,
  vaultPath: string | null,
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
  const { dir: assetsDir, vaultRoot } = assetsDirFor(docPath, vaultPath)
  let notes: string[]
  if (vaultRoot) {
    const scanned = await vaultNotePaths(vaultRoot)
    // 仓库都扫不了,就别在这里冒险删东西
    if (!scanned) return
    notes = scanned
  } else {
    try {
      notes = (await readdir(docDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && NOTE_EXTS.has(extname(entry.name).slice(1).toLowerCase()))
        .map(entry => join(docDir, entry.name))
    } catch {
      return
    }
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
      await trashImageFile(assetsDir, name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[iMark] 回收图片资产失败', name, err)
      }
    }
  }
}

/**
 * 撤销恢复图片:把应用回收区里的文件搬回 `.assets/`。
 *
 * 只在正文里重新出现受管图片引用时调用(撤销删除、手工把链接粘回来)。已经存在
 * 的目标文件不动,避免覆盖用户后来放进来的同名文件。
 */
export async function restoreImageAssets(
  docPath: string,
  vaultPath: string | null,
  names: string[]
): Promise<void> {
  if (typeof docPath !== 'string' || !docPath || !isAbsolute(docPath)) {
    throw new Error('文档路径无效')
  }
  if (!Array.isArray(names)) return

  const candidates = [...new Set(names)].filter(
    name => typeof name === 'string' && !/[/\\]/.test(name) && isManagedImageName(name)
  )
  if (!candidates.length) return

  const { dir: assetsDir } = assetsDirFor(docPath, vaultPath)
  for (const name of candidates) {
    try {
      await restoreImageFile(assetsDir, name)
    } catch (err) {
      console.error('[iMark] 恢复图片资产失败', name, err)
    }
  }
}
