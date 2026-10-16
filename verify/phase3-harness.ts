/**
 * 阶段三验收:插件窗口 + 沙箱 + 权限门禁。
 *
 * 覆盖交接单 §3.10 的验收清单。分五组:
 *   A 生命周期(建窗/停用关窗/卸载清分区/熔断强关且重启后仍停用)
 *   B 权限矩阵(未声明被拒且文件没被碰、授权被撤回后仍被拒、身份不可伪造)
 *   C 路径(越界、符号链接、.git、写当前打开的文件)
 *   D 网络(默认拒本机、放开后可用、重定向第二跳被拒、超限截断)
 *   E 闸门(表外 op、频率、超时)与兼容(未知 kind 硬拒)
 *
 * 跑法:node verify/run.mjs phase3
 *
 * 说明:**能力类断言**多数直接调 `invokeOp`(闸门 + ops 表,与沙箱走的是同一段代码),
 * 页面/通道类断言走真窗口里的真页面。哪条是哪种,断言文字里写清楚了。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerPluginScheme, pluginWindowOf, pluginWindowTitle } from '../src/main/plugins/windows'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { pluginDir, setRecord, getRecord } from '../src/main/plugins/installed'
import { invokeOp } from '../src/main/plugins/gate'
import { setNetFetchImpl, resolveVaultPath, opPermissions } from '../src/main/plugins/ops'
import { validateManifest, SANDBOX_ONLY_PERMISSIONS, hasMainEntry } from '../src/shared/pluginPackage'
import type { OpContext } from '../src/main/plugins/ops'

// registerSchemesAsPrivileged 只在 app ready 之前有效(见 phase3-smoke 的说明)
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

/** 轮询直到条件成立或超时,返回是否成立 */
async function until(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await sleep(50)
  }
  return fn()
}

interface Fixture {
  id: string
  permissions: string[]
  main: string
  ui?: { entry: string; width?: number; height?: number }
  /** 落进 installed.json 的授权快照(默认与 permissions 相同) */
  granted?: string[]
  source?: 'local' | 'market'
}

/** 在磁盘上造一个已安装的沙箱插件(磁盘是权威:有目录 + 合法清单就算装上了) */
async function makePlugin(fx: Fixture): Promise<void> {
  const dir = pluginDir(fx.id)
  await mkdir(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    id: fx.id,
    name: `验收插件 ${fx.id}`,
    description: '验收用',
    version: '1.0.0',
    kind: 'sandboxed',
    main: 'main.js',
    permissions: fx.permissions,
    fields: [],
    actions: [{ id: 'report', label: '报告' }]
  }
  if (fx.ui) manifest.ui = fx.ui
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'main.js'), fx.main, 'utf8')
  if (fx.ui) {
    await mkdir(join(dir, fx.ui.entry.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    await writeFile(
      join(dir, fx.ui.entry),
      `<!doctype html><html><head><meta charset="utf-8"><title>ui</title>
       <link rel="stylesheet" href="/__imark/ui.css"></head>
       <body><h1 id="t">插件窗口</h1><script src="/main.js"></script></body></html>`,
      'utf8'
    )
  }
  await setRecord({
    id: fx.id,
    version: '1.0.0',
    kind: 'sandboxed',
    integrity: 'x'.repeat(64),
    mainSha256: null,
    publisher: null,
    source: fx.source ?? 'local',
    registryUrl: null,
    installedAt: Date.now(),
    grantedPermissions: (fx.granted ?? fx.permissions) as never[]
  })
}

const SIMPLE_MAIN = `
window.imark.plugin.handle({
  onEnable() { window.imark.setState({ status: 'ok', lastMessage: 'ready' }) },
  runAction(id) { return { ok: true, message: 'ran ' + id } }
})
`

/**
 * 会往 localStorage 里写东西的插件:用来验「卸载之后数据真的没了」。
 * 首次启用写一个标记,之后每次都在报告里把它读出来。
 */
const STORE_MAIN = `
window.imark.plugin.handle({
  onEnable() {
    if (!localStorage.getItem('probe')) localStorage.setItem('probe', 'sbx-store-1')
  },
  runAction() { return { ok: true, message: 'probe=' + String(localStorage.getItem('probe')) } }
})
`

/**
 * 每次都抛的插件:用来验熔断。
 *
 * 熔断要**连续 3 次失败**,而"用户手动关掉再打开"会重置计数(那是熔断后唯一的
 * 恢复路径,见 host.save)。所以这里让 onEnable 与 runAction 都抛:
 * 启用那次算 1 次,之后每次 runAction 再算 1 次,凑够 3 次。
 */
const THROWING_MAIN = `
window.imark.plugin.handle({
  onEnable() { throw new Error('故意失败') },
  runAction() { throw new Error('故意失败') }
})
`

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
  const outside = join(ud, 'outside')
  await mkdir(vault, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(vault, '笔记.md'), '# 笔记\n', 'utf8')
  await writeFile(join(outside, 'secret.txt'), '不该读到的东西\n', 'utf8')
  await mkdir(join(vault, '.git'), { recursive: true })
  await writeFile(join(vault, '.git', 'config'), '[remote "origin"]\n\turl = https://user:token@example.com/x.git\n', 'utf8')
  // 仓库内指向仓库外的符号链接(Windows 上普通用户建不了符号链接,失败就跳过这一条)
  let symlinkOk = true
  try {
    await symlink(outside, join(vault, 'link-out'), 'junction')
  } catch {
    symlinkOk = false
  }

  await makePlugin({ id: 'sbx-basic', permissions: ['vault:read', 'network'], main: SIMPLE_MAIN })
  await makePlugin({
    id: 'sbx-ui',
    permissions: ['ui'],
    main: SIMPLE_MAIN,
    ui: { entry: 'ui/index.html', width: 420, height: 320 }
  })
  await makePlugin({ id: 'sbx-throws', permissions: [], main: THROWING_MAIN })
  // 从市场装的:有"用户同意过哪些权限"的快照,才是 effective = granted ∩ declared 的场景
  await makePlugin({
    id: 'sbx-readonly',
    permissions: ['vault:read'],
    main: SIMPLE_MAIN,
    source: 'market'
  })
  // 手动拷进来的:没有确认流程,按"全给"处理(界面上会标注未经确认)
  await makePlugin({
    id: 'sbx-local',
    permissions: ['vault:read', 'vault:write'],
    main: SIMPLE_MAIN,
    source: 'local'
  })
  // 网络用(它是唯一会在被卸载之前一直活着的插件 —— 见 [E] 那一段)
  await makePlugin({ id: 'sbx-net', permissions: ['network'], main: SIMPLE_MAIN, source: 'market' })
  // git 能力用(见 [F] 那一段)
  await makePlugin({ id: 'sbx-git', permissions: ['git'], main: SIMPLE_MAIN, source: 'market' })
  // localStorage 清理用(见 [A] 那一段)
  await makePlugin({ id: 'sbx-store', permissions: [], main: STORE_MAIN })

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        autoSave: false,
        marketUrl: '',
        plugins: {
          'sbx-basic': { enabled: true, config: {} },
          'sbx-ui': { enabled: true, config: {} },
          'sbx-throws': { enabled: true, config: {} },
          'sbx-readonly': { enabled: true, config: {} },
          'sbx-local': { enabled: true, config: {} },
          'sbx-net': { enabled: true, config: {} }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  /**
   * 当前宿主。**必须是可变的**:下面有几次"重启模拟"会再调 initPluginHost,
   * 换成一个全新的宿主对象 —— 旧对象里的 entries 已经不代表磁盘现状了。
   */
  let current = await initPluginHost()
  const entriesOf = (h: typeof current): Map<string, unknown> =>
    (h as unknown as { entries: Map<string, unknown> }).entries
  const opContextOf = (h: typeof current, id: string): OpContext =>
    (h as unknown as { opContextFor(e: unknown): OpContext }).opContextFor(entriesOf(h).get(id))
  const opAs = (id: string, op: string, args?: unknown) =>
    invokeOp(opContextOf(current, id), op, args, { source: 'sandbox' })

  // ---------- A 生命周期 ----------

  console.log('\n[A] 生命周期')
  check('纯后台插件建出了隐藏窗口', await until(() => pluginWindowOf('sbx-basic') !== null))
  check('纯后台插件的窗口不进任务栏', pluginWindowOf('sbx-basic')?.isVisible() === false)

  const uiWin = pluginWindowOf('sbx-ui')
  check('带界面的插件也建出了窗口', await until(() => pluginWindowOf('sbx-ui') !== null))
  check(
    '带界面的插件加载的是作者写的 HTML',
    uiWin ? uiWin.webContents.getURL().endsWith('/ui/index.html') : false,
    uiWin?.webContents.getURL()
  )
  check('窗口标题标出了这是插件(防钓鱼)', /iMark 插件$/.test(pluginWindowTitle('sbx-ui')))
  check('界面插件的初始尺寸来自清单', uiWin ? uiWin.getBounds().width === 420 : false, String(uiWin?.getBounds().width))
  const shown = uiWin
    ? await uiWin.webContents
        .executeJavaScript('document.getElementById("t") ? document.getElementById("t").textContent : "(没有标题元素)"')
        .catch((e: Error) => `err:${e.message}`)
    : '(没有窗口)'
  check('作者页面的 DOM 真的渲染了', shown === '插件窗口', String(shown))

  // 停用 → 关窗
  await current.save('sbx-ui', { enabled: false })
  const closed = await until(() => pluginWindowOf('sbx-ui') === null, 2500)
  check('停用后窗口在 2 秒内消失', closed)

  // 卸载 → 分区数据被清
  await current.uninstall('sbx-basic', { removeConfig: true })
  await sleep(500)
  check('卸载后插件窗口消失', pluginWindowOf('sbx-basic') === null)

  /**
   * 分区数据的清理**断言的是效果,不是目录**。
   *
   * Chromium 在应用运行期间一直握着那几个文件(Cookies / Local Storage 的 LOCK),
   * 目录本身删不掉,能删的、也是真正要删的是**里面存着的东西** ——
   * 所以这里验的是最要紧的那条:同样的 id 重新装一次,读不到上一家留下的数据。
   * (一个 id 是可以被别人重新发布的,残留数据会被新插件读到,那才是风险)
   */
  await current.save('sbx-store', { enabled: true })
  await sleep(1200)
  const stored1 = await current.runAction('sbx-store', 'report')
  check('插件页写得进 localStorage', /sbx-store-1/.test(stored1.message), stored1.message)
  await current.uninstall('sbx-store', { removeConfig: true })
  await sleep(400)
  // 同 id 重装(模拟"这个 id 换了一个作者")
  await makePlugin({ id: 'sbx-store', permissions: [], main: STORE_MAIN })
  current = await initPluginHost()
  await current.save('sbx-store', { enabled: true })
  await sleep(1200)
  const stored2 = await current.runAction('sbx-store', 'report')
  check(
    '卸载再装回来(同 id)读不到上一家的 localStorage',
    !/sbx-store-1/.test(stored2.message),
    stored2.message
  )

  // 熔断:onEnable 与 runAction 都抛 → 连续 3 次失败后强关窗口 + 落盘
  console.log('\n[B] 熔断')
  await current.save('sbx-throws', { enabled: true })
  await sleep(300)
  await current.runAction('sbx-throws', 'report')
  await sleep(100)
  await current.runAction('sbx-throws', 'report')
  await sleep(300)
  const throwsView = (await current.list()).find(p => p.descriptor.id === 'sbx-throws')
  check(
    '连续失败 3 次后被熔断',
    throwsView?.disabledByHost === true,
    `failures=${throwsView?.failures} disabledByHost=${throwsView?.disabledByHost}`
  )
  check('熔断后窗口被强关', await until(() => pluginWindowOf('sbx-throws') === null, 2500))

  const record = await getRecord('sbx-throws')
  check('熔断不写进 installed.json(那是安装信息,不是运行态)', record !== null)
  const settingsRaw = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as {
    plugins: Record<string, { enabled?: boolean }>
  }
  check('熔断状态落盘了(重启后不会自己跑起来)', settingsRaw.plugins['sbx-throws']?.enabled === false)

  // 重启模拟:重新建一个宿主(与真实重启一样从磁盘读起)
  current = await initPluginHost()
  const afterRestart = (await current.list()).find(p => p.descriptor.id === 'sbx-throws')
  check('重启后仍然是停用状态', afterRestart?.state.enabled === false)

  // ---------- C 权限矩阵 ----------

  console.log('\n[C] 权限矩阵')
  const target = join(vault, '受保护.md')
  await writeFile(target, '原文\n', 'utf8')
  const before = (await stat(target)).mtimeMs
  await sleep(30)
  const deniedW = await opAs('sbx-readonly', 'vault.write', { path: '受保护.md', text: '被改了' })
  check('没声明 vault:write → 写被拒', deniedW.ok === false && deniedW.error.code === 'E_PERMISSION', JSON.stringify(deniedW))
  check('被拒之后文件内容没变', (await readFile(target, 'utf8')) === '原文\n')
  check('被拒之后文件 mtime 没变', (await stat(target)).mtimeMs === before)

  const allowedR = await opAs('sbx-readonly', 'vault.read', { path: '笔记.md' })
  check('声明了 vault:read → 读得到', allowedR.ok === true && (allowedR.value as { text: string }).text === '# 笔记\n')

  // 手动安装(source: 'local')没有确认流程:清单写了就算给了(界面上标注未经确认)
  const localRead = await opAs('sbx-local', 'vault.read', { path: '笔记.md' })
  check('手动拷进来的插件(未经确认)按"清单写了就算给了"处理', localRead.ok === true, JSON.stringify(localRead))

  // 撤回授权:installed.json 里的 grant 拿掉,清单还写着 —— 必须仍然被拒
  const rec = await getRecord('sbx-readonly')
  if (rec) {
    await setRecord({ ...rec, grantedPermissions: [] })
    current = await initPluginHost()
    const denied2 = await opAs('sbx-readonly', 'vault.read', { path: '笔记.md' })
    check(
      '授权被撤回(installed.json 里删掉)之后,即使清单还写着也读不到',
      denied2.ok === false && denied2.error.code === 'E_PERMISSION',
      JSON.stringify(denied2)
    )
    const view3 = (await current.list()).find(p => p.descriptor.id === 'sbx-readonly')
    check('界面上的权限列表跟着收缩', (view3?.permissions ?? ['vault:read']).length === 0)
  }

  // ---------- D 路径 ----------

  console.log('\n[D] 路径关卡')
  const cases: { label: string; path: string; expect: string }[] = [
    { label: '../../.ssh/id_rsa 这类越界', path: '../../.ssh/id_rsa', expect: 'E_BAD_ARGS' },
    { label: '绝对路径', path: 'C:/Windows/win.ini', expect: 'E_BAD_ARGS' },
    { label: '反斜杠分隔', path: '..\\..\\x', expect: 'E_BAD_ARGS' },
    { label: 'URL 编码的 ..', path: '%2e%2e/secret.txt', expect: 'E_BAD_ARGS' },
    { label: '.git/config(可能含凭据)', path: '.git/config', expect: 'E_PERMISSION' }
  ]
  for (const c of cases) {
    const r = await opAs('sbx-local', 'vault.read', { path: c.path })
    const code = r.ok ? 'ok' : r.error.code
    check(`${c.label} 被拒(${c.expect})`, code === c.expect, code)
  }
  if (symlinkOk) {
    const r = await opAs('sbx-local', 'vault.read', { path: 'link-out/secret.txt' })
    check('仓库内的符号链接指向仓库外 → 被拒', r.ok === false, JSON.stringify(r))
  } else {
    console.log('  · 跳过符号链接一条(本机没有创建符号链接的权限)')
  }
  const writeOutside = await opAs('sbx-local', 'vault.write', { path: '../outside/x.txt', text: 'x' })
  check('写仓库外的路径被拒', writeOutside.ok === false)

  // ---------- E 网络 ----------

  console.log('\n[E] 网络策略')
  const calls: string[] = []
  setNetFetchImpl(async (url, init) => {
    calls.push(url)
    if (url.includes('redirect')) {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    }
    if (url.includes('too-big')) {
      return new Response(new Uint8Array(9 * 1024 * 1024), { status: 200 })
    }
    return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=b' } })
  })

  const local = await opAs('sbx-net', 'net.fetch', { url: 'http://127.0.0.1:8787/api' })
  check('默认拒本机地址', local.ok === false && local.error.code === 'E_PERMISSION', JSON.stringify(local))
  check('被拒时请求压根没发出去', calls.length === 0, calls.join(','))

  await current.setNetAccess('sbx-net', true)
  const local2 = await opAs('sbx-net', 'net.fetch', { url: 'http://127.0.0.1:8787/api' })
  check('用户在设置里放开之后可以连本机', local2.ok === true, JSON.stringify(local2))

  await current.setNetAccess('sbx-net', false)
  const redirect = await opAs('sbx-net', 'net.fetch', { url: 'http://example.com/redirect' })
  check(
    '重定向的第二跳指向元数据地址 → 被拒(手动跟跳 + 每跳重查)',
    redirect.ok === false && redirect.error.code === 'E_PERMISSION',
    JSON.stringify(redirect)
  )
  const big = await opAs('sbx-net', 'net.fetch', { url: 'http://example.com/too-big' })
  check('超大响应在 8 MiB 处失败', big.ok === false && /8 MiB/.test(big.error.message), JSON.stringify(big))

  const okFetch = await opAs('sbx-net', 'net.fetch', { url: 'http://example.com/ok' })
  check('正常请求返回结构化结果', okFetch.ok === true && (okFetch.value as { body: string }).body === 'hello')
  check(
    '响应里不带 set-cookie',
    okFetch.ok && !Object.keys((okFetch.value as { headers: object }).headers).includes('set-cookie')
  )

  // ---------- F 闸门与兼容 ----------

  console.log('\n[F] 闸门与兼容')
  const unknown = await opAs('sbx-net', 'vault.exec', { cmd: 'rm -rf /' })
  check('表外的 op 一律拒绝(没有通用透传)', unknown.ok === false && unknown.error.code === 'E_UNKNOWN_OP')

  const badArgs = await opAs('sbx-local', 'vault.read', 42)
  check('参数形状不对 → E_BAD_ARGS', badArgs.ok === false && badArgs.error.code === 'E_BAD_ARGS')

  let busy = 0
  for (let i = 0; i < 70; i++) {
    const r = await opAs('sbx-local', 'vault.write', { path: '限流.md', text: 'y' })
    if (!r.ok && r.error.code === 'E_BUSY') busy += 1
  }
  check('写文件的频率限制生效(vault.write 60/分钟)', busy > 0, `被拒 ${busy} 次`)

  /**
   * git.run 的 cwd 与参数。
   *
   * 这一组是**回归**固化下来的:能力表最初把沙箱的"只收相对路径"规则套到了 git.run 上,
   * 而 git-sync(trusted 插件)一直传的是 `settings.vaultPath` 那个**绝对**路径 ——
   * 于是它当场报「路径请用正斜杠 / 分隔」。要守住的是范围(必须在仓库里),不是写法。
   */
  const insideVault = await opAs('sbx-git', 'git.run', { args: ['status'], cwd: vault })
  check('git.run 接受仓库内的绝对路径(trusted 插件一直这么传)', insideVault.ok === true, JSON.stringify(insideVault))
  const outsideVault = await opAs('sbx-git', 'git.run', { args: ['status'], cwd: outside })
  check(
    'git.run 拒绝仓库外的绝对路径',
    outsideVault.ok === false && outsideVault.error.code === 'E_PERMISSION',
    JSON.stringify(outsideVault)
  )
  const evilArg = await opAs('sbx-git', 'git.run', { args: ['-c', 'core.sshCommand=calc', 'status'] })
  check('git.run 拒绝能变成任意命令执行的参数(-c)', evilArg.ok === false && evilArg.error.code === 'E_BAD_ARGS')
  const evilSub = await opAs('sbx-git', 'git.run', { args: ['daemon'] })
  check('git.run 拒绝白名单之外的子命令', evilSub.ok === false && evilSub.error.code === 'E_BAD_ARGS')

  const g = opPermissions()
  check('能力表里每一项都标了权限或 null', Object.values(g).every(v => v === null || typeof v === 'string'))
  check('能力表覆盖了清单里出现的权限词', Object.values(g).some(v => v === 'vault:read'))

  const kinds = [
    validateManifest({ id: 'xx', name: 'x', description: '', version: '1.0.0', kind: 'quantum', fields: [], actions: [] }),
    validateManifest({
      id: 'xx',
      name: 'x',
      description: '',
      version: '1.0.0',
      kind: 'sandboxed',
      main: 'main.js',
      ui: { entry: 'ui/i.html' },
      fields: [],
      actions: []
    })
  ]
  check(
    '不认识的 kind 明确拒绝(旧版应用据这条拒绝沙箱包)',
    kinds[0]?.ok === false && kinds[0].errors.some(e => e.includes('kind')),
    JSON.stringify(kinds[0]?.errors)
  )
  check(
    '声明了 ui 却没申请 ui 权限 → 拒绝',
    kinds[1]?.ok === false && kinds[1].errors.some(e => e.includes('ui')),
    JSON.stringify(kinds[1]?.errors)
  )
  check('沙箱专属权限出现在 script 清单里 → 拒绝', (() => {
    const r = validateManifest({
      id: 'xx', name: 'x', description: '', version: '1.0.0', kind: 'script', main: 'main.js',
      permissions: ['ui'], fields: [], actions: []
    })
    return r.ok === false && r.errors.some(e => e.includes('ui'))
  })())
  check('SANDBOX_ONLY_PERMISSIONS 与 hasMainEntry 的口径对得上', SANDBOX_ONLY_PERMISSIONS.length === 2 && hasMainEntry('sandboxed'))

  const resolved = await resolveVaultPath('', 'dir')
  check('仓库根可以被解析出来', resolved === vault, resolved)

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  await rm(join(outside, 'secret.txt'), { force: true }).catch(() => {})
  app.exit(fail === 0 ? 0 : 1)
}

void main()
