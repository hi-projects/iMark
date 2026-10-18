/**
 * 验收:main / render 两层模型。
 *
 *   [A] node main:主进程 CJS,完整 Node;
 *   [B] restricted main:隐藏执行页,无 Node/editor/window;
 *   [C] render-only:真实 EditorView + CM6 kit,没有 main 时 send 明确失败;
 *   [D] mixed:restricted main ↔ render 双向消息,`vault:read` 塑形;
 *   [E] 停用:隐藏页关闭、render 会话被卸载。
 *
 * 跑法:node verify/run.mjs layers
 * ⚠️ 改了 src/main、src/preload、src/renderer 之后先 `npx electron-vite build`。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost, type PluginHost } from '../src/main/plugins/host'
import { createMainWindow } from '../src/main/window'
import { pluginDir } from '../src/main/plugins/installed'
import { registerPluginScheme, pluginWebContentsOf } from '../src/main/plugins/restrictedPage'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  let last = await fn()
  while (!ok(last) && Date.now() < end) {
    await sleep(120)
    last = await fn()
  }
  return last
}

registerPluginScheme()

const NODE_MAIN = `
module.exports = (imk) => ({
  onEnable() {
    imk.setState({
      status: 'ok',
      lastMessage: 'node:' + typeof require + ':' + typeof process + ':' + typeof imk.render
    })
  }
})
`

const RESTRICTED_MAIN = `
window.__restrictedProbe = {
  require: typeof require,
  process: typeof process,
  editor: typeof window.imark.editor,
  windowApi: typeof window.imark.window,
  renderApi: typeof window.imark.render
}
window.imark.plugin.handle({
  onEnable() { window.imark.setState({ status: 'ok', lastMessage: 'restricted-ok' }) },
  runAction(id) { return { ok: true, message: 'restricted:' + id } }
})
`

const RENDER_ONLY = `
var probe = window.__renderProbe = {}
imk.plugin.handle({
  onEnable: function () {
    var v = imk.editor.getView()
    probe.view = !!v && typeof v.dispatch === 'function' && !!v.state && !!v.state.doc
    probe.kit = typeof imk.editor.kit.view.EditorView
    probe.commands = typeof imk.editor.kit.commands
    void imk.main.send('no-main', null).then(
      function () { probe.noMain = 'resolved' },
      function (err) { probe.noMain = String(err && err.message) }
    )
    imk.plugin.setState({ status: 'ok', lastMessage: 'render-ok' })
  }
})
`

const MIXED_MAIN = `
window.imark.plugin.handle({
  onEnable() {
    window.imark.render.onMessage(function (channel, data) {
      if (channel !== 'ping') return
      window.imark.render.send('pong', { x: data && data.x, vault: typeof window.imark.vault })
    })
  }
})
`

const MIXED_RENDER = `
imk.plugin.handle({
  onEnable: function () {
    imk.main.onMessage(function (channel, data) {
      if (channel === 'pong') {
        imk.plugin.setState({ status: 'ok', lastMessage: 'pong:' + data.x + ':' + data.vault })
      }
    })
    void imk.main.send('ping', { x: 7 })
  }
})
`

async function makePlugin(
  id: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>
): Promise<void> {
  const dir = pluginDir(id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id,
        name: `验收 ${id}`,
        description: 'layers harness',
        version: '1.0.0',
        fields: [],
        actions: [{ id: 'report', label: '报告' }],
        ...manifest
      },
      null,
      2
    ),
    'utf8'
  )
  for (const [name, code] of Object.entries(files)) {
    await writeFile(join(dir, name), code, 'utf8')
  }
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, '笔记.md'), '# 笔记\n验收标记\n', 'utf8')

  await makePlugin('layer-node', { main: { mode: 'node', entry: 'main.js' } }, {
    'main.js': NODE_MAIN
  })
  await makePlugin('layer-restricted', { main: { mode: 'restricted', entry: 'main.js' } }, {
    'main.js': RESTRICTED_MAIN
  })
  await makePlugin('layer-render', { render: { entry: 'render.js' } }, {
    'render.js': RENDER_ONLY
  })
  await makePlugin(
    'layer-mixed',
    {
      main: { mode: 'restricted', entry: 'main.js' },
      render: { entry: 'render.js' },
      permissions: ['vault:read']
    },
    { 'main.js': MIXED_MAIN, 'render.js': MIXED_RENDER }
  )

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '笔记.md'),
        autoSave: false,
        marketUrl: '',
        plugins: {
          'layer-node': { enabled: true, config: {} },
          'layer-restricted': { enabled: true, config: {} },
          'layer-render': { enabled: true, config: {} },
          'layer-mixed': { enabled: true, config: {} }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  await initPluginHost()
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  const host = getPluginHost() as PluginHost
  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const stateOf = async (id: string): Promise<string> =>
    (await host.list()).find(p => p.descriptor.id === id)?.state.lastMessage ?? ''

  console.log('\n[A] node main')
  const nodeMsg = await until(() => stateOf('layer-node'), v => v.startsWith('node:'))
  check('node main 的 onEnable 跑过', nodeMsg.startsWith('node:'), nodeMsg)
  check('它是完整 Node 环境', nodeMsg.includes('node:function:object'), nodeMsg)
  check('没有 render 层时 imk.render 不存在', nodeMsg.endsWith(':undefined'), nodeMsg)

  console.log('\n[B] restricted main')
  const restrictedMsg = await until(() => stateOf('layer-restricted'), v => v === 'restricted-ok')
  check('restricted main 的 onEnable 跑过', restrictedMsg === 'restricted-ok', restrictedMsg)
  const rwc = pluginWebContentsOf('layer-restricted')
  check('隐藏执行页存在', rwc !== null)
  const rProbe = rwc
    ? await rwc.executeJavaScript('window.__restrictedProbe', true)
    : null
  check('页面里没有 require', rProbe?.require === 'undefined', JSON.stringify(rProbe))
  check('页面里没有 process', rProbe?.process === 'undefined', JSON.stringify(rProbe))
  check('页面里没有 editor 能力', rProbe?.editor === 'undefined', JSON.stringify(rProbe))
  check('页面里没有 window 能力', rProbe?.windowApi === 'undefined', JSON.stringify(rProbe))
  check('没有 render 层时没有 imark.render', rProbe?.renderApi === 'undefined', JSON.stringify(rProbe))

  console.log('\n[C] render-only')
  const renderMsg = await until(() => stateOf('layer-render'), v => v === 'render-ok')
  check('render 层的 onEnable 跑过', renderMsg === 'render-ok', renderMsg)
  const rp = await evalJs<Record<string, unknown>>('window.__renderProbe || null')
  check('getView() 拿到真实 EditorView', rp?.view === true, JSON.stringify(rp))
  check('kit 提供共享 CM6 EditorView', rp?.kit === 'function', JSON.stringify(rp))
  check('kit 提供 commands', rp?.commands === 'object', JSON.stringify(rp))
  check(
    '没有 main 层时 imk.main.send 明确失败',
    typeof rp?.noMain === 'string' && rp.noMain.includes('没有 main'),
    JSON.stringify(rp)
  )

  console.log('\n[D] restricted main + render 双向消息')
  const mixedMsg = await until(() => stateOf('layer-mixed'), v => v.startsWith('pong:'))
  check('render → main → render 消息闭环', mixedMsg === 'pong:7:object', mixedMsg)

  console.log('\n[E] 停用清理')
  await host.save('layer-restricted', { enabled: false })
  await host.save('layer-render', { enabled: false })
  await host.save('layer-mixed', { enabled: false })
  const gone = await until(async () => pluginWebContentsOf('layer-restricted') === null, v => v, 4000)
  check('停用后隐藏执行页关闭', gone === true)

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
