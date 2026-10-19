/**
 * 「定时上传（Git）」的**本机代理路径**验收。
 *
 * 为什么单独一套:浏览器走的是 Windows 系统代理,git 的 libcurl 不读它 ——
 * 于是「浏览器能打开 GitHub,插件测试连接超时」成为最容易踩到、又最难自查的配置。
 * 这里用三件事把它钉住:
 *   1. 手动代理:起一个真正的 forward proxy,把远端域名指向一个**解析不了**的
 *      `.invalid` 地址;只有请求真的经过代理,`ls-remote` 才可能成功;
 *   2. 自动检测:把 HTTP_PROXY 指向上面的代理,验证自动模式确实用了环境变量;
 *   3. 直连:同一个环境变量还在,但 off 模式必须压过它(并断言代理没收到新请求)。
 * 另外单独验一次**推送**也带上了代理参数,而不是只有「测试连接」这一条路。
 *
 * 解析函数(reg query 输出、ProxyServer 分协议写法、NO_PROXY/回环判断)是纯函数,
 * 直接 import 插件源码断言,不依赖这台机器当前的系统代理设置。
 *
 * 跑法(在仓库根目录):node verify/run.mjs git-sync-proxy
 */

import { app, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { setSecret } from '../src/main/secrets'
import { secretKey, targetSecretSlot, type PluginTarget } from '../src/shared/plugins'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import {
  normalizeProxyUrl,
  parseProxyOverride,
  parseRegQuery,
  parseWindowsProxyServer,
  proxyForUrl
} from '../plugins-src/git-sync/proxy'

registerPluginScheme()

const run = promisify(execFile)

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

/** 在指定目录跑 git,返回 stdout */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd })
  return stdout
}

/**
 * 一个真的 forward proxy:只处理绝对 URI(GET http://host/path),按裸仓库的
 * dumb-http 文件结构回内容。远端域名用 `.invalid`,解析必然失败 —— 于是
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
      // 不是绝对 URI 就不是 forward proxy 请求,直接拒绝
      res.writeHead(400)
      res.end('absolute URI required')
      return
    }
    // 推送会走到这里:回一个明确的 501,让 git 失败,但请求已记下
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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

  // ---------- 零、纯函数:把几种真实写法都过一遍 ----------
  console.log('\n[零] 代理地址解析')
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

  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const remote = join(ud, 'remote.git')

  for (const d of [vault, remote, join(ud, 'plugins')]) {
    await rm(d, { recursive: true, force: true })
  }
  await mkdir(vault, { recursive: true })
  await mkdir(remote, { recursive: true })

  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await writeFile(join(vault, '笔记.md'), '# 代理验收\n\n经代理上传。\n', 'utf8')

  // dumb http 的 ls-remote 读的是 update-server-info 写的 info/refs
  await git(remote, ['update-server-info'])

  const proxy = await startForwardProxy(remote)
  console.log(`\n[代理] ${proxy.url}`)

  const target: PluginTarget = {
    id: 'p1',
    // .invalid 永远不会解析成功:不经过代理就必然失败
    url: 'http://imk-proxy-test.invalid/notes.git',
    localBranch: 'main',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  await setSecret(secretKey('git-sync', 'targets', targetSecretSlot(target)), 'tok-proxy')

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: null,
        marketUrl: '',
        autoSave: false,
        plugins: {
          'git-sync': {
            enabled: true,
            config: {
              targets: [target],
              intervalMinutes: 0,
              syncOnStart: false,
              commitMessage: 'sync: {time}',
              authorName: 'iMark',
              authorEmail: 'imark@local',
              autoInitRepo: true,
              initBranch: 'main',
              writeGitignore: false,
              writeReadme: false,
              proxyMode: 'manual',
              proxyUrl: proxy.url
            }
          }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned)
  const win = createMainWindow(settings)
  await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const host = getPluginHost()!
  const view = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  console.log('\n[依赖] 插件与代理配置')
  check('git-sync 从内置包加载成功', view !== undefined && view.loadError === undefined,
    String(view?.loadError))
  check('插件版本已更新(含 proxy.js)', view?.descriptor.version === '1.1.0', view?.descriptor.version)
  check('代理字段已归一化进配置', view?.config.proxyMode === 'manual' && view.config.proxyUrl === proxy.url,
    JSON.stringify({ mode: view?.config.proxyMode, url: view?.config.proxyUrl }))

  /** 等配置变更触发的后台同步跑完,免得它插进后面的断言 */
  async function settle(): Promise<void> {
    await sleep(3600)
    for (let i = 0; i < 50; i++) {
      const v = (await host.list()).find(x => x.descriptor.id === 'git-sync')
      if (v?.state.status !== 'running') break
      await sleep(200)
    }
  }

  // ---------- 一、手动代理:测试连接 ----------
  console.log('\n[一] 手动代理 + 测试连接')
  const probe = await host.runAction('git-sync', 'test-connection', 'p1')
  console.log(`      插件自己说:${probe.message}${probe.detail ? ` / ${probe.detail}` : ''}`)
  check('测试连接成功(远端域名本身解析不了,只能经代理)', probe.ok === true,
    `${probe.message} / ${probe.detail ?? ''}`)
  check(
    '代理确实收到了 ls-remote 请求(绝对 URI 形态)',
    proxy.seen.some(
      r =>
        r.url.startsWith('http://imk-proxy-test.invalid/notes.git/') &&
        r.url.includes('/info/refs')
    ),
    JSON.stringify(proxy.seen.slice(-3))
  )
  const logsAfterProbe =
    ((await host.list()).find(v => v.descriptor.id === 'git-sync')?.logs ?? [])
      .map(l => l.message)
      .join('\n')
  check(
    '插件日志写明了代理与来源',
    logsAfterProbe.includes(`经代理 ${proxy.url}`) && logsAfterProbe.includes('插件设置'),
    logsAfterProbe.slice(-300)
  )

  // ---------- 二、自动检测:环境变量 ----------
  console.log('\n[二] 自动检测 + HTTP_PROXY 环境变量')
  // 这台开发机可能本来就设着别的代理变量,先全部清掉,让断言只反映本用例
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
  await host.save('git-sync', { config: { proxyMode: 'auto' } })
  await sleep(300)
  const beforeAuto = proxy.seen.length
  const autoProbe = await host.runAction('git-sync', 'test-connection', 'p1')
  check('自动模式经环境变量代理连接成功', autoProbe.ok === true,
    `${autoProbe.message} / ${autoProbe.detail ?? ''}`)
  check('代理收到了自动模式的请求', proxy.seen.length > beforeAuto,
    `${beforeAuto} → ${proxy.seen.length}`)
  const autoLogs =
    ((await host.list()).find(v => v.descriptor.id === 'git-sync')?.logs ?? [])
      .map(l => l.message)
      .join('\n')
  check('日志里写明了来源是环境变量', autoLogs.includes('环境变量 HTTP_PROXY'), autoLogs.slice(-300))
  const detectAuto = await host.runAction('git-sync', 'detect-proxy')
  check(
    '「检测本机代理」报告环境变量来源与端口可连接',
    detectAuto.ok === true &&
      detectAuto.message.includes(proxy.url) &&
      detectAuto.message.includes('环境变量 HTTP_PROXY') &&
      detectAuto.message.includes('端口可连接'),
    detectAuto.message
  )
  const detectAgain = await host.runAction('git-sync', 'detect-proxy')
  check('重复检测不会破坏状态', detectAgain.ok === true, detectAgain.message)
  await settle()

  // ---------- 三、直连:必须压过环境变量 ----------
  console.log('\n[三] 直连模式:环境变量还在,但不应再走代理')
  await host.save('git-sync', { config: { proxyMode: 'off' } })
  await sleep(300)
  const beforeOff = proxy.seen.length
  const offProbe = await host.runAction('git-sync', 'test-connection', 'p1')
  check('直连模式连接失败(.invalid 解析不了)', offProbe.ok === false, offProbe.message)
  check('直连模式没有向代理发请求', proxy.seen.length === beforeOff,
    `${beforeOff} → ${proxy.seen.length}`)
  check(
    '失败提示说清了是「直连」而不是笼统的「网络错误」',
    (offProbe.detail ?? '').includes('直连'),
    offProbe.detail ?? ''
  )
  const detectOff = await host.runAction('git-sync', 'detect-proxy')
  check('「检测本机代理」如实报告直连', detectOff.message.includes('直连'), detectOff.message)
  await settle()

  // ---------- 四、推送路径也带代理 ----------
  console.log('\n[四] 立即上传:推送也要经过代理')
  await host.save('git-sync', { config: { proxyMode: 'manual', proxyUrl: proxy.url } })
  await sleep(300)
  const beforePush = proxy.seen.length
  const sync = await host.runAction('git-sync', 'sync-now')
  const pushSeen = proxy.seen.slice(beforePush)
  check('推送失败是预期的(验收代理不支持 receive-pack)', sync.ok === false, sync.message)
  check(
    '推送的握手请求确实经过了代理(git-receive-pack)',
    pushSeen.some(r => r.url.includes('git-receive-pack')),
    JSON.stringify(pushSeen)
  )
  const syncLogs =
    ((await host.list()).find(v => v.descriptor.id === 'git-sync')?.logs ?? [])
      .map(l => l.message)
      .join('\n')
  check(
    '推送日志里同样写明了代理',
    syncLogs.includes(`经代理 ${proxy.url}`),
    syncLogs.slice(-300)
  )

  proxy.close()
  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
