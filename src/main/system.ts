/**
 * 系统集成:把 iMark 注册成 Markdown 文件的「打开方式」(设置 → 系统)。
 *
 * 两个平台的做法完全不同:
 *
 * **Windows**:Windows 8 起,`…\Explorer\FileExts\.md\UserChoice` 带哈希保护,
 * **应用不能静默把自己设成默认程序**(写进去会被系统判为无效而忽略)。所以这里的
 * 职责分成两半:
 *   1. 把 iMark 注册成一个**合法的候选**(ProgID + OpenWithProgids),让「打开方式」
 *      列表里出现它;
 *   2. 把用户送到系统「默认应用」设置页 —— 最后那一下必须由用户自己点。
 *      Windows 11 可以直接落到 iMark 自己的应用页,少掉「在列表里找到它」这一步;
 *      Windows 10 只能打开通用页。
 * 界面上的按钮文案也是照着这两半写的(见 SystemSettings.vue),不承诺做不到的事。
 *
 * **Linux**:走 freedesktop 的 MIME 关联,`mimeapps.list` 没有哈希保护,应用**可以**
 * 直接写成默认 —— 一条 `xdg-mime default <id> text/markdown` 就完了,GNOME/KDE/XFCE
 * 都认。前提是 iMark 的 .desktop 条目已经装进 XDG 数据目录并声明了
 * `MimeType=text/markdown;`(deb 安装即满足;AppImage 需要先做桌面集成)。
 * 例外是 Flatpak/Snap:沙箱里的 mimeapps.list 不是宿主机的,改不到,只能手动设置。
 *
 * 注册表只写 `HKCU\Software\Classes`(当前用户),不碰 HKLM、不需要管理员;
 * 也**不**改写 `.md` 的默认值 —— 那会悄悄改变用户的现状,候选归候选。
 */

import { app, nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { DefaultEditorStatus } from '@shared/types'
import { appIconPng } from './appIcon'
import { dataRoot } from './dataDir'

const run = promisify(execFile)

/** 我们注册的 ProgID。扩展名 → 这个 ProgID 的映射写进 OpenWithProgids */
export const PROG_ID = 'iMark.md'
/** 认作「Markdown 文档」的扩展名 */
export const MARKDOWN_EXTS = ['.md', '.markdown'] as const
/** 「默认应用」选择器里显示的应用名 */
export const APP_NAME = 'iMark'

const CLASSES = 'HKCU\\Software\\Classes'
const CAPABILITIES = 'HKCU\\Software\\iMark\\Capabilities'
const USER_CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice'
/** Win11 新版「默认应用」写这里:ProgId 是**子键**,子键里还有一个同名值 */
const USER_CHOICE_LATEST = `${USER_CHOICE}Latest`

/** 一条注册表写入(name 为 null 表示默认值) */
export interface RegWrite {
  key: string
  name: string | null
  data: string
}

/**
 * 注册要写的全部注册表项。
 *
 * 抽成纯函数是为了**能被验收逐条检查**(断言路径、引号、%1、应用名都在)而不必真的
 * 写注册表 —— 一个自动化用例不该悄悄改掉跑测试那台机器的文件关联。
 *
 * 四组东西(2026-10-17 在真机上踩过「选择器里只有 Electron」,才补齐后两组):
 *   1. **ProgID**:扩展名 → 打开命令;
 *   2. **OpenWithProgids**:让 iMark 出现在「打开方式」候选里(不动现有默认程序);
 *   3. **应用身份**(`Applications\<真实 exe 名>` + FriendlyAppName):选择器按
 *      **命令里的可执行文件**去找这一项,再用 FriendlyAppName 作显示名;没有它时
 *      退回 exe 的文件描述 —— 开发模式下就是「Electron」。
 *      键名必须与真实 exe 一致:写 `Applications\iMark.exe` 而命令指向 electron.exe
 *      是**认不出来**的(同样实测过)。
 *   4. **RegisteredApplications + Capabilities**(Windows 8+ 的「默认应用」注册):
 *      让 iMark 以「应用」而不是「一个能打开 .md 的 ProgID」出现。
 */
export function associationWrites(
  exePath: string,
  appPath: string,
  packaged: boolean,
  iconPath: string | null
): RegWrite[] {
  // 打包后双击文件时,Windows 用 "%1" 传路径;开发模式还要把应用目录带上
  const command = packaged ? `"${exePath}" "%1"` : `"${exePath}" "${appPath}" "%1"`
  // 图标:优先用生成好的 .ico;拿不到就退回 exe 自己的图标(开发模式是 Electron 的)
  const icon = iconPath ? `${iconPath},0` : `${exePath},0`
  const writes: RegWrite[] = [
    // 1) ProgID
    { key: `${CLASSES}\\${PROG_ID}`, name: null, data: 'iMark 文档' },
    { key: `${CLASSES}\\${PROG_ID}\\DefaultIcon`, name: null, data: icon },
    { key: `${CLASSES}\\${PROG_ID}\\shell\\open\\command`, name: null, data: command }
  ]
  for (const ext of MARKDOWN_EXTS) {
    // 2) 只加进「打开方式」候选:不动现有默认程序
    writes.push({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: PROG_ID, data: '' })
  }
  // 3) 应用身份:键名跟着**真实 exe** 走(打包 = iMark.exe,开发 = electron.exe),
  //    显示名由 FriendlyAppName 覆盖。开发模式下这是在 electron.exe 这个共有键上
  //    写一个名字 —— 只影响本机,且只有 iMark 一个开发应用会用到 .md 关联
  // 路径可能来自 Windows,也可能来自非 Windows 上的模拟/验收 —— 两种分隔符都切
  const appExe = exePath.replace(/^.*[\\/]/, '')
  writes.push(
    { key: `${CLASSES}\\Applications\\${appExe}`, name: 'FriendlyAppName', data: APP_NAME },
    { key: `${CLASSES}\\Applications\\${appExe}\\DefaultIcon`, name: null, data: icon },
    { key: `${CLASSES}\\Applications\\${appExe}\\shell\\open\\command`, name: null, data: command }
  )
  for (const ext of MARKDOWN_EXTS) {
    writes.push({ key: `${CLASSES}\\Applications\\${appExe}\\SupportedTypes`, name: ext, data: '' })
  }
  // 4) 现代注册:「默认应用」选择器的「建议的应用」
  writes.push(
    { key: 'HKCU\\Software\\RegisteredApplications', name: 'iMark', data: 'Software\\iMark\\Capabilities' },
    { key: CAPABILITIES, name: 'ApplicationName', data: APP_NAME },
    { key: CAPABILITIES, name: 'ApplicationDescription', data: '所见即所得 Markdown 编辑器' }
  )
  for (const ext of MARKDOWN_EXTS) {
    writes.push({ key: `${CAPABILITIES}\\FileAssociations`, name: ext, data: PROG_ID })
  }
  return writes
}

/** 一张待写进 ICO 的位图。`bgra` 是**自上而下**的 32bpp 像素(nativeImage.toBitmap 的布局) */
export interface IcoImage {
  width: number
  height: number
  bgra: Buffer
}

/**
 * 把若干张位图拼成 ICO —— 经典 32bpp **DIB** 条目,不是 PNG 压缩条目。
 *
 * 为什么不走「PNG 内嵌 ICO」那条捷径:Vista+ 的资源管理器认,但 GDI+ 等消费者不认
 * (2026-10-17 实测:System.Drawing 连我们生成的图标都打不开,报「参数范围扩展到图像的
 * 结尾」)。文件图标会被资源管理器、Open With、各种第三方外壳一起读,所以老实写 DIB:
 * BITMAPINFOHEADER + 自下而上的 BGRA + 一份全 0 的 AND 掩码(32bpp 下形状由 alpha 决定,
 * 掩码只是格式要求)。
 *
 * ICO 的宽高字段只有一个字节:0 表示 256。
 */
export function icoFromImages(images: readonly IcoImage[]): Buffer {
  const entries = images.map(img => {
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0) // biSize
    header.writeInt32LE(img.width, 4)
    header.writeInt32LE(img.height * 2, 8) // 颜色位图 + AND 掩码,高度取两倍
    header.writeUInt16LE(1, 12) // planes
    header.writeUInt16LE(32, 14) // bpp
    header.writeUInt32LE(0, 16) // BI_RGB
    header.writeUInt32LE(img.width * img.height * 4, 20)
    // DIB 的像素是**自下而上**的
    const rowBytes = img.width * 4
    const xor = Buffer.alloc(rowBytes * img.height)
    for (let y = 0; y < img.height; y += 1) {
      const src = (img.height - 1 - y) * rowBytes
      img.bgra.copy(xor, y * rowBytes, src, src + rowBytes)
    }
    // AND 掩码:每行按 4 字节对齐;全 0 = 不透明
    const maskRow = ((img.width + 31) >> 5) << 2
    return Buffer.concat([header, xor, Buffer.alloc(maskRow * img.height)])
  })

  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((data, i) => {
    const img = images[i]!
    const base = 6 + 16 * i
    header.writeUInt8(img.width >= 256 ? 0 : img.width, base)
    header.writeUInt8(img.height >= 256 ? 0 : img.height, base + 1)
    header.writeUInt8(0, base + 2) // 调色板颜色数(0 = 真彩)
    header.writeUInt8(0, base + 3)
    header.writeUInt16LE(1, base + 4) // planes
    header.writeUInt16LE(32, base + 6) // bpp
    header.writeUInt32LE(data.length, base + 8)
    header.writeUInt32LE(offset, base + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...entries])
}

/** ICO 里放哪几档尺寸:16/32/48 给资源管理器的小图标,256 给大图标与「默认应用」 */
const ICO_SIZES = [16, 32, 48, 256] as const

/**
 * 文件关联要用的 .ico。`DefaultIcon` 只认 ico / exe / dll,**不认 png** ——
 * 从应用自带的 icon.png 生成多尺寸 ico,落在数据根下(路径稳定,重启后照样有效;
 * 不放临时目录,否则清一次临时文件图标就没了)。
 *
 * 它决定的不是「默认应用」选择器里那一行(那一行取 exe 的图标,注册表改不了),
 * 而是关联生效后 **.md 文件本身的图标**。
 *
 * 失败时返回 null:注册照常进行,只是图标退回 exe 自带的那个 —— 不该因为图标失败
 * 就连关联都注册不了。
 */
export async function ensureAssociationIcon(): Promise<string | null> {
  const png = appIconPng()
  if (!png) return null
  try {
    const image = nativeImage.createFromPath(png)
    if (image.isEmpty()) return null
    const images: IcoImage[] = []
    for (const size of ICO_SIZES) {
      const resized = image.resize({ width: size, height: size, quality: 'best' })
      const bgra = resized.toBitmap()
      // resize 在极少数情况下会给回带 scaleFactor 的位图;尺寸对不上就跳过这一档
      if (bgra.length !== size * size * 4) continue
      images.push({ width: size, height: size, bgra })
    }
    if (images.length === 0) return null
    const target = join(dataRoot(), 'iMark.ico')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, icoFromImages(images))
    return target
  } catch {
    return null
  }
}

/** 用 reg.exe 读一个值;键不存在是**正常状态**(第一次用的人),返回 null */
async function regGet(key: string, name: string | null): Promise<string | null> {
  const args = name === null ? ['query', key, '/ve'] : ['query', key, '/v', name]
  try {
    const { stdout } = await run('reg.exe', args, { windowsHide: true })
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ|NONE)\s*(.*)$/)
      if (!m) continue
      if (name === null || m[1] === name) return m[2]!.trim()
    }
    return null
  } catch {
    return null
  }
}

async function regSet(write: RegWrite): Promise<void> {
  const target = write.name === null ? ['/ve'] : ['/v', write.name]
  await run(
    'reg.exe',
    ['add', write.key, ...target, '/t', 'REG_SZ', '/d', write.data, '/f'],
    { windowsHide: true }
  )
}

/**
 * 「用户选择的 ProgID」在注册表里的三层兜底,按系统实际会用的顺序读:
 *   1. `UserChoiceLatest\ProgId`(Win11 新版设置页写的子键形式);
 *   2. `UserChoiceLatest` 的同名值(个别版本的形式);
 *   3. 旧 `UserChoice`(新版设置页**不会**同步更新它);
 *   4. 都没有才看 HKCR 的合并视图(系统级默认)。
 *
 * 前两层必须排在旧键前面:2026-10-18 实测过反例 —— 系统设置里 .md 已显示 iMark,
 * 旧 UserChoice 却仍是 MarkText,只读旧键的界面就会一直报「当前默认程序:MarkText」。
 * Explorer 优先认 UserChoiceLatest,这里跟着它走。
 *
 * 读函数是注入的:验收可以拿假注册表钉住这个顺序,不必改跑测试那台机器的关联。
 */
export async function effectiveUserChoice(
  get: (key: string, name: string | null) => Promise<string | null>
): Promise<string | null> {
  const pick = (v: string | null): string | null => (v && v.trim() ? v : null)
  return (
    pick(await get(`${USER_CHOICE_LATEST}\\ProgId`, 'ProgId')) ??
    pick(await get(USER_CHOICE_LATEST, 'ProgId')) ??
    pick(await get(USER_CHOICE, 'ProgId')) ??
    pick(await get('HKCR\\.md', null))
  )
}

/**
 * 「现在默认的是谁」。
 *
 * 读取顺序见 effectiveUserChoice。用户之后在系统设置里选中 iMark 时,
 * Windows 写的就是我们注册的 ProgID,所以这里按 ProgID 与 `Applications\<exe>`
 * 两种形式都认。
 */
export async function defaultEditorStatus(): Promise<DefaultEditorStatus> {
  if (process.platform === 'linux') return linuxDefaultEditorStatus()
  if (process.platform !== 'win32') {
    return { supported: false, isDefault: false, current: null }
  }
  try {
    const current = await effectiveUserChoice(regGet)
    const exeName = basename(process.execPath)
    const isDefault =
      current === PROG_ID || current === `Applications\\${exeName}` || current === exeName
    return { supported: true, isDefault, current: current || null }
  } catch (err) {
    return {
      supported: true,
      isDefault: false,
      current: null,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/* ------------------------------- Linux ------------------------------- */

/**
 * `.md` / `.markdown` 在 shared-mime-info 里都归 `text/markdown`;
 * `text/x-markdown` 只是它的别名,写进 .desktop 供老工具识别。
 */
const LINUX_MIME = 'text/markdown'

/**
 * Flatpak/Snap 的 `mimeapps.list` 在沙箱里,写进去的是**沙箱内**的配置,
 * 宿主机的文件管理器根本看不到 —— 这类安装只能让用户去系统设置里选。
 * (`SNAP_NAME` 是 Snap 环境必有的,单独判断以防 SNAP 没导出。)
 */
function linuxSandboxed(): boolean {
  return Boolean(process.env.FLATPAK_ID || process.env.SNAP || process.env.SNAP_NAME)
}

/** XDG 规定的数据目录,按优先级排序(先出现的 .desktop 同 ID 覆盖后面的) */
function xdgDataDirs(): string[] {
  const home = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const system = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .map(dir => dir.trim())
    .filter(Boolean)
  return [...new Set([home, ...system])]
}

interface LinuxDesktopEntry {
  /** 条目 ID,即文件名(如 `iMark.desktop`)—— xdg-mime 收的就是这个 */
  id: string
  /** `[Desktop Entry]` 组里的 Exec 原样值 */
  exec: string
  /** `Name=`(用于显示「当前默认程序」;没有就退回 id) */
  name: string
}

/** 从 .desktop 文件里取 `[Desktop Entry]` 组的 Exec / Name */
export function parseDesktopEntry(text: string): Omit<LinuxDesktopEntry, 'id'> {
  let inEntry = false
  let exec = ''
  let name = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue
    if (!exec && line.startsWith('Exec=')) exec = line.slice('Exec='.length).trim()
    else if (!name && line.startsWith('Name=')) name = line.slice('Name='.length).trim()
  }
  return { exec, name }
}

/**
 * 扫一遍所有 XDG 数据目录里的 .desktop。
 *
 * 同一个 ID 只收第一个:XDG 的规矩是用户目录覆盖系统目录。
 */
async function linuxDesktopEntries(): Promise<LinuxDesktopEntry[]> {
  const entries: LinuxDesktopEntry[] = []
  const seen = new Set<string>()
  for (const root of xdgDataDirs()) {
    let names: string[]
    try {
      names = await readdir(join(root, 'applications'))
    } catch {
      continue
    }
    for (const id of names) {
      if (!id.endsWith('.desktop') || seen.has(id)) continue
      seen.add(id)
      try {
        const text = await readFile(join(root, 'applications', id), 'utf8')
        entries.push({ id, ...parseDesktopEntry(text) })
      } catch {
        // 读不了就当没有:一次权限问题不该让整张列表消失
      }
    }
  }
  return entries
}

/**
 * 认出「iMark 自己的」桌面条目。
 *
 * 先按 Exec 里的路径匹配 —— 这是最可靠的:dev 运行时指向 electron + 源码目录,
 * deb 安装后指向 `/opt/iMark/imark`,AppImage 集成后指向 .AppImage 文件
 * (Electron 把挂载点之外的真实路径放在 `APPIMAGE`,挂载点里的 execPath 匹配不上)。
 * 都匹配不到才退回按 ID 猜(electron-builder 默认用 productFilename 命名)。
 */
export function ownDesktopEntry(
  entries: readonly LinuxDesktopEntry[],
  selfPaths: readonly string[]
): string | null {
  const hints = selfPaths.filter(Boolean)
  const byExec = entries.find(e => e.exec && hints.some(p => e.exec.includes(p)))
  if (byExec) return byExec.id
  for (const id of ['iMark.desktop', `${app.name}.desktop`, 'imark.desktop']) {
    if (entries.some(e => e.id === id)) return id
  }
  return null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isMissingCommand(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** XDG 配置目录:先用户后系统 */
function xdgConfigDirs(): string[] {
  const home = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const system = (process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(Boolean)
  return [...new Set([home, ...system])]
}

/** 系统里有没有 xdg-mime —— 有它才能改关联,xdg-utils 不是每个桌面都预装 */
let xdgMimeReady: Promise<boolean> | null = null
function xdgMimeAvailable(): Promise<boolean> {
  xdgMimeReady ??= run('xdg-mime', ['--version']).then(
    () => true,
    err => (isMissingCommand(err) ? false : true)
  )
  return xdgMimeReady
}

/**
 * 从一份 mimeapps.list 里取 `[Default Applications]` 下某个类型的值。
 *
 * 值可以是 `a.desktop;b.desktop`,按规范取第一个。
 */
async function defaultFromMimeappsList(file: string, mime: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  let inSection = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inSection = line === '[Default Applications]'
      continue
    }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const types = line
      .slice(0, eq)
      .split(';')
      .map(t => t.trim())
      .filter(Boolean)
    if (!types.includes(mime)) continue
    const first = line
      .slice(eq + 1)
      .split(';')
      .map(v => v.trim())
      .find(Boolean)
    if (first) return first
  }
  return null
}

/**
 * 「现在 .md 显式关联到谁」,按 freedesktop 规定的顺序读 mimeapps.list:
 * 配置目录(先桌面环境专属、后通用)、再数据目录的 applications/。
 *
 * 不用 `xdg-mime query default` 是有教训的:xdg-utils 1.1.3 在哪儿都没配置时会
 * 退化成「扫一遍所有 .desktop,谁声明支持这个类型就报谁」—— 我们自己声明了
 * `text/markdown`,于是它在**从没设过默认**的机器上报 iMark 是默认,
 * 可 GNOME 实际还是用别的程序打开。界面只该说显式配置过的事实。
 */
async function configuredDefaultApp(mime: string): Promise<string | null> {
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .filter(Boolean)
    .map(d => d.toLowerCase())
  // 同一个目录里,桌面环境专属的文件优先于通用文件(规范顺序)
  const prefixes = [...desktops.map(d => `${d}-`), '']
  const dirs = [
    ...xdgConfigDirs(),
    ...xdgDataDirs().map(dir => join(dir, 'applications'))
  ]
  for (const dir of dirs) {
    for (const prefix of prefixes) {
      const found = await defaultFromMimeappsList(join(dir, `${prefix}mimeapps.list`), mime)
      if (found) return found
    }
  }
  return null
}

async function linuxDefaultEditorStatus(): Promise<DefaultEditorStatus> {
  if (linuxSandboxed()) {
    return {
      supported: false,
      isDefault: false,
      current: null,
      error:
        '当前运行在 Flatpak/Snap 沙箱里，应用改不到宿主机的文件关联，请在系统设置里手动把 .md 关联到 iMark。'
    }
  }
  if (!(await xdgMimeAvailable())) {
    return {
      supported: false,
      isDefault: false,
      current: null,
      error: '系统缺少 xdg-mime（xdg-utils），无法修改文件关联，请先在系统里安装 xdg-utils。'
    }
  }
  const entries = await linuxDesktopEntries()
  const own = ownDesktopEntry(entries, [
    process.execPath,
    app.getAppPath(),
    process.env.APPIMAGE ?? ''
  ])
  const currentId = await configuredDefaultApp(LINUX_MIME)
  const currentEntry = currentId ? entries.find(e => e.id === currentId) : undefined
  return {
    supported: true,
    isDefault: own !== null && currentId === own,
    current: currentEntry?.name || currentId,
    desktopEntry: own,
    // Linux 上应用能直接把默认改完,不需要用户再去设置页点一下
    direct: true
  }
}

/**
 * Linux 的「设为默认」:一条命令就改完,不需要打开任何设置页。
 *
 * 失败分两种:没有桌面条目(没安装/AppImage 没集成)—— 没有可指向的 ID;
 * xdg-mime 调不动 —— 环境缺 xdg-utils。两种都原样交代,不假装成功。
 */
async function linuxRegisterAsDefaultEditor(): Promise<DefaultEditorStatus> {
  const before = await linuxDefaultEditorStatus()
  if (!before.supported || before.desktopEntry == null) return before
  try {
    await run('xdg-mime', ['default', before.desktopEntry, LINUX_MIME])
  } catch (err) {
    return {
      ...before,
      isDefault: false,
      error: isMissingCommand(err)
        ? '系统缺少 xdg-mime（xdg-utils），无法写入文件关联，请先在系统里安装 xdg-utils。'
        : `写入文件关联失败:${errorMessage(err)}`
    }
  }
  // 报真实状态:命令成功不等于桌面环境已经认账,重新查一遍再说
  return linuxDefaultEditorStatus()
}

/**
 * 「设为默认」要打开的设置页。
 *
 * Windows 11(构建 22000+)支持 `registeredAppUser` 参数,能直接落到本应用那一页 ——
 * 用户到了就能点「设为默认」,不必在应用列表里找 iMark。参数值必须是
 * `HKCU\Software\RegisteredApplications` 下的值名(见 associationWrites,即 APP_NAME)。
 * Windows 10 不认这个参数,仍打开通用页:整条 URI 保持系统认识的样子,免得打不开。
 *
 * 这仍然只是**把用户送过去**。Windows 8 起没有受支持的 API 能替用户完成最后一下
 * (UserChoice 有哈希保护,Win11 还有 UCPD),不要试图绕过。
 */
export function defaultAppsSettingsUri(systemVersion: string): string {
  const build = Number(systemVersion.split('.')[2] ?? 0)
  return build >= 22000
    ? `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP_NAME)}`
    : 'ms-settings:defaultapps'
}

/**
 * 注册 + 把用户送到系统设置页。
 *
 * 返回的是**做完之后的真实状态**(而不是「成功」):注册只保证 iMark 出现在候选里,
 * 是不是默认仍然取决于用户接下来在系统设置里点了什么。
 */
export async function registerAsDefaultEditor(): Promise<DefaultEditorStatus> {
  if (process.platform === 'linux') return linuxRegisterAsDefaultEditor()
  if (process.platform !== 'win32') return defaultEditorStatus()
  // 先生成 .ico(拿不到就退回 exe 自己的图标 —— 图标失败不该拖累注册)
  const iconPath = await ensureAssociationIcon()
  try {
    for (const write of associationWrites(
      process.execPath,
      app.getAppPath(),
      app.isPackaged,
      iconPath
    )) {
      await regSet(write)
    }
  } catch (err) {
    return {
      supported: true,
      isDefault: false,
      current: null,
      error: `写入文件关联失败:${err instanceof Error ? err.message : String(err)}`
    }
  }
  try {
    // 最后一步只能由用户完成;打开系统设置是唯一「帮得上忙」的动作
    // Win11 会直接落在 iMark 的应用页,Win10 是通用页(见 defaultAppsSettingsUri)
    await shell.openExternal(defaultAppsSettingsUri(process.getSystemVersion()))
  } catch {
    // 打不开系统设置不算注册失败:候选已经注册好了,用户也可以自己去设置里选
  }
  return defaultEditorStatus()
}
