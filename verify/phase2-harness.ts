/**
 * 阶段二(槽位 + 宿主能力 API + 事件钩子)验收。
 *
 * 这一轮加的东西**大多要真跑才显形**:状态栏条目、命令面板、原生菜单里的快捷键、
 * 右键菜单、事件钩子、通知气泡 —— 全是"渲染层与主进程各拿一半"的东西。
 * 所以分两半:
 *   A 纯函数(清单校验 / 可用性判定 / 贡献点登记表)—— 不建窗口就能判
 *   B 真跑(两个开发目录插件:一个全走 API,一个全走清单)
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs phase2
 *
 * **测不到的一段(诚实说明)**:本机没装 xdotool,注入不了 OS 级按键,所以
 * 「原生加速键真的按下去会触发」这一环模拟不了。harness 的做法是**找到那个菜单项
 * 并调用它的 click()** —— 从菜单项往后(发 IPC → 渲染层 → 宿主执行)全都是真的,
 * 只有"Electron 收到物理按键并挑中这一项"属于框架职责,交给框架。
 */

import { app, dialog, Menu, protocol, type BrowserWindow, type MenuItem } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  KEYBINDING_RE,
  canonicalManifest,
  validateManifest,
  type PluginManifest
} from '../src/shared/pluginPackage'
import { commandAvailable } from '../src/shared/plugins'
import {
  ContribRegistry,
  checkCommand,
  checkMenuItem,
  checkStatusItem
} from '../src/main/plugins/contrib'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import {
  getPluginHost,
  initPluginHost,
  type PluginHost
} from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { IPC } from '../src/shared/ipc-channels'
import {
  createMainWindow,
  getMainWindow,
  setCurrentDocPath,
  setEditorPresent
} from '../src/main/window'

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

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'imark',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// ---------------------------------------------------------------- A 纯函数

/** 一份合法清单的底子,各用例在它上面改一处 */
function manifest(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'probe',
    name: '探针',
    description: '',
    version: '1.0.0',
    kind: 'script',
    fields: [],
    actions: [{ id: 'do-it', label: '干活' }],
    main: 'main.js',
    ...over
  }
}

function pureChecks(): void {
  console.log('\n[A] 清单里的新槽位')

  const ok = validateManifest(
    manifest({
      commands: [{ id: 'c1', label: '命令', action: 'do-it', keybinding: 'Ctrl+Alt+1', when: 'editor' }],
      statusBar: [{ id: 's1', label: '状态', icon: 'zap', tooltip: 't', action: 'do-it' }],
      menus: [{ id: 'm1', label: '菜单', where: 'files', action: 'do-it', danger: true }]
    })
  )
  check('三样槽位齐全时清单合法', ok.ok, ok.errors.join(';'))

  const noAction = validateManifest(
    manifest({ commands: [{ id: 'c1', label: '命令' }] })
  )
  check(
    '命令缺 action → 报错(清单里的东西必须装的时候就能执行)',
    !noAction.ok && noAction.errors.some(e => e.includes('action')),
    noAction.errors.join(';')
  )

  const danglingAction = validateManifest(
    manifest({ menus: [{ id: 'm1', label: '菜单', where: 'files', action: 'nope' }] })
  )
  check(
    'action 指向未声明的动作 → 报错并点名',
    !danglingAction.ok && danglingAction.errors.some(e => e.includes('nope')),
    danglingAction.errors.join(';')
  )

  const twoStatus = validateManifest(
    manifest({
      statusBar: [
        { id: 's1', label: '甲', action: 'do-it' },
        { id: 's2', label: '乙', action: 'do-it' }
      ]
    })
  )
  check(
    '状态栏两条 → 报错(一个插件最多占一格)',
    !twoStatus.ok && twoStatus.errors.some(e => e.includes('最多 1 条')),
    twoStatus.errors.join(';')
  )

  const editorMenu = validateManifest(
    manifest({ menus: [{ id: 'm1', label: '菜单', where: 'editor', action: 'do-it' }] })
  )
  check(
    'menus.where=editor → 报错(编辑器右键菜单还没做,先别放出一个点不着的取值)',
    !editorMenu.ok && editorMenu.errors.some(e => e.includes('where')),
    editorMenu.errors.join(';')
  )

  const badKeybinding = validateManifest(
    manifest({ commands: [{ id: 'c1', label: '命令', action: 'do-it', keybinding: 'Ctrl+' }] })
  )
  check(
    'keybinding 形状不对 → 报错',
    !badKeybinding.ok && badKeybinding.errors.some(e => e.includes('keybinding')),
    badKeybinding.errors.join(';')
  )

  console.log('\n[A] 清单键序(integrity 的输入形状)')
  const rebuilt = canonicalManifest(
    manifest({
      commands: [{ id: 'c1', label: '命令', action: 'do-it' }],
      statusBar: [],
      menus: []
    }) as unknown as PluginManifest
  )
  const keys = Object.keys(rebuilt).join(',')
  check(
    '既有键的**相对顺序**没变(新键追在末尾)',
    keys.startsWith('id,name,description,version,kind,fields,actions,main'),
    keys
  )
  check('新键排在最后三位', keys.endsWith('commands,statusBar,menus'), keys)
  const noSlots = canonicalManifest(manifest({}) as unknown as PluginManifest)
  check(
    '没声明槽位时不补空数组(补了的话既有包算出的 integrity 全变)',
    !('commands' in noSlots) && !('statusBar' in noSlots) && !('menus' in noSlots),
    JSON.stringify(Object.keys(noSlots))
  )

  console.log('\n[A] 命令的可用性判定')
  const none = { hasEditor: false, hasVault: false }
  const both = { hasEditor: true, hasVault: true }
  check('always 永远可用', commandAvailable('always', none) && commandAvailable('always', both))
  check('不填 = always', commandAvailable(undefined, none))
  check('editor 没文档时不可用', !commandAvailable('editor', none))
  check('editor 有文档时可用', commandAvailable('editor', { hasEditor: true, hasVault: false }))
  check('vault 没仓库时不可用', !commandAvailable('vault', { hasEditor: true, hasVault: false }))
  check('vault 有仓库时可用', commandAvailable('vault', both))

  console.log('\n[A] 贡献点登记表')
  const reg = new ContribRegistry()
  const bad = reg.addCommand({ id: 'Bad Id!', label: 'x' })
  check('命令 id 非法 → 被拒', !bad.ok && bad.errors.length > 0, JSON.stringify(bad))
  const noLabel = reg.addCommand({ id: 'c1', label: '   ' })
  check('命令 label 全空格 → 被拒', !noLabel.ok)
  const longLabel = reg.addCommand({ id: 'c1', label: '字'.repeat(60) })
  check(
    '命令 label 过长 → 拒掉并说清上限(与清单那条路的判定一致)',
    !longLabel.ok && longLabel.errors.some(e => e.includes('40')),
    longLabel.ok ? '竟然通过了' : longLabel.errors.join(';')
  )

  const reg2 = new ContribRegistry()
  reg2.addCommand({ id: 'c1', label: '第一次' })
  reg2.addCommand({ id: 'c1', label: '第二次' })
  check(
    '同 id 的命令 = 覆盖,不是两条',
    reg2.merge(null).commands.length === 1 && reg2.merge(null).commands[0]?.label === '第二次',
    JSON.stringify(reg2.merge(null).commands)
  )

  const reg3 = new ContribRegistry()
  reg3.setStatusItem({ id: 's1', label: '甲', icon: 'zap' })
  reg3.setStatusItem({ id: 's2', label: '乙', icon: 'star' })
  check(
    '状态栏是抢位:第二次调用替换而不是新增',
    reg3.merge(null).statusItem?.label === '乙' && reg3.merge(null).statusItem?.id === 's2',
    JSON.stringify(reg3.merge(null).statusItem)
  )
  reg3.setStatusItem(null)
  check('传 null 收回状态栏条目', reg3.merge(null).statusItem === null)

  const reg4 = new ContribRegistry()
  const badIcon = reg4.setStatusItem({ id: 's1', label: '甲', icon: '<script>' })
  check('状态栏 icon 不是图标名 → 被拒', badIcon.problems.length > 0, badIcon.problems.join(';'))
  const badWhere = reg4.addMenuItem({ id: 'm1', label: '甲', where: 'editor' as never })
  check('右键菜单 where 非 files → 被拒', badWhere.problems.length > 0, badWhere.problems.join(';'))

  console.log('\n[A] 运行期注册的快捷键也要校验')
  check('形状合法的快捷键过', checkCommand({ id: 'c1', label: 'x', keybinding: 'Ctrl+Shift+P' }).length === 0)
  check(
    '形状不合法的快捷键被挡(它会直接递给 Electron 原生菜单)',
    checkCommand({ id: 'c1', label: 'x', keybinding: 'Ctrl+' }).length > 0
  )
  check('KEYBINDING_RE 认 CmdOrCtrl', KEYBINDING_RE.test('CmdOrCtrl+Alt+P'))
  check('KEYBINDING_RE 不认裸字母', !KEYBINDING_RE.test('P'))
  check('checkStatusItem 认得合法条目', checkStatusItem({ id: 's1', label: '甲', icon: 'zap' }).length === 0)
  check('checkMenuItem 认得合法条目', checkMenuItem({ id: 'm1', label: '甲', where: 'files' }).length === 0)

  console.log('\n[A] 执行体按槽位分表(id 可以同名)')
  const reg5 = new ContribRegistry()
  const cmdFn = (): number => 1
  const menuFn = (): number => 2
  reg5.addCommand({ id: 'same', label: '命令' }, cmdFn)
  reg5.addMenuItem({ id: 'same', label: '菜单', where: 'files' }, menuFn)
  check(
    '同名命令与菜单各自拿到自己的执行体',
    reg5.handlerFor('command', 'same') === cmdFn && reg5.handlerFor('menu', 'same') === menuFn
  )
  reg5.resetApi()
  check(
    '停用时整体清空(清单声明的那份不受影响,它是现读 manifest 的)',
    reg5.handlerFor('command', 'same') === undefined && reg5.merge(null).commands.length === 0
  )
}

// ---------------------------------------------------------------- 开发目录插件

/** 探针 A:槽位全部走 API(imk.commands.register / imk.ui.statusItem / imk.on) */
const PLUGIN_A_MAIN = `module.exports = function (imk) {
  var counts = {}
  var last = {}

  function bump(name) {
    counts[name] = (counts[name] || 0) + 1
    imk.setState({ counts: Object.assign({}, counts) })
  }
  function remember(name, payload) {
    counts[name] = (counts[name] || 0) + 1
    last[name] = payload
    imk.setState({ counts: Object.assign({}, counts), last: Object.assign({}, last) })
  }

  return {
    onEnable: function () {
      imk.log('info', '探针 A 起来了')
      imk.ui.notify('探针 A 起来了', 'success')

      imk.ui.statusItem(
        { id: 'a-status', label: '探针A', icon: 'zap', tooltip: '探针 A 的状态' },
        function () { bump('statusClick') }
      )

      // 命令与快捷键。快捷键要能真的挂到原生菜单上(见 harness 的原生菜单断言)
      imk.commands.register(
        { id: 'a-hello', label: '打招呼', detail: 'harness 用', keybinding: 'Ctrl+Alt+9' },
        function (ctx) { remember('a-hello', ctx); imk.ui.notify('你好,我是探针 A', 'info') }
      )
      // 只在有文档时可用(验菜单项的灰/亮)
      imk.commands.register(
        { id: 'a-needs-editor', label: '要文档', when: 'editor' },
        function (ctx) { remember('a-needs-editor', ctx) }
      )
      // 故意抢应用已占用的 Ctrl+S:应当被摘掉快捷键,但命令本身还在
      imk.commands.register(
        { id: 'a-steal-save', label: '想抢保存', keybinding: 'CmdOrCtrl+S' },
        function () { bump('stealSave') }
      )
      // 一次性发 15 条通知:验限流
      imk.commands.register({ id: 'a-burst', label: '刷屏' }, function () {
        for (var i = 0; i < 15; i++) imk.ui.notify('刷屏 ' + i, 'info')
      })
      imk.commands.register({ id: 'a-status-off', label: '收起状态栏' }, function () {
        imk.ui.statusItem(null)
      })
      // 图标名不在宿主的白名单里:应当退化成纯文字,而不是让宿主去渲染一个它不认识的东西
      imk.commands.register({ id: 'a-status-weird', label: '换个怪图标' }, function () {
        imk.ui.statusItem({ id: 'a-status', label: '怪图标', icon: 'not-in-the-list' })
      })

      imk.commands.menuItem({ id: 'a-files', label: '用探针 A 处理', where: 'files' }, function (ctx) {
        remember('a-files', ctx)
      })

      imk.on('document:save', function (p) { remember('document:save', p) })
      imk.on('document:change', function (p) { remember('document:change', p) })
      imk.on('file:open', function (p) { remember('file:open', p) })
      imk.on('vault:change', function (p) { remember('vault:change', p) })
      imk.on('theme:change', function (p) { remember('theme:change', p) })
      imk.on('config:change', function (p) { remember('config:change', p) })
      imk.log('info', '探针 A 注册完毕')
    },
    onDisable: function () {
      imk.log('info', '探针 A 停了')
    },
    runAction: function (actionId) {
      return { ok: true, message: 'A 收到 ' + actionId }
    }
  }
}
`

/** 探针 B:槽位全部写在清单里,代码里只有 runAction */
const PLUGIN_B_MAIN = `module.exports = function (imk) {
  var counts = {}
  var last = {}
  function bump(name, payload) {
    counts[name] = (counts[name] || 0) + 1
    last[name] = payload
    imk.setState({ counts: Object.assign({}, counts), last: Object.assign({}, last) })
  }
  return {
    onEnable: function () {
      imk.on('config:change', function (p) { bump('config:change', p) })
      imk.on('document:save', function (p) { bump('document:save', p) })
    },
    runAction: function (actionId, ctx, targetId, payload) {
      bump('runAction', { actionId: actionId, payload: payload, targetId: targetId })
      return { ok: true, message: 'B 收到 ' + actionId }
    }
  }
}
`

async function writePlugin(
  dir: string,
  manifestJson: Record<string, unknown>,
  mainJs: string
): Promise<string> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestJson, null, 2), 'utf8')
  await writeFile(join(dir, 'main.js'), mainJs, 'utf8')
  return dir
}

// ---------------------------------------------------------------- B 真跑

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

  pureChecks()

  await app.whenReady()

  // 原生对话框全部 stub 掉:这一轮不该弹出任何需要人点的东西
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
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '第一行\n', 'utf8')
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

  const dirA = await writePlugin(
    join(ud, 'devA'),
    {
      id: 'phase2a',
      name: '阶段二探针A',
      description: 'harness 用:槽位全部走 API',
      version: '1.0.0',
      kind: 'script',
      fields: [{ key: 'note', kind: 'text', label: '备注', default: '' }],
      actions: [],
      main: 'main.js'
    },
    PLUGIN_A_MAIN
  )
  const dirB = await writePlugin(
    join(ud, 'devB'),
    {
      id: 'phase2b',
      name: '阶段二探针B',
      description: 'harness 用:槽位全部写在清单里',
      version: '1.0.0',
      kind: 'script',
      fields: [],
      actions: [{ id: 'b-do', label: '清单动作' }],
      commands: [
        {
          id: 'b-cmd',
          label: '清单命令',
          detail: '写在清单里的',
          action: 'b-do',
          keybinding: 'Ctrl+Alt+8',
          when: 'editor'
        }
      ],
      statusBar: [
        { id: 'b-status', label: '清单', icon: 'star', tooltip: '清单声明的状态条目', action: 'b-do' }
      ],
      menus: [{ id: 'b-menu', label: '清单菜单项', where: 'files', action: 'b-do' }],
      main: 'main.js'
    },
    PLUGIN_B_MAIN
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned, [dirA, dirB])
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1800)

  const host = getPluginHost() as PluginHost
  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  type State = {
    counts?: Record<string, number>
    last?: Record<string, unknown>
    enabled?: boolean
  }
  const viewOf = async (id: string): Promise<{ state: State; logs: string[] } | undefined> => {
    const list = await host.list()
    const v = list.find(x => x.descriptor.id === id)
    return v ? { state: v.state as unknown as State, logs: (v.logs ?? []) as string[] } : undefined
  }
  const countOf = async (id: string, name: string): Promise<number> =>
    (await viewOf(id))?.state.counts?.[name] ?? 0

  /** 每次页面重载后都要重做的事:把 alert 关进笼子,否则真弹一个会卡死整个渲染进程 */
  await evalJs(`(() => {
    window.__alerts = []
    window.alert = m => { window.__alerts.push(String(m)) }
    return true
  })()`)

  const toasts = (): Promise<string[]> =>
    evalJs<string[]>(
      `Array.from(document.querySelectorAll('.toast')).map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim())`
    )

  /** 贡献点快照(渲染层手里的那一份,不是主进程的) */
  const snapshot = (): Promise<{ contribs: unknown[]; context: Record<string, boolean> }> =>
    evalJs(`window.api.getPluginContribs()`)

  // ---- 两个探针都起来了 ----
  console.log('\n[B] 开发目录里的两个探针')
  const a = await viewOf('phase2a')
  const b = await viewOf('phase2b')
  check('探针 A 在插件列表里', a !== undefined)
  check('探针 A 已启用且没有加载错误', a?.state.enabled === true, JSON.stringify(a?.state))
  check('探针 B 在插件列表里', b !== undefined)
  check('探针 B 已启用且没有加载错误', b?.state.enabled === true, JSON.stringify(b?.state))
  check(
    '探针 A 的 onEnable 跑到注册完成那一步',
    (a?.logs ?? []).some(l => l.includes('注册完毕')),
    (a?.logs ?? []).join(' | ')
  )

  // ---- 通知 ----
  console.log('\n[B] 通知:右下角气泡带插件名')
  // onEnable 里那条通知发生在**建窗之前**,没地方可画,只能丢掉并留一句日志
  check(
    '窗口还没起来时发的通知被记了一笔(而不是无声消失)',
    (await viewOf('phase2a'))?.logs.some(l => l.includes('界面还没就绪')) === true,
    JSON.stringify((await viewOf('phase2a'))?.logs)
  )
  // 现在有窗口了:再让它发一条
  await host.invokeContrib({ pluginId: 'phase2a', itemId: 'a-hello', from: 'command' })
  await sleep(500)
  const t1 = await toasts()
  check('气泡出现了', t1.length > 0, JSON.stringify(t1))
  check(
    '气泡里写明了是谁发的(插件名)',
    t1.some(x => x.includes('阶段二探针A')),
    JSON.stringify(t1)
  )
  check('气泡内容就是插件说的那句', t1.some(x => x.includes('你好,我是探针 A')), JSON.stringify(t1))
  await evalJs(`(() => {
    Array.from(document.querySelectorAll('.toast-close')).forEach(b => b.click())
    return true
  })()`)
  await sleep(200)

  // ---- 状态栏 ----
  console.log('\n[B] 状态栏条目')
  /** 状态栏按钮里没有文字(认得出图标就只画图标),所以判断依据是 title */
  const statusTitles = (): Promise<string[]> =>
    evalJs<string[]>(
      `Array.from(document.querySelectorAll('.status-plug')).map(el => el.getAttribute('title') || '')`
    )
  const statusTexts = (): Promise<string[]> =>
    evalJs<string[]>(
      `Array.from(document.querySelectorAll('.status-plug')).map(el => (el.textContent || '').trim())`
    )
  check(
    'API 注册的状态条目在状态栏上',
    (await statusTitles()).some(x => x.includes('探针 A 的状态')),
    JSON.stringify(await statusTitles())
  )
  check(
    '清单声明的状态条目也在',
    (await statusTitles()).some(x => x.includes('清单声明的状态条目')),
    JSON.stringify(await statusTitles())
  )
  const snap = await snapshot()
  check(
    '主进程下发的上下文 = 真的开着仓库、开着文档',
    snap.context.hasVault === true && snap.context.hasEditor === true,
    JSON.stringify(snap.context)
  )

  // 点一下:状态条目自己带的回调要被调用(API 注册的条目不必绕回 runAction)
  const clickedStatus = await evalJs<boolean>(`(() => {
    const el = Array.from(document.querySelectorAll('.status-plug')).find(x => (x.getAttribute('title') || '').includes('探针 A 的状态'))
    if (!el) return false
    el.click()
    return true
  })()`)
  check('找到并点到了那条状态条目', clickedStatus)
  await sleep(500)
  check(
    '点状态栏条目 → 插件注册的那个回调跑了',
    (await countOf('phase2a', 'statusClick')) === 1,
    String(await countOf('phase2a', 'statusClick'))
  )

  // 图标白名单:认不出的名字退化成纯文字
  await host.invokeContrib({ pluginId: 'phase2a', itemId: 'a-status-weird', from: 'command' })
  await sleep(400)
  const textPlugs = await evalJs<number>(`document.querySelectorAll('.status-plug-text').length`)
  check(
    '图标名不在白名单里 → 退化成纯文字(不给插件"让宿主渲染任意东西"的口子)',
    textPlugs >= 1,
    String(textPlugs)
  )
  check(
    '退化之后标签照样看得见',
    (await statusTexts()).some(x => x.includes('怪图标')),
    JSON.stringify(await statusTexts())
  )

  // ---- 命令面板 ----
  console.log('\n[B] 命令面板(快捷键 Ctrl+Alt+P 的那一项)')
  // 原生加速键注入不了(没有 xdotool),这里发的是菜单项 click 时会发的那条 IPC
  getMainWindow()?.webContents.send(IPC.MenuCommand, 'view:command-palette')
  const opened = await waitFor(`document.querySelector('.switcher-input')`)
  check('面板打开了', opened)
  const placeholder = await evalJs<string>(
    `document.querySelector('.switcher-input')?.getAttribute('placeholder') ?? ''`
  )
  check('直接落在命令模式(替用户打上了 >)', placeholder.includes('命令名'), placeholder)
  const items = (): Promise<string[]> =>
    evalJs<string[]>(
      `Array.from(document.querySelectorAll('.switcher-item')).map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim())`
    )
  const listed = await items()
  check(
    'API 注册的命令出现在面板里',
    listed.some(x => x.includes('打招呼')),
    JSON.stringify(listed)
  )
  check(
    '清单声明的命令也出现在面板里',
    listed.some(x => x.includes('清单命令')),
    JSON.stringify(listed)
  )
  check(
    '条目上标了是哪个插件提供的',
    listed.some(x => x.includes('打招呼') && x.includes('阶段二探针A')),
    JSON.stringify(listed)
  )

  // 搜索:按插件名也能搜到(作者记不住命令叫什么)
  await evalJs(`(() => {
    const el = document.querySelector('.switcher-input')
    el.value = '> 探针B'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(200)
  const searched = await items()
  check(
    '按插件名搜索能搜到那个插件的命令',
    searched.some(x => x.includes('清单命令')),
    JSON.stringify(searched)
  )

  // 点一条:走的是"渲染层 → 主进程 → 插件执行体"那条真路
  await evalJs(`(() => {
    const el = document.querySelector('.switcher-input')
    el.value = '> 打招呼'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(200)
  const helloBefore = await countOf('phase2a', 'a-hello')
  await evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('.switcher-item')).find(x => x.textContent.includes('打招呼'))
    el.click()
    return true
  })()`)
  await sleep(600)
  check('点了之后面板关掉', !(await evalJs<boolean>(`!!document.querySelector('.switcher-input')`)))
  check('插件那条命令的执行体真的跑了', (await countOf('phase2a', 'a-hello')) === helloBefore + 1,
    `${helloBefore} → ${await countOf('phase2a', 'a-hello')}`)
  const helloCtx = (await viewOf('phase2a'))?.state.last?.['a-hello'] as
    | { filePath?: string | null; hasVault?: boolean }
    | undefined
  check(
    '执行体拿到了现场(从面板进来时 filePath 是 null,但知道有没有仓库)',
    helloCtx?.filePath === null && helloCtx?.hasVault === true,
    JSON.stringify(helloCtx)
  )
  check(
    '命令执行时插件自己发的通知也出来了',
    (await toasts()).some(x => x.includes('你好,我是探针 A')),
    JSON.stringify(await toasts())
  )

  // ---- 原生菜单与快捷键 ----
  console.log('\n[B] 原生菜单:快捷键、冲突、灰亮')
  const appMenu = Menu.getApplicationMenu()
  check('应用菜单存在(窗口的菜单栏是隐藏的,但菜单对象必须在)', appMenu !== null)
  const pluginRoot = appMenu?.items.find(i => i.label === '插件')
  check('菜单里有一栏「插件」', pluginRoot !== undefined, appMenu?.items.map(i => i.label).join('/'))
  const groupA = pluginRoot?.submenu?.items.find(i => i.label === '阶段二探针A')
  const groupB = pluginRoot?.submenu?.items.find(i => i.label === '阶段二探针B')
  check('A 的组在(组名用插件名,不是 id)', groupA !== undefined,
    pluginRoot?.submenu?.items.map(i => i.label).join('/'))
  check('B 的组在', groupB !== undefined)

  const findItem = (menuItem: MenuItem | undefined, label: string): MenuItem | undefined =>
    menuItem?.submenu?.items.find(i => (i.label ?? '').startsWith(label))

  const hello = findItem(groupA, '打招呼')
  check('API 注册的命令进了原生菜单', hello !== undefined,
    groupA?.submenu?.items.map(i => i.label).join('/'))
  check(
    '快捷键原样挂上去了(Ctrl+Alt+9)',
    hello?.accelerator === 'Ctrl+Alt+9',
    String(hello?.accelerator)
  )
  const bCmd = findItem(groupB, '清单命令')
  check('清单声明的命令也进了原生菜单', bCmd !== undefined)
  check('清单里的快捷键也挂上去了(Ctrl+Alt+8)', bCmd?.accelerator === 'Ctrl+Alt+8',
    String(bCmd?.accelerator))

  const steal = findItem(groupA, '想抢保存')
  check('抢 Ctrl+S 的命令还在(冲突不该让整条命令消失)', steal !== undefined)
  check(
    '但它的快捷键被摘掉了(应用优先)',
    !steal?.accelerator,
    String(steal?.accelerator)
  )
  const saveItem = appMenu?.items
    .flatMap(i => i.submenu?.items ?? [])
    .find(i => i.label === '保存')
  check(
    '应用自己的 Ctrl+S 没被抢走',
    saveItem?.accelerator === 'CmdOrCtrl+S',
    String(saveItem?.accelerator)
  )
  check(
    '被摘掉的原因写进了插件日志(作者才知道被谁占着)',
    (await viewOf('phase2a'))?.logs.some(l => l.includes('Ctrl+S') && l.includes('保存')) === true,
    JSON.stringify((await viewOf('phase2a'))?.logs)
  )

  // 快捷键那一环:注入不了 OS 按键,直接触发菜单项 —— 从菜单项往后全是真的
  const saveBefore = await countOf('phase2a', 'stealSave')
  steal?.click()
  await sleep(400)
  check(
    '触发那条命令(点菜单项)时执行体跑了',
    (await countOf('phase2a', 'stealSave')) === saveBefore + 1,
    `${saveBefore} → ${await countOf('phase2a', 'stealSave')}`
  )
  const helloBeforeMenu = await countOf('phase2a', 'a-hello')
  hello?.click()
  await sleep(400)
  check(
    '菜单项点下去 = 命令真的执行(宿主 → 渲染层 → 插件一条龙)',
    (await countOf('phase2a', 'a-hello')) === helloBeforeMenu + 1,
    `${helloBeforeMenu} → ${await countOf('phase2a', 'a-hello')}`
  )

  // 命令的灰/亮随「有没有文档」变
  check('有文档时 when:editor 的命令是亮的', bCmd?.enabled === true, String(bCmd?.enabled))
  setCurrentDocPath(null)
  setEditorPresent(false)
  host.contextChanged()
  await sleep(300)
  const bCmdOff = findItem(
    Menu.getApplicationMenu()?.items.find(i => i.label === '插件')?.submenu?.items.find(i => i.label === '阶段二探针B'),
    '清单命令'
  )
  check(
    '没有文档 → 菜单项灰掉并写明原因',
    bCmdOff?.enabled === false && (bCmdOff?.label ?? '').includes('当前不可用'),
    `${String(bCmdOff?.enabled)} / ${String(bCmdOff?.label)}`
  )
  const snapOff = await snapshot()
  check(
    '渲染层拿到的上下文也跟着变了',
    snapOff.context.hasEditor === false,
    JSON.stringify(snapOff.context)
  )
  setCurrentDocPath(note)
  setEditorPresent(true)
  host.contextChanged()
  await sleep(300)
  const bCmdOn = findItem(
    Menu.getApplicationMenu()?.items.find(i => i.label === '插件')?.submenu?.items.find(i => i.label === '阶段二探针B'),
    '清单命令'
  )
  check('文档回来 → 又亮了', bCmdOn?.enabled === true, String(bCmdOn?.enabled))

  // 不可用的时候执行也被挡住(界面灰只是提示,执行前的判定才是闸门)
  const blocked = await host.invokeContrib({ pluginId: 'phase2b', itemId: 'b-cmd', from: 'command' })
  check('可用时执行放行', blocked.ok, JSON.stringify(blocked))
  setCurrentDocPath(null)
  setEditorPresent(false)
  host.contextChanged()
  const stillBlocked = await host.invokeContrib({ pluginId: 'phase2b', itemId: 'b-cmd', from: 'command' })
  check(
    '不可用时执行被拒(绕过界面也点不动)',
    !stillBlocked.ok && stillBlocked.message.includes('不可用'),
    JSON.stringify(stillBlocked)
  )
  setCurrentDocPath(note)
  setEditorPresent(true)
  host.contextChanged()
  await sleep(200)

  // ---- 右键菜单 ----
  console.log('\n[B] 文件列表右键菜单')
  const menuLabels = (): Promise<string[]> =>
    evalJs<string[]>(
      `Array.from(document.querySelectorAll('.explorer-menu-item')).map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim())`
    )
  await evalJs(`(() => {
    const row = document.querySelector('.explorer-file')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }))
    return true
  })()`)
  await sleep(300)
  const menuNow = await menuLabels()
  check('右键菜单打开了', menuNow.length > 0, JSON.stringify(menuNow))
  check('应用自己的条目还在', menuNow.some(x => x.includes('重命名')), JSON.stringify(menuNow))
  check(
    'API 注册的插件条目进菜单了',
    menuNow.some(x => x.includes('用探针 A 处理')),
    JSON.stringify(menuNow)
  )
  check(
    '清单声明的插件条目也进菜单了',
    menuNow.some(x => x.includes('清单菜单项')),
    JSON.stringify(menuNow)
  )
  check(
    '插件条目上标了来源(用户得能看出哪一条不是原装的)',
    menuNow.some(x => x.includes('用探针 A 处理') && x.includes('阶段二探针A')),
    JSON.stringify(menuNow)
  )
  check(
    '插件条目排在应用条目后面(有分隔)',
    menuNow.findIndex(x => x.includes('重命名')) < menuNow.findIndex(x => x.includes('清单菜单项')),
    JSON.stringify(menuNow)
  )

  // 点插件条目:要带上"用户指的是哪个文件"
  await evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('.explorer-menu-item')).find(x => x.textContent.includes('用探针 A 处理'))
    if (!el) return false
    el.click()
    return true
  })()`)
  await sleep(600)
  const filesCtx = (await viewOf('phase2a'))?.state.last?.['a-files'] as
    | { filePath?: string | null }
    | undefined
  check('点插件条目后菜单关掉', !(await evalJs<boolean>(`!!document.querySelector('.explorer-menu')`)))
  check('执行体跑了', (await countOf('phase2a', 'a-files')) === 1)
  check(
    '执行体拿到了右键的那个文件路径(右键菜单存在的全部意义)',
    filesCtx?.filePath === note,
    JSON.stringify(filesCtx)
  )
  await evalJs(`(() => { document.querySelector('.explorer-menu-mask')?.click(); return true })()`)

  // 清单那条走 runAction,payload 里同样带文件路径
  await evalJs(`(() => {
    const row = document.querySelector('.explorer-file')
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }))
    return true
  })()`)
  await sleep(250)
  await evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('.explorer-menu-item')).find(x => x.textContent.includes('清单菜单项'))
    if (!el) return false
    el.click()
    return true
  })()`)
  await sleep(600)
  const bAction = (await viewOf('phase2b'))?.state.last?.['runAction'] as
    | { actionId?: string; payload?: { editor?: { filePath?: string } } }
    | undefined
  check('清单条目的 action 走到了 runAction', bAction?.actionId === 'b-do', JSON.stringify(bAction))
  check(
    '清单条目的 runAction 也拿到了文件路径',
    bAction?.payload?.editor?.filePath === note,
    JSON.stringify(bAction?.payload)
  )

  // ---- 状态条目被收回 ----
  console.log('\n[B] 状态栏条目可以被插件自己收回')
  await host.invokeContrib({ pluginId: 'phase2a', itemId: 'a-status-off', from: 'command' })
  await sleep(400)
  check(
    '收回之后状态栏上没有它了',
    !(await statusTitles()).some(x => x.includes('探针 A 的状态')),
    JSON.stringify(await statusTitles())
  )
  check(
    '但清单声明的那条还在(每个插件各管各的)',
    (await statusTitles()).some(x => x.includes('清单声明的状态条目')),
    JSON.stringify(await statusTitles())
  )

  // ---- 启停 ----
  console.log('\n[B] 停用 / 重新启用')
  // 启停要看命令面板,就得先把面板打开 —— 之前这里是拿一个**已经关着的**面板
  // 里的条目去断言"消失了",那种检查永远为真,等于没测
  const paletteHas = async (needle: string): Promise<boolean> => {
    getMainWindow()?.webContents.send(IPC.MenuCommand, 'view:command-palette')
    await waitFor(`document.querySelector('.switcher-input')`)
    await evalJs(`(() => {
      const el = document.querySelector('.switcher-input')
      el.value = '> ' + ${JSON.stringify(needle)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(250)
    const hit = (await items()).some(x => x.includes(needle))
    await evalJs(`(() => {
      const el = document.querySelector('.switcher-input')
      if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)
    await sleep(250)
    return hit
  }
  check('停用前面板里确实有这条命令(先证明这条路是通的)', await paletteHas('打招呼'))

  await evalJs(`window.api.savePlugin('phase2a', { enabled: false })`)
  await sleep(700)
  check('停用后命令从面板里消失', !(await paletteHas('打招呼')))
  const rootAfterOff = Menu.getApplicationMenu()?.items.find(i => i.label === '插件')
  check(
    '停用后原生菜单里的那组也消失了',
    rootAfterOff?.submenu?.items.find(i => i.label === '阶段二探针A') === undefined,
    rootAfterOff?.submenu?.items.map(i => i.label).join('/')
  )
  check(
    'B 的组不受影响',
    rootAfterOff?.submenu?.items.find(i => i.label === '阶段二探针B') !== undefined
  )

  await evalJs(`window.api.savePlugin('phase2a', { enabled: true })`)
  await sleep(900)
  const rootAfterOn = Menu.getApplicationMenu()?.items.find(i => i.label === '插件')
  const groupA2 = rootAfterOn?.submenu?.items.find(i => i.label === '阶段二探针A')
  check('重新启用后组又回来了', groupA2 !== undefined)
  check(
    '状态条目也回来了(API 注册的在 onEnable 里重来一遍)',
    (await statusTitles()).some(x => x.includes('探针 A 的状态')),
    JSON.stringify(await statusTitles())
  )
  check('命令也能在面板里搜到了', await paletteHas('打招呼'))

  // 停用 → 启用 一轮之后,事件不能变成收两遍
  console.log('\n[B] 事件钩子')
  const beforeSave = await countOf('phase2a', 'document:save')
  await evalJs(`(() => {
    const el = document.querySelector('.cm-content')
    if (el) el.focus()
    return true
  })()`)
  wc.sendInputEvent({ type: 'char', keyCode: 'a' })
  await sleep(200)
  wc.sendInputEvent({ type: 'char', keyCode: 'b' })
  await sleep(300)
  getMainWindow()?.webContents.send(IPC.MenuCommand, 'file:save')
  const saved = await waitFor(`true`, 400)
  void saved
  await sleep(900)
  const afterSave = await countOf('phase2a', 'document:save')
  check(
    '保存一次 → document:save 只来一次(停用再启用之后也不许翻倍)',
    afterSave === beforeSave + 1,
    `${beforeSave} → ${afterSave}`
  )
  const savePayload = (await viewOf('phase2a'))?.state.last?.['document:save'] as
    | { filePath?: string | null; ok?: boolean }
    | undefined
  check('事件里带着文件路径与结果', savePayload?.filePath === note && savePayload?.ok === true,
    JSON.stringify(savePayload))

  // document:change 必须节流:敲 12 下不该换来 12 条事件
  const beforeChange = await countOf('phase2a', 'document:change')
  for (const ch of 'cdefghijklmn') {
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    await sleep(30)
  }
  await sleep(1000)
  const afterChange = await countOf('phase2a', 'document:change')
  const delta = afterChange - beforeChange
  check(
    `连打 13 个字符 → document:change 被节流(${delta} 条,敲了 13 下)`,
    delta > 0 && delta <= 5,
    String(delta)
  )
  const changePayload = (await viewOf('phase2a'))?.state.last?.['document:change'] as
    | { chars?: number; words?: number; dirty?: boolean }
    | undefined
  check(
    '最后那一份状态是完整的(节流有尾沿,不会停在中间值)',
    typeof changePayload?.chars === 'number' && changePayload.chars > 0,
    JSON.stringify(changePayload)
  )

  // config:change 只发给被改的那个插件
  const aCfgBefore = await countOf('phase2a', 'config:change')
  const bCfgBefore = await countOf('phase2b', 'config:change')
  await evalJs(`window.api.savePlugin('phase2a', { config: { note: '改过了' } })`)
  await sleep(700)
  check(
    '改 A 的配置 → A 收到 config:change',
    (await countOf('phase2a', 'config:change')) === aCfgBefore + 1,
    `${aCfgBefore} → ${await countOf('phase2a', 'config:change')}`
  )
  check(
    'B 收不到(告诉它"别人被改了配置"既没用又泄露用户装了谁)',
    (await countOf('phase2b', 'config:change')) === bCfgBefore,
    `${bCfgBefore} → ${await countOf('phase2b', 'config:change')}`
  )

  // ---- 通知限流 ----
  console.log('\n[B] 通知限流(防好心办坏事)')
  await evalJs(`(() => {
    Array.from(document.querySelectorAll('.toast-close')).forEach(b => b.click())
    return true
  })()`)
  await sleep(200)
  await host.invokeContrib({ pluginId: 'phase2a', itemId: 'a-burst', from: 'command' })
  await sleep(500)
  const burstToasts = await toasts()
  check(
    `一次发 15 条 → 屏幕上最多几条(实际 ${burstToasts.length} 条),不会糊住界面`,
    burstToasts.length <= 4,
    JSON.stringify(burstToasts)
  )
  check(
    '被丢掉这件事写进了插件日志(作者能查"我的通知怎么没出来")',
    (await viewOf('phase2a'))?.logs.some(l => l.includes('通知超过 10 条')) === true,
    JSON.stringify((await viewOf('phase2a'))?.logs)
  )

  // ---- 认得出的图标真的画了 ----
  console.log('\n[B] 图标白名单')
  const starIcon = await evalJs<number>(`document.querySelectorAll('.status-plug svg').length`)
  check('认得出的图标名画成了 svg', starIcon >= 1, String(starIcon))

  // ---- 既有插件零回归 ----
  console.log('\n[B] 既有插件零回归')
  const all = await host.list()
  for (const id of ['quick-edit', 'git-sync']) {
    const v = all.find(x => x.descriptor.id === id)
    check(`${id} 在列表里且没有加载错误`, v !== undefined && v.loadError === undefined,
      String(v?.loadError))
  }
  check(
    'quick-edit 默认启用(与阶段二之前一致)',
    all.find(x => x.descriptor.id === 'quick-edit')?.state.enabled === true
  )
  // git-sync 是兜底包,装上但不自动启用(用户没让它碰过他的仓库)。要验它的槽位
  // 就得先打开它 —— 这顺带也是「清单声明的槽位在真插件上生效」的一次实测
  await evalJs(`window.api.savePlugin('git-sync', { enabled: true })`)
  await sleep(900)
  const gitContrib = (await snapshot()).contribs as Array<{
    pluginId: string
    statusItem: { label?: string } | null
    commands: unknown[]
  }>
  const gitSyncContrib = gitContrib.find(c => c.pluginId === 'git-sync')
  check(
    'git-sync 的状态栏条目来自它的清单(硬编码那个按钮真的换掉了)',
    gitSyncContrib?.statusItem?.label === '同步',
    JSON.stringify(gitSyncContrib?.statusItem)
  )
  check(
    'git-sync 的命令也进了快照',
    (gitSyncContrib?.commands.length ?? 0) >= 1,
    JSON.stringify(gitSyncContrib?.commands)
  )
  // 启动时 onEnable 只能跑一遍。
  //
  // 这条是**回归护栏**:quick-edit 是默认启用的兜底包,补齐它的那条路
  // (补装时 save()→enable 一次)和启动循环(对 state.enabled 为真的 entry 再 enable 一次)
  // 会撞在一起。两遍 onEnable 对一个在 onEnable 里 setInterval 的插件就是两个定时器,
  // 而现象是「每隔一段时间重复干两次」这种要查很久的问题。输出「已就绪」这行日志
  // 正是它 onEnable 里的动作,数一遍就够了。
  const qeLogs = (await viewOf('quick-edit'))?.logs ?? []
  check(
    '启动时插件只被启用一次(onEnable 不会跑两遍)',
    qeLogs.filter(l => l.includes('Quick Edit 已就绪')).length === 1,
    JSON.stringify(qeLogs.filter(l => l.includes('已就绪')))
  )

  const quickContrib = gitContrib.find(c => c.pluginId === 'quick-edit')
  check(
    'quick-edit 没有槽位,就不出现在贡献点快照里(空插件不占位)',
    quickContrib === undefined ||
      (quickContrib.commands.length === 0 && quickContrib.statusItem === null),
    JSON.stringify(quickContrib)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
