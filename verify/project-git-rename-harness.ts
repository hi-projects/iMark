/**
 * 验收:仓库目录重命名 / 移动后,项目 Git 配置与密钥跟着走。
 *
 * 用户报告:在文件树里重命名仓库文件夹(比如把嵌套在另一个仓库里的项目改名)
 * 之后,这个项目的 Git 设置就没了。
 *
 * 项目 Git 配置按**绝对路径**索引:settings.projectGit 的键是路径,密钥键是
 * 路径的哈希。目录一改名,旧键永远读不到 —— 配置看起来"消失",密钥也读不出来。
 *
 * 两段:
 *   A 迁移本身:被改名目录自己的配置、目录下所有项目、token / password 两种
 *     密钥都搬到新路径;旧键清掉;不相干的仓库不受影响;只改大小写时键不变。
 *   B 端到端:在文件树里真的重命名一个「同时是最近仓库」的文件夹,走
 *     VaultRename → moveProjectGit → 渲染层更新最近仓库列表,最后设置文件里
 *     新路径有配置、旧路径没有,密钥也能读出来。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs project-git-rename
 */

import { app, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { getSettingsSync, loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { getSecret } from '../src/main/secrets'
import {
  moveProjectGit,
  projectGitKey,
  projectGitSecretKey,
  readProjectGitRemote,
  setProjectGitRemote
} from '../src/main/projectGit'
import { renameVaultPath } from '../src/main/vault'

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
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

type RemoteInput = Parameters<typeof setProjectGitRemote>[1]

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs project-git-rename` 跑会自动带上)')
    app.exit(2)
    return
  }
  await app.whenReady()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const other = join(ud, 'other')
  const uiProj = join(vault, 'ui-proj')
  const note = join(vault, '根笔记.md')
  await rm(vault, { recursive: true, force: true })
  await rm(other, { recursive: true, force: true })
  await mkdir(join(vault, 'proj', 'nested'), { recursive: true })
  await mkdir(join(vault, 'keep'), { recursive: true })
  await mkdir(uiProj, { recursive: true })
  await mkdir(other, { recursive: true })
  await writeFile(note, '# 根笔记\n', 'utf8')
  await writeFile(join(uiProj, '项目笔记.md'), '# 项目\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault, uiProj],
        lastFile: note,
        openFiles: [note],
        marketUrl: '',
        autoSave: false,
        autoSaveMode: 'off',
        explorer: true,
        outline: false
      },
      null,
      2
    ),
    'utf8'
  )
  registerIpc()
  registerImarkProtocol()
  await loadSettings()

  const cfg = (url: string, secret: string, auth: 'token' | 'password' = 'token'): RemoteInput => ({
    url,
    auth,
    username: auth === 'password' ? 'me' : '',
    localBranch: 'main',
    remoteBranch: '',
    secret
  })

  const proj = join(vault, 'proj')
  const nested = join(proj, 'nested')
  const keep = join(vault, 'keep')
  await setProjectGitRemote(proj, cfg('https://example.com/proj.git', 'tok-proj'))
  await setProjectGitRemote(nested, cfg('https://example.com/nested.git', 'tok-nested'))
  await setProjectGitRemote(keep, cfg('https://example.com/keep.git', 'tok-keep', 'password'))
  await setProjectGitRemote(other, cfg('https://example.com/other.git', 'tok-other'))
  await setProjectGitRemote(uiProj, cfg('https://example.com/ui.git', 'tok-ui'))

  // ---------- A. 迁移本身 ----------

  console.log('\n【A】目录改名:配置与密钥跟着走')
  const before = await readProjectGitRemote(proj)
  check('重命名前读得到远端', before?.url === 'https://example.com/proj.git', JSON.stringify(before))
  check('重命名前 token 已保存', (await getSecret(projectGitSecretKey(proj, 'token'))) === 'tok-proj')

  const proj2 = join(vault, 'proj2')
  await renameVaultPath(proj, proj2)
  await moveProjectGit(proj, proj2)

  const moved = await readProjectGitRemote(proj2)
  check('新路径读得到原配置', moved?.url === 'https://example.com/proj.git', JSON.stringify(moved))
  check('新路径的令牌跟着搬过来了', moved?.hasSecret === true, JSON.stringify(moved))
  check(
    '密钥内容没变(能真的拿去鉴权)',
    (await getSecret(projectGitSecretKey(proj2, 'token'))) === 'tok-proj'
  )
  check('旧路径不再有配置', (await readProjectGitRemote(proj)) === null)
  check('旧路径的密钥已清掉', (await getSecret(projectGitSecretKey(proj, 'token'))) === null)
  check(
    '目录下的嵌套项目一起迁过去了',
    (await readProjectGitRemote(join(proj2, 'nested')))?.url === 'https://example.com/nested.git'
  )
  check(
    '同级的其它项目不受影响',
    (await readProjectGitRemote(keep))?.url === 'https://example.com/keep.git'
  )
  check(
    '目录外的仓库也不受影响',
    (await readProjectGitRemote(other))?.url === 'https://example.com/other.git'
  )

  console.log('\n【A2】只改大小写:配置仍读得到')
  const upper = join(vault, 'KEEP2')
  const lower = join(vault, 'keep2')
  await setProjectGitRemote(lower, cfg('https://example.com/keep2.git', 'tok-keep2'))
  await moveProjectGit(lower, upper)
  check(
    '大小写变化后配置还在',
    (await readProjectGitRemote(upper))?.url === 'https://example.com/keep2.git',
    JSON.stringify(await readProjectGitRemote(upper))
  )

  // ---------- B. 端到端:文件树重命名 ----------

  console.log('\n【B】文件树里重命名「同时是最近仓库」的文件夹')
  const settings = await loadSettings()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(1800)
  const evalJs = <T,>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const waitFor = async (code: string, ms = 6000): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  check('文件树里找到了 ui-proj', await waitFor(`[...document.querySelectorAll('.explorer-name')].some(el => el.textContent === 'ui-proj')`))
  const clicked = await evalJs<boolean>(`(() => {
    const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
      .find(el => el.querySelector('.explorer-name')?.textContent === 'ui-proj')
    if (!row) return false
    const btn = [...row.querySelectorAll('.explorer-item-actions button')].find(b => b.title === '重命名')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check('点得到「重命名」', clicked)
  check('重命名输入框出现', await waitFor(`document.querySelector('.explorer-editing input')`))
  await evalJs(`(() => {
    const input = document.querySelector('.explorer-editing input')
    input.value = 'ui-proj2'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  const renamed = join(vault, 'ui-proj2')
  const renamedOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(renamed)) return true
      await sleep(80)
    }
    return false
  })()
  check('目录真的改名了', renamedOk)
  await sleep(1500)

  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as {
    vaults?: string[]
    projectGit?: Record<string, { url?: string }>
  }
  check(
    '最近仓库列表换到新路径',
    Array.isArray(saved.vaults) && saved.vaults.includes(renamed) && !saved.vaults.includes(uiProj),
    JSON.stringify(saved.vaults)
  )
  check(
    '项目 Git 配置迁到新路径(设置文件里)',
    saved.projectGit?.[projectGitKey(renamed)]?.url === 'https://example.com/ui.git',
    JSON.stringify(saved.projectGit?.[projectGitKey(renamed)])
  )
  check(
    '旧路径的配置已清掉',
    !saved.projectGit?.[projectGitKey(uiProj)],
    JSON.stringify(saved.projectGit?.[projectGitKey(uiProj)])
  )
  check(
    '密钥也跟着迁过去了',
    (await getSecret(projectGitSecretKey(renamed, 'token'))) === 'tok-ui' &&
      (await getSecret(projectGitSecretKey(uiProj, 'token'))) === null
  )
  check(
    '内存里的设置缓存也是新路径',
    !!getSettingsSync().vaults?.includes(renamed)
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  win.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
