/**
 * 阶段一(地基)验收:共享格式数据、imark:// 收紧、开发模式热重载、权限注入。
 *
 * 这一轮改的东西大多"在真跑里才显形",所以分两半:
 *   A 纯函数(白名单/保留段/键序/开发参数解析/能力权限) —— 不建窗口就能判
 *   B 真跑(imark:// 路径矩阵、setDocPath 链路、开发目录热重载、vault 注入)
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs phase1
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import {
  canonicalManifest,
  integrityInput,
  isSafeRelPath,
  validateEnvelope,
  validateManifest
} from '../src/shared/pluginPackage'
import { devDirsFromArgv } from '../src/main/plugins/dev'
// capabilities.ts 自己在末尾 registerCapability(webhookCapability),引它就够了
import { checkAgainstCapability } from '../src/main/plugins/capabilities'
import { createImkApi } from '../src/main/plugins/api'
import type { PluginContext } from '../src/shared/pluginApi'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import {
  createMainWindow,
  currentDocPath,
  setCurrentDocPath
} from '../src/main/window'
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

/** 1×1 透明 PNG,够验"这是一张真图片" */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'imark',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])
registerPluginScheme()

// ---------------------------------------------------------------- A 纯函数

function pureChecks(): void {
  console.log('\n[A] 共享格式数据(扩展名 / 保留段 / 键序)')

  // 插件没有自有 HTML 页面(界面由 render 层直接操作 DOM),html/htm 从白名单移除
  check('html 不再进白名单', !isSafeRelPath('ui/index.html'))
  check('htm 不再进白名单', !isSafeRelPath('ui/index.htm'))
  check('woff2 进白名单', isSafeRelPath('ui/font.woff2'))
  check('webp 进白名单', isSafeRelPath('assets/a.webp'))
  check('__imark 首段被拒', !isSafeRelPath('__imark/ui.css'))
  check('__imark 大小写不敏感', !isSafeRelPath('__IMARK/ui.css'))
  check('__imark 出现在中间段也被拒', !isSafeRelPath('ui/__imark/x.css'))
  check('__imarkX 不受影响(不是保留段)', isSafeRelPath('__imarkx/a.css'))
  check('不支持的后缀仍被拒', !isSafeRelPath('ui/App.vue'))
  check('`..` 仍被拒', !isSafeRelPath('ui/../x.css'))

  // 键序:integrity 的输入形状,顺序变了所有既有包都会失效
  const rebuilt = canonicalManifest({
    lineMenu: [],
    version: '1.0.0',
    name: 'x',
    id: 'x',
    description: '',
    actions: [],
    fields: [],
    main: { mode: 'node', entry: 'main.js' }
  })
  const keys = Object.keys(rebuilt).join(',')
  check(
    'canonicalManifest 键序稳定(v2)',
    keys === 'id,name,description,version,main,fields,actions,lineMenu',
    keys
  )
  check('缺失的 actions 补空数组', Array.isArray(rebuilt.actions))

  console.log('\n[A] --plugin-dev 参数解析')
  // 断言要与平台无关:比 `resolve()` 的结果,不比字符串前后缀 ——
  // Windows 上 resolve('/a') 是 `D:\a`,既不 startsWith('/') 也不 endsWith('/a')
  check('等号写法', devDirsFromArgv(['--plugin-dev=/a'])[0] === resolve('/a'))
  check('空格写法', devDirsFromArgv(['--plugin-dev', '/b'])[0] === resolve('/b'))
  check('后面跟着另一个开关时不当目录', devDirsFromArgv(['--plugin-dev', '--foo']).length === 0)
  check('重复目录去重', devDirsFromArgv(['--plugin-dev=/c', '--plugin-dev=/c']).length === 1)
  check('相对路径被解析成绝对路径', isAbsolute(devDirsFromArgv(['--plugin-dev=rel'])[0] ?? ''))

  console.log('\n[A] 能力声明的权限必须写进清单')
  const withPerm = validateManifest({
    id: 'notify-x',
    name: 'x',
    description: '',
    version: '1.0.0',
    capability: 'webhook',
    permissions: ['network', 'secrets'],
    fields: [{ key: 'targets', kind: 'targets', label: 't', default: [] }],
    actions: [{ id: 'test', label: 'test' }],
    targetActions: [{ id: 'test-target', label: 'tt' }],
    targetFieldKey: 'targets'
  })
  check('清单本身合法', withPerm.ok, withPerm.errors.join(';'))
  if (withPerm.value) {
    check('权限齐了就没有问题', checkAgainstCapability(withPerm.value).length === 0)
  }
  const missing = validateManifest({
    id: 'notify-y',
    name: 'y',
    description: '',
    version: '1.0.0',
    capability: 'webhook',
    permissions: [],
    fields: [{ key: 'targets', kind: 'targets', label: 't', default: [] }],
    actions: [{ id: 'test', label: 'test' }],
    targetActions: [{ id: 'test-target', label: 'tt' }],
    targetFieldKey: 'targets'
  })
  const problems = missing.value ? checkAgainstCapability(missing.value) : ['清单不合法']
  check(
    '漏声明能力需要的权限 → 报错并点名',
    problems.some(p => p.includes('network')) && problems.some(p => p.includes('secrets')),
    problems.join(';')
  )
}

// ---------------------------------------------------------------- B 真跑

/** 造一个开发目录里的插件。返回目录路径。 */
async function writeDevPlugin(dir: string, message: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        id: 'devprobe',
        name: '开发探针',
        description: 'harness 用',
        version: '1.0.0',
        main: { mode: 'node', entry: 'main.js' },
        // 刻意**不声明** vault:read —— 用来验它真的被挡住了
        permissions: [],
        fields: [],
        actions: []
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(
    join(dir, 'main.js'),
    `module.exports = function (imk) {
  return {
    onEnable: function () {
      imk.setState({
        lastMessage: ${JSON.stringify(message)},
        lastDetail: 'vault=' + (imk.vault === undefined ? 'undefined' : 'present')
      })
    }
  }
}
`,
    'utf8'
  )
}

/** 在页面里加载一张 imark:// 图片,返回 onload / onerror / timeout */
const IMG_PROBE = `
new Promise(function (resolve) {
  var img = new Image()
  var done = false
  var finish = function (v) { if (!done) { done = true; resolve(v) } }
  img.onload = function () { finish('ok') }
  img.onerror = function () { finish('err') }
  img.src = window.__probeUrl
  setTimeout(function () { finish('timeout') }, 4000)
})
`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

  pureChecks()

  await app.whenReady()

  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const elsewhere = join(ud, 'elsewhere')
  const devDir = join(ud, 'devplug')

  await rm(vault, { recursive: true, force: true })
  await rm(elsewhere, { recursive: true, force: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await rm(devDir, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await mkdir(elsewhere, { recursive: true })

  // 仓库内 / 文档同级 / 两处之外,各放一张真图片
  await writeFile(join(vault, 'in.png'), PNG)
  await writeFile(join(vault, 'note.txt'), 'not an image', 'utf8')
  await writeFile(join(elsewhere, 'pic.png'), PNG)
  await writeFile(join(ud, 'secret.png'), PNG)

  // 文档开在仓库**内**。lastFile 的恢复被 isInside(vaultPath, lastFile) 挡着
  // (App.vue / vaultService.ts 两处都有),写仓库外的路径根本不会被打开 ——
  // 用它来验「文档目录也是允许根」是验不出来的,那条单独测(见下)。
  const note = join(vault, '笔记.md')
  await writeFile(note, '# 笔记\n', 'utf8')
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

  await writeDevPlugin(devDir, 'V1')

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned, [devDir])
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  // ---- setDocPath 链路:渲染层 watcher → IPC → 主进程 ----
  console.log('\n[B] setDocPath 链路(imark:// 允许根的基准)')
  check(
    '渲染层 → IPC → 主进程:文档路径对上仓库里那个文件',
    currentDocPath() === note,
    String(currentDocPath())
  )

  // ---- imark:// 路径矩阵 ----
  console.log('\n[B] imark:// 路径矩阵')
  const probe = async (abs: string, label: string, want: 'ok' | 'err'): Promise<void> => {
    const url = 'imark://img/' + encodeURIComponent(abs)
    await evalJs(`window.__probeUrl = ${JSON.stringify(url)}`)
    const got = await evalJs<string>(IMG_PROBE)
    check(`${label} → ${want}`, got === want, `实际 ${got}`)
  }

  await probe(join(vault, 'in.png'), '仓库根里的图片', 'ok')
  await probe(join(ud, 'secret.png'), '仓库之外', 'err')
  await probe(join(vault, '..', 'secret.png'), '`..` 逃出仓库', 'err')
  await probe(join(vault, 'note.txt'), '仓库内但非图片后缀', 'err')
  await probe('/etc/passwd', '仓库外的系统文件', 'err')
  await probe(join(vault, 'in.png').replace('/vault/', '/vault/../vault/'), '绕一圈又回到仓库内', 'ok')

  // 「当前文档所在目录」也是允许根。它在真跑里是可达的:把 .md 拖进编辑器
  // 就能打开仓库外的文件(EditorPane.vue 的 onDrop 不做仓库包含检查)。
  // 这里直接调生产代码里那个 setter,验的是 allowedRoots() 与协议处理器的合体行为。
  const farDoc = join(elsewhere, 'note.md')
  await writeFile(farDoc, '# 仓库外的笔记\n', 'utf8')
  setCurrentDocPath(farDoc)
  await probe(join(elsewhere, 'pic.png'), '仓库外·文档同级的图片', 'ok')
  await probe(join(vault, 'in.png'), '换了文档之后仓库根仍然有效', 'ok')
  await probe(join(elsewhere, '..', 'secret.png'), '仓库外·`..` 逃出文档目录', 'err')
  setCurrentDocPath(note)

  // ---- 开发模式 ----
  console.log('\n[B] 开发模式(--plugin-dev)')
  const host = getPluginHost()!
  const findDev = async (): Promise<Record<string, unknown> | undefined> =>
    (await host.list()).find(v => v.descriptor.id === 'devprobe') as
      | Record<string, unknown>
      | undefined

  const v1 = await findDev()
  check('开发目录里的插件出现在列表里', v1 !== undefined)
  check('被标记为 dev(界面上要标红)', v1?.dev === true)
  check('第一次以开发模式加载时自动启用', (v1?.state as { enabled?: boolean })?.enabled === true)
  check(
    '未声明 vault:read → imk.vault 是 undefined',
    (v1?.state as { lastDetail?: string })?.lastDetail === 'vault=undefined',
    String((v1?.state as { lastDetail?: string })?.lastDetail)
  )
  check('onEnable 真的跑过(V1)', (v1?.state as { lastMessage?: string })?.lastMessage === 'V1')

  // 热重载:改代码 → 去抖后自动重新加载
  await writeDevPlugin(devDir, 'V2')
  await sleep(2500)
  const v2 = await findDev()
  check('改完文件自动重载(V1 → V2)', (v2?.state as { lastMessage?: string })?.lastMessage === 'V2',
    String((v2?.state as { lastMessage?: string })?.lastMessage))
  check('重载后仍然启用', (v2?.state as { enabled?: boolean })?.enabled === true)

  // 坏代码:登记成坏插件但不抛、且继续盯着
  await writeFile(join(devDir, 'main.js'), 'this is not javascript (((', 'utf8')
  await sleep(2500)
  const broken = await findDev()
  check('坏代码 → 登记为加载失败', typeof broken?.loadError === 'string' && broken.loadError !== '')
  check('坏代码不会把宿主带崩(其它插件还在)', (await host.list()).length >= 3)
  // 回归点:坏代码会让宿主把 enabled 写成 false。开发插件的「启用」是作者的意图,
  // 不能被一次编译失败抹掉 —— 抹掉了的话,下一轮重载读回 false,插件就再也不会起来了。
  check(
    '坏代码不改写「作者想要它开着」这个意图',
    (broken?.state as { enabled?: boolean })?.enabled === true
  )

  await writeDevPlugin(devDir, 'V3')
  await sleep(2500)
  const v3 = await findDev()
  check(
    '改好之后自动恢复(且真的跑起来了)',
    v3?.loadError === undefined && (v3?.state as { lastMessage?: string })?.lastMessage === 'V3',
    `loadError=${String(v3?.loadError)} lastMessage=${String((v3?.state as { lastMessage?: string })?.lastMessage)}`
  )

  // 开发插件不该能被"卸载"
  let threw = ''
  try {
    await host.uninstall('devprobe', { removeConfig: true })
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  check('卸载开发插件被明确拒绝', threw.includes('开发模式'), threw)
  check('拒绝之后插件还在', (await findDev()) !== undefined)

  // ---- 既有插件零回归 ----
  console.log('\n[B] 既有插件零回归')
  const views = await host.list()
  const quick = views.find(v => v.descriptor.id === 'quick-edit')
  const git = views.find(v => v.descriptor.id === 'git-sync')
  check('quick-edit 已补装', quick !== undefined)
  check('quick-edit 没有加载错误', quick?.loadError === undefined, String(quick?.loadError))
  check('quick-edit 默认启用', quick?.state.enabled === true)
  check('git-sync 已补装(默认关着)', git !== undefined)
  check('git-sync 没有加载错误', git?.loadError === undefined, String(git?.loadError))

  // vault:read 的门禁对自带插件不误伤
  const api = createImkApi(
    {
      pluginId: 'probe',
      getConfig: () => ({}),
      setState: () => {},
      flushDocument: async () => {},
      isEnabled: () => true,
      isDisabledByHost: () => false
    } as unknown as PluginContext,
    {
      pluginId: 'probe',
      pluginName: 'probe',
      pluginVersion: '1.0.0',
      dir: '',
      permissions: ['vault:read', 'git'],
      validateSecretTarget: () => {},
      log: () => {}
    }
  )
  check('声明了 vault:read → imk.vault 存在', api.vault !== undefined)
  check('未声明 secrets → imk.secrets 是 undefined', api.secrets === undefined)

  // 打包出来的内置包仍然能被自己的校验接受,而且 integrity 还能**原样算出来**。
  // 后半句才是关键:键序是 integrity 的输入,一旦 manifestKeyOrder 被动过,
  // 既有包的 integrity 就会变。这条挂了 = 所有已发布包在客户端眼里都成了「被篡改」。
  console.log('\n[B] 既有内置包仍然可用(键序 / 白名单没有动坏)')
  for (const id of ['quick-edit', 'git-sync', 'note-embed', 'todo-marks', 'ai-for-edit']) {
    // 按 __dirname 找(打包后落在 out/main/,上两级就是仓库根),
    // **不能写成相对 cwd 的 '../src/...'** —— cwd 是仓库根,那样会指到仓库的上一级去
    const raw = await readFile(
      join(__dirname, `../../src/main/market/builtin/${id}.imkpkg.json`),
      'utf8'
    )
    const env = validateEnvelope(JSON.parse(raw))
    check(`${id} 内置包通过结构校验`, env.ok, env.errors.slice(0, 3).join(';'))
    if (!env.value) continue

    const sameOrder =
      JSON.stringify(canonicalManifest(env.value.manifest)) === JSON.stringify(env.value.manifest)
    check(`${id} 清单过一遍 canonicalManifest 字节不变`, sameOrder)

    const recomputed = createHash('sha256')
      .update(integrityInput(env.value.manifest, env.value.files))
      .digest('hex')
    check(
      `${id} integrity 能原样重算(${env.value.integrity.slice(0, 12)}…)`,
      recomputed === env.value.integrity,
      `重算 ${recomputed.slice(0, 12)}…`
    )
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
