/**
 * git-sync 的**合并冲突界面**端到端验收。
 *
 * 这条路径和「能同步」是两回事:远端与本地改到同一行时,扩展不能 abort、
 * 不能把标记提交上去,编辑器还必须真的把冲突标记渲染成可操作的界面。
 *
 * 覆盖：
 *   1. 自动合并冲突后保留合并状态,MARKER 出现在文件里,远端没有被覆盖；
 *   2. 扩展通知渲染层重载后,打开着的文档立刻出现 VSCode 风格的冲突操作栏
 *      （冲突 i/n、当前/传入两段的底色与三枚按钮）；
 *   3. 状态栏出现「N 处冲突」,全部处理完后消失；
 *   4. 三处冲突分别选「接受当前 / 接受传入 / 保留两者」,结果正确；
 *   5. 再点「立即同步」:完成合并提交、推送到远端,仓库回到干净状态。
 *
 * 跑法（在仓库根目录）：node verify/run.mjs git-sync-conflict
 */

import { app, dialog, protocol } from 'electron'
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
import type { PluginStatus } from '../src/shared/plugins'
import { APP_VERSION } from './appVersion'

const run = promisify(execFile)
const REPO = join(__dirname, '..', '..')
const EXT_ID = 'imark.git-sync'

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

async function gitSoft(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch {
    return ''
  }
}

async function textOf(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
}

/** 20 行的基础笔记;本地与远端在不同行上各改一处,制造三个互相独立的冲突 */
function baseNote(): string {
  return Array.from({ length: 20 }, (_, i) => `行${i + 1}`).join('\n') + '\n'
}

const localNote = baseNote()
  .replace('行2\n', '本地2\n')
  .replace('行10\n', '本地10\n')
  .replace('行18\n', '本地18\n')

const remoteNote = baseNote()
  .replace('行2\n', '远端2\n')
  .replace('行10\n', '远端10\n')
  .replace('行18\n', '远端18\n')

interface TargetConfig {
  id: string
  url: string
  auth: 'ssh' | 'token' | 'password'
  username: string
  localBranch: string
  remoteBranch: string
}

const configKey = (key: string): string => `${EXT_ID}.${key}`

const configOf = (remote: string): Record<string, unknown> => ({
  [configKey('targets')]: [
    {
      id: 't1',
      url: remote,
      auth: 'ssh',
      username: '',
      localBranch: 'main',
      remoteBranch: 'main'
    } satisfies TargetConfig
  ],
  [configKey('intervalMinutes')]: 0,
  [configKey('syncOnStart')]: false,
  [configKey('commitMessage')]: 'sync: {time}',
  [configKey('authorName')]: 'iMark',
  [configKey('authorEmail')]: 'imark@local',
  [configKey('autoInitRepo')]: true,
  [configKey('initBranch')]: 'main',
  [configKey('writeGitignore')]: true,
  [configKey('writeReadme')]: false,
  [configKey('proxyMode')]: 'manual',
  [configKey('proxyUrl')]: ''
})

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs git-sync-conflict` 跑会自动带上）')
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
  const deviceB = join(ud, 'device-b')
  const seed = join(ud, 'seed')

  for (const dir of [vault, remote, deviceB, seed, join(ud, 'plugins'), join(ud, 'extensions-data')]) {
    await rm(dir, { recursive: true, force: true })
  }

  // 远端基准版本
  await mkdir(remote, { recursive: true })
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await mkdir(seed, { recursive: true })
  await git(seed, ['init', '--initial-branch=main'])
  await writeFile(join(seed, '笔记.md'), baseNote(), 'utf8')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-m', 'base: 20 行'])
  await git(seed, ['remote', 'add', 'origin', remote])
  await git(seed, ['push', 'origin', 'main'])

  // 本地先克隆基准版本,再改同样的三行(未提交)。应用会把它当成仓库直接打开。
  await git(ud, ['clone', remote, vault])
  await writeFile(join(vault, '笔记.md'), localNote, 'utf8')
  const note = join(vault, '笔记.md')

  // 另一台设备从同一个基准改三行并推上去 —— 两边从共同祖先分叉
  await git(ud, ['clone', remote, deviceB])
  await writeFile(join(deviceB, '笔记.md'), remoteNote, 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 改三行'])
  await git(deviceB, ['push', 'origin', 'main'])

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
          [EXT_ID]: { enabled: true, config: configOf(remote) }
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
  const win = createMainWindow(settings)
  const wc = win.webContents
  wc.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { message?: unknown } | undefined
    const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
    if (message) console.log(`[console] ${message}`)
  })
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)
  await service.startup()
  await sleep(700)

  const view = async () =>
    (await service.getExtensionViews()).find(v => v.descriptor.id === EXT_ID)

  async function waitStatus(status: PluginStatus, ms = 25_000): Promise<void> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if ((await view())?.status.status === status) return
      await sleep(150)
    }
  }

  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(expr: string, ms = 10_000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await js<boolean>(`Boolean(${expr})`).catch(() => false)) return true
      await sleep(100)
    }
    return false
  }

  const editorText = (): Promise<string> =>
    js<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
  const barCount = (): Promise<number> =>
    js<number>(`document.querySelectorAll('.cm-md-conflict-bar').length`)
  const clickBarButton = (text: string): Promise<boolean> =>
    js<boolean>(`(() => {
      const bar = document.querySelector('.cm-md-conflict-bar')
      if (!bar) return false
      const btn = [...bar.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})
      if (!btn) return false
      btn.click()
      return true
    })()`)

  // ---------- 1. 先让编辑器把本地版本打开 ----------

  console.log('\n【1】冲突前：编辑器打开的是本地版本')
  check('笔记已打开', (await waitFor(`document.querySelector('.cm-content')`)))
  check('编辑器内容是本地版本', (await editorText()).includes('本地2'), (await editorText()).slice(0, 60))

  // ---------- 2. 同步触发冲突 ----------

  console.log('\n【2】两边改同一批行：保留冲突标记，不推送')
  const conflicted = (await service.executeCommand(SYNC_NOW)) as {
    ok: boolean
    message: string
    detail?: string
  }
  console.log(`      扩展自己说：${conflicted?.message}`)
  console.log(`      详情：${conflicted?.detail ?? ''}`)
  check('同步返回失败', conflicted?.ok === false, JSON.stringify(conflicted))
  check('消息说明是合并冲突', (conflicted?.message ?? '').includes('冲突'), conflicted?.message)
  check('详情列出了冲突文件', (conflicted?.detail ?? '').includes('笔记.md'), conflicted?.detail)

  const disk = await textOf(note)
  check('磁盘上保留了冲突标记', disk.includes('<<<<<<<') && disk.includes('=======') && disk.includes('>>>>>>>'))
  check('远端没有被覆盖', (await gitSoft(remote, ['show', 'main:笔记.md'])) === remoteNote)
  check('仓库处于合并中（MERGE_HEAD 存在）', (await gitSoft(vault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).trim().length > 0)
  await waitStatus('error')

  // ---------- 3. 编辑器冲突界面 ----------

  console.log('\n【3】打开的文档自动重载并渲染冲突操作栏')
  check('出现三处冲突操作栏', (await waitFor(`document.querySelectorAll('.cm-md-conflict-bar').length === 3`)), String(await barCount()))
  const barText = await js<string>(`document.querySelector('.cm-md-conflict-bar')?.textContent ?? ''`)
  check('操作栏标出「冲突 1/3」', barText.includes('冲突 1/3'), barText)
  check('操作栏标出当前版本', barText.includes('当前更改'), barText)
  check('操作栏有三枚按钮', (await js<number>(`document.querySelectorAll('.cm-md-conflict-bar')[0].querySelectorAll('button').length`)) === 3)
  check('传入内容标题在文档里', (await editorText()).includes('传入更改'))
  check('标记已经不在可见文本里', !(await editorText()).includes('<<<<<<<'))
  check(
    '状态栏出现 3 处冲突',
    await waitFor(`document.querySelector('.status-conflicts')?.textContent.includes('3 处冲突')`)
  )

  // ---------- 4. 三种取舍 ----------

  console.log('\n【4】三处冲突分别选：接受当前 / 接受传入 / 保留两者')
  check('点击第一处「接受当前」', await clickBarButton('接受当前'))
  await sleep(250)
  check('第一处操作栏消失', (await barCount()) === 2, String(await barCount()))
  check('第二处「接受传入」', await clickBarButton('接受传入'))
  await sleep(250)
  check('第二处操作栏消失', (await barCount()) === 1, String(await barCount()))
  check('第三处「保留两者」', await clickBarButton('保留两者'))
  check(
    '全部冲突处理完，操作栏与状态栏提示消失',
    await waitFor(`document.querySelectorAll('.cm-md-conflict-bar').length === 0 && !document.querySelector('.status-conflicts')`)
  )
  const resolved = await editorText()
  check('保留了本地改动（接受当前）', resolved.includes('本地2') && !resolved.includes('远端2'), resolved.slice(0, 120))
  check('采用了远端改动（接受传入）', resolved.includes('远端10') && !resolved.includes('本地10'))
  check('两边都保留（保留两者）', resolved.includes('本地18') && resolved.includes('远端18'))

  // ---------- 5. 再同步：提交合并并推送 ----------

  console.log('\n【5】再同步：完成合并提交并推送')
  const finished = (await service.executeCommand(SYNC_NOW)) as { ok: boolean; message: string; detail?: string }
  console.log(`      扩展自己说：${finished?.message}`)
  check('同步成功', finished?.ok === true, JSON.stringify(finished))
  check('MERGE_HEAD 已清掉', (await gitSoft(vault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).trim() === '')
  const finalDisk = await textOf(note)
  check('磁盘上不再有冲突标记', !finalDisk.includes('<<<<<<<') && !finalDisk.includes('=======') && !finalDisk.includes('>>>>>>>'))
  const remoteFinal = await gitSoft(remote, ['show', 'main:笔记.md'])
  check('远端收到处理后的内容', remoteFinal.includes('本地2') && remoteFinal.includes('远端10') && remoteFinal.includes('本地18') && remoteFinal.includes('远端18'), remoteFinal.slice(0, 160))
  check('远端没有收到未保留的另一侧内容', !remoteFinal.includes('远端2') && !remoteFinal.includes('本地10'))
  check('这是一个合并提交（两个父提交）', (await git(remote, ['rev-list', '--parents', '-1', 'main'])).trim().split(/\s+/).length === 3)
  await waitStatus('ok')
  check('工作区干净', (await gitSoft(vault, ['status', '--porcelain'])).trim() === '')
  check('状态栏冲突计数已归零', !(await js<boolean>(`Boolean(document.querySelector('.status-conflicts'))`)))

  // ---------- 6. 非编辑器文件：自动弹出冲突处理窗口 ----------

  console.log('\n【6】.gitignore 冲突：自动打开「处理合并冲突」窗口')
  await git(deviceB, ['pull', '--rebase', 'origin', 'main'])
  await writeFile(join(deviceB, '.gitignore'), 'remote-ignore\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: .gitignore'])
  await git(deviceB, ['push', 'origin', 'main'])
  await writeFile(join(vault, '.gitignore'), 'local-ignore\n', 'utf8')

  const dotConflict = (await service.executeCommand(SYNC_NOW)) as { ok: boolean; message: string }
  check('.gitignore 冲突让同步失败', dotConflict?.ok === false, JSON.stringify(dotConflict))
  check('磁盘上的 .gitignore 保留了冲突标记', (await textOf(join(vault, '.gitignore'))).includes('<<<<<<<'))
  check('冲突处理窗口自动打开', await waitFor(`document.querySelector('.conflict-dialog')`))
  check(
    '窗口读出了 .gitignore',
    await waitFor(`document.querySelector('.conflict-dialog')?.textContent.includes('local-ignore')`)
  )
  const dialogText = await js<string>(`document.querySelector('.conflict-dialog')?.textContent ?? ''`)
  check('窗口里列出了 .gitignore', dialogText.includes('.gitignore'), dialogText.slice(0, 200))
  check('窗口里能看到两边的 .gitignore 内容', dialogText.includes('local-ignore') && dialogText.includes('remote-ignore'))
  check(
    '未处理完时不能保存',
    await waitFor(`document.querySelector('.conflict-dialog-primary')?.disabled === true`)
  )
  check(
    '点击「全部接受传入」',
    (await waitFor(
      `[...document.querySelectorAll('.conflict-dialog-mini-btn')].some(b => b.textContent.trim() === '全部接受传入')`
    )) &&
      (await js<boolean>(`(() => {
        const btn = [...document.querySelectorAll('.conflict-dialog-mini-btn')]
          .find(b => b.textContent.trim() === '全部接受传入')
        if (!btn) return false
        btn.click()
        return true
      })()`))
  )
  check(
    '处理完后保存按钮可用',
    await waitFor(`document.querySelector('.conflict-dialog-primary') && !document.querySelector('.conflict-dialog-primary').disabled`)
  )
  check(
    '点击「保存并继续同步」',
    await js<boolean>(`(() => {
      const btn = document.querySelector('.conflict-dialog-primary')
      if (!btn) return false
      btn.click()
      return true
    })()`)
  )
  check('窗口自动关闭', await waitFor(`!document.querySelector('.conflict-dialog')`))
  await waitStatus('ok')
  check('.gitignore 已是接受传入的版本', (await textOf(join(vault, '.gitignore'))) === 'remote-ignore\n')
  check('远端 .gitignore 也是该版本', (await gitSoft(remote, ['show', 'main:.gitignore'])) === 'remote-ignore\n')
  check('MERGE_HEAD 已清掉', (await gitSoft(vault, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).trim() === '')
  check('工作区干净', (await gitSoft(vault, ['status', '--porcelain'])).trim() === '')

  await shutdownExtensions()
  console.log(`\n${pass} 通过，${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

const SYNC_NOW = 'imark.git-sync.syncNow'

main().catch(err => {
  console.error(err)
  app.exit(1)
})
