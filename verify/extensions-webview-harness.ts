/**
 * 验收:扩展 webview。
 *
 * 一个合成扩展 `test.webview` 在真实窗口里创建面板，盯四件事：
 *
 *   [1] 协议:token、归属扩展、localResourceRoots、面板 HTML 与静态资源
 *   [2] 消息:main ↔ 扩展 ↔ iframe 的双向往返；就绪前排队不丢
 *   [3] 面板 API:state、title、尺寸/位置/呈现方式随命令即时反映到 DOM
 *   [4] 主题:renderer 把 CSS 变量送进跨源 iframe
 *   [5] 持久化:关闭再启动后按序列化器恢复同一面板（panelId/token/state 不变）
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs extensions-webview
 */

import { app, dialog, net, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { EXTENSION_WEBVIEW_SCHEME } from '../src/shared/extensionProtocol'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerExtensionWebviewProtocol } from '../src/main/extensions/webviewProtocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { dataRoot } from '../src/main/dataDir'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import type { ExtensionManifest } from '../src/shared/extensionPackage'

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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const EXT_ID = 'test.webview'
const VIEW_TYPE = 'test.webview.panel'
import { APP_VERSION } from './appVersion'

const MANIFEST: ExtensionManifest = {
  publisher: 'test',
  name: 'webview',
  version: '1.0.0',
  displayName: 'Webview 探针',
  description: 'extensions-webview harness 用的合成扩展',
  engines: { imark: '^1.0.0' },
  main: './main.js',
  activationEvents: ['onStartupFinished'],
  contributes: {
    commands: [
      { command: 'test.webview.create', title: 'Create' },
      { command: 'test.webview.state', title: 'State' },
      { command: 'test.webview.post', title: 'Post' },
      { command: 'test.webview.setHtml', title: 'Set Html' },
      { command: 'test.webview.setState', title: 'Set State' },
      { command: 'test.webview.getState', title: 'Get State' },
      { command: 'test.webview.setTitle', title: 'Set Title' },
      { command: 'test.webview.setPresentation', title: 'Set Presentation' },
      { command: 'test.webview.setSize', title: 'Set Size' },
      { command: 'test.webview.setPosition', title: 'Set Position' },
      { command: 'test.webview.dispose', title: 'Dispose' },
      { command: 'test.webview.assetUrl', title: 'Asset Url' }
    ]
  }
}

const FIXTURE_CODE = `
const path = require('node:path')
const imark = require('imark')
const { Uri, ViewColumn } = imark

let extRoot = ''
let panel = null
const stats = {
  created: 0,
  restores: 0,
  disposed: 0,
  messages: [],
  restoreStates: [],
  viewStates: []
}

function attach(target, label) {
  target.webview.onDidReceiveMessage(message => {
    stats.messages.push(message)
    // 往返探针：收到 ping 就回 pong，用来证明 iframe → 扩展 → iframe 闭环
    if (message && message.kind === 'ack' && message.value && message.value.kind === 'ping') {
      target.webview.postMessage({ kind: 'pong', value: message.value.value })
    }
  })
  target.onDidDispose(() => {
    stats.disposed += 1
    if (panel === target) panel = null
  })
  target.onDidChangeViewState(event => {
    stats.viewStates.push({ visible: event.visible, active: event.active })
  })
  target.webview.html = buildHtml(label || 'panel', 0)
}

function buildHtml(label, delayReady) {
  const csp = panel.webview.cspSource
  const asset = panel.webview.asWebviewUri(Uri.file(path.join(extRoot, 'asset.png'))).toString()
  const script =
    '<script>' +
    '(function(){' +
    '  var log = [];' +
    '  window.__log = log;' +
    '  function reply(message){ parent.postMessage({ type: "imark:message", message: message }, "*"); }' +
    '  function applyTheme(theme){' +
    '    if (!theme || !theme.colors) return;' +
    '    Object.keys(theme.colors).forEach(function(key){' +
    '      document.documentElement.style.setProperty(key, theme.colors[key]);' +
    '    });' +
    '  }' +
    '  window.addEventListener("message", function(event){' +
    '    var data = event.data;' +
    '    if (!data || typeof data.type !== "string") return;' +
    '    if (data.type === "imark:bootstrap") {' +
    '      window.__bootstrap = data;' +
    '      applyTheme(data.theme);' +
    '      log.push(["bootstrap", data.panelId]);' +
    '      reply({ kind: "bootstrap", panelId: data.panelId, extensionId: data.extensionId, themeKind: data.theme && data.theme.kind, colorCount: Object.keys((data.theme && data.theme.colors) || {}).length });' +
    '    } else if (data.type === "imark:theme") {' +
    '      applyTheme(data.theme);' +
    '      log.push(["theme", data.theme && data.theme.kind]);' +
    '      reply({ kind: "theme-ack", bg: getComputedStyle(document.body).backgroundColor });' +
    '    } else if (data.type === "imark:message") {' +
    '      log.push(["message", data.message]);' +
    '      reply({ kind: "ack", value: data.message });' +
    '    }' +
    '  });' +
    '  document.getElementById("asset").addEventListener("load", function(){ reply({ kind: "asset-loaded" }); });' +
    '  function ready(){ parent.postMessage({ type: "imark:ready" }, "*"); }' +
    '  if (' + (delayReady > 0 ? 'true' : 'false') + ') setTimeout(ready, ' + delayReady + '); else ready();' +
    '  document.getElementById("label").textContent = ' + JSON.stringify(label) + ';' +
    '})();' +
    '</script>'
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; script-src \\'unsafe-inline\\'; style-src \\'unsafe-inline\\'; img-src ' + csp + ' data:;">' +
    '<style>html,body{margin:0;height:100%;background:var(--bg-editor,#fff);color:var(--text-primary,#000)}</style>' +
    '</head><body>' +
    '<div id="label">loading</div>' +
    '<img id="asset" alt="asset" src="' + asset + '">' +
    script +
    '</body></html>'
}

function waitPanelId(target) {
  return new Promise(resolve => {
    const tick = () => (target.panelId ? resolve() : setTimeout(tick, 10))
    tick()
  })
}

function snapshot() {
  return {
    panelId: panel ? panel.panelId : null,
    token: panel ? panel.token : null,
    title: panel ? panel.title : null,
    visible: panel ? panel.visible : false,
    active: panel ? panel.active : false,
    retain: panel ? Boolean(panel.webview.options && panel.webview.options.retainContextWhenHidden) : false,
    viewType: panel ? panel.viewType : null,
    messages: stats.messages.slice(),
    created: stats.created,
    restores: stats.restores,
    restoreStates: stats.restoreStates.slice(),
    disposed: stats.disposed,
    viewStates: stats.viewStates.slice()
  }
}

exports.activate = context => {
  extRoot = context.extensionPath
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.create', async options => {
      const opts = options || {}
      panel = imark.window.createWebviewPanel('${VIEW_TYPE}', opts.title || 'Probe', ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: opts.retainContextWhenHidden === true,
        localResourceRoots: [Uri.file(extRoot)],
        imark: {
          presentation: opts.presentation || 'sidebar',
          width: opts.width || 420,
          height: opts.height || 480,
          anchor: opts.anchor || 'bottom-right'
        }
      })
      stats.created += 1
      attach(panel, opts.label || 'panel')
      await waitPanelId(panel)
      return {
        panelId: panel.panelId,
        token: panel.token,
        csp: panel.webview.cspSource
      }
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.state', () => snapshot())
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.post', value => {
      if (!panel) throw new Error('没有面板')
      panel.webview.postMessage(value)
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.setHtml', payload => {
      if (!panel) throw new Error('没有面板')
      panel.webview.html = buildHtml((payload && payload.label) || 'panel', (payload && payload.delayReady) || 0)
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.setState', value => {
      if (!panel) throw new Error('没有面板')
      panel.webview.setState(value)
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.getState', () => (panel ? panel.webview.getState() : null))
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.setTitle', title => {
      if (!panel) throw new Error('没有面板')
      panel.title = title
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.setPresentation', value => {
      if (!panel) throw new Error('没有面板')
      panel.imark.setPresentation(value)
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.setSize', size => {
      if (!panel) throw new Error('没有面板')
      panel.imark.setSize(size.width, size.height)
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.setPosition', anchor => {
      if (!panel) throw new Error('没有面板')
      panel.imark.setPosition(anchor)
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.dispose', () => {
      if (!panel) throw new Error('没有面板')
      panel.dispose()
      return true
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('test.webview.assetUrl', () =>
      panel
        ? panel.webview.asWebviewUri(Uri.file(path.join(extRoot, 'asset.png'))).toString()
        : null
    )
  )
  context.subscriptions.push(
    imark.window.registerWebviewPanelSerializer('${VIEW_TYPE}', {
      deserializeWebviewPanel(restored, state) {
        panel = restored
        stats.restores += 1
        stats.restoreStates.push(state)
        attach(restored, 'restored')
        return Promise.resolve()
      }
    })
  )
}
`

interface ProbeState {
  panelId: string | null
  token: string | null
  title: string | null
  visible: boolean
  active: boolean
  retain: boolean
  viewType: string | null
  messages: { kind?: string; value?: { kind?: string; value?: unknown }; panelId?: string; extensionId?: string; colorCount?: number; bg?: string }[]
  created: number
  restores: number
  restoreStates: unknown[]
  disposed: number
  viewStates: { visible: boolean; active: boolean }[]
}

interface CreatedPanel {
  panelId: string
  token: string
  csp: string
}

/** 1x1 透明 PNG：足够让 iframe 发出一次真实资源请求 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs extensions-webview` 跑会自动带上）')
    app.exit(2)
    return
  }

  // 特权 scheme 必须在 ready 之前注册；harness 不 import index.ts，要自己来
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'imark',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    {
      scheme: EXTENSION_WEBVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])

  await app.whenReady()

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
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await rm(join(ud, 'extensions-data'), { recursive: true, force: true })
  await writeFile(note, 'alpha\nbeta\ngamma\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  const extDir = join(dataRoot(), 'plugins', EXT_ID)
  await mkdir(extDir, { recursive: true })
  await writeFile(join(extDir, 'package.json'), JSON.stringify(MANIFEST, null, 2), 'utf8')
  await writeFile(join(extDir, 'main.js'), FIXTURE_CODE, 'utf8')
  await writeFile(join(extDir, 'asset.png'), PNG_1X1)

  // 扩展根之外的同名资源：路径穿越必须被拒绝
  await writeFile(join(dataRoot(), 'plugins', 'outside.txt'), 'outside', 'utf8')

  registerIpc()
  registerImarkProtocol()
  registerExtensionWebviewProtocol()
  const settings = await loadSettings()
  let service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)
  await service.startup()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  const state = (): Promise<ProbeState> =>
    service.executeCommand('test.webview.state') as Promise<ProbeState>

  async function waitForState(
    predicate: (value: ProbeState) => boolean,
    ms = 8000
  ): Promise<ProbeState | null> {
    const until = Date.now() + ms
    let last: ProbeState | null = null
    while (Date.now() < until) {
      try {
        last = await state()
        if (predicate(last)) return last
      } catch {
        /* 扩展可能还在激活 */
      }
      await sleep(80)
    }
    // 超时返回 null：调用方 `!!result` 才是真的「等到了」，不会被最后一份快照骗过
    return null
  }

  function iframeInfo(): Promise<{
    count: number
    src: string
    className: string
    title: string
    width: string
    height: string
  }> {
    return evalJs(`(() => {
      const frame = document.querySelector('iframe.webview-frame')
      const section = frame ? frame.closest('.webview-panel') : null
      return {
        count: document.querySelectorAll('iframe.webview-frame').length,
        src: frame ? frame.getAttribute('src') || '' : '',
        className: section ? section.className : '',
        title: section ? (section.querySelector('.webview-title')?.textContent || '') : '',
        width: section ? section.style.width : '',
        height: section ? section.style.height : ''
      }
    })()`)
  }

  // ---------- 1. 创建面板 / 协议 ----------

  console.log('\n【1】创建面板：iframe 指向 imark-webview://，入口 HTML 与静态资源可取')
  const created = (await service.executeCommand('test.webview.create', [
    { title: 'Probe', retainContextWhenHidden: true }
  ])) as CreatedPanel
  check('命令返回 panelId', typeof created.panelId === 'string' && created.panelId.startsWith('wv-'), String(created.panelId))
  check('token 是 32 位十六进制', /^[a-f0-9]{32}$/.test(created.token), created.token)
  check('cspSource 是扩展专属 origin', created.csp === `imark-webview://${EXT_ID}`, created.csp)

  check(
    '渲染层出现一个 sandbox iframe',
    await waitFor(`document.querySelectorAll('iframe.webview-frame').length === 1`)
  )
  let frame = await iframeInfo()
  check(
    'iframe src 指向面板入口并带 token',
    frame.src.startsWith(`imark-webview://${EXT_ID}/__imark_panel__/index.html?token=${created.token}`),
    frame.src
  )
  check(
    'sandbox 只开脚本/表单/同源/下载',
    await evalJs<boolean>(
      `document.querySelector('iframe.webview-frame')?.getAttribute('sandbox') === 'allow-scripts allow-forms allow-same-origin allow-downloads'`
    )
  )
  check('面板按 sidebar 呈现', frame.className.includes('webview-panel-sidebar'), frame.className)
  check('标题来自 createWebviewPanel', frame.title === 'Probe', frame.title)

  const boot = await waitForState(value => value.messages.some(m => m.kind === 'bootstrap'))
  check('iframe 就绪后收到 bootstrap', !!boot, JSON.stringify(boot?.messages))
  const bootMsg = boot?.messages.find(m => m.kind === 'bootstrap')
  check('bootstrap 带 panelId', bootMsg?.panelId === created.panelId, String(bootMsg?.panelId))
  check('bootstrap 带 extensionId', bootMsg?.extensionId === EXT_ID, String(bootMsg?.extensionId))
  check(
    'bootstrap 带主题变量(≥ 10 个)',
    (bootMsg?.colorCount ?? 0) >= 10,
    String(bootMsg?.colorCount)
  )
  check(
    'iframe 里的图片经协议加载成功',
    await waitForState(value => value.messages.some(m => m.kind === 'asset-loaded'), 5000).then(Boolean)
  )

  const entryUrl = `${created.csp}/__imark_panel__/index.html?token=${created.token}`
  const entry = await net.fetch(entryUrl)
  const entryText = await entry.text()
  check('入口 HTML 200', entry.status === 200, String(entry.status))
  check('入口 HTML 是扩展写入的那份', entryText.includes('<div id="label">'), entryText.slice(0, 80))

  const noToken = await net.fetch(`${created.csp}/__imark_panel__/index.html`)
  check('缺 token → 403', noToken.status === 403, String(noToken.status))

  const wrongHost = await net.fetch(
    `imark-webview://other.ext/__imark_panel__/index.html?token=${created.token}`
  )
  check('别的扩展 host 拿同一 token → 403', wrongHost.status === 403, String(wrongHost.status))

  const unknownToken = await net.fetch(
    `${created.csp}/__imark_panel__/index.html?token=${'a'.repeat(32)}`
  )
  check('不存在的 token → 403', unknownToken.status === 403, String(unknownToken.status))

  const assetUrl = (await service.executeCommand('test.webview.assetUrl')) as string
  check(
    'asWebviewUri 拼出扩展根下的相对路径',
    assetUrl === `${created.csp}/asset.png?token=${created.token}`,
    assetUrl
  )
  const assetRes = await net.fetch(assetUrl)
  const assetBytes = Buffer.from(await assetRes.arrayBuffer())
  check('静态资源 200', assetRes.status === 200, String(assetRes.status))
  check('静态资源内容一致', assetBytes.equals(PNG_1X1), `${assetBytes.length} bytes`)
  check(
    '静态资源 MIME 正确',
    (assetRes.headers.get('content-type') ?? '').includes('image/png'),
    String(assetRes.headers.get('content-type'))
  )

  const traversal = await net.fetch(`${created.csp}/..%2Foutside.txt?token=${created.token}`)
  check(
    '编码过的 ../ 越出扩展根 → 403',
    traversal.status === 403,
    `${traversal.status}`
  )

  // ---------- 2. 双向消息 ----------

  console.log('\n【2】消息：扩展 → iframe → 扩展 的往返；就绪前的消息排队')
  await service.executeCommand('test.webview.post', [{ kind: 'hello', n: 1 }])
  const acked = await waitForState(value =>
    value.messages.some(m => m.kind === 'ack' && m.value?.kind === 'hello')
  )
  check('iframe 收到扩展 postMessage 并回执', !!acked, JSON.stringify(acked?.messages))

  await service.executeCommand('test.webview.post', [{ kind: 'ping', value: 42 }])
  const pong = await waitForState(value =>
    value.messages.some(m => m.kind === 'ack' && m.value?.kind === 'pong' && m.value?.value === 42)
  )
  check(
    'ping 走完 iframe → 扩展 → iframe 的闭环',
    !!pong,
    JSON.stringify(pong?.messages.map(m => m.kind))
  )

  await service.executeCommand('test.webview.post', [{ kind: 'early' }])
  const beforeReload = await iframeInfo()
  await service.executeCommand('test.webview.setHtml', [{ label: 'slow', delayReady: 600 }])
  await service.executeCommand('test.webview.post', [{ kind: 'queued-before-ready' }])
  const queued = await waitForState(value =>
    value.messages.some(m => m.kind === 'ack' && m.value?.kind === 'queued-before-ready')
  )
  check('iframe 重载等待就绪期间的消息没有丢', !!queued, JSON.stringify(queued?.messages))
  const slowFrame = await iframeInfo()
  const revOf = (src: string): number => Number(/[?&]rev=(\d+)/.exec(src)?.[1] ?? -1)
  check(
    'HTML 更新让 iframe 重载(rev 前进)',
    slowFrame.src !== beforeReload.src && revOf(slowFrame.src) > revOf(beforeReload.src),
    `${beforeReload.src} → ${slowFrame.src}`
  )

  // ---------- 3. 面板 API ----------

  console.log('\n【3】state / title / 尺寸 / 位置 / 呈现方式')
  await service.executeCommand('test.webview.setState', [{ note: 'kept', n: 7 }])
  const kept = (await service.executeCommand('test.webview.getState')) as {
    note: string
    n: number
  }
  check('webview.setState/getState 往返', kept?.note === 'kept' && kept?.n === 7, JSON.stringify(kept))

  await service.executeCommand('test.webview.setTitle', ['Renamed'])
  check(
    '标题改到渲染层',
    await waitFor(`document.querySelector('.webview-title')?.textContent === 'Renamed'`)
  )

  await service.executeCommand('test.webview.setPresentation', ['floating'])
  check(
    'setPresentation(floating) 生效',
    await waitFor(
      `document.querySelector('.webview-panel')?.classList.contains('webview-panel-floating')`
    )
  )
  check(
    'floating 面板有默认尺寸',
    (await iframeInfo()).width === '420px',
    (await iframeInfo()).width
  )
  await service.executeCommand('test.webview.setSize', [{ width: 480, height: 300 }])
  check(
    'setSize 改到 DOM',
    await waitFor(
      `(() => { const s = document.querySelector('.webview-panel'); return s && s.style.width === '480px' && s.style.height === '300px' })()`
    ),
    JSON.stringify(await iframeInfo())
  )
  await service.executeCommand('test.webview.setPosition', ['top-left'])
  check(
    'setPosition 改到 DOM',
    await waitFor(
      `document.querySelector('.webview-panel')?.classList.contains('webview-anchor-top-left')`
    )
  )
  await service.executeCommand('test.webview.setPresentation', ['sidebar'])
  check(
    '切回 sidebar',
    await waitFor(
      `document.querySelector('.webview-panel')?.classList.contains('webview-panel-sidebar')`
    )
  )

  // ---------- 4. 主题注入 ----------

  console.log('\n【4】主题：renderer 把 CSS 变量推进跨源 iframe')
  service.handleRendererMessage({
    type: 'editor.themeChanged',
    theme: { kind: 'dark', colors: { '--bg-editor': '#123456', '--text-primary': '#eeeeee' } }
  })
  const themed = await waitForState(value =>
    value.messages.some(m => m.kind === 'theme-ack')
  )
  const themeAck = themed?.messages.find(m => m.kind === 'theme-ack')
  check('iframe 收到 imark:theme', !!themeAck, JSON.stringify(themed?.messages))
  check(
    '注入的颜色真的改变了 iframe 背景',
    themeAck?.bg === 'rgb(18, 52, 86)',
    String(themeAck?.bg)
  )

  // ---------- 5. 持久化与恢复 ----------

  console.log('\n【5】关闭扩展系统再启动：面板按序列化器恢复')
  const beforeRestart = await state()
  await service.executeCommand('test.webview.setState', [{ note: 'saved-state', n: 9 }])
  await service.executeCommand('test.webview.post', [{ kind: 'before-restart' }])
  await waitForState(value => value.messages.some(m => m.kind === 'ack' && m.value?.kind === 'before-restart'))
  await sleep(400)
  await shutdownExtensions()

  const persistedPath = join(ud, 'extensions-data', 'webviews.json')
  const persistedRaw = JSON.parse(await readFile(persistedPath, 'utf8')) as {
    version: number
    panels: { panelId: string; token: string; state: unknown; viewType: string }[]
  }
  check('webviews.json 已写盘', persistedRaw.version === 1 && persistedRaw.panels.length === 1, JSON.stringify(persistedRaw))
  const saved = persistedRaw.panels[0]
  check('磁盘记录沿用 panelId', saved?.panelId === beforeRestart.panelId, String(saved?.panelId))
  check('磁盘记录沿用 token', saved?.token === beforeRestart.token, String(saved?.token))
  check(
    '磁盘记录保存 webview.state',
    JSON.stringify(saved?.state) === JSON.stringify({ note: 'saved-state', n: 9 }),
    JSON.stringify(saved?.state)
  )

  service = await initExtensions({ appVersion: APP_VERSION })
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await service.startup()

  const restored = await waitForState(value => value.restores >= 1, 12000)
  check('序列化器被调用一次', restored?.restores === 1, String(restored?.restores))
  check(
    'deserializeWebviewPanel 拿到保存的 state',
    JSON.stringify(restored?.restoreStates[0]) === JSON.stringify({ note: 'saved-state', n: 9 }),
    JSON.stringify(restored?.restoreStates)
  )
  check('恢复后面板沿用 panelId', restored?.panelId === beforeRestart.panelId, String(restored?.panelId))
  check('恢复后面板沿用 token', restored?.token === beforeRestart.token, String(restored?.token))

  const restoredFrame = await iframeInfo()
  check(
    '恢复的 iframe 仍指向同一 token',
    restoredFrame.src.includes(`token=${beforeRestart.token}`),
    restoredFrame.src
  )
  check(
    '恢复后 iframe 重新收到 bootstrap',
    await waitForState(
      value =>
        value.restores >= 1 &&
        value.messages.filter(m => m.kind === 'bootstrap').length >= 1,
      8000
    ).then(Boolean)
  )
  await service.executeCommand('test.webview.post', [{ kind: 'after-restore', value: 1 }])
  const afterRestore = await waitForState(value =>
    value.messages.some(m => m.kind === 'ack' && m.value?.kind === 'after-restore')
  )
  check('恢复后消息仍然往返', !!afterRestore, JSON.stringify(afterRestore?.messages))

  // ---------- 6. 关闭 ----------

  console.log('\n【6】panel.dispose()：DOM、扩展事件与 token 一起失效')
  await service.executeCommand('test.webview.dispose')
  check(
    'iframe 从 DOM 移除',
    await waitFor(`document.querySelectorAll('iframe.webview-frame').length === 0`)
  )
  const disposed = await waitForState(value => value.disposed >= 1)
  check('扩展收到 onDidDispose', disposed?.disposed === 1, String(disposed?.disposed))
  const stale = await net.fetch(entryUrl)
  check('关闭后旧 token 的资源请求 403', stale.status === 403, String(stale.status))
  const afterDispose = JSON.parse(await readFile(persistedPath, 'utf8')) as { panels: unknown[] }
  await sleep(400)
  const finalDisk = JSON.parse(await readFile(persistedPath, 'utf8')) as { panels: unknown[] }
  check(
    '关闭后持久化列表为空',
    finalDisk.panels.length === 0,
    JSON.stringify({ before: afterDispose.panels.length, after: finalDisk.panels.length })
  )

  await shutdownExtensions()
  console.log(`\n${pass} 通过, ${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
