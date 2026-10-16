/**
 * 阶段四验收:**编辑器扩展点**与**主界面扩展点**。
 *
 * 三组:
 *   A 编辑器(读/改/装饰/样式)—— 沙箱插件走 ops,断言落在真渲染层的 DOM 上
 *   B 界面注入(仅脚本插件)—— mount / 点击回执 / 停用后收走
 *   C 停靠面板(沙箱插件)—— 建视图、按渲染层报的矩形摆、停用后消失
 *   D 权限与形态的边界 —— 谁能声明什么、谁能调什么
 *
 * 跑法:node verify/run.mjs phase4
 *
 * 注意:**改了 src/preload 或 src/renderer 之后要先跑一次 `npx electron-vite build`** ——
 * 渲染层与 preload 走的是 out/ 里的构建产物(见 verify/run.mjs 顶部的说明)。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerPluginScheme, pluginSurfaceInfoOf, pluginWebContentsOf } from '../src/main/plugins/windows'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { pluginDir, setRecord } from '../src/main/plugins/installed'
import { invokeOp } from '../src/main/plugins/gate'
import { validateManifest } from '../src/shared/pluginPackage'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import type { OpContext } from '../src/main/plugins/ops'

registerPluginScheme()

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

// ---------- 测试插件 ----------

/** 沙箱插件:读、改、装饰、注入样式,外加一个停靠面板 */
const SANDBOX_MAIN = `
const imark = window.imark
imark.plugin.handle({
  onEnable() {
    imark.setState({ status: 'ok', lastMessage: 'ready' })
  },
  runAction(id) { return { ok: true, message: 'ran ' + id } }
})
`

const SCRIPT_PLUGIN_SOURCE = `
let clicks = []
module.exports = imk => ({
  onEnable() {
    imk.ui.mount({
      id: 'panel',
      side: 'right',
      title: '来自脚本插件的面板',
      html: '<p id="hello">你好 <button data-imk-click="ping">点我</button></p>'
    })
    imk.ui.injectStyles('.boxed { color: rgb(1, 2, 3) }')
    imk.ui.onClick('panel', name => {
      clicks.push(name)
      imk.setState({ status: 'ok', lastMessage: 'clicked:' + clicks.join(',') })
    })
  },
  runAction() { return { ok: true, message: 'clicks:' + clicks.join(',') } }
})
`

const SANDBOX_MANIFEST = {
  id: 'p4-sandbox',
  name: '阶段四沙箱插件',
  description: '验收用',
  version: '1.0.0',
  kind: 'sandboxed',
  main: 'main.js',
  ui: { entry: 'ui/index.html', dock: 'right', width: 300, height: 200 },
  permissions: ['ui', 'editor:read', 'editor:write'],
  fields: [],
  actions: [{ id: 'report', label: '报告' }]
}

const SCRIPT_MANIFEST = {
  id: 'p4-script',
  name: '阶段四脚本插件',
  description: '验收用',
  version: '1.0.0',
  kind: 'script',
  main: 'main.js',
  permissions: ['editor:read'],
  fields: [],
  actions: [{ id: 'report', label: '报告' }]
}

async function writePlugin(id: string, manifest: unknown, main: string, extra?: Record<string, string>): Promise<void> {
  const dir = pluginDir(id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'main.js'), main, 'utf8')
  for (const [rel, content] of Object.entries(extra ?? {})) {
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    await writeFile(join(dir, rel), content, 'utf8')
  }
  await setRecord({
    id,
    version: '1.0.0',
    kind: (manifest as { kind: 'script' | 'sandboxed' }).kind,
    integrity: 'x'.repeat(64),
    mainSha256: null,
    publisher: null,
    // 手动安装 = 声明即授权(见 host.ts 的 effectiveGrantsOf)
    source: 'local',
    registryUrl: null,
    installedAt: Date.now(),
    grantedPermissions: ((manifest as { permissions?: string[] }).permissions ?? []) as never[]
  })
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
  const note = join(vault, '笔记.md')
  await writeFile(note, 'hello world\n第二行\n', 'utf8')

  await writePlugin('p4-sandbox', SANDBOX_MANIFEST, SANDBOX_MAIN, {
    'ui/index.html':
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/__imark/ui.css"></head>' +
      '<body><p>插件面板</p><script type="module" src="/main.js"></script></body></html>'
  })
  await writePlugin('p4-script', SCRIPT_MANIFEST, SCRIPT_PLUGIN_SOURCE)

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: note,
        autoSave: false,
        marketUrl: '',
        plugins: {
          'p4-sandbox': { enabled: true, config: {} },
          'p4-script': { enabled: true, config: {} }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  const host = await initPluginHost()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  // 等渲染层把仓库、文档、插件列表都装上
  await sleep(2500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const entries = (host as unknown as { entries: Map<string, unknown> }).entries
  const ctxOf = (id: string): OpContext =>
    (host as unknown as { opContextFor(e: unknown): OpContext }).opContextFor(entries.get(id))
  const opAs = (id: string, op: string, args?: unknown) =>
    invokeOp(ctxOf(id), op, args, { source: id === 'p4-script' ? 'trusted' : 'sandbox' })

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  // ---------- A 编辑器扩展点 ----------

  console.log('\n[A] 编辑器扩展点')
  const read = await opAs('p4-sandbox', 'editor.read')
  check('编辑器打开了文档', read.ok && (read.value as { open: boolean }).open === true, JSON.stringify(read).slice(0, 160))
  check(
    '读到的是正文',
    read.ok && (read.value as { text: string }).text.startsWith('hello world'),
    read.ok ? JSON.stringify((read.value as { text: string }).text.slice(0, 40)) : ''
  )

  const denied = await opAs('p4-script', 'editor.replace', { from: 0, to: 0, text: 'x' })
  check(
    '没声明 editor:write 的插件改不了文档',
    denied.ok === false && denied.error.code === 'E_PERMISSION',
    JSON.stringify(denied)
  )

  // 装饰:加标记 → DOM 里应出现带归属属性的元素
  const deco = await opAs('p4-sandbox', 'editor.decorate', {
    decorations: [
      { from: 0, to: 5, class: 'p4-mark' },
      { from: 6, to: 11, class: 'p4-mark' }
    ]
  })
  check('装饰调用被受理', deco.ok === true, JSON.stringify(deco))
  const marksInDom = await evalJs<number>(`document.querySelectorAll('.cm-content [data-imk-plugin="p4-sandbox"]').length`)
  check('装饰真的画到了正文上', marksInDom === 2, `DOM 里 ${marksInDom} 个`)

  // 映射:在装饰**前面**插字,标记必须跟着走(而不是错位一格)
  const inserted = await opAs('p4-sandbox', 'editor.replace', { from: 0, to: 0, text: 'X' })
  check('插入文本成功', inserted.ok === true, JSON.stringify(inserted))
  await sleep(200)
  const afterInsert = await evalJs<string>(
    `(document.querySelector('.cm-content [data-imk-plugin="p4-sandbox"]') || {}).textContent || ''`
  )
  check('装饰跟着文档一起移动(位置被映射过,没有错位)', afterInsert === 'hello', `现在盖住的是「${afterInsert}」`)

  // 样式:必须被 @scope 圈住
  await opAs('p4-sandbox', 'editor.styles', { css: '.p4-mark { background: red }' })
  const styleContent = await evalJs<string>(
    `(document.querySelector('style[data-imk-plugin="style-p4-sandbox"]') || {}).textContent || ''`
  )
  check('注入的样式被 @scope 圈在插件自己的元素里', styleContent.includes('@scope ([data-imk-plugin="p4-sandbox"])'), styleContent.slice(0, 80))
  const scoped = await evalJs<string>(
    `getComputedStyle(document.body).backgroundColor !== 'rgb(255, 0, 0)' ? 'ok' : 'leaked'`
  )
  check('样式没有漏到插件之外的元素上', scoped === 'ok')

  // 清装饰
  await opAs('p4-sandbox', 'editor.clearDecorations')
  await sleep(200)
  const cleared = await evalJs<number>(`document.querySelectorAll('.cm-content [data-imk-plugin="p4-sandbox"]').length`)
  check('clearDecorations 把标记收干净', cleared === 0, `还剩 ${cleared} 个`)

  // ---------- B 界面注入(仅脚本插件) ----------

  console.log('\n[B] 界面注入')
  const mounted = await waitFor(`document.querySelector('[data-imk-mount="panel"]')`)
  check('脚本插件挂的界面出现在主界面里', mounted)
  const header = await evalJs<string>(
    `(document.querySelector('[data-imk-mount="panel"]')?.closest('.plugin-panel')?.querySelector('.plugin-panel-kind') || {}).textContent?.trim() || ''`
  )
  check('面板顶栏标出了形态(脚本插件)', header === '脚本插件', header)
  const injectedStyle = await evalJs<string>(
    `(document.querySelector('style[data-imk-plugin="style-p4-script"]') || {}).textContent || ''`
  )
  check('注入的 CSS 同样被 @scope 圈住', injectedStyle.includes('@scope ([data-imk-plugin="p4-script"])'))

  // 点击回执
  await evalJs(`document.querySelector('[data-imk-click="ping"]').click()`)
  await sleep(400)
  const clickView = (await host.list()).find(p => p.descriptor.id === 'p4-script')
  check(
    '注入界面里的点击回到了插件代码里',
    (clickView?.state.lastMessage ?? '').includes('clicked:ping'),
    clickView?.state.lastMessage
  )

  // 沙箱插件不许挂界面
  const sandboxMount = await opAs('p4-sandbox', 'ui.mount', { id: 'x', html: '<p>x</p>' })
  check(
    '沙箱插件不能用 ui.mount(它有自己的一整套页面)',
    sandboxMount.ok === false && sandboxMount.error.code === 'E_PERMISSION',
    JSON.stringify(sandboxMount).slice(0, 160)
  )

  // ---------- C 停靠面板 ----------

  console.log('\n[C] 停靠面板')
  const info = pluginSurfaceInfoOf('p4-sandbox')
  check('沙箱插件建的是停靠视图(不是独立窗口)', info?.kind === 'docked', JSON.stringify(info))
  const slotInDom = await waitFor(`document.querySelector('[data-dock-slot="p4-sandbox"]')`)
  check('主界面上留出了槽位', slotInDom)
  check(
    '停靠视图已经摆到槽位上(可见)',
    (await waitFor(`true`, 1500)) && pluginSurfaceInfoOf('p4-sandbox')?.visible === true,
    JSON.stringify(pluginSurfaceInfoOf('p4-sandbox'))
  )
  const bounds = pluginSurfaceInfoOf('p4-sandbox')?.bounds
  check(
    '视图的尺寸来自渲染层报的槽位(不是 0×0)',
    Boolean(bounds && bounds.width > 50 && bounds.height > 50),
    JSON.stringify(bounds)
  )
  const slotMatches = await evalJs<boolean>(`(() => {
    const el = document.querySelector('[data-dock-slot="p4-sandbox"]')
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.x > 0 && r.width > 50
  })()`)
  check('槽位在窗口里的位置是合理的(右侧栏)', slotMatches)

  // 停用 → 视图消失
  await host.save('p4-sandbox', { enabled: false })
  check(
    '停用后停靠视图被摘掉',
    (await waitFor(`true`, 800)) && pluginSurfaceInfoOf('p4-sandbox') === null,
    JSON.stringify(pluginSurfaceInfoOf('p4-sandbox'))
  )

  // ---------- D 形态与权限的边界 ----------

  console.log('\n[D] 形态与权限的边界')
  check(
    '脚本插件不能声明 ui(它没有页面)',
    (() => {
      const r = validateManifest({ ...SCRIPT_MANIFEST, permissions: ['ui'] })
      return r.ok === false && r.errors.some(e => e.includes('ui'))
    })()
  )
  check(
    '脚本插件**可以**声明 editor:read(编辑器扩展点对两种形态都开放)',
    validateManifest({ ...SCRIPT_MANIFEST, permissions: ['editor:read', 'editor:write'] }).ok === true
  )
  check(
    '声明式插件不能声明 editor:read(它没有代码)',
    (() => {
      const r = validateManifest({
        id: 'p4-decl',
        name: 'x',
        description: '',
        version: '1.0.0',
        kind: 'declarative',
        capability: 'webhook',
        permissions: ['editor:read'],
        fields: [{ key: 'targets', kind: 'targets', label: 't', default: [] }],
        actions: [{ id: 'test', label: 'test' }],
        targetActions: [{ id: 'test-target', label: 'tt' }],
        targetFieldKey: 'targets'
      })
      return r.ok === false && r.errors.some(e => e.includes('editor:read'))
    })()
  )
  check(
    'ui.dock 只认三侧',
    validateManifest({ ...SANDBOX_MANIFEST, ui: { entry: 'ui/index.html', dock: 'middle' } }).ok === false
  )
  const dockView = (await host.list()).find(p => p.descriptor.id === 'p4-sandbox')
  check('插件视图里带着停靠信息(界面据此留位置)', dockView?.dock === 'right' && dockView?.dockWidth === 300, JSON.stringify({ dock: dockView?.dock, w: dockView?.dockWidth }))

  // 脚本插件停用后,它挂的界面与样式都要被收走
  await host.save('p4-script', { enabled: false })
  const cleaned = await waitFor(`!document.querySelector('[data-imk-mount="panel"]')`, 3000)
  check('脚本插件停用后,它挂的界面被收走', cleaned)
  const styleGone = await evalJs<boolean>(`!document.querySelector('style[data-imk-plugin="style-p4-script"]')`)
  check('它注入的样式也被收走', styleGone)

  check('停用后插件页(renderer)也一起没了', pluginWebContentsOf('p4-sandbox') === null)

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
