/**
 * 验收:设置 → 系统(默认 Markdown 编辑器)与「设置面板可拖动」。
 *
 * 四段:
 *   [A] 注册表写入清单(**纯函数**,不真的写注册表)。一个自动化用例不该悄悄改掉
 *       跑测试那台机器的文件关联 —— 所以这里只检查「会写哪些键、值对不对」,
 *       包括两条底线:命令里带 `"%1"`;不碰 `.md` 的默认值(只当候选,不抢现有关联)。
 *   [B] 命令行参数 → 要打开的文件(纯函数 + 真实临时文件)。
 *   [C] 端到端:把文件放进「启动参数」,应用起来后编辑器里是它。
 *   [D] 设置面板:左栏有「系统」;标题栏能拖动、拖不出视口、从正文拖不动;关掉重开回到居中。
 *
 * 「设为默认…」按钮**不在**这里点:它会把 iMark 写进 HKCU\Software\Classes 并弹出系统设置,
 * 那是对机器的真实副作用。按钮到 IPC 之间只剩一句 invoke,值不值得用副作用去换,
 * 答案是不值得 —— 写入内容本身由 [A] 逐条钉住。
 *
 * 跑法:node verify/run.mjs settings-system
 *
 * ⚠️ 改了 `src/renderer/**` 或 `src/main/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层与 preload 走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 */

import { app, BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'

import { defaultEditorStatus, effectiveUserChoice } from '../src/main/system'
import {
  MARKDOWN_EXTS,
  PROG_ID,
  associationWrites,
  defaultAppsSettingsUri,
  ensureAssociationIcon,
  icoFromImages
} from '../src/main/system'
import { fileFromArgv, setPendingOpenFile } from '../src/main/openFile'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

const RECT = `
(() => {
  const r = document.querySelector('.settings-dialog').getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
})()
`

/** 在 selector 上按下、在窗口上移动/松开 —— 与真实指针走同一套监听(window 上的 pointermove/up) */
function dragScript(selector: string, x: number, y: number, dx: number, dy: number): string {
  return `
(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return false
  const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, buttons: 1, clientX: ${x}, clientY: ${y} }))
  window.dispatchEvent(new PointerEvent('pointermove', { ...opts, button: -1, buttons: 1, clientX: ${x + dx}, clientY: ${y + dy} }))
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, buttons: 0, clientX: ${x + dx}, clientY: ${y + dy} }))
  return true
})()
`
}

const near = (a: number, b: number, tol = 1.5): boolean => Math.abs(a - b) <= tol

/** 截图落在 .verify-ud/shots/(run.mjs 每次只清 .verify-ud/<名字>,不会带走这一份) */
const SHOTS = join(__dirname, '..', '..', '.verify-ud', 'shots')

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }

  // ---------- A. 注册表写入清单(纯函数) ----------
  console.log('\n[A] 文件关联要写哪些注册表键(不执行)')
  const exe = 'C:\\Program Files\\iMark\\iMark.exe'
  const iconPath = 'C:\\Users\\me\\.imark\\iMark.ico'
  const packaged = associationWrites(exe, 'C:\\unused', true, iconPath)
  const command = packaged.find(w => w.key.endsWith('shell\\open\\command'))?.data ?? ''
  console.log(`     命令: ${command}`)
  check('注册了 ProgID 的打开命令', packaged.some(w => w.key === `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`))
  check('命令就是 exe + "%1"(双击文件时路径能从 %1 进来)', command === `"${exe}" "%1"`, command)
  check(
    '两个扩展名都进了「打开方式」候选(OpenWithProgids)',
    MARKDOWN_EXTS.every(ext =>
      packaged.some(
        w => w.key === `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids` && w.name === PROG_ID
      )
    )
  )
  check(
    '不碰 .md 的默认值(只当候选,不抢用户现在的关联)',
    !packaged.some(w => /\\Classes\\\.md$/.test(w.key) && w.name === null)
  )
  // 「选择器里只有 Electron」那次事故的核心:应用身份必须挂在**命令里的真实 exe**
  // 名下,显示名由 FriendlyAppName 覆盖;挂在别的名字上 Windows 认不出来
  const appNameWrites = (list: typeof packaged, exeName: string): boolean =>
    list.some(
      w =>
        w.key === `HKCU\\Software\\Classes\\Applications\\${exeName}` &&
        w.name === 'FriendlyAppName' &&
        w.data === 'iMark'
    )
  check('打包模式注册 Applications\\iMark.exe 并写明 FriendlyAppName=iMark', appNameWrites(packaged, 'iMark.exe'))
  check(
    '打包模式注册到 RegisteredApplications + Capabilities(「默认应用」按它列应用)',
    packaged.some(w => w.key === 'HKCU\\Software\\RegisteredApplications' && w.name === 'iMark') &&
      packaged.some(w => w.key.endsWith('\\Capabilities') && w.name === 'ApplicationName' && w.data === 'iMark') &&
      MARKDOWN_EXTS.every(ext =>
        packaged.some(
          w => w.key === 'HKCU\\Software\\iMark\\Capabilities\\FileAssociations' && w.name === ext && w.data === PROG_ID
        )
      )
  )

  // Win11 的应用页直达:多一个参数,用户就少一步「在列表里找 iMark」
  check(
    'Win11 的「设为默认」直接落到 iMark 的应用页',
    defaultAppsSettingsUri('10.0.26200') === 'ms-settings:defaultapps?registeredAppUser=iMark',
    defaultAppsSettingsUri('10.0.26200')
  )
  check(
    'Win10 打开通用默认应用页(它不认 registeredAppUser)',
    defaultAppsSettingsUri('10.0.19045') === 'ms-settings:defaultapps',
    defaultAppsSettingsUri('10.0.19045')
  )

  check(
    '文件类型与应用身份两处图标都指向生成的 .ico(开发模式不再显示 Electron 图标)',
    packaged.some(
      w => w.key === `HKCU\\Software\\Classes\\${PROG_ID}\\DefaultIcon` && w.data === `${iconPath},0`
    ) &&
      packaged.some(
        w =>
          w.key === 'HKCU\\Software\\Classes\\Applications\\iMark.exe\\DefaultIcon' &&
          w.data === `${iconPath},0`
      ),
    packaged.filter(w => w.key.endsWith('DefaultIcon')).map(w => w.data).join(' / ')
  )

  const dev = associationWrites('C:\\electron.exe', 'D:\\workspace\\imarkdown', false, iconPath)
  const devCommand = dev.find(w => w.key.endsWith('shell\\open\\command'))?.data ?? ''
  console.log(`     开发模式: ${devCommand}`)
  check(
    '开发模式的命令带上应用目录(否则 electron 不知道跑哪个应用)',
    devCommand === `"C:\\electron.exe" "D:\\workspace\\imarkdown" "%1"`,
    devCommand
  )
  // 开发模式必须写在 electron.exe 名下 —— 写 iMark.exe 的话 Windows 认不出来(实测)
  check(
    '开发模式把 FriendlyAppName=iMark 写在真实的 electron.exe 键上',
    appNameWrites(dev, 'electron.exe')
  )
  check(
    '开发模式的应用身份也带 .ico 图标',
    dev.some(
      w =>
        w.key === 'HKCU\\Software\\Classes\\Applications\\electron.exe\\DefaultIcon' &&
        w.data === `${iconPath},0`
    ),
    dev.filter(w => w.key.endsWith('DefaultIcon')).map(w => w.data).join(' / ')
  )

  // ---------- A1. 读「当前默认程序」的注册表优先级 ----------
  // 2026-10-18 的真机现象:系统设置里 .md 已显示 iMark,旧 UserChoice 仍是 MarkText,
  // 只读旧键的界面一直报 MarkText。这里用假注册表钉住 UserChoiceLatest 优先。
  console.log('\n[A1] 当前默认程序:Win11 新键优先,旧键只兜底')
  const EXTS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md'
  const LATEST_SUB = `${EXTS_KEY}\\UserChoiceLatest\\ProgId|ProgId`
  const LATEST_VALUE = `${EXTS_KEY}\\UserChoiceLatest|ProgId`
  const LEGACY = `${EXTS_KEY}\\UserChoice|ProgId`
  const MERGED = 'HKCR\\.md|(默认)'
  const fakeReg =
    (values: Record<string, string>) =>
    async (key: string, name: string | null): Promise<string | null> =>
      values[`${key}|${name ?? '(默认)'}`] ?? null

  const latestWins = await effectiveUserChoice(
    fakeReg({ [LATEST_SUB]: 'iMark.md', [LEGACY]: 'Applications\\MarkText.exe' })
  )
  check(
    'UserChoiceLatest\\ProgId 有值时以它为准(旧 UserChoice 的 MarkText 不再误报)',
    latestWins === 'iMark.md',
    String(latestWins)
  )
  const latestValueWins = await effectiveUserChoice(
    fakeReg({ [LATEST_VALUE]: 'iMark.md', [LEGACY]: 'Applications\\MarkText.exe' })
  )
  check(
    'UserChoiceLatest 以值形式存在时也认',
    latestValueWins === 'iMark.md',
    String(latestValueWins)
  )
  const legacyFallback = await effectiveUserChoice(
    fakeReg({ [LEGACY]: 'Applications\\MarkText.exe', [MERGED]: 'Markdown' })
  )
  check('没有新版键时退回旧 UserChoice', legacyFallback === 'Applications\\MarkText.exe', String(legacyFallback))
  const mergedFallback = await effectiveUserChoice(fakeReg({ [MERGED]: 'Markdown' }))
  check('两套用户选择都没有才看 HKCR 合并视图', mergedFallback === 'Markdown', String(mergedFallback))
  const emptyLatest = await effectiveUserChoice(
    fakeReg({ [LATEST_SUB]: '  ', [LEGACY]: 'Applications\\MarkText.exe' })
  )
  check('新版键里是空值时不算数,继续兜底', emptyLatest === 'Applications\\MarkText.exe', String(emptyLatest))

  // ---------- A2. 图标生成 ----------
  console.log('\n[A2] 生成 .ico(DefaultIcon 不认 png;条目必须是 DIB,PNG 内嵌格式有些消费者不认)')
  const bgra = Buffer.alloc(4 * 4 * 4)
  for (let i = 0; i < bgra.length; i += 1) bgra[i] = i & 0xff
  const one = icoFromImages([{ width: 4, height: 4, bgra }])
  const dib = 22
  check('ICO 头:type=1、单条目、宽高字段', one.readUInt16LE(2) === 1 && one.readUInt16LE(4) === 1 && one[6] === 4)
  check(
    '条目是 32bpp DIB:偏移 22 处就是 BITMAPINFOHEADER',
    one.readUInt32LE(dib) === 40 && one.readUInt16LE(dib + 14) === 32,
    `biSize=${one.readUInt32LE(dib)} bpp=${one.readUInt16LE(dib + 14)}`
  )
  check('DIB 高度是两倍(颜色位图 + AND 掩码)', one.readInt32LE(dib + 8) === 8)
  check(
    '像素自下而上(第一行取的是源的末行)',
    one.subarray(dib + 40, dib + 44).equals(bgra.subarray(48, 52))
  )

  const generated = await ensureAssociationIcon()
  console.log(`     生成路径: ${generated ?? '(失败)'}`)
  check('从 build/icon.png 生成了 .ico 文件', generated !== null && existsSync(generated), String(generated))
  if (generated) {
    const bytes = await readFile(generated)
    console.log(`     ${bytes.length} 字节`)
    check(
      '生成物含 16 / 32 / 48 / 256 四档(宽高字段 0 = 256)',
      bytes.readUInt16LE(2) === 1 &&
        bytes.readUInt16LE(4) === 4 &&
        bytes[6] === 16 &&
        bytes[22] === 32 &&
        bytes[38] === 48 &&
        bytes[54] === 0
    )
    const firstDataOffset = bytes.readUInt32LE(6 + 12)
    check(
      '第一档数据是 BITMAPINFOHEADER',
      bytes.readUInt32LE(firstDataOffset) === 40,
      `offset=${firstDataOffset}`
    )
  }

  // ---------- B. 命令行参数 → 文件 ----------
  console.log('\n[B] 从启动参数里认出要打开的文件')
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const external = join(ud, '外部文件.md')
  const someDir = join(ud, '某个目录')
  await mkdir(vault, { recursive: true })
  await mkdir(someDir, { recursive: true })
  await writeFile(join(vault, '笔记.md'), '# 笔记\n\n仓库里的文件。\n', 'utf8')
  await writeFile(external, '# 外部文件\n\n从系统递进来的。\n', 'utf8')

  const appPath = app.getAppPath()
  check('打包后:exe 之后的文件参数被认出', fileFromArgv([exe, external], true) === external)
  check(
    '开发模式:应用目录不会被当成文件',
    fileFromArgv(['C:\\electron.exe', appPath, external], false) === external
  )
  check(
    '带值开关的下一项不当文件(--user-data-dir 的值)',
    fileFromArgv(['C:\\electron.exe', '--user-data-dir', external, '--x=y'], true) === null
  )
  check('目录不算文件', fileFromArgv([exe, someDir], true) === null)
  check('没有文件参数时为 null', fileFromArgv([exe], true) === null)

  // ---------- 准备窗口 ----------
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '笔记.md'),
        autoSaveMode: 'off',
        marketUrl: ''
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  // 渲染层的插件服务一挂载就会 listPlugins();不给宿主的话界面右下角会弹一条
  // 「插件系统尚未就绪」—— 不影响断言,但会出现在截图里
  await initExtensions({ appVersion: APP_VERSION })
  const settings = await loadSettings()
  // 模拟「双击 .md 启动」:文件在 argv 里,主进程暂存,渲染层初始化完来取
  setPendingOpenFile(external)
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(2500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  // 断言查的是「有没有」,排版好不好看只能看
  const shot = async (name: string): Promise<void> => {
    // 窗口被别的窗口**完全遮挡**时 Chromium 会停掉合成,capturePage 拿到的是旧画面;
    // 临时提到最前(必要时还原最小化)把它逼回「可见」,截完恢复。
    console.log(`[shot] visible=${win.isVisible()} minimized=${win.isMinimized()} focused=${win.isFocused()}`)
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    const wasTop = win.isAlwaysOnTop()
    if (!wasTop) win.setAlwaysOnTop(true)
    win.moveTop()
    // 有焦点 + 尺寸真的变一下,DWM 才会重画这块 surface(只靠置顶时实测拿到的是旧帧)
    win.focus()
    const bounds = win.getBounds()
    win.setBounds({ ...bounds, width: Math.max(400, bounds.width - 2) })
    await sleep(80)
    win.setBounds(bounds)
    await sleep(300)
    // 再等一帧;必须带超时 —— 窗口真被最小化时 rAF 根本不跑,干等会把用例挂死
    await Promise.race([
      evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'),
      sleep(500)
    ])
    await sleep(120)
    await mkdir(SHOTS, { recursive: true })
    await writeFile(join(SHOTS, name), (await wc.capturePage()).toPNG())
    if (!wasTop) win.setAlwaysOnTop(false)
  }

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  // ---------- C. 启动参数里的文件被打开 ----------
  console.log('\n[C] 启动参数里的文件在编辑器里打开')
  const opened = await waitFor(`document.querySelector('.cm-content')?.textContent?.includes('外部文件')`)
  const title = win.getTitle()
  console.log(`     窗口标题: ${title}`)
  check('编辑器里是那个文件(不是 lastFile)', opened)
  check('窗口标题写着文件名', title.includes('外部文件'), title)

  // ---------- D. 设置 → 系统 ----------
  console.log('\n[D] 设置 → 系统 + 拖动面板')
  await evalJs(`document.querySelector('button[title^="设置"]').click()`)
  const dialogReady = await waitFor(`document.querySelector('.settings-dialog')`)
  check('设置面板打开了', dialogReady)
  if (!dialogReady) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }
  await sleep(300)

  const clickedSystem = await evalJs<boolean>(`
    (() => {
      const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.trim() === '系统')
      if (!b) return false
      b.click()
      return true
    })()
  `)
  await sleep(250)
  check('左栏有「系统」', clickedSystem)
  check(
    '右侧标题切到「系统」',
    (await evalJs<string>(`document.querySelector('.settings-main-header h1')?.textContent ?? ''`)) === '系统'
  )
  const pageText = await evalJs<string>(`(() => document.querySelector('.settings-body')?.innerText ?? '')()`)
  check('页面里有「默认 Markdown 编辑器」', pageText.includes('默认 Markdown 编辑器'), pageText.slice(0, 120))
  check(
    '说明一句话说清用途(文档默认用 iMark 打开)',
    pageText.includes('默认用 iMark 打开'),
    pageText.slice(0, 120)
  )
  const statusLine = await evalJs<string>(`(() => document.querySelector('.settings-row-desc')?.innerText ?? '')()`)
  console.log(`     状态行: ${statusLine.replace(/\s+/g, ' ')}`)
  check(
    '状态行给出了当前默认程序(或「已经是默认」)',
    /当前默认程序|iMark 现在是|还没有查询到/.test(statusLine),
    statusLine
  )
  // 宿主桥改成一次性取用后,渲染层不再有 window.api;直接调主进程侧的实现
  // (IPC 处理器 SystemDefaultEditorStatus 调的就是它)
  const apiStatus = await defaultEditorStatus()
  // 断的是「平台契约」而不是某台机器的现状:Windows 上必须支持,其它平台必须老实说支持不了
  check(
    '平台契约:只有 Windows 声称自己支持代注册',
    apiStatus.supported === (process.platform === 'win32'),
    `supported=${apiStatus.supported} platform=${process.platform}`
  )
  const buttonText = await evalJs<string>(
    `(() => [...document.querySelectorAll('.settings-body button')].map(b => b.textContent.trim()).find(t => t.includes('默认')) ?? '')()`
  )
  check('有「设为默认…」按钮(已是默认时显示「已是默认」)', /设为默认|已是默认|正在注册/.test(buttonText), buttonText)
  await shot('settings-system.png')

  // 拖动:标题栏按下 → 移动
  const before = await evalJs<Rect>(RECT)
  const vp = await evalJs<{ iw: number; ih: number }>(`({ iw: innerWidth, ih: innerHeight })`)
  const maxDx = Math.max(0, vp.iw - 8 - before.right)
  const maxDy = Math.max(0, vp.ih - 8 - before.bottom)
  const wantDx = Math.min(120, maxDx)
  const wantDy = Math.min(80, maxDy)
  console.log(`     视口 ${vp.iw}x${vp.ih},面板 ${Math.round(before.width)}x${Math.round(before.height)}`)
  check('视口里还有可拖动的空间', wantDx > 0 || wantDy > 0, `maxDx=${maxDx} maxDy=${maxDy}`)

  const header = await evalJs<{ x: number; y: number }>(`
    (() => { const r = document.querySelector('.settings-main-header').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()
  `)
  await evalJs(dragScript('.settings-main-header', header.x, header.y, wantDx, wantDy))
  await sleep(150)
  const moved = await evalJs<Rect>(RECT)
  check(
    '拖标题栏 → 面板跟着走',
    near(moved.left, before.left + wantDx) && near(moved.top, before.top + wantDy),
    `位移 (${Math.round(moved.left - before.left)}, ${Math.round(moved.top - before.top)}),期望 (${Math.round(wantDx)}, ${Math.round(wantDy)})`
  )

  // 拖到很远:必须整块留在视口里
  await evalJs(dragScript('.settings-main-header', header.x, header.y, 5000, 5000))
  await sleep(150)
  const corner = await evalJs<Rect>(RECT)
  check(
    '拖到视口外会被夹回来(整块仍可见)',
    corner.left >= 7 && corner.top >= 7 && corner.right <= vp.iw - 7 && corner.bottom <= vp.ih - 7,
    `面板 (${Math.round(corner.left)},${Math.round(corner.top)})-(${Math.round(corner.right)},${Math.round(corner.bottom)}),视口 ${vp.iw}x${vp.ih}`
  )

  // 从正文按下不该拖动
  const bodyPoint = await evalJs<{ x: number; y: number }>(`
    (() => { const r = document.querySelector('.settings-body').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(60, r.height / 2) } })()
  `)
  await evalJs(dragScript('.settings-body', bodyPoint.x, bodyPoint.y, -150, -150))
  await sleep(150)
  const afterBody = await evalJs<Rect>(RECT)
  check(
    '从正文拖不动(只有标题栏是把手)',
    near(afterBody.left, corner.left) && near(afterBody.top, corner.top),
    `(${Math.round(afterBody.left)},${Math.round(afterBody.top)}) vs (${Math.round(corner.left)},${Math.round(corner.top)})`
  )

  // 关掉再打开:回到居中
  await evalJs(`document.querySelector('.settings-close').click()`)
  await waitFor(`!document.querySelector('.settings-dialog')`)
  await evalJs(`document.querySelector('button[title^="设置"]').click()`)
  await waitFor(`document.querySelector('.settings-dialog')`)
  await sleep(300)
  const reopened = await evalJs<Rect>(RECT)
  check(
    '关掉重开 → 回到居中(不记上次拖到哪)',
    near(reopened.left, before.left) && near(reopened.top, before.top),
    `(${Math.round(reopened.left)},${Math.round(reopened.top)}) vs 初始 (${Math.round(before.left)},${Math.round(before.top)})`
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
