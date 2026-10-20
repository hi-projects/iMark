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
  const afterSync = (await host.list()).find(v => v.descriptor.id === 'git-sync')
  check(
    '推送结果按目标记下(设置页据此给卡片上色)',
    afterSync?.state.targetResults?.t1 === 'ok',
    JSON.stringify(afterSync?.state.targetResults)
  )

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
  check(
    '单目标测试只更新自己那一行,不抹掉其他远端已有的结果',
    afterProbe?.state.targetResults?.t2 === 'ok' && afterProbe.state.targetResults?.t1 === 'ok',
    JSON.stringify(afterProbe?.state.targetResults)
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
    '每个远端的成败分别记在自己的目标 id 下',
    syncView?.state.targetResults?.t1 === 'ok' && syncView.state.targetResults?.t2 === 'error',
    JSON.stringify(syncView?.state.targetResults)
  )
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

  // ---------- 五、设置页:边框颜色只表达「操作结果」 ----------
  console.log('\n[五] 设置页:远端卡片边框=上次操作结果,输入校验集中列出')
  // 等这一轮真的结束再停用:onDisable 会 abort 正在跑的同步,那会把某个远端的
  // 最后一次结果改写成「失败」,后面的断言就不是我们要看的东西了
  for (let i = 0; i < 50; i++) {
    const v = (await host.list()).find(x => x.descriptor.id === 'git-sync')
    if (v?.state.status !== 'running') break
    await new Promise(r => setTimeout(r, 100))
  }
  // 第三个远端只填了地址:它从没被操作过,应该保持灰框,并出现在统一的校验列表里。
  // 顺带停用插件,免得 3 秒后的配置同步把界面检查期间的颜色改掉。
  const incompleteTarget: PluginTarget = {
    id: 't3',
    url: 'https://example.invalid/repo.git',
    localBranch: '',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  await host.save('git-sync', {
    enabled: false,
    config: {
      targets: [
        localTarget,
        { ...authTarget, url: join(ud, 'missing-remote.git') },
        incompleteTarget
      ]
    }
  })
  await new Promise(r => setTimeout(r, 300))

  const wc = win.webContents
  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  for (let i = 0; i < 50; i++) {
    if (await evalJs<boolean>(`!!document.querySelector('.settings-nav')`)) break
    await sleep(100)
  }
  await evalJs(
    `[...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.includes('定时上传'))?.click()`
  )
  for (let i = 0; i < 50; i++) {
    if (await evalJs<boolean>(`document.querySelectorAll('.plugin-target').length >= 3`)) break
    await sleep(100)
  }
  const ui = await evalJs<{
    count: number
    borders: string[]
    problems: string
    success: string
    danger: string
    border: string
  }>(`
    (() => {
      const cssColor = name => {
        const probe = document.createElement('div')
        probe.style.color = 'var(' + name + ')'
        document.body.appendChild(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }
      const cards = [...document.querySelectorAll('.plugin-target')]
      const problems = document.querySelector('.plugin-target-problems')
      return {
        count: cards.length,
        borders: cards.map(c => getComputedStyle(c).borderTopColor),
        problems: problems ? problems.innerText.replace(/\\s+/g, ' ') : '',
        success: cssColor('--success'),
        danger: cssColor('--danger'),
        border: cssColor('--border')
      }
    })()
  `)
  console.log(`      边框:${ui.borders.join(' / ')}`)
  console.log(`      校验:${ui.problems || '(空)'}`)
  check('三个远端都渲染出来', ui.count === 3, `实际 ${ui.count} 张卡片`)
  check('推送成功的远端是绿框', ui.borders[0] === ui.success, `${ui.borders[0]} vs ${ui.success}`)
  check('推送失败的远端是红框', ui.borders[1] === ui.danger, `${ui.borders[1]} vs ${ui.danger}`)
  check(
    '没操作过的远端保持默认灰框',
    ui.borders[2] === ui.border,
    `${ui.borders[2]} vs ${ui.border}`
  )
  check(
    '输入不满足不再染红卡片边框',
    ui.borders[2] !== ui.danger,
    ui.borders[2]
  )
  check(
    '缺什么集中列在一处(第 3 个远端：本地分支、访问令牌)',
    ui.problems.includes('存在 1 个远端配置未完成/错误') &&
      ui.problems.includes('第 3 个远端：未填本地分支、访问令牌'),
    ui.problems
  )
  // 刚点「添加远端」得到的全空行也要列出来:这正是用户需要知道必填项的时候。
  const blankTarget: PluginTarget = {
    id: 't4',
    url: '',
    localBranch: '',
    remoteBranch: '',
    auth: 'token',
    username: ''
  }
  await host.save('git-sync', {
    enabled: false,
    config: { targets: [localTarget, { ...authTarget, url: join(ud, 'missing-remote.git') }, incompleteTarget, blankTarget] }
  })
  await sleep(300)
  const blankProblems = await evalJs<string>(
    `document.querySelector('.plugin-target-problems')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  )
  check(
    '全空的远端行也列出缺少的必填项',
    blankProblems.includes('存在 2 个远端配置未完成/错误') &&
      blankProblems.includes('第 4 个远端：未填远程仓库、本地分支、访问令牌'),
    blankProblems
  )

  // 账号密码认证下,地址还没填时账号、密码也要列出来:界面上这两格同样标着「必填」。
  await host.save('git-sync', {
    enabled: false,
    config: {
      targets: [
        localTarget,
        { ...authTarget, url: join(ud, 'missing-remote.git') },
        incompleteTarget,
        { ...blankTarget, auth: 'password' }
      ]
    }
  })
  await sleep(300)
  const blankPasswordProblems = await evalJs<string>(
    `document.querySelector('.plugin-target-problems')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  )
  check(
    '空地址 + 账号密码认证时也列出账号、密码',
    blankPasswordProblems.includes('存在 2 个远端配置未完成/错误') &&
      blankPasswordProblems.includes('第 4 个远端：未填远程仓库、本地分支、账号、密码'),
    blankPasswordProblems
  )

  // 地址格式不做校验:像 `111` 这种认不出的写法,只要地址和分支填了就不该报错 ——
  // 能不能用交给 git 回答。用账号密码认证:顺便把两字标签(账号/密码)的输入框
  // 也渲染出来,才能验左对齐。
  const badUrlTarget: PluginTarget = {
    id: 't5',
    url: '111',
    localBranch: '11',
    remoteBranch: '',
    auth: 'password',
    username: ''
  }
  await host.save('git-sync', {
    enabled: false,
    config: {
      targets: [
        localTarget,
        { ...authTarget, url: join(ud, 'missing-remote.git') },
        incompleteTarget,
        blankTarget,
        badUrlTarget
      ]
    }
  })
  await sleep(300)
  const badUrlProblems = await evalJs<string>(
    `document.querySelector('.plugin-target-problems')?.innerText.replace(/\\s+/g, ' ') ?? ''`
  )
  check(
    '认不出的地址不再报格式错误(只校验必填项)',
    badUrlProblems.includes('存在 2 个远端配置未完成/错误') &&
      !badUrlProblems.includes('第 5 个远端') &&
      !badUrlProblems.includes('格式不正确'),
    badUrlProblems
  )

  // 标签定宽:地址/分支/认证方式/账号/密码各行的输入框左边缘必须落在同一条线上。
  const alignedLefts = await evalJs<number[]>(`
    (() => {
      const card = [...document.querySelectorAll('.plugin-target')]
        .find(c => c.querySelector('.plugin-target-auth')?.value === 'password')
      if (!card) return []
      const fields = [
        ...card.querySelectorAll('.plugin-target-cell-wide > .plugin-input'),
        card.querySelector('.plugin-target-row .plugin-target-cell:first-child > .plugin-input'),
        card.querySelector('.plugin-target-auth')
      ].filter(Boolean)
      return [...new Set(fields.map(el => Math.round(el.getBoundingClientRect().left)))]
    })()
  `)
  check('各行输入框左对齐', alignedLefts.length === 1, `左边缘:${alignedLefts.join(' / ')}`)

  // 两字标签(账号/密码)在 4em 的标签列里居中,左右留白相等。
  const labelGaps = await evalJs<{ label: string; left: number; right: number }[]>(`
    (() => {
      const card = [...document.querySelectorAll('.plugin-target')]
        .find(c => c.querySelector('.plugin-target-auth')?.value === 'password')
      if (!card) return []
      return [...card.querySelectorAll('.plugin-target-cell > span')]
        .filter(s => [...s.textContent.trim()].length === 2)
        .map(span => {
          const range = document.createRange()
          range.selectNodeContents(span)
          const text = range.getBoundingClientRect()
          const box = span.getBoundingClientRect()
          return {
            label: span.textContent.trim(),
            left: Math.round(text.left - box.left),
            right: Math.round(box.right - text.right)
          }
        })
    })()
  `)
  check(
    '两字标签(账号/密码)在标签列内居中',
    labelGaps.length === 2 && labelGaps.every(g => Math.abs(g.left - g.right) <= 1),
    labelGaps.map(g => `${g.label} ${g.left}/${g.right}`).join(' , ')
  )

  // 已保存密钥那一行的掩码占满中间空白:点它(或掩码旁边的空白)不该展开「更换」。
  // 这一行曾用 <label> 包住掩码与两个按钮,label 的默认激活行为会把非交互区域的
  // 点击转给第一个 labelable 控件 —— 也就是「更换」按钮。
  await evalJs(`
    (() => {
      const mask = document.querySelector('.plugin-target .plugin-secret-mask')
      if (mask) mask.scrollIntoView({ block: 'center' })
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    })()`)
  await sleep(150)
  const maskPoint = await evalJs<{ x: number; y: number; hit: string; index: number; before: boolean } | null>(`
    (() => {
      const cards = [...document.querySelectorAll('.plugin-target')]
      const index = cards.findIndex(c => c.querySelector('.plugin-secret-mask'))
      if (index < 0) return null
      const card = cards[index]
      const r = card.querySelector('.plugin-secret-mask').getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const el = document.elementFromPoint(x, y)
      return {
        x,
        y,
        index,
        hit: el ? el.tagName + '.' + el.className : '(none)',
        before: Boolean(card.querySelector('.plugin-target-secret'))
      }
    })()`)
  if (maskPoint) {
    wc.sendInputEvent({ type: 'mouseDown', x: maskPoint.x, y: maskPoint.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: maskPoint.x, y: maskPoint.y, button: 'left', clickCount: 1 })
    await sleep(200)
  }
  // 必须按**点击前记下的卡片下标**复查:误触后掩码会消失,再按掩码找会落到下一张卡上。
  // 别的卡本来就可能因为「还没存密钥」而渲染着输入框,所以只看这一张。
  const strayOpened = maskPoint
    ? await evalJs<boolean>(`
        Boolean(document.querySelectorAll('.plugin-target')[${maskPoint.index}]?.querySelector('.plugin-target-secret'))`)
    : false
  if (maskPoint) console.log(`      点击: (${maskPoint.x},${maskPoint.y}) 命中 ${maskPoint.hit},点前该卡是替换态 ${maskPoint.before}`)
  check(
    '点密钥掩码/空白处不会误触「更换」',
    maskPoint !== null && !maskPoint.before && !strayOpened,
    maskPoint === null ? '找不到密钥掩码' : strayOpened ? '点空白处后进入了替换态' : ''
  )

  // 「更换」已保存的密钥时,输入框只是替换草稿:留空不会清掉原值,
  // 提示语不能继续写「必填」,否则用户会以为没填却没报错。
  const replaceHint = await evalJs<string>(`
    (async () => {
      const card = document.querySelector('.plugin-target')
      const change = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '更换')
      if (!change) return '(找不到更换按钮)'
      change.click()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const input = card.querySelector('.plugin-target-secret')
      const placeholder = input?.getAttribute('placeholder') ?? ''
      const cancel = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '取消')
      cancel?.click()
      return placeholder
    })()
  `)
  check(
    '更换已保存的令牌时提示留空会保留原值',
    replaceHint.includes('留空则保留已保存的') && !replaceHint.includes('必填'),
    replaceHint
  )

  // 密钥行在「输入框」与「遮罩 + 更换/清除」两种状态下必须等高,
  // 否则保存令牌后,下面的测试/删除按钮会上下跳一下。
  const secretRowShift = await evalJs<number>(`
    (async () => {
      const card = document.querySelector('.plugin-target')
      const actions = card.querySelector('.plugin-target-actions')
      const change = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '更换')
      if (!change) return 999
      const topMask = actions.getBoundingClientRect().top
      change.click()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      const topInput = actions.getBoundingClientRect().top
      const cancel = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '取消')
      cancel?.click()
      return Math.round((topInput - topMask) * 10) / 10
    })()
  `)
  check('密钥行切换「遮罩/输入框」时动作按钮不跳动', Math.abs(secretRowShift) <= 1, `${secretRowShift}px`)

  // 用户真正会看到的变化是「还没存密钥(只有输入框)→ 保存后(遮罩 + 两个按钮)」:
  // 这两种状态的密钥行也必须等高,不能只验「更换/取消」内部切换。
  const secretRowHeights = await evalJs<number[]>(`
    (() => [...document.querySelectorAll('.plugin-target')]
      .map(card => {
        const row = [...card.querySelectorAll('.plugin-target-row')]
          .find(r => r.querySelector('.plugin-target-secret, .plugin-secret-mask'))
        return row ? Math.round(row.getBoundingClientRect().height * 10) / 10 : -1
      })
      .filter(h => h > 0))()`)
  check(
    '有密钥/没密钥时密钥行等高(保存令牌不推动下方内容)',
    secretRowHeights.length > 1 && new Set(secretRowHeights).size === 1,
    secretRowHeights.join(' / ')
  )

  // 认证方式下拉框显示的是「已选项」,不是待输入的文本:值文本居中。
  const authAlign = await evalJs<string>(`
    (() => {
      const select = document.querySelector('.plugin-target-auth')
      return select ? getComputedStyle(select).textAlign : '<missing>'
    })()`)
  check('认证方式下拉框的值文本居中', authAlign === 'center', authAlign)

  // 留一张下拉框特写:原生 select 的文本对齐在 computed style 里能读到,
  // 但「看上去是不是居中」还得看图(箭头在右端,居中的基准可能不是框的正中)。
  await evalJs(`
    (() => {
      const select = document.querySelector('.plugin-target-auth')
      if (select) select.scrollIntoView({ block: 'center' })
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    })()`)
  await new Promise(r => setTimeout(r, 150))
  const authRect = await evalJs<{ x: number; y: number; width: number; height: number }>(`
    (() => {
      const r = document.querySelector('.plugin-target-auth').getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)
  const inset = 10
  const authShot = await wc.capturePage({
    x: Math.round(authRect.x - inset),
    y: Math.round(authRect.y - inset),
    width: Math.round(authRect.width + inset * 2),
    height: Math.round(authRect.height + inset * 2)
  })
  await writeFile(join(ud, 'auth-select.png'), authShot.toPNG())

  // 「调试」里的两类横线要能看出层次:模块标题下的是全强度边框,
  // 操作条目之间的是浅一档的分隔线。颜色一样时整块会像一堆并列的卡片。
  const dividers = await evalJs<{ count: number; entry: string; module: string }>(`
    (() => {
      const ops = [...document.querySelectorAll('.plugin-op')]
      const op = ops[ops.length - 1]
      const head = document.querySelector('.plugin-ops-head')
      return {
        count: ops.length,
        entry: op ? getComputedStyle(op).borderTopColor : '',
        module: head ? getComputedStyle(head).borderBottomColor : ''
      }
    })()
  `)
  console.log(`      分隔线:条目 ${dividers.entry} / 模块 ${dividers.module}`)
  check('调试里有操作记录,才能比较两类分隔线', dividers.count > 0, String(dividers.count))
  check(
    '操作条目之间的分隔线比模块标题下的浅一档',
    dividers.entry !== '' && dividers.module !== '' && dividers.entry !== dividers.module,
    `${dividers.entry} vs ${dividers.module}`
  )
  // 留一张图:颜色断言看不出「三个状态 + 校验框」挤在一起是否还读得顺
  await evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  await new Promise(r => setTimeout(r, 120))
  await writeFile(join(ud, 'git-sync-targets.png'), (await wc.capturePage()).toPNG())

  http.close()
  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
