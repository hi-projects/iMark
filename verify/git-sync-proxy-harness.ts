/**
 * git-sync 的**本机代理路径**验收。
 *
 * 为什么单独一套：浏览器走系统代理，git 的 libcurl 不读它 —— 「浏览器能打开
 * GitHub，扩展测试连接却超时」是最容易踩到、又最难自查的配置。这里钉住三件事：
 *   1. 手动代理：起一个真正的 forward proxy，远端域名用解析不了的 `.invalid`，
 *      只有请求真的经过代理，`ls-remote` 才可能成功；
 *   2. 自动检测：环境变量里的 HTTP_PROXY 被宿主进程读到并显式交给 git；
 *   3. 找不到代理：手动地址为空时直接连接，环境变量里的代理也不能生效
 *      （并断言代理没收到新请求）。
 * 另外验一次**推送**也带上了代理参数，而不是只有「测试连接」这一条路。
 *
 * git 跑在扩展宿主进程里。宿主在 fork 时继承主进程环境变量，
 * 所以 HTTP_PROXY 必须在 `service.startup()` 之前设置，否则宿主读不到。
 *
 * 跑法（在仓库根目录）：node verify/run.mjs git-sync-proxy
 */

import { app, dialog, protocol } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { installExtensionPackage } from '../src/main/extensions/installer'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import {
  normalizeProxyUrl,
  parseGnomeProxy,
  parseProxyOverride,
  parseRegQuery,
  parseWindowsProxyServer,
  proxyForUrl,
  proxyFromGnome
} from '../plugins-src/git-sync/proxy'

const run = promisify(execFile)
const REPO = join(__dirname, '..', '..')
const EXT_ID = 'imark.git-sync'
import { APP_VERSION } from './appVersion'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd })
  return stdout
}

/**
 * 一个真的 forward proxy：只处理绝对 URI（GET http://host/path），按裸仓库的
 * dumb-http 文件结构回内容。远端域名用 `.invalid`，解析必然失败 —— 于是
 * 「测试连接成功」这件事本身就证明了请求确实经过了代理。
 */
function startForwardProxy(root: string): Promise<{
  url: string
  seen: { method: string; url: string }[]
  close(): void
}> {
  const seen: { method: string; url: string }[] = []
  const server: Server = createServer((req, res) => {
    const raw = req.url ?? ''
    seen.push({ method: req.method ?? '', url: raw })
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      res.writeHead(400)
      res.end('absolute URI required')
      return
    }
    // 推送会走到这里：回一个明确的 501，让 git 失败，但请求已记下
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(501)
      res.end('receive-pack not supported by harness proxy')
      return
    }
    const rel = decodeURIComponent(target.pathname).replace(/^\/notes\.git/, '')
    readFile(join(root, rel)).then(
      buf => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(buf)
      },
      () => {
        res.writeHead(404)
        res.end('404')
      }
    )
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => server.close()
      })
    })
  })
}

interface TargetConfig {
  id: string
  url: string
  auth: 'ssh' | 'token' | 'password'
  username: string
  localBranch: string
  remoteBranch: string
}

/** 配置存的是**完整键**:`<扩展id>.<属性>` */
const configKey = (key: string): string => `${EXT_ID}.${key}`

const configOf = (target: TargetConfig, mode: string, proxyUrl: string): Record<string, unknown> => ({
  [configKey('targets')]: [target],
  [configKey('intervalMinutes')]: 0,
  [configKey('syncOnStart')]: false,
  [configKey('commitMessage')]: 'sync: {time}',
  [configKey('authorName')]: 'iMark',
  [configKey('authorEmail')]: 'imark@local',
  [configKey('autoInitRepo')]: true,
  [configKey('initBranch')]: 'main',
  [configKey('writeGitignore')]: false,
  [configKey('writeReadme')]: false,
  [configKey('proxyMode')]: mode,
  [configKey('proxyUrl')]: proxyUrl
})

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs git-sync-proxy` 跑会自动带上）')
    app.exit(2)
    return
  }

  // ---------- 零、纯函数：把几种真实写法都过一遍 ----------

  console.log('\n【0】代理地址解析')
  check(
    'ProxyServer 裸 host:port 补成 http://',
    parseWindowsProxyServer('127.0.0.1:7890', 'https') === 'http://127.0.0.1:7890',
    String(parseWindowsProxyServer('127.0.0.1:7890', 'https'))
  )
  check(
    'ProxyServer 按协议取值',
    parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891', 'https') ===
      'http://127.0.0.1:7891',
    String(parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891', 'https'))
  )
  check(
    'ProxyServer 的 socks 项转成 socks5://',
    parseWindowsProxyServer('socks=127.0.0.1:7891', 'http') === 'socks5://127.0.0.1:7891',
    String(parseWindowsProxyServer('socks=127.0.0.1:7891', 'http'))
  )
  const reg = parseRegQuery(
    [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:7890',
      '    ProxyOverride    REG_SZ    <local>;*.corp.example'
    ].join('\r\n')
  )
  check(
    'reg query 输出能解析出 ProxyEnable / ProxyServer',
    reg.get('proxyenable') === '0x1' && reg.get('proxyserver') === '127.0.0.1:7890',
    JSON.stringify([...reg])
  )
  check(
    'ProxyOverride 的 <local> 展开成本机地址',
    parseProxyOverride('<local>;*.corp.example').join(',') ===
      'localhost,127.0.0.1,::1,.corp.example',
    parseProxyOverride('<local>;*.corp.example').join(',')
  )
  check('手动地址缺协议时补 http://', normalizeProxyUrl('127.0.0.1:7890') === 'http://127.0.0.1:7890')
  check('手动地址拒绝非代理协议', normalizeProxyUrl('file:///tmp/x') === null)
  check(
    '回环远端不走代理',
    proxyForUrl('http://127.0.0.1:8080/x', {
      url: 'http://127.0.0.1:7890',
      source: 't',
      bypass: []
    }) === null
  )
  check(
    '外部 HTTPS 远端走代理',
    proxyForUrl('https://github.com/a/b.git', {
      url: 'http://127.0.0.1:7890',
      source: 't',
      bypass: []
    }) === 'http://127.0.0.1:7890'
  )
  check(
    'SSH 远端不走 HTTP 代理',
    proxyForUrl('git@github.com:a/b.git', {
      url: 'http://127.0.0.1:7890',
      source: 't',
      bypass: []
    }) === null
  )
  check(
    'NO_PROXY 命中的域名不走代理',
    proxyForUrl('https://internal.corp.example/x', {
      url: 'http://127.0.0.1:7890',
      source: 't',
      bypass: ['.corp.example']
    }) === null
  )
  check(
    'ProxyOverride 的 10.* 通配符命中内网地址',
    proxyForUrl('https://10.1.2.3/x', {
      url: 'http://127.0.0.1:7890',
      source: 't',
      bypass: parseProxyOverride('10.*;172.2*')
    }) === null
  )

  // ---------- 零之二、Linux GNOME 系统代理 ----------

  console.log('\n【0b】GNOME 系统代理（gsettings）解析')
  const gnomeOutput = [
    "org.gnome.system.proxy autoconfig-url 'http://wpad.example/proxy.pac'",
    "org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1']",
    "org.gnome.system.proxy mode 'manual'",
    'org.gnome.system.proxy use-same-proxy false',
    "org.gnome.system.proxy.http host '127.0.0.1'",
    'org.gnome.system.proxy.http port 7890',
    "org.gnome.system.proxy.https host '127.0.0.1'",
    'org.gnome.system.proxy.https port 7891',
    "org.gnome.system.proxy.socks host ''",
    'org.gnome.system.proxy.socks port 0'
  ].join('\n')
  const gnome = parseGnomeProxy(gnomeOutput)
  check('解析出 manual 与忽略列表', gnome?.mode === 'manual' && gnome.ignoreHosts.join(',') === 'localhost,127.0.0.0/8,::1', JSON.stringify(gnome))
  check(
    'http / https 各自取到地址（FlClash 混合端口）',
    gnome?.http === 'http://127.0.0.1:7890' && gnome?.https === 'http://127.0.0.1:7891',
    JSON.stringify([gnome?.http, gnome?.https])
  )
  const gnomeDetected = gnome ? proxyFromGnome(gnome, 'https') : null
  check(
    'HTTPS 远端使用 https 项，来源标明 GNOME',
    gnomeDetected?.url === 'http://127.0.0.1:7891' && gnomeDetected.source === 'Linux 系统代理（GNOME）',
    JSON.stringify(gnomeDetected)
  )
  check(
    '忽略列表交给 NO_PROXY 语义（本机与回环仍直连）',
    proxyForUrl('http://127.0.0.1:9/x', gnomeDetected) === null,
    String(proxyForUrl('http://127.0.0.1:9/x', gnomeDetected))
  )
  // https 项为空时退回 http 项(只设了 HTTP 代理的客户端)
  const httpOnly = parseGnomeProxy(
    [
      "org.gnome.system.proxy mode 'manual'",
      'org.gnome.system.proxy use-same-proxy false',
      "org.gnome.system.proxy.http host '127.0.0.1'",
      'org.gnome.system.proxy.http port 7890',
      "org.gnome.system.proxy.https host ''",
      'org.gnome.system.proxy.https port 0'
    ].join('\n')
  )
  check(
    'https 项为空时退回 http 项',
    httpOnly && proxyFromGnome(httpOnly, 'https')?.url === 'http://127.0.0.1:7890',
    JSON.stringify(httpOnly && proxyFromGnome(httpOnly, 'https'))
  )
  // 只有 socks 项时给 git 一个 socks5 地址
  const socksOnly = parseGnomeProxy(
    [
      "org.gnome.system.proxy mode 'manual'",
      'org.gnome.system.proxy use-same-proxy false',
      "org.gnome.system.proxy.socks host '127.0.0.1'",
      'org.gnome.system.proxy.socks port 7891'
    ].join('\n')
  )
  check(
    '只有 socks 项时归一成 socks5://',
    socksOnly && proxyFromGnome(socksOnly, 'https')?.url === 'socks5://127.0.0.1:7891',
    JSON.stringify(socksOnly && proxyFromGnome(socksOnly, 'https'))
  )
  const gnomeOff = parseGnomeProxy(
    [
      "org.gnome.system.proxy mode 'none'",
      "org.gnome.system.proxy.http host '127.0.0.1'",
      'org.gnome.system.proxy.http port 7890'
    ].join('\n')
  )
  check('mode 不是 manual 时不算检测到代理', gnomeOff !== null && proxyFromGnome(gnomeOff, 'https') === null)
  const gnomeAll = parseGnomeProxy(
    [
      "org.gnome.system.proxy mode 'manual'",
      "org.gnome.system.proxy ignore-hosts ['*']",
      "org.gnome.system.proxy.http host '127.0.0.1'",
      'org.gnome.system.proxy.http port 7890'
    ].join('\n')
  )
  check(
    'ignore-hosts 为 * 时按全部直连处理',
    gnomeAll !== null && proxyFromGnome(gnomeAll, 'https') === null
  )
  const gnomeV6 = parseGnomeProxy(
    [
      "org.gnome.system.proxy mode 'manual'",
      "org.gnome.system.proxy.http host '::1'",
      'org.gnome.system.proxy.http port 7890'
    ].join('\n')
  )
  check(
    'IPv6 主机补上方括号',
    gnomeV6 && proxyFromGnome(gnomeV6, 'http')?.url === 'http://[::1]:7890',
    JSON.stringify(gnomeV6 && proxyFromGnome(gnomeV6, 'http'))
  )

  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const remote = join(ud, 'remote.git')
  const note = join(vault, '笔记.md')
  for (const dir of [vault, remote, join(ud, 'plugins'), join(ud, 'extensions-data')]) {
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(vault, { recursive: true })
  await mkdir(remote, { recursive: true })
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await writeFile(note, '# 代理验收\n\n经代理上传。\n', 'utf8')
  // dumb http 的 ls-remote 读的是 update-server-info 写的 info/refs
  await git(remote, ['update-server-info'])

  const proxy = await startForwardProxy(remote)
  console.log(`\n【代理】${proxy.url}`)

  // 开发机可能本来就设着别的代理变量，先全部清掉，让断言只反映本用例。
  // 这些变量要在扩展宿主 fork 之前设置：宿主会继承此刻的环境。
  for (const key of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy'
  ]) {
    delete process.env[key]
  }
  process.env.HTTP_PROXY = proxy.url
  process.env.http_proxy = proxy.url

  const target: TargetConfig = {
    id: 'p1',
    // .invalid 永远不会解析成功：不经过代理就必然失败
    url: 'http://imk-proxy-test.invalid/notes.git',
    localBranch: 'main',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off',
        extensions: {
          [EXT_ID]: { enabled: true, config: configOf(target, 'manual', proxy.url) }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  const envelope = JSON.parse(
    await readFile(join(REPO, 'src/main/market/builtin/imark.git-sync.imkpkg.json'), 'utf8')
  ) as unknown
  await installExtensionPackage(envelope, { source: 'bundled', appVersion: APP_VERSION })

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  await service.setExtensionSecret(EXT_ID, 'targets:p1', 'tok-proxy')
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)
  // 这一行之后宿主才 fork，HTTP_PROXY 才会被继承
  await service.startup()
  await sleep(500)

  const view = async () => (await service.getExtensionViews()).find(v => v.descriptor.id === EXT_ID)
  check('扩展已激活', service.isActivated(EXT_ID))
  check(
    '代理字段已归一化进配置',
    (await view())?.config['imark.git-sync.proxyMode'] === 'manual' &&
      (await view())?.config['imark.git-sync.proxyUrl'] === proxy.url,
    JSON.stringify((await view())?.config)
  )

  const logText = async (): Promise<string> => {
    const path = service.getLogPath(EXT_ID)
    await sleep(400)
    return path ? await readFile(path, 'utf8').catch(() => '') : ''
  }

  /** 等配置变更触发的后台同步跑完，免得它插进后面的断言 */
  async function settle(): Promise<void> {
    await sleep(3800)
    const until = Date.now() + 10_000
    while (Date.now() < until) {
      if ((await view())?.status.status !== 'running') return
      await sleep(150)
    }
  }

  // ---------- 一、手动代理：测试连接 ----------

  console.log('\n【1】手动代理 + 测试连接')
  const probe = (await service.executeCommand('imark.git-sync.testTarget', [
    { targetId: 'p1' }
  ])) as { ok: boolean; message: string; detail?: string }
  console.log(`      扩展自己说：${probe.message}${probe.detail ? ` / ${probe.detail}` : ''}`)
  check('测试连接成功（远端域名本身解析不了，只能经代理）', probe?.ok === true, JSON.stringify(probe))
  check(
    '代理确实收到了 ls-remote 请求（绝对 URI 形态）',
    proxy.seen.some(
      r =>
        r.url.startsWith('http://imk-proxy-test.invalid/notes.git/') &&
        r.url.includes('/info/refs')
    ),
    JSON.stringify(proxy.seen.slice(-3))
  )
  check(
    '扩展日志写明了代理与来源',
    (await logText()).includes(`经代理 ${proxy.url}`) && (await logText()).includes('扩展设置'),
    (await logText()).slice(-300)
  )

  // ---------- 二、自动检测：环境变量 ----------

  console.log('\n【2】自动检测 + HTTP_PROXY 环境变量')
  await service.setExtensionConfig(EXT_ID, configOf(target, 'auto', proxy.url))
  await sleep(300)
  const beforeAuto = proxy.seen.length
  const autoProbe = (await service.executeCommand('imark.git-sync.testTarget', [
    { targetId: 'p1' }
  ])) as { ok: boolean; message: string }
  check('自动模式经环境变量代理连接成功', autoProbe?.ok === true, JSON.stringify(autoProbe))
  check('代理收到了自动模式的请求', proxy.seen.length > beforeAuto, `${beforeAuto} → ${proxy.seen.length}`)
  check(
    '日志里写明了来源是环境变量',
    (await logText()).includes('环境变量 HTTP_PROXY'),
    (await logText()).slice(-300)
  )

  const detectAuto = (await service.executeCommand('imark.git-sync.detectProxy')) as {
    ok: boolean
    message: string
  }
  check(
    '「检测本机代理」报告环境变量来源与端口可连接',
    detectAuto?.ok === true &&
      detectAuto.message.includes(proxy.url) &&
      detectAuto.message.includes('环境变量 HTTP_PROXY') &&
      detectAuto.message.includes('端口可连接'),
    detectAuto?.message
  )
  const detectAgain = (await service.executeCommand('imark.git-sync.detectProxy')) as {
    ok: boolean
  }
  check('重复检测不会破坏状态', detectAgain?.ok === true, JSON.stringify(detectAgain))
  await settle()

  // ---------- 三、找不到代理：直接连接，且压过环境变量 ----------

  console.log('\n【3】手动代理地址为空：直接连接（环境变量里的代理也不应生效）')
  await service.setExtensionConfig(EXT_ID, configOf(target, 'manual', ''))
  await sleep(300)
  const beforeDirect = proxy.seen.length
  const directProbe = (await service.executeCommand('imark.git-sync.testTarget', [
    { targetId: 'p1' }
  ])) as { ok: boolean; message: string; detail?: string }
  check('没有可用代理时连接失败（.invalid 解析不了）', directProbe?.ok === false, JSON.stringify(directProbe))
  check(
    '没有可用代理时没有向代理发请求',
    proxy.seen.length === beforeDirect,
    `${beforeDirect} → ${proxy.seen.length}`
  )
  check(
    '失败提示说清了已直接连接',
    (directProbe.detail ?? '').includes('直接连接'),
    directProbe.detail ?? ''
  )
  const detectEmpty = (await service.executeCommand('imark.git-sync.detectProxy')) as {
    message: string
  }
  check(
    '「检测本机代理」报告手动地址为空',
    (detectEmpty?.message ?? '').includes('无法识别'),
    detectEmpty?.message
  )
  await settle()

  // ---------- 四、推送路径也带代理 ----------

  console.log('\n【4】立即上传：推送也要经过代理')
  await service.setExtensionConfig(EXT_ID, configOf(target, 'manual', proxy.url))
  await sleep(300)
  const beforePush = proxy.seen.length
  const sync = (await service.executeCommand('imark.git-sync.syncNow')) as {
    ok: boolean
    message: string
  }
  const pushSeen = proxy.seen.slice(beforePush)
  check('推送失败是预期的（验收代理不支持 receive-pack）', sync?.ok === false, JSON.stringify(sync))
  check(
    '推送的握手请求确实经过了代理（git-receive-pack）',
    pushSeen.some(r => r.url.includes('git-receive-pack')),
    JSON.stringify(pushSeen)
  )
  check(
    '推送日志里同样写明了代理',
    (await logText()).includes(`经代理 ${proxy.url}`),
    (await logText()).slice(-300)
  )

  await settle()
  proxy.close()
  await shutdownExtensions()
  console.log(`\n${pass} 通过，${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
