/**
 * 「定时上传(Git)」的**凭据路径**端到端验收 —— 补上 git-sync-harness 漏掉的那一半。
 *
 * 为什么单独一套:git-sync-harness 用的是 ssh + 本地路径远端,`credentialArgs()` 返回空数组,
 * 于是「插件把宿主给的一次性 credential helper 拼进 git 命令行、再把用户名/令牌经环境变量
 * 传给子进程」这条**真实用户最常走的路**(https + 访问令牌)一次都没被跑过。
 * 能力表改造之后它整个断了,而原来的 harness 全绿 —— 测试与用户走的是两条路。
 *
 * 这里验三件事,每件都对应一个曾经断掉的环节:
 *   1. 带令牌的目标能真跑一次「立即上传」,提交落到远端(凭据参数不再被闸门拒掉);
 *   2. 仓库与全局都没有 user.name/user.email 时,插件的 `-c user.name=…` 兜底照样可用
 *      (与凭据是同一类"带 -c 的 git 调用");
 *   3. 起一个要求 Basic 认证的 HTTP 端点,让 git 真的去问 credential helper 要凭据 ——
 *      断言服务端收到的**正是**配置里那对用户名/口令,也就是环境变量确实进了子进程。
 *      本地路径远端不会触发认证,少了这条就验不到 env 那一半。
 *
 * 跑法(在仓库根目录):node verify/run.mjs git-sync-auth
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
import { getPluginHost, initPluginHost, operationLabelFor } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { setSecret } from '../src/main/secrets'
import { secretKey, targetSecretSlot, type PluginTarget } from '../src/shared/plugins'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'

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

/** 在指定目录跑 git,返回 stdout(`-c core.quotePath=false` 的理由见 git-sync-harness) */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd })
  return stdout
}

/**
 * 容错的 git 读取:失败了回空串。
 * 前面一条断言失败(推送没成功)时,后面靠 git 读远端来判定的几条会直接抛 ——
 * 一个未处理的 Promise 拒绝会把 harness 打断在半路,剩下的断言连跑都跑不到。
 */
async function gitSoft(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch {
    return ''
  }
}

/**
 * 要求 Basic 认证的静态端点:认证头记下来给断言用,其余按裸仓库的 **dumb http** 协议发文件
 * (`git update-server-info` 写的 info/refs)。不带认证头一律 401 —— git 收到挑战后就会去问
 * credential helper,而 helper 的输入正是插件传进子进程的环境变量。
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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

  // 并发操作的归属:后台同步不能在用户动作跑着时「借走」它的名字。
  // node main 靠 AsyncLocalStorage;restricted 的 setState 经 IPC,跨不过去,仍用共享字段。
  console.log('\n[0] 并发操作的归属')
  check(
    'node main 忽略共享的 currentAction(后台同步不会被记成用户动作)',
    operationLabelFor(null, null, '测试全部远端', 'node') === '后台任务'
  )
  check(
    'node main 用异步调用链里的动作名',
    operationLabelFor(null, '测试全部远端', '后台任务', 'node') === '测试全部远端'
  )
  check(
    'restricted 仍用共享字段兜底',
    operationLabelFor(null, null, '测试全部远端', 'restricted') === '测试全部远端'
  )
  check(
    '宿主兜底给的显式标签优先',
    operationLabelFor('表格', '别的动作', '后台任务', 'node') === '表格'
  )
  check('什么都不知道时记成后台任务', operationLabelFor(null, null, null, null) === '后台任务')

  // 让仓库与全局都查不到 user.name/user.email —— 逼插件走 `-c user.name=…` 那条兜底。
  // 真实用户里"换台机器、还没配过 git"就是这个状态,而它和凭据参数是同一类带 -c 的调用。
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = join(process.cwd(), '.verify-ud', 'gitconfig-不存在')

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
  await writeFile(join(vault, '笔记.md'), '# 第一篇\n\n同步我。\n', 'utf8')

  // 两个远端:一个本地裸仓库(负责"真推上去"),一个要求认证的 http 端点(负责"真去要凭据")
  const localTarget: PluginTarget = {
    id: 't1',
    url: remote,
    localBranch: 'main',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  const authTarget: PluginTarget = {
    id: 't2',
    url: '', // 端口要等服务器起来才知道,下面回填
    localBranch: 'main',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  const TOKEN_LOCAL = 'tok-local'
  const TOKEN_HTTP = 'tok-http'

  // 凭据:插件的密钥 key 是 `<插件id>:<字段key>:<槽位>`,槽位算错就读不到 —— 用宿主那对函数拼
  await setSecret(secretKey('git-sync', 'targets', targetSecretSlot(localTarget)), TOKEN_LOCAL)
  await setSecret(secretKey('git-sync', 'targets', targetSecretSlot(authTarget)), TOKEN_HTTP)

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
              // 第一轮只配本地那个:此时还没有任何提交,没法 update-server-info
              targets: [localTarget],
              intervalMinutes: 0,
              syncOnStart: false,
              commitMessage: 'sync: {time}',
              authorName: 'iMark',
              authorEmail: 'imark@local',
              autoInitRepo: true,
              initBranch: 'main',
              writeGitignore: false,
              writeReadme: false
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
  await new Promise(r => setTimeout(r, 1200))

  const host = getPluginHost()!
  const view = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  console.log('\n[依赖] 插件与密钥')
  check('git-sync 从内置包加载成功', view !== undefined && view.loadError === undefined,
    String(view?.loadError))
  check('git-sync 是启用状态', view?.state.enabled === true)
  check(
    '远端密钥已写入(令牌认证没有密钥时会先被插件自己拦下)',
    (view?.secrets?.[secretKey('git-sync', 'targets', 't1')] ?? '') !== '',
    JSON.stringify(view?.secrets)
  )

  // ---------- 一、带令牌的目标真跑一次「立即上传」 ----------
  console.log('\n[一] 令牌认证 + 立即上传')
  const result = await host.runAction('git-sync', 'sync-now')
  console.log(`      插件自己说:${result.message}${result.detail ? ` / ${result.detail}` : ''}`)
  check('动作返回成功', result.ok === true, `${result.message} / ${result.detail ?? ''}`)
  if (!result.ok) {
    // 这一步失败就是这次改造最典型的症状:闸门把宿主自己给的凭据参数当成危险参数拒了。
    // 把最可能的原因直接摆出来,省得下次再顺藤摸瓜。
    console.log(`      ↑ 详情里若是 E_BAD_ARGS / 沙箱,就是 git.run 的参数闸门把 trusted 插件也管了`)
  }

  const branches = await gitSoft(remote, ['branch', '--list', '--format=%(refname:short)'])
  check('远端有了 main 分支', branches.trim() === 'main', branches.trim())
  const files = await gitSoft(remote, ['ls-tree', '-r', '--name-only', 'main'])
  check('笔记被推上去了', files.includes('笔记.md'), files.trim())
  const author = (await gitSoft(remote, ['log', '-1', '--format=%an <%ae>', 'main'])).trim()
  check('提交作者用的是插件的兜底身份(-c user.name/-c user.email)', author === 'iMark <imark@local>',
    author)

  // ---------- 二、「测试连接」打到要求认证的 http 端点 ----------
  // 先让远端有 refs,ls-remote 才有的可读(dumb http 读的是 update-server-info 写的 info/refs)
  await gitSoft(remote, ['update-server-info'])
  const http = await startAuthServer(remote)
  authTarget.url = http.url
  // 第二个远端只在这一步用:换成它会让「立即上传」也去推那个推不动的 http 端点
  await host.save('git-sync', { config: { targets: [localTarget, authTarget] } })
  await new Promise(r => setTimeout(r, 300))

  console.log('\n[二] 令牌认证 + 测试连接(远端要求 Basic 认证)')
  const probe = await host.runAction('git-sync', 'test-connection', 't2')
  console.log(`      插件自己说:${probe.message}${probe.detail ? ` / ${probe.detail}` : ''}`)
  const expected = `Basic ${Buffer.from('oauth2:' + TOKEN_HTTP).toString('base64')}`
  check(
    '服务端收到的是配置里那对用户名/口令(credential helper 真的被调用,且环境变量到了子进程)',
    http.seen.length > 0 && http.seen.every(h => h === expected),
    http.seen.length === 0 ? '一次认证请求都没收到' : http.seen.join(' | ')
  )
  check('动作返回成功', probe.ok === true, `${probe.message} / ${probe.detail ?? ''}`)
  // 单远端且没有额外信息(缺分支/失败原因)时,状态行已经说清楚了,
  // 详情不该再重复一条「第 2 个远端：连接成功」
  check('单远端成功时不再重复写详情', !probe.detail, probe.detail ?? '')
  // 状态行按界面上的行序称呼远端,而不是拿地址末段(仓库名)当标签
  const afterProbe = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  check(
    '状态行用「第 2 个远端」定位目标(不用 url 末段)',
    (afterProbe?.state.lastMessage ?? '').startsWith('第 2 个远端：'),
    afterProbe?.state.lastMessage ?? ''
  )
  check(
    '状态里不再保留单独的明细(只有 lastMessage 一段文本)',
    afterProbe?.state.lastDetail === undefined,
    afterProbe?.state.lastDetail ?? ''
  )
  const lastOp = afterProbe?.recentOps?.[0]
  check(
    '最近操作记录了这次测试连接',
    lastOp?.action === '测试连接' && lastOp.status === 'ok' && lastOp.message.includes('第 2 个远端'),
    JSON.stringify(lastOp)
  )
  const pluginLog = await readFile(join(ud, 'logs', 'plugins', 'git-sync.log'), 'utf8').catch(() => '')
  check(
    '完整日志文件里有这次操作',
    pluginLog.includes('[操作] 测试连接') && pluginLog.includes('第 2 个远端：连接测试通过'),
    pluginLog.slice(-400)
  )
  // 设置页的「插件日志」读的是内存里的日志尾巴,不是那个文件 —— 两边必须一致
  check(
    '设置页的插件日志里也能看到这次操作',
    afterProbe?.logs?.some(
      l => l.level === 'operation' && l.message.includes('测试连接') && l.message.includes('第 2 个远端：连接测试通过')
    ) === true,
    JSON.stringify(afterProbe?.logs?.slice(-3))
  )
  check(
    '设置页「打开日志文件」能找到同一个文件',
    host.ensureLogFile('git-sync') === join(ud, 'logs', 'plugins', 'git-sync.log'),
    host.ensureLogFile('git-sync')
  )

  // 多远端:整体状态在徽标里,正文逐行罗列,而不是摘要、明细各写一份
  const allProbe = await host.runAction('git-sync', 'test-all')
  const allView = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  check('多远端测试成功', allProbe.ok === true, allProbe.message)
  check(
    '多远端状态正文只逐行罗列(整体状态交给徽标)',
    allView?.state.lastMessage === '第 1 个远端：连接测试通过\n第 2 个远端：连接测试通过',
    allView?.state.lastMessage ?? ''
  )
  check(
    '多远端操作也进了最近操作(按钮名与状态可读)',
    allView?.recentOps?.[0]?.action === '测试全部远端' && allView.recentOps[0].status === 'ok',
    JSON.stringify(allView?.recentOps?.[0])
  )
  const persisted = JSON.parse(
    await readFile(join(ud, 'logs', 'plugins', 'git-sync.recent.json'), 'utf8').catch(() => '[]')
  ) as { action?: string }[]
  check(
    '最近操作已持久化(重启后还能看到)',
    Array.isArray(persisted) && persisted[0]?.action === '测试全部远端',
    JSON.stringify(persisted[0])
  )

  // 多远端同步:一个远端成功、一个失败时,状态正文也该逐行罗列。
  // 配置变更会在 3 秒后触发一次后台同步,先等此前的后台同步跑完,避免撞上 running 保护。
  console.log('\n[三] 多远端同步:逐行列出每个远端的推送结果')
  await new Promise(r => setTimeout(r, 4000))
  for (let i = 0; i < 50; i++) {
    const v = (await host.list()).find(x => x.descriptor.id === 'git-sync')
    if (v?.state.status !== 'running') break
    await new Promise(r => setTimeout(r, 200))
  }
  // 把第二个远端换成一个不存在的路径,让同步必然「一半成功一半失败」
  await host.save('git-sync', {
    config: {
      targets: [localTarget, { ...authTarget, url: join(ud, 'missing-remote.git') }]
    }
  })
  await new Promise(r => setTimeout(r, 300))
  const syncProbe = await host.runAction('git-sync', 'sync-now')
  const syncView = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  check('动作返回失败(部分远端失败)', syncProbe.ok === false, syncProbe.message)
  check(
    '状态正文逐行列出每个远端的推送结果',
    syncView?.state.lastMessage === '第 1 个远端：推送成功\n第 2 个远端：推送失败',
    syncView?.state.lastMessage ?? ''
  )
  check('整体状态是「部分失败」', syncView?.state.status === 'partial', syncView?.state.status)
  check(
    '最近操作记录了这次同步',
    syncView?.recentOps?.[0]?.action === '立即上传' &&
      syncView.recentOps[0].status === 'partial',
    JSON.stringify(syncView?.recentOps?.[0])
  )

  // 正在同步时再点一次:这是「已排队」,不是成功完成
  console.log('\n[四] 正在同步时再点一次:排队消息不能写成成功')
  const first = host.runAction('git-sync', 'sync-now')
  const second = await host.runAction('git-sync', 'sync-now')
  check(
    '排队动作被接受,但显式标记为 running',
    second.ok === true && second.status === 'running',
    JSON.stringify(second)
  )
  const queuedView = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  check(
    '排队消息没有被写成成功',
    queuedView?.state.status !== 'ok',
    queuedView?.state.status ?? ''
  )
  await first
  // 等排队的第二轮跑完,别在退出时关掉它还在用的 http 服务
  await new Promise(r => setTimeout(r, 1500))

  http.close()
  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
