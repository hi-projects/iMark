/**
 * git-sync 扩展端到端验收。
 *
 * 真开一个裸仓库当远端，真让扩展在自己的宿主进程里 `git add / commit / push`，
 * 最后用 git 自己读回远端分支 —— 不看扩展怎么说，只看远端有什么。
 *
 * 覆盖：
 *   1 内置包安装、清单贡献点（命令/快捷键/配置/动作/状态栏）
 *   2 `onStartupFinished` 激活、状态栏条目与初始文案
 *   3 首次同步：远端建分支、文件与忽略项写入、提交信息模板生效
 *   4 无改动不造空提交；有改动 +1 提交
 *   5 `testAll` / `testTarget`（逐远端）与状态卡结果
 *   6 密钥缺失时在动 git 之前失败，并说清是哪一行
 *   7 多远端：一个成功一个失败 → partial，逐个远端结果可见
 *   8 配置变更 → 防抖后自动补跑一轮（onDidChangeConfiguration）
 *   9 停用释放宿主；重新启用后命令再激活；卸载清目录与贡献点
 *
 * 跑法（在仓库根目录）：
 *   node verify/run.mjs git-sync
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { ExtensionView } from '../src/shared/extensions'
import type { PluginStatus } from '../src/shared/plugins'

const run = promisify(execFile)
const REPO = join(__dirname, '..', '..')
const EXT_ID = 'imark.git-sync'
import { APP_VERSION } from './appVersion'

// 必须在 app ready 之前注册；主窗口加载 markdown 时用得到
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

/**
 * 在指定目录跑 git，返回 stdout。
 *
 * `-c core.quotePath=false`：git 默认把非 ASCII 路径转义成八进制，中文文件名
 * 在输出里就变成一串 `\347\254\224`，拿它做 includes 永远匹配不上。
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'harness',
      GIT_AUTHOR_EMAIL: 'harness@local',
      GIT_COMMITTER_NAME: 'harness',
      GIT_COMMITTER_EMAIL: 'harness@local'
    }
  })
  return stdout
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

const baseConfig = (targets: TargetConfig[]): Record<string, unknown> => ({
  [configKey('targets')]: targets,
  [configKey('intervalMinutes')]: 0,
  [configKey('syncOnStart')]: false,
  [configKey('commitMessage')]: 'sync: {time}',
  [configKey('authorName')]: 'iMark',
  [configKey('authorEmail')]: 'imark@local',
  [configKey('autoInitRepo')]: true,
  [configKey('initBranch')]: 'main',
  [configKey('writeGitignore')]: true,
  [configKey('writeReadme')]: false,
  // 本地路径远端不需要代理；空的手动地址会直接连接，避免宿主机环境变量里的代理影响结果
  [configKey('proxyMode')]: 'manual',
  [configKey('proxyUrl')]: ''
})

const target1 = (remote: string): TargetConfig => ({
  id: 't1',
  url: remote,
  auth: 'ssh',
  username: '',
  localBranch: 'main',
  remoteBranch: 'main'
})

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs git-sync` 跑会自动带上）')
    app.exit(2)
    return
  }

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
  const badRemote = join(ud, 'no-such-remote.git')
  const note = join(vault, '笔记.md')

  for (const dir of [vault, remote, badRemote, join(ud, 'plugins'), join(ud, 'extensions-data')]) {
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(vault, { recursive: true })
  await mkdir(remote, { recursive: true })
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await writeFile(note, '# 第一篇\n\n同步我。\n', 'utf8')

  const config = baseConfig([target1(remote)])
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
          [EXT_ID]: { enabled: true, config }
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
  const installed = await installExtensionPackage(envelope, {
    source: 'bundled',
    appVersion: APP_VERSION
  })
  check('内置包通过校验并安装', installed.manifest.version === '1.0.0')

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)
  await service.startup()
  await sleep(600)

  const view = async (): Promise<ExtensionView | undefined> =>
    (await service.getExtensionViews()).find(v => v.descriptor.id === EXT_ID)

  async function waitStatus(status: PluginStatus, ms = 20_000): Promise<ExtensionView | undefined> {
    const until = Date.now() + ms
    let current = await view()
    while (Date.now() < until) {
      if (current?.status.status === status && !service.isActivated(EXT_ID)) return current
      if (current?.status.status === status) return current
      await sleep(150)
      current = await view()
    }
    return current
  }

  const statusItem = () => service.getContributions().statusItems.find(i => i.extensionId === EXT_ID)

  async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
    const until = Date.now() + ms
    let value = await fn()
    while (Date.now() < until) {
      if (ok(value)) return value
      await sleep(120)
      value = await fn()
    }
    return value
  }

  // ---------- 1. 安装与贡献点 ----------

  console.log('\n【1】内置包：清单贡献点来自 package.json')
  const v = await view()
  check('扩展列表里有 imark.git-sync', !!v, JSON.stringify(service.listExtensions().map(x => x.descriptor.id)))
  check('默认启用', v?.enabled === true)
  check('来源标成内置（bundled）', v?.source === 'bundled', String(v?.source))
  const commands = v?.descriptor.contributes.commands ?? []
  for (const id of [
    'imark.git-sync.syncNow',
    'imark.git-sync.testAll',
    'imark.git-sync.detectProxy',
    'imark.git-sync.testTarget'
  ]) {
    check(`声明了命令 ${id}`, commands.some(c => c.command === id))
  }
  const keybindings = service.getContributions().keybindings.filter(k => k.extensionId === EXT_ID)
  const syncKey = keybindings.find(k => k.command === 'imark.git-sync.syncNow')
  check('声明了 ctrl+alt+s 快捷键且未被摘掉', syncKey?.key === 'ctrl+alt+s' && !syncKey.dropped, JSON.stringify(syncKey))
  const actions = service.getContributions().actions.filter(a => a.extensionId === EXT_ID)
  check('声明了 4 个设置页动作', actions.length === 4, JSON.stringify(actions.map(a => a.command)))
  check(
    '「测试连接」是每远端动作',
    actions.some(a => a.command === 'imark.git-sync.testTarget' && a.scope === 'target')
  )
  const fields = v?.descriptor.settingsFields ?? []
  check('配置翻译成 targets 字段', fields.some(f => f.key === 'targets' && f.kind === 'targets'))
  check('代理模式是下拉选择', fields.some(f => f.key === 'proxyMode' && f.kind === 'select'))
  const proxyField = fields.find(f => f.key === 'proxyMode')
  check(
    '连接方式只保留自动/手动（直连是兜底，不单独列选项）',
    proxyField?.options?.map(option => option.value).join(',') === 'auto,manual',
    JSON.stringify(proxyField?.options)
  )
  check(
    '同步间隔是数字且有 0–1440 限制',
    fields.some(f => f.key === 'intervalMinutes' && f.kind === 'number' && f.min === 0 && f.max === 1440)
  )

  // ---------- 2. 启动激活与状态栏 ----------

  console.log('\n【2】onStartupFinished 激活、状态栏条目')
  check('启动后扩展已激活', service.isActivated(EXT_ID))
  const groups = service.hostGroupsView().filter(g => g.extensionIds.includes(EXT_ID))
  check('扩展有独立宿主进程（默认 isolated）', groups.length === 1 && groups[0]!.pid !== null, JSON.stringify(groups))
  const item = await waitFor(statusItem, x => !!x)
  check('状态栏出现 Git 同步条目', item?.text === '$(git) Git 同步', JSON.stringify(item))
  check('点击执行立即同步', item?.command === 'imark.git-sync.syncNow')
  check('悬停说明指向同步动作', (item?.tooltip ?? '').includes('立即上传'), String(item?.tooltip))
  check('初始状态是 idle', (await view())?.status.status === 'idle', String((await view())?.status.status))

  // ---------- 3. 首次同步 ----------

  console.log('\n【3】首次同步：远端真的收到提交')
  check(
    '远端此刻还没有 main 分支',
    (await git(remote, ['branch', '--list'])).trim() === ''
  )
  const first = (await service.executeCommand('imark.git-sync.syncNow')) as {
    ok: boolean
    message: string
  }
  check('命令返回 ok', first?.ok === true, JSON.stringify(first))
  console.log(`      扩展自己说：${first?.message}`)

  const branches = await git(remote, ['branch', '--list', '--format=%(refname:short)'])
  check('远端有了 main 分支', branches.trim() === 'main', branches.trim())
  const files = await git(remote, ['ls-tree', '-r', '--name-only', 'main'])
  check('笔记被推上去了', files.includes('笔记.md'), files.trim())
  check('.gitignore 按配置写入', files.includes('.gitignore'), files.trim())
  const blob = await git(remote, ['show', 'main:笔记.md'])
  check('远端内容与本地一致', blob === '# 第一篇\n\n同步我。\n', JSON.stringify(blob))
  const subject = (await git(remote, ['log', '-1', '--format=%s', 'main'])).trim()
  check('提交信息用了模板（sync: 时间）', /^sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(subject), subject)

  const afterFirst = await waitStatus('ok')
  console.log(`      status = ${JSON.stringify(afterFirst?.status)}`)
  check('运行状态上报为 ok', afterFirst?.status.status === 'ok', JSON.stringify(afterFirst?.status))
  check('状态文本说明已推送', (afterFirst?.status.lastMessage ?? '').includes('推送'), afterFirst?.status.lastMessage)
  check('lastRunAt 有值', typeof afterFirst?.status.lastRunAt === 'number')
  const okItem = await waitFor(statusItem, x => x?.text === '$(check) Git 同步')
  check('状态栏切成成功图标', okItem?.text === '$(check) Git 同步', JSON.stringify(okItem?.text))
  check('远端结果上报为 ok', afterFirst?.status.targetResults?.t1 === 'ok')

  // ---------- 4. 空同步与有改动 ----------

  console.log('\n【4】没有改动不造空提交；有改动 +1 提交')
  const count = async (): Promise<number> =>
    Number((await git(remote, ['rev-list', '--count', 'main'])).trim())
  const before = await count()
  const second = (await service.executeCommand('imark.git-sync.syncNow')) as { ok: boolean; message: string }
  check('第二次仍成功', second?.ok === true, JSON.stringify(second))
  check(`提交数没变（${before} → ${await count()}）`, (await count()) === before)
  check('状态说明无改动', ((await waitStatus('ok'))?.status.lastMessage ?? '').includes('无改动'), (await view())?.status.lastMessage)

  await writeFile(join(vault, '第二篇.md'), '# 第二篇\n', 'utf8')
  const third = (await service.executeCommand('imark.git-sync.syncNow')) as { ok: boolean }
  check('第三次成功', third?.ok === true)
  check(`提交数 +1（${before} → ${await count()}）`, (await count()) === before + 1)
  check(
    '新文件也推上去了',
    (await git(remote, ['ls-tree', '-r', '--name-only', 'main'])).includes('第二篇.md')
  )

  // ---------- 5. 测试连接 ----------

  console.log('\n【5】测试全部远端 / 单远端')
  const testAll = (await service.executeCommand('imark.git-sync.testAll')) as {
    ok: boolean
    message: string
  }
  check('testAll 成功', testAll?.ok === true, JSON.stringify(testAll))
  check('提示里说明远端已有分支', (testAll?.message ?? '').includes('连接测试通过'), testAll?.message)
  check('状态卡记录 t1 连接成功', (await waitStatus('ok'))?.status.targetResults?.t1 === 'ok', JSON.stringify((await view())?.status.targetResults))

  await sleep(400)
  const testToasts = (await wc.executeJavaScript(
    `[...document.querySelectorAll('.toast')].map(el => el.textContent || '')`,
    true
  )) as string[]
  check(
    '测试结果只在设置页状态卡显示，不弹右下角通知',
    !testToasts.some(text => text.includes('连接测试通过') || text.includes('连接失败')),
    JSON.stringify(testToasts)
  )

  const testOne = (await service.executeCommand('imark.git-sync.testTarget', [{ targetId: 't1' }])) as {
    ok: boolean
    message: string
  }
  check('testTarget 只测指定远端', testOne?.ok === true && (testOne.message ?? '').includes('第 1 个远端'), JSON.stringify(testOne))

  // ---------- 6. 密钥缺失 ----------

  console.log('\n【6】缺密钥：在动 git 之前失败，并指出是哪一行')
  const tokenTarget: TargetConfig = {
    id: 't2',
    url: 'https://example.invalid/notes.git',
    auth: 'token',
    username: '',
    localBranch: 'main',
    remoteBranch: 'main'
  }
  await service.setExtensionConfig(EXT_ID, baseConfig([target1(remote), tokenTarget]))
  const missing = (await service.executeCommand('imark.git-sync.syncNow')) as {
    ok: boolean
    message: string
  }
  check('命令返回失败', missing?.ok === false, JSON.stringify(missing))
  check('错误指到第 2 个远端', (missing?.message ?? '').includes('第 2 个远端'), missing?.message)
  check('错误说明缺的是访问令牌', (missing?.message ?? '').includes('访问令牌'), missing?.message)
  const failedStatus = await waitStatus('error')
  check('状态卡标记 error', failedStatus?.status.status === 'error', failedStatus?.status.status)
  const missingLogs = (await view())?.logs ?? []
  check(
    '失败原因同时写进扩展日志',
    missingLogs.some(entry => entry.level === 'error' && entry.message.includes('访问令牌')),
    JSON.stringify(missingLogs.slice(-3))
  )
  check(
    '操作日志不再把失败记成成功',
    missingLogs.some(
      entry => entry.level === 'operation' && entry.message.includes('失败')
    ),
    JSON.stringify(missingLogs.filter(entry => entry.level === 'operation').slice(-2))
  )

  // ---------- 7. 多远端部分失败 ----------

  console.log('\n【7】多远端：一个成功、一个失败 → partial')
  const broken: TargetConfig = {
    id: 'bad',
    url: badRemote,
    auth: 'ssh',
    username: '',
    localBranch: 'main',
    remoteBranch: 'main'
  }
  await writeFile(join(vault, '第三篇.md'), '# 第三篇\n', 'utf8')
  const beforePartial = await count()
  // 配置变更会触发扩展内部的防抖补跑（3s），用它验证 onDidChangeConfiguration 链路
  await service.setExtensionConfig(EXT_ID, baseConfig([target1(remote), broken]))
  const partial = await waitStatus('partial', 25_000)
  check('配置变更后自动跑了一轮并上报 partial', partial?.status.status === 'partial', JSON.stringify(partial?.status))
  check('成功的远端记为 ok', partial?.status.targetResults?.t1 === 'ok', JSON.stringify(partial?.status.targetResults))
  check('失败的远端记为 error', partial?.status.targetResults?.bad === 'error', JSON.stringify(partial?.status.targetResults))
  check('状态文本列出两个远端的成败', (partial?.status.lastMessage ?? '').includes('推送失败'), partial?.status.lastMessage)
  check(
    '失败的详情里带分类提示',
    (partial?.status.lastDetail ?? '').includes('仓库') ||
      (partial?.status.lastDetail ?? '').includes('连接') ||
      (partial?.status.lastDetail ?? '').includes('remote'),
    partial?.status.lastDetail
  )
  const partialLogs = (await view())?.logs ?? []
  check(
    '推送失败原因同时写进扩展日志',
    partialLogs.some(entry => entry.level === 'error' && entry.message.includes('推送失败')) &&
      partialLogs.some(
        entry => entry.level === 'error' && entry.message.includes('第 2 个远端')
      ),
    JSON.stringify(partialLogs.slice(-4))
  )
  check(`成功的那个远端收到了新提交（${beforePartial} → ${await count()}）`, (await count()) === beforePartial + 1)
  const partialItem = await waitFor(statusItem, x => x?.text === '$(alert) Git 同步')
  check('状态栏切成告警图标', partialItem?.text === '$(alert) Git 同步', JSON.stringify(partialItem?.text))

  const testBad = (await service.executeCommand('imark.git-sync.testTarget', [{ targetId: 'bad' }])) as {
    ok: boolean
    message: string
  }
  check('单测失败的远端返回失败', testBad?.ok === false, JSON.stringify(testBad))
  check('失败结果也写进状态卡', (await waitStatus('error'))?.status.targetResults?.bad === 'error')

  const testGoodAgain = (await service.executeCommand('imark.git-sync.testTarget', [{ targetId: 't1' }])) as {
    ok: boolean
  }
  check('单测成功的远端返回成功', testGoodAgain?.ok === true, JSON.stringify(testGoodAgain))

  // ---------- 8. 检测代理（手动地址为空） ----------

  console.log('\n【8】检测本机代理：手动地址为空时提示地址问题')
  const proxy = (await service.executeCommand('imark.git-sync.detectProxy')) as {
    ok: boolean
    message: string
  }
  check('detectProxy 返回失败', proxy?.ok === false, JSON.stringify(proxy))
  check('说明手动地址无法识别', (proxy?.message ?? '').includes('无法识别'), proxy?.message)

  // ---------- 9. 停用 / 重新启用 / 卸载 ----------

  console.log('\n【9】停用释放宿主，重新启用后可再次激活；卸载清理干净')
  // 先回到单远端配置：下一步的「重新启用后执行命令」不应再撞上故意填坏的那个远端。
  // 配置变更会触发 3 秒防抖补跑，等它跑完再停用，避免状态在断言之间跳变。
  await service.setExtensionConfig(EXT_ID, baseConfig([target1(remote)]))
  await sleep(4500)
  check('恢复单远端配置后自动补跑成功', (await view())?.status.status === 'ok', JSON.stringify((await view())?.status))
  await service.setEnabled(EXT_ID, false)
  check('扩展标为停用', (await view())?.enabled === false)
  check('宿主已释放', !service.isActivated(EXT_ID))
  check('状态栏条目消失', await (async () => {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      if (!statusItem()) return true
      await sleep(120)
    }
    return false
  })())
  check(
    '命令从命令面板消失',
    !service.getContributions().commands.some(c => c.command === 'imark.git-sync.syncNow')
  )

  await service.setEnabled(EXT_ID, true)
  check('重新启用后尚未激活（onStartupFinished 只跑一次）', !service.isActivated(EXT_ID))
  const revived = (await service.executeCommand('imark.git-sync.syncNow')) as { ok: boolean }
  check('执行命令触发重新激活并成功', revived?.ok === true, JSON.stringify(revived))
  check('状态栏条目回来了', await waitFor(statusItem, x => !!x, 8000) !== undefined)

  await service.uninstallExtension(EXT_ID)
  check('扩展列表里不再有它', !(await view()))
  check('状态栏条目彻底消失', !statusItem())
  const dirGone = await readFile(join(ud, 'plugins', EXT_ID, 'package.json'), 'utf8').then(
    () => false,
    () => true
  )
  check('安装目录被删除', dirGone)

  await shutdownExtensions()
  console.log(`\n${pass} 通过，${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
