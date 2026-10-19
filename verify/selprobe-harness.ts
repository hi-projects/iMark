import { app, BrowserWindow, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initPluginHost } from '../src/main/plugins/host'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1

async function main(): Promise<void> {
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'wrap.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  const text = `${'啊你是hi'.repeat(12)}${'水'.repeat(400)}\n贡献:\n\n- 展示了 DDPM 和 SM 之间的关系。\n`
  await writeFile(note, text, 'utf8')
  await loadSettings()
  await saveSettings({
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: note,
    openFiles: [note],
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false,
    lineWrapping: true,
    editorFontSize: 15
  })
  await initPluginHost()

  const win = createMainWindow(await loadSettings())
  win.setSize(1280, 800)
  win.webContents.setBackgroundThrottling(false)
  await new Promise<void>(r => win.webContents.once('did-finish-load', () => r()))
  win.setPosition(-3000, 0)
  win.show()
  win.focus()
  await sleep(1200)

  const evalJs = <T,>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code, true) as Promise<T>

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
  await sleep(200)

  const info = await evalJs<Record<string, unknown>>(`(() => {
    const content = document.querySelector('.cm-content');
    const view = content && content.cmTile && content.cmTile.root && content.cmTile.root.view;
    if (!view) return { error: 'no view' };
    view.dispatch({ selection: { anchor: 0, head: 220 } });
    view.focus();
    const line = document.querySelector('.cm-line');
    return {
      focus: view.hasFocus,
      padding: line ? getComputedStyle(line).padding : null,
      maxWidth: getComputedStyle(content).maxWidth,
      lineHeight: line ? getComputedStyle(content.parentElement).lineHeight : null
    };
  })()`)
  console.log('INFO', JSON.stringify(info))
  await sleep(600)

  const sel = await evalJs<Record<string, unknown>>(`(() => {
    const content = document.querySelector('.cm-content').getBoundingClientRect();
    const line = document.querySelector('.cm-line').getBoundingClientRect();
    const firstChar = document.querySelector('.cm-line')?.firstChild;
    const range = document.createRange();
    if (firstChar) range.selectNodeContents(firstChar);
    const charRect = firstChar && firstChar.nodeType === 3 ? range.getBoundingClientRect() : null;
    const markers = [...document.querySelectorAll('.cm-selectionLayer .cm-selectionBackground')].map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, top: r.top, height: r.height };
    });
    return { content: { left: content.left, right: content.right }, line: { left: line.left, right: line.right }, charRect: charRect ? { left: charRect.left, right: charRect.right } : null, markers: markers.slice(0, 5) };
  })()`)
  console.log('SEL', JSON.stringify(sel, null, 2))

  try {
    const img = await win.webContents.capturePage()
    await writeFile(join(ud, 'wrap.png'), img.toPNG())
    console.log('SHOT', join(ud, 'wrap.png'))
  } catch (err) {
    console.log('SHOT FAILED', String(err))
  }
  win.hide()

  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
