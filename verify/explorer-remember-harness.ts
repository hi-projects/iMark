/**
 * 验收:文件树的目录展开状态按仓库记住。
 *
 * 期望:
 *   · 第一次打开仓库:目录全部收起,只列第一层;
 *   · 展开 / 收起后写进 settings.json 的 vaultExpandedDirs(按仓库路径分开存);
 *   · 重新打开(重启 / 重载窗口)按上次关闭时的状态恢复;
 *   · 收起后重开同样恢复成收起。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs explorer-remember
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_VERSION } from './appVersion'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs explorer-remember` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await rm(vault, { recursive: true, force: true })
  await mkdir(join(vault, '第一章', '子节'), { recursive: true })
  await mkdir(join(vault, '第二章'), { recursive: true })
  await writeFile(join(vault, '根文件.md'), '# 根文件\n', 'utf8')
  await writeFile(join(vault, '第一章', '1.1.md'), '# 1.1\n', 'utf8')
  await writeFile(join(vault, '第一章', '子节', '1.1.1.md'), '# 1.1.1\n', 'utf8')
  await writeFile(join(vault, '第二章', '2.1.md'), '# 2.1\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: null,
        marketUrl: '',
        explorer: true
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  const rowNames = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('.explorer-list .explorer-item .explorer-name')].map(e => (e.textContent || '').trim())`
    )

  const clickRow = (name: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => (el.querySelector('.explorer-name')?.textContent || '').trim() === ${JSON.stringify(name)})
      if (!row) return false
      row.click()
      return true
    })()`)

  const settingsPath = join(ud, 'settings.json')
  const savedDirs = async (): Promise<string[]> => {
    try {
      const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        vaultExpandedDirs?: Record<string, string[]>
      }
      return raw.vaultExpandedDirs?.[vault] ?? []
    } catch {
      return []
    }
  }

  /** 等异步存盘把展开状态写到磁盘上 */
  async function waitSavedDirs(ok: (dirs: string[]) => boolean, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (ok(await savedDirs())) return true
      await sleep(100)
    }
    return false
  }

  /** 重载窗口 = 重新打开仓库(settings 里的 vaultPath 不变) */
  async function reload(): Promise<void> {
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1500)
    await waitFor(`document.querySelector('.explorer-list .explorer-name')`)
    await sleep(300)
  }

  const dir1 = join(vault, '第一章')
  const sub = join(vault, '第一章', '子节')

  // ---------- 1. 第一次打开:全部收起 ----------

  console.log('\n【1】第一次打开仓库:目录默认收起,只列第一层')
  check('文件树已加载', await waitFor(`document.querySelector('.explorer-list .explorer-name')`))
  {
    const names = await rowNames()
    check(
      '首屏只有第一层目录与根文件',
      names.includes('第一章') && names.includes('第二章') && names.includes('根文件.md') &&
        !names.includes('1.1.md') && !names.includes('2.1.md'),
      JSON.stringify(names)
    )
    const dirs = await savedDirs()
    check('第一次打开没有存过展开状态', dirs.length === 0, JSON.stringify(dirs))
  }

  // ---------- 2. 展开后写盘 ----------

  console.log('\n【2】展开目录:状态按仓库写进 settings.json')
  check('展开第一章', await clickRow('第一章'))
  check('第一章的子项出现', await waitFor(`[...document.querySelectorAll('.explorer-name')].some(e => (e.textContent || '').trim() === '1.1.md')`))
  await sleep(200)
  check('展开子节', await clickRow('子节'))
  check('第三层文件出现', await waitFor(`[...document.querySelectorAll('.explorer-name')].some(e => (e.textContent || '').trim() === '1.1.1.md')`))
  check(
    '展开状态已落盘',
    await waitSavedDirs(d => d.includes(dir1) && d.includes(sub)),
    JSON.stringify(await savedDirs())
  )
  {
    const names = await rowNames()
    check('没展开的第二章仍收起', !names.includes('2.1.md'), JSON.stringify(names))
  }

  // ---------- 3. 重开:按上次状态恢复 ----------

  console.log('\n【3】重新打开仓库:恢复上次展开的两层')
  await reload()
  {
    const names = await rowNames()
    check('第一章仍展开(1.1.md 在)', names.includes('1.1.md'), JSON.stringify(names))
    check('子节仍展开(1.1.1.md 在)', names.includes('1.1.1.md'), JSON.stringify(names))
    check('没展开过的第二章仍收起', !names.includes('2.1.md'), JSON.stringify(names))
  }

  // ---------- 4. 收起后重开:恢复成收起 ----------

  console.log('\n【4】收起第一章后重开:不会再自己展开')
  check('收起第一章', await clickRow('第一章'))
  check('子项消失', await waitFor(`![...document.querySelectorAll('.explorer-name')].some(e => (e.textContent || '').trim() === '1.1.md')`))
  // 收起父目录不会动子目录的记录:它们仍是「展开」的,只是父目录收起后不显示。
  // 重开后的可见状态是收起,这就够了。
  check('收起状态已落盘', await waitSavedDirs(d => !d.includes(dir1)), JSON.stringify(await savedDirs()))
  await reload()
  {
    const names = await rowNames()
    check(
      '重开后仍是收起状态,只列第一层',
      names.includes('第一章') && !names.includes('1.1.md') && !names.includes('1.1.1.md'),
      JSON.stringify(names)
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
