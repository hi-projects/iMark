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
 *   5 `testTarget` 与状态卡结果
 *   6 密钥缺失时在动 git 之前失败，且不写日志/状态卡
 *     （配置问题只由设置页的黄色提示展示）
 *   7 远端不可用：同步失败、状态卡标红、日志带原因
 *   8 配置变更 → 防抖后自动补跑一轮（onDidChangeConfiguration）
 *   9 停用释放宿主；重新启用后命令再激活；卸载清目录与贡献点
 *
 * 跑法（在仓库根目录）：
 *   node verify/run.mjs git-sync
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
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
import { setProjectGitRemote } from '../src/main/projectGit'
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

/** 远端由项目级配置提供,扩展只保留同步参数 */
const baseConfig = (): Record<string, unknown> => ({
  [configKey('intervalMinutes')]: 0,
  [configKey('syncOnStart')]: false,
  [configKey('commitMessage')]: 'sync: {time}',
  [configKey('authorName')]: 'iMark',
  [configKey('authorEmail')]: 'imark@local',
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
  // 图片目录是隐藏目录(文件树不显示),但同步必须照常带上它
  await mkdir(join(vault, '.assets'), { recursive: true })
  await writeFile(join(vault, '.assets', 'keep-me.png'), 'png', 'utf8')

  const config = baseConfig()
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
  check('内置包通过校验并安装', installed.manifest.version === '1.1.0')

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  // 远端在启动前写进项目级配置(ssh 不需要密钥)
  await setProjectGitRemote(vault, {
    url: remote,
    auth: 'ssh',
    username: '',
    localBranch: 'main',
    remoteBranch: 'main'
  })
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  /** 改项目远端并像真正的选择页那样通知扩展 */
  const setRemote = async (target: TargetConfig, secret?: string): Promise<void> => {
    await setProjectGitRemote(vault, {
      url: target.url,
      auth: target.auth,
      username: target.username,
      localBranch: target.localBranch,
      remoteBranch: target.remoteBranch,
      ...(secret === undefined ? {} : { secret })
    })
    service.notifyProjectGitChanged()
  }
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
    'imark.git-sync.uploadNow',
    'imark.git-sync.downloadNow',
    'imark.git-sync.resolveConflicts',
    'imark.git-sync.detectProxy',
    'imark.git-sync.testTarget'
  ]) {
    check(`声明了命令 ${id}`, commands.some(c => c.command === id))
  }
  const keybindings = service.getContributions().keybindings.filter(k => k.extensionId === EXT_ID)
  const syncKey = keybindings.find(k => k.command === 'imark.git-sync.syncNow')
  check('声明了 ctrl+alt+s 快捷键且未被摘掉', syncKey?.key === 'ctrl+alt+s' && !syncKey.dropped, JSON.stringify(syncKey))
  const actions = service.getContributions().actions.filter(a => a.extensionId === EXT_ID)
  check('声明了 5 个设置页动作', actions.length === 5, JSON.stringify(actions.map(a => a.command)))
  const targetAction = actions.find(a => a.command === 'imark.git-sync.testTarget')
  check(
    '「测试连接」挂到远端仓库字段上',
    targetAction?.scope === 'target' && targetAction.targetSetting === `${EXT_ID}.targets`,
    JSON.stringify(targetAction)
  )
  const fields = v?.descriptor.settingsFields ?? []
  const remoteField = fields.find(f => f.key === 'targets')
  check(
    '扩展设置里有「远端仓库」字段，且绑定项目级 Git 配置',
    remoteField?.kind === 'targets' &&
      remoteField.single === true &&
      remoteField.projectGit === true &&
      remoteField.targetSecret !== undefined,
    JSON.stringify(remoteField)
  )
  check(
    '设置里不再有自动初始化仓库相关字段',
    !fields.some(f =>
      ['autoInitRepo', 'initBranch', 'writeGitignore', 'writeReadme'].includes(f.key)
    ),
    JSON.stringify(fields.map(f => f.key))
  )
  const startField = fields.find(f => f.key === 'syncOnStart')
  check('启动后同步一次默认关闭', startField?.default === false, JSON.stringify(startField))
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
  check('扩展有独立宿主进程', groups.length === 1 && groups[0]!.pid !== null, JSON.stringify(groups))
  const item = await waitFor(statusItem, x => !!x)
  check('状态栏出现远程同步条目', item?.text === '$(git) 远程同步', JSON.stringify(item))
  check('点击执行立即同步', item?.command === 'imark.git-sync.syncNow')
  check('悬停说明指向同步动作', (item?.tooltip ?? '').includes('同步'), String(item?.tooltip))
  check('初始状态是 idle', (await view())?.status.status === 'idle', String((await view())?.status.status))

  // ---------- 3. 首次同步 ----------

  console.log('\n【3】首次同步：远端真的收到提交')
  check(
    '远端此刻还没有 main 分支',
    (await git(remote, ['branch', '--list'])).trim() === ''
  )
  // 扩展不再替用户初始化仓库:非 git 目录必须明确失败,而不是偷偷 git init
  const noRepo = (await service.executeCommand('imark.git-sync.syncNow')) as {
    ok: boolean
    message: string
  }
  check(
    '不是 git 仓库时同步明确失败',
    noRepo?.ok === false && noRepo.message === '当前仓库还不是 git 仓库',
    JSON.stringify(noRepo)
  )
  check('失败时没有建出 .git', !existsSync(join(vault, '.git')))
  await git(vault, ['init', '--initial-branch=main'])

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
  check('不自动写入 .gitignore', !files.includes('.gitignore'), files.trim())
  check('隐藏的 .assets 目录也同步到远端', files.includes('.assets/keep-me.png'), files.trim())
  const blob = await git(remote, ['show', 'main:笔记.md'])
  check('远端内容与本地一致', blob === '# 第一篇\n\n同步我。\n', JSON.stringify(blob))
  const subject = (await git(remote, ['log', '-1', '--format=%s', 'main'])).trim()
  check('提交信息用了模板（sync: 时间）', /^sync: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(subject), subject)

  const afterFirst = await waitStatus('ok')
  console.log(`      status = ${JSON.stringify(afterFirst?.status)}`)
  check('运行状态上报为 ok', afterFirst?.status.status === 'ok', JSON.stringify(afterFirst?.status))
  check('状态文本说明已推送', (afterFirst?.status.lastMessage ?? '').includes('推送'), afterFirst?.status.lastMessage)
  check('lastRunAt 有值', typeof afterFirst?.status.lastRunAt === 'number')
  const okItem = await waitFor(statusItem, x => x?.text === '$(check) 远程同步')
  check('状态栏切成成功图标', okItem?.text === '$(check) 远程同步', JSON.stringify(okItem?.text))
  check('远端结果上报为 ok', afterFirst?.status.targetResults?.project === 'ok')

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

  console.log('\n【5】测试连接')
  const testOne = (await service.executeCommand('imark.git-sync.testTarget')) as {
    ok: boolean
    message: string
  }
  check('testTarget 成功', testOne?.ok === true, JSON.stringify(testOne))
  check('提示里说明远端已有分支', (testOne?.message ?? '').includes('连接测试通过'), testOne?.message)
  check(
    '状态卡记录连接成功',
    (await waitStatus('ok'))?.status.targetResults?.project === 'ok',
    JSON.stringify((await view())?.status.targetResults)
  )

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

  // ---------- 6. 密钥缺失 ----------

  console.log('\n【6】缺密钥：在动 git 之前失败；配置问题只在黄色提示里说')
  // 先记下配置前的状态:缺密钥属于「远端没填完」,不该把状态卡从 ok 改成 error
  const beforeMissing = (await view())?.status.status
  const tokenTarget: TargetConfig = {
    id: 't2',
    url: 'https://example.invalid/notes.git',
    auth: 'token',
    username: '',
    localBranch: 'main',
    remoteBranch: 'main'
  }
  await setRemote(tokenTarget)
  const opsBeforeMissing = ((await view())?.logs ?? []).filter(
    entry => entry.level === 'operation'
  ).length
  const missing = (await service.executeCommand('imark.git-sync.syncNow')) as {
    ok: boolean
    message: string
    silent?: boolean
  }
  check('命令返回失败', missing?.ok === false, JSON.stringify(missing))
  check('结果标记为 silent（交给设置页的黄色提示）', missing?.silent === true, JSON.stringify(missing))
  check('错误指向唯一远端', (missing?.message ?? '').includes('远端'), missing?.message)
  check('错误说明缺的是访问令牌', (missing?.message ?? '').includes('访问令牌'), missing?.message)
  // 配置变更 3 秒后还会自动试跑一次;等它过去,确认状态卡仍未被这次校验覆盖
  await sleep(3500)
  const afterMissing = await view()
  check(
    '状态卡保持原状态，不因配置未填完变红',
    afterMissing?.status.status === beforeMissing,
    `${beforeMissing} → ${afterMissing?.status.status}`
  )
  const missingLogs = afterMissing?.logs ?? []
  check(
    '不把缺密钥写进扩展日志',
    !missingLogs.some(entry => entry.level === 'error' && entry.message.includes('访问令牌')),
    JSON.stringify(missingLogs.slice(-3))
  )
  const opsAfterMissing = missingLogs.filter(entry => entry.level === 'operation')
  check(
    '操作日志不记录这次失败（silent）',
    opsAfterMissing.length === opsBeforeMissing,
    JSON.stringify(opsAfterMissing.slice(-2))
  )

  // ---------- 7. 单个远端不可用 ----------

  console.log('\n【7】远端不可用：同步失败，状态卡标红')
  const broken: TargetConfig = {
    id: 'bad',
    url: badRemote,
    auth: 'ssh',
    username: '',
    localBranch: 'main',
    remoteBranch: 'main'
  }
  await writeFile(join(vault, '第三篇.md'), '# 第三篇\n', 'utf8')
  const beforeBroken = await count()
  // 项目远端变更会触发扩展内部的防抖补跑（3s），用它验证项目级变更链路
  await setRemote(broken)
  const failed = await waitStatus('error', 25_000)
  check('配置变更后自动跑了一轮并上报 error', failed?.status.status === 'error', JSON.stringify(failed?.status))
  check('远端记为 error', failed?.status.targetResults?.project === 'error', JSON.stringify(failed?.status.targetResults))
  check('状态文本说明失败', (failed?.status.lastMessage ?? '').includes('同步失败'), failed?.status.lastMessage)
  check(
    '失败的详情里带分类提示',
    (failed?.status.lastDetail ?? '').includes('仓库') ||
      (failed?.status.lastDetail ?? '').includes('连接') ||
      (failed?.status.lastDetail ?? '').includes('remote'),
    failed?.status.lastDetail
  )
  const failLogs = (await view())?.logs ?? []
  check(
    '失败原因同时写进扩展日志',
    failLogs.some(entry => entry.level === 'error' && entry.message.includes('失败')) &&
      failLogs.some(entry => entry.level === 'error' && entry.message.includes('远端')),
    JSON.stringify(failLogs.slice(-4))
  )
  check('失败的远端没有收到提交', (await count()) === beforeBroken)
  const failItem = await waitFor(statusItem, x => x?.text === '$(alert) 远程同步')
  check('状态栏切成告警图标', failItem?.text === '$(alert) 远程同步', JSON.stringify(failItem?.text))

  const testBad = (await service.executeCommand('imark.git-sync.testTarget')) as {
    ok: boolean
    message: string
  }
  check('测试失败的远端返回失败', testBad?.ok === false, JSON.stringify(testBad))
  check('失败结果也写进状态卡', (await waitStatus('error'))?.status.targetResults?.project === 'error')

  // ---------- 8. 检测代理（手动地址为空） ----------

  console.log('\n【8】检测代理：手动地址为空时提示地址问题')
  const proxy = (await service.executeCommand('imark.git-sync.detectProxy')) as {
    ok: boolean
    message: string
  }
  check('detectProxy 返回失败', proxy?.ok === false, JSON.stringify(proxy))
  check('说明手动地址无法识别', (proxy?.message ?? '').includes('无法识别'), proxy?.message)

  // ---------- 9. 停用 / 重新启用 / 卸载 ----------

  console.log('\n【9】停用释放宿主，重新启用后可再次激活；卸载清理干净')
  // 回到可用远端：下一步的「重新启用后执行命令」不应再撞上故意填坏的那个远端。
  // 配置变更会触发 3 秒防抖补跑；等到它真的跑完再停用，避免状态在断言之间跳变。
  await setRemote(target1(remote))
  const restored = await waitStatus('ok', 15_000)
  check('恢复单远端配置后自动补跑成功', restored?.status.status === 'ok', JSON.stringify(restored?.status))
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
