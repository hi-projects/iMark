/**
 * git-sync 的**凭据路径**端到端验收。
 *
 * 主 harness 用的是 ssh + 本地路径远端，`credentialArgs()` 返回空数组，于是
 * 「一次性 credential helper 拼进 git 命令行 + 用户名/令牌经环境变量传给子进程」
 * 这条真实用户最常走的路（HTTPS + 访问令牌）一次都没被跑过。
 *
 * 这里验三件事：
 *   1. 带令牌的目标能真跑一次「立即上传」，提交落到远端；
 *   2. 仓库与全局都没有 user.name/user.email 时，`-c user.name=…` 兜底照样可用；
 *   3. 起一个要求 Basic 认证的 HTTP 端点，让 git 真去问 credential helper ——
 *      断言服务端收到的正是配置里那对用户名/口令。
 *
 * 跑法（在仓库根目录）：node verify/run.mjs git-sync-auth
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

async function gitSoft(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch {
    return ''
  }
}

/**
 * 要求 Basic 认证的静态端点：认证头记下来给断言用，其余按裸仓库的 dumb http
 * 协议发文件（`git update-server-info` 写的 info/refs）。不带认证头一律 401。
 */
function startAuthServer(root: string): Promise<{ url: string; seen: string[]; close(): void }> {
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const auth = req.headers.authorization
    if (auth) seen.push(auth)
    if (!auth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="imk"' })
      res.end('auth required')
      return
    }
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/notes\.git/, '')
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
        url: `http://127.0.0.1:${port}/notes.git`,
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

const configOf = (targets: TargetConfig[]): Record<string, unknown> => ({
  [configKey('targets')]: targets,
  [configKey('intervalMinutes')]: 0,
  [configKey('syncOnStart')]: false,
  [configKey('commitMessage')]: 'sync: {time}',
  [configKey('authorName')]: 'iMark',
  [configKey('authorEmail')]: 'imark@local',
  [configKey('autoInitRepo')]: true,
  [configKey('initBranch')]: 'main',
  [configKey('writeGitignore')]: false,
  [configKey('writeReadme')]: false,
  [configKey('proxyMode')]: 'off',
  [configKey('proxyUrl')]: 'http://127.0.0.1:7890'
})

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs git-sync-auth` 跑会自动带上）')
    app.exit(2)
    return
  }

  // 让仓库与全局都查不到 user.name/user.email —— 逼扩展走 `-c user.name=…` 兜底。
  // 真实用户「换台机器、还没配过 git」就是这个状态。
  // 必须在 fork 扩展宿主之前设置：宿主继承主进程环境变量。
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = join(process.cwd(), '.verify-ud', 'gitconfig-不存在')

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
  await writeFile(note, '# 第一篇\n\n同步我。\n', 'utf8')

  const TOKEN_LOCAL = 'tok-local-secret'
  const TOKEN_HTTP = 'tok-http-secret'
  const PASS_HTTP = 'pa55-secret'
  const baseTarget: TargetConfig = {
    id: 't1',
    url: remote,
    localBranch: 'main',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  // 端口要等服务器起来才知道；先用占位地址，测试前再回填
  const httpTokenTarget: TargetConfig = {
    id: 't2',
    url: 'http://127.0.0.1:1/notes.git',
    localBranch: 'main',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  const httpPasswordTarget: TargetConfig = {
    id: 't3',
    url: 'http://127.0.0.1:1/notes.git',
    localBranch: 'main',
    remoteBranch: '',
    auth: 'password',
    username: 'alice'
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
          [EXT_ID]: { enabled: true, config: configOf([baseTarget]) }
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
  // 密钥在启动前写入（槽位与扩展自己的 key 一致）；写入失败会直接抛
  await service.setExtensionSecret(EXT_ID, 'targets:t1', TOKEN_LOCAL)
  await service.setExtensionSecret(EXT_ID, 'targets:t2', TOKEN_HTTP)
  await service.setExtensionSecret(EXT_ID, 'targets:t3#password', PASS_HTTP)

  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)
  await service.startup()
  await sleep(500)

  const view = async () => (await service.getExtensionViews()).find(v => v.descriptor.id === EXT_ID)

  async function waitStatus(status: string, ms = 15_000): Promise<void> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if ((await view())?.status.status === status) return
      await sleep(120)
    }
  }

  // ---------- 一、带令牌的目标真跑一次「立即上传」 ----------

  console.log('\n【1】令牌认证 + 立即上传')
  const first = (await service.executeCommand('imark.git-sync.syncNow')) as {
    ok: boolean
    message: string
  }
  console.log(`      扩展自己说：${first?.message}`)
  check('命令返回成功', first?.ok === true, JSON.stringify(first))

  const branches = await gitSoft(remote, ['branch', '--list', '--format=%(refname:short)'])
  check('远端有了 main 分支', branches.trim() === 'main', branches.trim())
  check('笔记被推上去了', (await gitSoft(remote, ['ls-tree', '-r', '--name-only', 'main'])).includes('笔记.md'))
  const author = (await gitSoft(remote, ['log', '-1', '--format=%an <%ae>', 'main'])).trim()
  check('仓库/全局没有身份时用插件的兜底身份', author === 'iMark <imark@local>', author)
  await waitStatus('ok')
  check('推送结果按目标记下（t1 = ok）', (await view())?.status.targetResults?.t1 === 'ok', JSON.stringify((await view())?.status.targetResults))

  check(
    '本地路径远端不因为带令牌参数而失败（凭据参数未破坏 git 调用）',
    first?.ok === true
  )
  check('明文令牌没有写进 settings.json', !(await readFile(join(ud, 'settings.json'), 'utf8')).includes(TOKEN_LOCAL))

  // ---------- 二、测试连接打到要求认证的 HTTP 端点 ----------

  // 先让远端有 refs，ls-remote 才有的可读（dumb http 读 info/refs）
  await gitSoft(remote, ['update-server-info'])
  const http = await startAuthServer(remote)
  httpTokenTarget.url = http.url
  httpPasswordTarget.url = http.url

  await service.setExtensionConfig(EXT_ID, configOf([baseTarget, httpTokenTarget, httpPasswordTarget]))
  await sleep(300)

  console.log('\n【2】访问令牌 + 测试连接（远端要求 Basic 认证）')
  http.seen.length = 0
  const probeToken = (await service.executeCommand('imark.git-sync.testTarget', [
    { targetId: 't2' }
  ])) as { ok: boolean; message: string }
  console.log(`      扩展自己说：${probeToken?.message}`)
  const expectedToken = `Basic ${Buffer.from(`oauth2:${TOKEN_HTTP}`).toString('base64')}`
  check(
    '服务端收到 oauth2 + 访问令牌（credential helper 真的被调用）',
    http.seen.length > 0 && http.seen.every(h => h === expectedToken),
    http.seen.length === 0 ? '一次认证请求都没收到' : http.seen.join(' | ')
  )
  check('测试连接返回成功', probeToken?.ok === true, JSON.stringify(probeToken))
  check(
    '状态行用「第 2 个远端」定位目标',
    ((await view())?.status.lastMessage ?? '').startsWith('第 2 个远端：'),
    (await view())?.status.lastMessage
  )
  check(
    '单目标测试不抹掉其他远端已有的结果',
    (await view())?.status.targetResults?.t1 === 'ok' && (await view())?.status.targetResults?.t2 === 'ok',
    JSON.stringify((await view())?.status.targetResults)
  )

  console.log('\n【3】账号密码 + 测试连接')
  http.seen.length = 0
  const probePassword = (await service.executeCommand('imark.git-sync.testTarget', [
    { targetId: 't3' }
  ])) as { ok: boolean; message: string }
  const expectedPassword = `Basic ${Buffer.from(`alice:${PASS_HTTP}`).toString('base64')}`
  check(
    '服务端收到配置里的账号与密码',
    http.seen.length > 0 && http.seen.every(h => h === expectedPassword),
    http.seen.length === 0 ? '一次认证请求都没收到' : http.seen.join(' | ')
  )
  check('测试连接返回成功', probePassword?.ok === true, JSON.stringify(probePassword))

  // ---------- 三、全部远端 ----------

  console.log('\n【4】测试全部远端：三个都走同一条凭据路径')
  const all = (await service.executeCommand('imark.git-sync.testAll')) as {
    ok: boolean
    message: string
  }
  check('testAll 成功', all?.ok === true, JSON.stringify(all))
  await waitStatus('ok')
  const allStatus = (await view())?.status
  check(
    '状态正文逐行列出三个远端',
    (allStatus?.lastMessage ?? '').split('\n').length === 3 &&
      (allStatus?.lastMessage ?? '').includes('第 3 个远端：'),
    allStatus?.lastMessage
  )
  const results = allStatus?.targetResults
  check(
    '三个远端都记为 ok',
    results?.t1 === 'ok' && results?.t2 === 'ok' && results?.t3 === 'ok',
    JSON.stringify(results)
  )

  // ---------- 四、密钥隔离 ----------

  console.log('\n【5】密钥只留在主进程：界面只有掩码，日志不含明文')
  const withSecrets = await service.getExtensionViewWithSecrets(EXT_ID)
  const hints = Object.entries(withSecrets?.secrets ?? {})
  check('三个密钥槽位都有掩码', hints.length === 3, JSON.stringify(hints))
  check(
    '掩码不是明文（也不包含明文片段）',
    hints.every(([, hint]) => hint.length > 0 && ![TOKEN_LOCAL, TOKEN_HTTP, PASS_HTTP].some(secret => hint.includes(secret))),
    JSON.stringify(hints)
  )
  check(
    '渲染层页面里没有明文密钥',
    !(await wc.executeJavaScript(
      `document.documentElement.innerHTML.includes(${JSON.stringify(TOKEN_HTTP)})`
    ))
  )

  // 输出通道：能读到每次网络操作走了什么连接方式
  const logPath = service.getLogPath(EXT_ID)
  await sleep(500)
  const logText = logPath ? await readFile(logPath, 'utf8').catch(() => '') : ''
  check('输出通道写下了网络连接方式', logText.includes('直连（插件里已关闭代理）'), logText.slice(-300))
  check(
    '日志里没有明文密钥',
    ![TOKEN_LOCAL, TOKEN_HTTP, PASS_HTTP].some(secret => logText.includes(secret)),
    logText.slice(-300)
  )

  // 等配置变更触发的后台补跑结束，别在退出时打断它的子进程
  await sleep(4500)
  http.close()
  await shutdownExtensions()
  console.log(`\n${pass} 通过，${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
