/**
 * git-sync 的**双向同步**端到端验收。
 *
 * 主 harness 只覆盖「本地有新改动 → 推送」，这条路上的 fetch/merge 永远走
 * 「远端还没有分支」或「本地领先」分支；一旦远端真的有别人推的提交，代码走的是
 * 完全不同的路径。这里用两个真实仓库（应用里的 vault + 另一个 git clone）当两台
 * 设备，钉住：
 *
 *   1. 空仓库首次同步：直接采纳已有远端的内容，不造本地根提交；
 *   2. 本地改动 →「上传文件」提交并推送到远端；
 *   3. 远端改动 → 完整同步快进到本地；
 *   4. 两边都有新提交 → 完整同步自动合并并推送；
 *   5. 「拉取文件」+ 不重叠的本地未提交改动 → 拉取后自动恢复本地改动；
 *   6. 「拉取文件」+ 同一文件的本地改动 → stash 恢复时冲突，进入冲突界面；
 *   7. 「拉取文件」时远端合并本身冲突 → 本地改动留在 stash，完成合并后自动恢复；
 *   8. 同一文件两边都改（提交级）→ 保留合并状态，处理完再同步完成合并。
 *
 * 跑法（在仓库根目录）：node verify/run.mjs git-sync-sync
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

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/**
 * 读取文本并归一换行。
 *
 * 检出的文件是否变成 CRLF 取决于用户全局的 `core.autocrlf`，与扩展无关；
 * 断言内容时按 LF 比较，才能在本机与 CI 上得到同一结果。
 */
async function textOf(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replace(/\r\n/g, '\n')
}

interface TargetConfig {
  id: string
  url: string
  auth: 'ssh' | 'token' | 'password'
  username: string
  localBranch: string
  remoteBranch: string
}

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
  [configKey('proxyMode')]: 'manual',
  [configKey('proxyUrl')]: ''
})

const targetOf = (id: string, remote: string): TargetConfig => ({
  id,
  url: remote,
  auth: 'ssh',
  username: '',
  localBranch: 'main',
  remoteBranch: 'main'
})

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs git-sync-sync` 跑会自动带上）')
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

  for (const dir of [
    vault,
    remote,
    deviceB,
    join(ud, 'plugins'),
    join(ud, 'extensions-data')
  ]) {
    await rm(dir, { recursive: true, force: true })
  }

  // 远端先有一份内容，模拟「已存在的仓库」；vault 保持为空
  await mkdir(remote, { recursive: true })
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  const seed = join(ud, 'seed')
  await rm(seed, { recursive: true, force: true })
  await git(ud, ['clone', remote, seed])
  await writeFile(join(seed, '远端笔记.md'), '# 远端笔记\n\n来自另一台设备。\n', 'utf8')
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n', 'utf8')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-m', 'seed: 远端已有内容'])
  await git(seed, ['push', 'origin', 'main'])

  await mkdir(vault, { recursive: true })
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: null,
        marketUrl: '',
        autoSaveMode: 'off',
        extensions: {
          [EXT_ID]: { enabled: true, config: baseConfig([targetOf('t1', remote)]) }
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
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)
  await service.startup()
  await sleep(600)

  const view = async () =>
    (await service.getExtensionViews()).find(v => v.descriptor.id === EXT_ID)

  async function waitStatus(status: PluginStatus, ms = 25_000): Promise<void> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const current = await view()
      if (current?.status.status === status && !service.isActivated(EXT_ID)) return
      if (current?.status.status === status) return
      await sleep(150)
    }
  }

  type CommandResult = { ok: boolean; message: string; detail?: string }

  const syncNow = async (): Promise<CommandResult> =>
    (await service.executeCommand('imark.git-sync.syncNow')) as CommandResult
  const uploadNow = async (): Promise<CommandResult> =>
    (await service.executeCommand('imark.git-sync.uploadNow')) as CommandResult
  const downloadNow = async (): Promise<CommandResult> =>
    (await service.executeCommand('imark.git-sync.downloadNow')) as CommandResult

  const remoteHead = async (): Promise<string> => gitSoft(remote, ['rev-parse', 'main'])
  const localHead = async (): Promise<string> => gitSoft(vault, ['rev-parse', 'main'])

  // ---------- 1. 空仓库首次同步：采纳远端 ----------

  console.log('\n【1】空仓库 + 已有远端：第一次同步直接采纳远端内容')
  check('本地此刻还没有远端笔记', !(await exists(join(vault, '远端笔记.md'))))
  const first = await syncNow()
  console.log(`      扩展自己说：${first?.message}`)
  check('同步成功', first?.ok === true, JSON.stringify(first))
  check('远端笔记被下载到本地', await exists(join(vault, '远端笔记.md')))
  check(
    '下载内容与远端一致',
    (await textOf(join(vault, '远端笔记.md'))) === '# 远端笔记\n\n来自另一台设备。\n'
  )
  check('远端自带的 .gitignore 没有被本地默认值覆盖', (await textOf(join(vault, '.gitignore'))) === 'node_modules/\n')
  check('远端 HEAD 没有被这次同步改写', (await remoteHead()) === (await localHead()))
  await waitStatus('ok')

  // ---------- 2. 本地改动 → 上传文件 ----------

  console.log('\n【2】本地改动：上传文件把它推到远端')
  await writeFile(join(vault, '本地笔记.md'), '# 本地笔记\n', 'utf8')
  const pushedLocal = await uploadNow()
  console.log(`      扩展自己说：${pushedLocal?.message}`)
  check('上传成功', pushedLocal?.ok === true, JSON.stringify(pushedLocal))
  check(
    '远端收到本地笔记',
    (await gitSoft(remote, ['ls-tree', '-r', '--name-only', 'main'])).includes('本地笔记.md')
  )

  // ---------- 3. 远端改动 → 同步拉回本地 ----------

  console.log('\n【3】远端有新提交：立即同步把它拉到本地')
  await git(ud, ['clone', remote, deviceB])
  await writeFile(join(deviceB, '设备B.md'), '# 设备 B\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 新增'])
  await git(deviceB, ['push', 'origin', 'main'])

  const pulled = await syncNow()
  console.log(`      扩展自己说：${pulled?.message}`)
  check('同步成功', pulled?.ok === true, JSON.stringify(pulled))
  check('设备 B 的文件出现在本地', await exists(join(vault, '设备B.md')))
  check('本地 HEAD 跟上了远端', (await localHead()) === (await remoteHead()))

  // ---------- 4. 两边都有新提交 → 自动合并 ----------

  console.log('\n【4】两边各写一个文件：完整同步自动合并')
  await git(deviceB, ['pull', '--rebase', 'origin', 'main'])
  await writeFile(join(deviceB, '设备B3.md'), '# 设备 B 3\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 第三篇'])
  await git(deviceB, ['push', 'origin', 'main'])
  await writeFile(join(vault, '本地笔记3.md'), '# 本地第三篇\n', 'utf8')

  const merged = await syncNow()
  console.log(`      扩展自己说：${merged?.message}`)
  check('同步成功', merged?.ok === true, JSON.stringify(merged))
  check('远端的第三篇被合并进来', await exists(join(vault, '设备B3.md')))
  check(
    '本地的第三篇被推上去',
    (await gitSoft(remote, ['ls-tree', '-r', '--name-only', 'main'])).includes('本地笔记3.md')
  )
  check('产生了合并提交（HEAD 有两个父提交）', (await git(vault, ['rev-list', '--parents', '-1', 'HEAD'])).trim().split(/\s+/).length === 3)

  // ---------- 5. 拉取文件：本地改动不重叠 → 拉取后恢复 ----------

  console.log('\n【5】拉取文件：本地未提交改动在拉取后恢复')
  await git(deviceB, ['pull', '--rebase', 'origin', 'main'])
  await writeFile(join(vault, '下载本地.md'), '本地未提交\n', 'utf8')
  await writeFile(join(deviceB, '下载远端.md'), '远端新增\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 下载远端'])
  await git(deviceB, ['push', 'origin', 'main'])

  const downloaded = await downloadNow()
  console.log(`      扩展自己说：${downloaded?.message}`)
  check('下载成功', downloaded?.ok === true, JSON.stringify(downloaded))
  check('提示说明本地改动已恢复', (downloaded?.message ?? '').includes('本地未提交改动已恢复'), downloaded?.message)
  check('远端新增文件出现在本地', await exists(join(vault, '下载远端.md')))
  check('本地未提交文件仍然存在', (await textOf(join(vault, '下载本地.md'))) === '本地未提交\n')
  check(
    '本地改动仍保持未提交',
    (await gitSoft(vault, ['status', '--porcelain'])).includes('下载本地.md')
  )
  check(
    '下载用的 stash 已经清理',
    !(await gitSoft(vault, ['stash', 'list'])).includes('imark-download:')
  )

  const commitDownloaded = await syncNow()
  check('随后同步把本地改动提交并推送', commitDownloaded?.ok === true, JSON.stringify(commitDownloaded))

  // ---------- 6. 拉取文件：同一文件冲突 → 冲突标记 ----------

  console.log('\n【6】拉取文件：本地改动与远端改同一文件 → 冲突界面')
  await writeFile(join(vault, '下载冲突.md'), '基础\n', 'utf8')
  const basePushed = await syncNow()
  check('先同步一个基础版本', basePushed?.ok === true, JSON.stringify(basePushed))
  await git(deviceB, ['pull', '--rebase', 'origin', 'main'])

  await writeFile(join(vault, '下载冲突.md'), '本地未提交\n', 'utf8')
  await writeFile(join(deviceB, '下载冲突.md'), '远端版本\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 下载冲突'])
  await git(deviceB, ['push', 'origin', 'main'])

  const downloadConflict = await downloadNow()
  console.log(`      扩展自己说：${downloadConflict?.message}`)
  console.log(`      详情：${downloadConflict?.detail ?? ''}`)
  check('下载返回失败', downloadConflict?.ok === false, JSON.stringify(downloadConflict))
  check('失败说明里点到了冲突', (downloadConflict?.detail ?? '').includes('冲突'), downloadConflict?.detail)
  check('失败说明里列出了冲突文件', (downloadConflict?.detail ?? '').includes('下载冲突.md'), downloadConflict?.detail)
  const downloadConflictDisk = await textOf(join(vault, '下载冲突.md'))
  check('文件写入了冲突标记', downloadConflictDisk.includes('<<<<<<<') && downloadConflictDisk.includes('=======') && downloadConflictDisk.includes('>>>>>>>'))
  check('本地 HEAD 已经跟上远端', (await localHead()) === (await remoteHead()))
  check(
    '下载用的 stash 已清理（冲突标记里保留两边内容）',
    !(await gitSoft(vault, ['stash', 'list'])).includes('imark-download:')
  )

  await writeFile(join(vault, '下载冲突.md'), '解决后\n', 'utf8')
  const downloadResolved = await syncNow()
  console.log(`      扩展自己说：${downloadResolved?.message}`)
  check('处理完后再同步成功', downloadResolved?.ok === true, JSON.stringify(downloadResolved))
  check('远端收到处理后的版本', (await gitSoft(remote, ['show', 'main:下载冲突.md'])) === '解决后\n')
  check('工作区变干净', (await gitSoft(vault, ['status', '--porcelain'])).trim() === '')
  await wc.executeJavaScript(`document.querySelector('.conflict-dialog-close')?.click()`, true)
  await sleep(200)

  // ---------- 7. 拉取文件：远端合并冲突 + 待恢复 stash ----------

  console.log('\n【7】拉取文件：合并冲突时保留 stash，完成合并后自动恢复')
  await git(deviceB, ['pull', '--rebase', 'origin', 'main'])
  // 本地先提交一个远端没有的文件版本(故意不推送)
  await writeFile(join(vault, '下载合并冲突.md'), '本地提交\n', 'utf8')
  await git(vault, ['add', '-A'])
  await git(vault, ['commit', '-m', 'local: 下载合并冲突'])
  // 本地另有一处未提交改动(与远端不重叠)
  await writeFile(join(vault, '待恢复.md'), 'stash 内容\n', 'utf8')
  // 远端也新增同名文件,制造提交级合并冲突
  await writeFile(join(deviceB, '下载合并冲突.md'), '远端提交\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 下载合并冲突'])
  await git(deviceB, ['push', 'origin', 'main'])

  const mergeDownload = await downloadNow()
  console.log(`      扩展自己说：${mergeDownload?.message}`)
  console.log(`      详情：${mergeDownload?.detail ?? ''}`)
  check('下载返回失败', mergeDownload?.ok === false, JSON.stringify(mergeDownload))
  check('失败说明里列出了冲突文件', (mergeDownload?.detail ?? '').includes('下载合并冲突.md'), mergeDownload?.detail)
  const mergeDownloadDisk = await textOf(join(vault, '下载合并冲突.md'))
  check('文件写入了冲突标记', mergeDownloadDisk.includes('<<<<<<<') && mergeDownloadDisk.includes('=======') && mergeDownloadDisk.includes('>>>>>>>'))
  check('保留了合并状态（MERGE_HEAD 存在）', await exists(join(vault, '.git', 'MERGE_HEAD')))
  check(
    '本地改动仍暂存在 stash 里',
    (await gitSoft(vault, ['stash', 'list'])).includes('imark-download:')
  )
  check('待恢复的文件暂时不在工作区', !(await exists(join(vault, '待恢复.md'))))

  await writeFile(join(vault, '下载合并冲突.md'), '解决\n', 'utf8')
  const mergeDownloadResolved = await syncNow()
  console.log(`      扩展自己说：${mergeDownloadResolved?.message}`)
  check('完成合并并恢复 stash 后同步成功', mergeDownloadResolved?.ok === true, JSON.stringify(mergeDownloadResolved))
  check('待恢复的文件被恢复', (await textOf(join(vault, '待恢复.md'))) === 'stash 内容\n')
  check(
    '待恢复的文件被提交并推送',
    (await gitSoft(remote, ['show', 'main:待恢复.md'])) === 'stash 内容\n'
  )
  check('冲突按解决后的内容推送', (await gitSoft(remote, ['show', 'main:下载合并冲突.md'])) === '解决\n')
  check(
    'stash 已经清理',
    !(await gitSoft(vault, ['stash', 'list'])).includes('imark-download:')
  )
  check('MERGE_HEAD 已清掉', !(await exists(join(vault, '.git', 'MERGE_HEAD'))))
  check('工作区变干净', (await gitSoft(vault, ['status', '--porcelain'])).trim() === '')
  await wc.executeJavaScript(`document.querySelector('.conflict-dialog-close')?.click()`, true)
  await sleep(200)

  // ---------- 8. 同一文件冲突：保留合并状态，处理后再完成 ----------

  console.log('\n【8】同一文件两边都改：保留冲突标记，处理完再同步')
  await git(deviceB, ['pull', '--rebase', 'origin', 'main'])
  await writeFile(join(deviceB, '共享.md'), '# 共享\n\nB 的版本\n', 'utf8')
  await git(deviceB, ['add', '-A'])
  await git(deviceB, ['commit', '-m', 'device-b: 共享 B'])
  await git(deviceB, ['push', 'origin', 'main'])
  await writeFile(join(vault, '共享.md'), '# 共享\n\nA 的版本\n', 'utf8')

  const conflicted = await syncNow()
  console.log(`      扩展自己说：${conflicted?.message}`)
  console.log(`      详情：${conflicted?.detail ?? ''}`)
  check('同步返回失败', conflicted?.ok === false, JSON.stringify(conflicted))
  check('失败说明里点到了冲突', (conflicted?.detail ?? '').includes('冲突'), conflicted?.detail)
  check('失败说明里列出了冲突文件', (conflicted?.detail ?? '').includes('共享.md'), conflicted?.detail)
  const conflictDisk = await textOf(join(vault, '共享.md'))
  check('本地文件写入了冲突标记', conflictDisk.includes('<<<<<<<') && conflictDisk.includes('=======') && conflictDisk.includes('>>>>>>>'))
  check('保留了合并状态（MERGE_HEAD 存在）', await exists(join(vault, '.git', 'MERGE_HEAD')))
  check('工作区是未完成的合并', (await gitSoft(vault, ['status', '--porcelain'])).trim().length > 0)
  check(
    '远端保持另一台设备的版本',
    (await gitSoft(remote, ['show', 'main:共享.md'])) === '# 共享\n\nB 的版本\n'
  )

  // 处理冲突(这里直接写回本地版本),再同步一次:扩展应完成合并提交并推送
  await writeFile(join(vault, '共享.md'), '# 共享\n\nA 的版本\n', 'utf8')
  const resolved = await syncNow()
  console.log(`      扩展自己说：${resolved?.message}`)
  check('处理完后再同步成功', resolved?.ok === true, JSON.stringify(resolved))
  check('MERGE_HEAD 已清掉', !(await exists(join(vault, '.git', 'MERGE_HEAD'))))
  check('工作区变干净', (await gitSoft(vault, ['status', '--porcelain'])).trim() === '')
  check(
    '远端收到处理后的版本',
    (await gitSoft(remote, ['show', 'main:共享.md'])) === '# 共享\n\nA 的版本\n'
  )
  check('冲突合并产生两个父提交', (await git(remote, ['rev-list', '--parents', '-1', 'main'])).trim().split(/\s+/).length === 3)

  await shutdownExtensions()
  console.log(`\n${pass} 通过，${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
