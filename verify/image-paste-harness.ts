/**
 * 剪贴板图片粘贴端到端验证。
 *
 * 起因:iMark 的编辑器只处理文本粘贴(CodeMirror 内置 paste 只读 text/plain),
 * 截图后 Ctrl+V 看起来毫无反应。这个 harness 钉住七件事:
 *   A 已保存文档粘贴图片 → 存进文档旁 assets/,正文插入相对路径,并且立刻渲染;
 *   B 有选区时粘贴 → 图片替换选区,而不是被内置 paste 空替换掉;
 *   C 删除正文里的图片链接并保存 → 对应文件移入回收站;
 *   D 粘贴后还没保存就删掉链接 → 首次保存时也要回收(会话记账);
 *   E 未保存文档粘贴 → 提示先保存,不写资产、不崩溃;
 *   F 对照组:纯文本粘贴仍然走 CodeMirror 原逻辑;
 *   G 同目录其他笔记仍引用着这张图 → 不回收。
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs image-paste
 */

import { app, dialog, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { trashUnreferencedImageAssets } from '../src/main/files'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initPluginHost } from '../src/main/plugins/host'
import { createMainWindow } from '../src/main/window'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'

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

/** 1×1 透明 PNG(68 字节),用来验证落盘字节与注入的完全一致 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG = Buffer.from(PNG_B64, 'base64')

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

async function main(): Promise<void> {
  await app.whenReady()

  // 「另存为」永远取消;「是否保存」一律选「不保存」,免得测试被原生对话框挂住
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  // 第一行留空:重载后光标在 position 0,粘贴就落在第一行,不必按键挪光标
  await writeFile(note, '\n# 标题\n\n正文段落\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off'
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost()
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as never })
    await sleep(180)
  }

  const assets = async (): Promise<string[]> =>
    readdir(join(vault, 'assets')).catch(() => [] as string[])

  /** 轮询等待某个文件消失(回收站是异步的,trashItem 返回时文件可能还没从目录里消失) */
  async function waitForFileGone(target: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (!existsSync(target)) return true
      await sleep(100)
    }
    return false
  }

  async function waitForNewAsset(before: string[], ms = 5000): Promise<string | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const now = await assets()
      const added = now.find(name => !before.includes(name) && /^image-.*\.png$/.test(name))
      if (added) return join(vault, 'assets', added)
      await sleep(100)
    }
    return null
  }

  /**
   * 在页面里合成一次粘贴。优先用真正的 ClipboardEvent;万一该 Electron/Chromium
   * 不接受 clipboardData init 字段,退回 Event + defineProperty —— CM 只读
   * `event.clipboardData`,不检查事件类或 isTrusted。
   */
  function pasteScript(block: string): string {
    return `(() => {
      ${block}
      let ev = null
      try {
        ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        if (!ev.clipboardData) ev = null
      } catch { ev = null }
      if (!ev) {
        ev = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', { value: dt })
      }
      const target = document.querySelector('.cm-content')
      if (!target) return false
      target.dispatchEvent(ev)
      return ev.defaultPrevented
    })()`
  }

  const pasteImage = (): Promise<boolean> =>
    evalJs<boolean>(
      pasteScript(`
      const bin = atob(${JSON.stringify(PNG_B64)})
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      `)
    )

  const pasteText = (text: string): Promise<boolean> =>
    evalJs<boolean>(
      pasteScript(`
      const dt = new DataTransfer()
      dt.setData('text/plain', ${JSON.stringify(text)})
      `)
    )

  async function saveNote(): Promise<string> {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(700)
    return readFile(note, 'utf8')
  }

  console.log('\n【A】已保存文档:粘贴图片 → 落盘 assets/ + 插入相对路径 + 立刻渲染')
  await focusEditor()
  const beforeA = await assets()
  const preventedA = await pasteImage()
  check('paste 事件被宿主拦下(defaultPrevented)', preventedA)
  const assetPath = await waitForNewAsset(beforeA)
  check('图片写进文档旁的 assets/', Boolean(assetPath), assetPath ?? '(没等到文件)')
  if (assetPath) {
    const written = await readFile(assetPath)
    check('落盘字节与剪贴板图片完全一致', written.equals(PNG), `${written.length} vs ${PNG.length} 字节`)
  }
  const renderedA = await waitFor(
    `document.querySelector('.cm-md-image-loaded img')?.naturalWidth > 0`,
    6000
  )
  check('插入后立刻按 imark:// 渲染成真图', renderedA)
  {
    const saved = await saveNote()
    check(
      'Markdown 里是相对路径 ![图片](assets/image-…png)',
      /!\[图片\]\(assets\/image-\d{8}-\d{6}-[0-9a-f]{8}\.png\)/.test(saved),
      JSON.stringify(saved.split('\n')[0])
    )
    check('图片之外的原有内容没被动过', saved.includes('# 标题') && saved.includes('正文段落'))
  }

  console.log('\n【B】有选区时粘贴:图片替换选区,而不是被内置 paste 清空')
  await focusEditor()
  await key('A', ['control'])
  const beforeB = await assets()
  const preventedB = await pasteImage()
  check('paste 事件被宿主拦下', preventedB)
  const assetPathB = await waitForNewAsset(beforeB)
  check('第二张图片也写进了 assets/', Boolean(assetPathB), assetPathB ?? '(没等到文件)')
  {
    const saved = await saveNote()
    const body = saved.trim()
    check(
      '正文只剩新图片,旧内容被选区替换',
      !body.includes('标题') && !body.includes('正文段落') && /^!\[图片\]\(assets\/image-.*\.png\)$/.test(body),
      JSON.stringify(body.slice(0, 120))
    )
    const oldGone = assetPath ? await waitForFileGone(assetPath) : false
    check('被替换掉的旧图片文件随之回收', oldGone, assetPath ?? '(没有第一张图)')
  }

  console.log('\n【C】删除正文里的图片链接并保存 → 对应文件回收')
  await focusEditor()
  await key('A', ['control'])
  await key('Delete')
  {
    const saved = await saveNote()
    check('正文已经清空', saved.trim() === '', JSON.stringify(saved.slice(0, 80)))
    const gone = assetPathB ? await waitForFileGone(assetPathB) : false
    check('图片文件随链接一起被回收', gone, assetPathB ?? '(没有第二张图)')
  }

  console.log('\n【D】粘贴后还没保存就删掉链接 → 首次保存时回收(靠会话记账)')
  await focusEditor()
  const beforeD = await assets()
  await pasteImage()
  const assetPathD = await waitForNewAsset(beforeD)
  check('第三张图片写进 assets/', Boolean(assetPathD), assetPathD ?? '(没等到文件)')
  await key('A', ['control'])
  await key('Delete')
  // 不经过一次「正文里带着这张图」的保存:保存前后比较发现不了它
  const savedD = await saveNote()
  check('正文保存为空', savedD.trim() === '', JSON.stringify(savedD.slice(0, 80)))
  check(
    '从未落过正文的粘贴图片也被回收',
    assetPathD ? await waitForFileGone(assetPathD) : false,
    assetPathD ?? '(没有第三张图)'
  )

  console.log('\n【E】未保存文档:提示先保存,不写资产')
  wc.send(IPC.MenuCommand, 'file:new')
  await sleep(700)
  const beforeC = await assets()
  const preventedC = await pasteImage()
  await sleep(500)
  check('paste 事件被宿主拦下', preventedC)
  {
    const toast = await evalJs<string>(`document.querySelector('.toast-message')?.textContent ?? ''`)
    check('出现「请先保存文档」提示', toast.includes('请先保存文档'), JSON.stringify(toast))
    const afterC = await assets()
    check('没有写出新的图片文件', afterC.length === beforeC.length, `${beforeC.length} → ${afterC.length}`)
  }

  console.log('\n【F】对照组:纯文本粘贴仍然走 CodeMirror 原逻辑')
  await focusEditor()
  await pasteText('普通粘贴')
  await sleep(400)
  {
    const text = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
    check('纯文本被正常插入', text.includes('普通粘贴'), JSON.stringify(text.slice(0, 80)))
  }

  console.log('\n【G】同目录其他笔记仍引用着这张图 → 不回收')
  {
    const name = 'image-20261019-120000-deadbeef.png'
    const target = join(vault, 'assets', name)
    await mkdir(join(vault, 'assets'), { recursive: true })
    await writeFile(target, PNG)
    await writeFile(join(vault, '共享.md'), `![图片](assets/${name})\n`, 'utf8')
    await trashUnreferencedImageAssets(note, [name])
    check('共享图片被其他笔记引用 → 保留', existsSync(target))
    await rm(join(vault, '共享.md'), { force: true })
    await trashUnreferencedImageAssets(note, [name])
    check('最后一个引用也消失后 → 回收', await waitForFileGone(target))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
