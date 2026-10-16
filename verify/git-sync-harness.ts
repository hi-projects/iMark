/**
 * git-sync 真跑一次上传 —— 本次改动碰过它的源码(加了 vault:read 的启动期检查),
 * 所以要证明「同步一次」这件事还是通的,而不是只看加载不报错。
 *
 * 真开一个裸仓库当远端、真让插件提交并推送,最后用 git 自己读回远端的分支内容。
 * 全程不 mock:插件跑的是打包出来的内置包,走的是生产的那条 loadExternal 路径。
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs git-sync
 */

import { app, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

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

/**
 * 在指定目录跑 git,返回 stdout(失败就把 stderr 抛出来,便于看清是哪一步)。
 *
 * `-c core.quotePath=false`:git 默认把非 ASCII 路径转义成 `"\347\254\224..."`,
 * 中文文件名在输出里就变成一串八进制,拿它做 includes 永远匹配不上。
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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

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

  // 远端:一个裸仓库。分支名刻意定成 main,和插件默认的 initBranch 对齐
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  // 仓库里放一篇笔记,插件的职责就是把它提交并推上去
  await writeFile(join(vault, '笔记.md'), '# 第一篇\n\n同步我。\n', 'utf8')

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
              targets: [
                {
                  id: 't1',
                  url: remote,
                  localBranch: 'main',
                  remoteBranch: 'main',
                  // auth 选 ssh:插件对 ssh 不做密钥校验,而本地路径远端本来也不需要凭据
                  auth: 'ssh',
                  username: ''
                }
              ],
              intervalMinutes: 0,
              // 关掉开机同步 —— 这一轮要自己控制时机,不然「什么时候跑的」说不清
              syncOnStart: false,
              commitMessage: 'sync: {time}',
              authorName: 'iMark',
              authorEmail: 'imark@local',
              autoInitRepo: true,
              initBranch: 'main',
              writeGitignore: true,
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
  console.log('\n[依赖] git 与插件清单')
  check('git-sync 从内置包加载成功', view !== undefined && view.loadError === undefined,
    String(view?.loadError))
  check('git-sync 是启用状态', view?.state.enabled === true)
  check('远端是一个真的裸仓库', (await git(remote, ['rev-parse', '--is-bare-repository'])).trim() === 'true')
  check('远端此刻还没有 main 分支', (await git(remote, ['branch', '--list'])).trim() === '')

  console.log('\n[真跑] 点「立即上传」')
  const result = await host.runAction('git-sync', 'sync-now')
  check('动作返回成功', result.ok === true, `${result.message} / ${result.detail ?? ''}`)
  console.log(`      插件自己说:${result.message}`)

  // 不看插件怎么说,看 git 怎么说
  console.log('\n[核对] 直接问远端仓库要答案')
  const branches = await git(remote, ['branch', '--list', '--format=%(refname:short)'])
  check('远端有了 main 分支', branches.trim() === 'main', branches.trim())

  const files = await git(remote, ['ls-tree', '-r', '--name-only', 'main'])
  check('笔记被推上去了', files.includes('笔记.md'), files.trim())
  check('插件的 .gitignore 也写进去了(writeGitignore: true)', files.includes('.gitignore'),
    files.trim())

  const blob = await git(remote, ['show', 'main:笔记.md'])
  check('远端那份笔记内容与本地一致', blob === '# 第一篇\n\n同步我。\n', JSON.stringify(blob))

  // 第二次:没有改动时不应该造出空提交(插件靠 status --porcelain 判的)
  console.log('\n[第二次] 没有新改动时不该造出空提交')
  const before = (await git(remote, ['rev-list', '--count', 'main'])).trim()
  const again = await host.runAction('git-sync', 'sync-now')
  const after = (await git(remote, ['rev-list', '--count', 'main'])).trim()
  check('第二次动作仍算成功', again.ok === true, `${again.message} / ${again.detail ?? ''}`)
  check(`提交数没变(${before} → ${after})`, before === after)

  // 再来一轮:真的改了文件,应该多一个提交
  console.log('\n[第三次] 改了文件就该多一个提交')
  await writeFile(join(vault, '第二篇.md'), '# 第二篇\n', 'utf8')
  const third = await host.runAction('git-sync', 'sync-now')
  const afterThird = (await git(remote, ['rev-list', '--count', 'main'])).trim()
  check('第三次动作成功', third.ok === true, `${third.message} / ${third.detail ?? ''}`)
  check(`提交数 +1(${after} → ${afterThird})`, Number(afterThird) === Number(after) + 1)
  const files2 = await git(remote, ['ls-tree', '-r', '--name-only', 'main'])
  check('新文件也推上去了', files2.includes('第二篇.md'), files2.trim())

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
