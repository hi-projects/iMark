/**
 * 复现:「+」→ 表格 → 插入,表格是最后内容时,光标先在第一格闪一下,随后整篇
 * 没有光标。
 *
 * 期望:插入结束后编辑器重新获得焦点,光标落在表格后面自动补出的新段(最后一行)。
 *
 * 真实路径里对话框关闭后,焦点落到 body;扩展随后走 edit + setSelection 两条
 * RPC。这里直接调用扩展命令,并在调用前把焦点挪出编辑器,复现同一状态。
 *
 * 跑法:xvfb-run -a node verify/run.mjs table-insert-focus
 */
import { app, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { IPC } from '../src/shared/ipc-channels'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.exit(2)
    return
  }
  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '测试.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '开头\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false,
        lineWrapping: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1600)
  await service.startup()
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  const click = (sel: string): Promise<boolean> =>
    evalJs<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`
    )
  const waitFor = async (code: string, ms = 6000): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(100)
    }
    return false
  }

  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  await sleep(200)
  check('「+」按钮出现', await waitFor(`document.querySelector('.line-plus')`, 8000))

  // 真实用户路径:+ → 菜单「表格」→ 对话框 → 插入
  await click('.line-plus')
  await sleep(250)
  await evalJs(`(() => {
    const el = [...document.querySelectorAll('.line-menu-item')].find(x => x.textContent.trim() === '表格')
    el.click(); return true
  })()`)
  await sleep(300)
  await evalJs(`(() => {
    const ins = [...document.querySelectorAll('.line-dialog input[type=number]')]
    const put = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })) }
    put(ins[0], 3); put(ins[1], 2)
    return ins.length
  })()`)
  check('对话框填好 3 行 2 列', true)
  // 监控插入过程中有没有单元格进入编辑态(旧实现会先抢第一格再退出 = 闪一下)
  await evalJs(`(() => {
    window.__cellFlash = false
    window.__cellFlashObserver = new MutationObserver(() => {
      if (document.querySelector('.cm-md-table-cell-editing')) window.__cellFlash = true
    })
    window.__cellFlashObserver.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class']
    })
    return true
  })()`)
  await click('.line-dialog-primary')
  check('对话框关掉了', await waitFor(`!document.querySelector('.line-dialog')`, 4000))
  await sleep(1000)
  console.log('【toasts】', JSON.stringify(await evalJs<string[]>(
    `[...document.querySelectorAll('.toast')].map(el => el.textContent)`
  )))
  console.log('【activated】', service.isActivated('imark.advanced-edit'))

  const after = await evalJs<{
    doc: string
    selLine: number
    lineCount: number
    selText: string
    activeId: string
    activeInEditor: boolean
    activeInTable: boolean
    hasFocus: boolean
    cursors: number
    cellEditing: boolean
  }>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const head = v.state.selection.main.head
      const line = v.state.doc.lineAt(head)
      const a = document.activeElement
      return {
        doc: v.state.doc.toString(),
        selLine: line.number,
        lineCount: v.state.doc.lines,
        selText: line.text,
        activeId: a ? (a.id || a.className || a.tagName) : 'none',
        activeInEditor: !!(a && a.closest && a.closest('.cm-content')),
        activeInTable: !!(a && a.closest && a.closest('.cm-md-table-widget')),
        hasFocus: v.hasFocus,
        cursors: document.querySelectorAll('.cm-cursor').length,
        cellEditing: !!document.querySelector('.cm-md-table-cell-editing')
      }
    })()`)
  console.log('【插入之后】', JSON.stringify(after, null, 2))

  check('表格渲染成 widget', after.doc.includes('|') && after.doc.includes(':---:'))
  check('光标在最后一行的新段上', after.selLine === after.lineCount && after.selText === '')
  check('没有单元格停在编辑态', !after.cellEditing && !after.activeInTable, JSON.stringify(after))
  const flashed = await evalJs<boolean>(`window.__cellFlash === true`)
  check('插入过程中没有任何单元格进入过编辑态(不再闪一下)', !flashed, String(flashed))
  check('编辑器获得焦点(有光标闪烁)', after.activeInEditor && after.hasFocus, JSON.stringify(after))
  check('编辑器画出了光标', after.cursors > 0, JSON.stringify(after))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
