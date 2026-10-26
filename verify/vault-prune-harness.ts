/**
 * 验收:最近仓库列表剔除已经不存在的目录。
 *
 * 两条用户可见规则:
 *   A 文件夹被删除、改名,或原路径被同名文件占住之后,选择页不再列出它;
 *   B 仍然存在的仓库原样保留(顺序不变),而且从设置里一起清掉,下次启动不再回来。
 *
 * 还要覆盖「不只是启动那一次」:打开仓库进编辑器 → 删掉另一个仓库 → 菜单
 * 「打开仓库」回到选择页,这一眼看到的列表同样应该是清理过的。
 *
 * 窗口全程不可见(见下面的 show 替换与 run.mjs 的 IMARK_VERIFY_HIDDEN)。
 *
 * 跑法(仓库根目录,先 npm run build,改了 preload/渲染层时必须重新 build):
 *   IMARK_VERIFY_HIDDEN=1 node verify/run.mjs vault-prune
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { getSettingsSync, loadSettings, saveSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'
import { IPC } from '../src/shared/ipc-channels'

// 特权 scheme 必须在 app ready 之前注册(与 src/main/index.ts 一致)
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

/** 验收窗口一律不显示:窗口照常创建与渲染,只是不出现在屏幕上 */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs vault-prune` 跑会自动带上)')
    app.exit(2)
    return
  }

  // 默认所有窗口关掉就退出;这个验收会自己 destroy 窗口
  app.on('window-all-closed', () => {})

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const alive = join(ud, 'vault-alive')
  const second = join(ud, 'vault-second')
  const missing = join(ud, 'vault-deleted')
  const replaced = join(ud, 'vault-replaced')
  const settingsFile = join(ud, 'settings.json')

  await rm(alive, { recursive: true, force: true })
  await rm(second, { recursive: true, force: true })
  await mkdir(alive, { recursive: true })
  await mkdir(second, { recursive: true })
  // 原仓库路径被同名文件占住:选择器打开的是文件夹,它同样不该留在列表里
  await rm(replaced, { recursive: true, force: true })
  await writeFile(replaced, 'not a directory', 'utf8')

  await loadSettings()
  await saveSettings({
    skipVaultPicker: false,
    vaultPath: null,
    vaults: [missing, alive, replaced, second],
    lastFile: null,
    openFiles: [],
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false
  })

  await initExtensions({ appVersion: APP_VERSION })

  function evalJs<T>(win: BrowserWindow, code: string): Promise<T> {
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async function waitFor(win: BrowserWindow, code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(win, `(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(60)
    }
    return false
  }

  /** 主进程设置缓存;saveSettings 会同步更新它,读它不会碰磁盘上的原子写 */
  function cachedVaults(): string[] {
    return [...(getSettingsSync()?.vaults ?? [])]
  }

  async function waitVaults(expected: string[], ms = 10000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (JSON.stringify(cachedVaults()) === JSON.stringify(expected)) return true
      await sleep(30)
    }
    return false
  }

  async function readFileVaults(): Promise<string[]> {
    const s = JSON.parse(await readFile(settingsFile, 'utf8')) as { vaults?: string[] }
    return s.vaults ?? []
  }

  /**
   * 写盘是串行队列:缓存先更新,落盘稍后完成 —— 等一小会儿再**一次性**读文件。
   * 不要高频轮询 settings.json:Windows 上 rename 会因为目标文件正被读而 EPERM,
   * 那是验收自己制造出来的"保存失败"(见 main/settings.ts 的 writeFileAtomic)。
   */
  async function checkPersisted(expected: string[], label: string): Promise<void> {
    await sleep(400)
    let actual: string[] = []
    try {
      actual = await readFileVaults()
    } catch (err) {
      check(label, false, `读 settings.json 失败:${String(err)}`)
      return
    }
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`)
  }

  const rows = (win: BrowserWindow): Promise<string[]> =>
    evalJs<string[]>(
      win,
      `[...document.querySelectorAll('.vault-row')].map(el => el.getAttribute('title'))`
    )

  async function waitRows(win: BrowserWindow, expected: string[], ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if (JSON.stringify(await rows(win)) === JSON.stringify(expected)) return true
      } catch {
        /* 页面还没就绪 */
      }
      await sleep(60)
    }
    return false
  }

  const win = createMainWindow(await loadSettings())
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', details => {
    if (details.level === 'error' || details.level === 'warning') {
      console.log(`     [渲染层 ${details.level}] ${details.message}`)
    }
  })
  await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()))

  console.log('\n【A】启动停在选择页:失效的仓库不再出现在列表里')
  {
    check('启动停在仓库选择界面', await waitFor(win, `document.querySelector('.vault-picker')`))
    check(
      '列表只剩仍然存在的两个目录(顺序不变)',
      await waitRows(win, [alive, second]),
      `实际 ${JSON.stringify(await rows(win))}`
    )
    check(
      '设置里的 vaults 一并清掉(下次启动不会回来)',
      await waitVaults([alive, second]),
      `实际 ${JSON.stringify(cachedVaults())}`
    )
    await checkPersisted([alive, second], '清理结果已经落盘')
    check('被同名文件占住的旧仓库同样被清掉', !cachedVaults().includes(replaced))
  }

  console.log('\n【B】运行中删掉仓库,回到选择页时同样清理')
  {
    const opened = await evalJs<boolean>(win, `(() => {
      const row = [...document.querySelectorAll('.vault-row')].find(el => el.getAttribute('title') === ${JSON.stringify(alive)})
      if (!row) return false
      row.click()
      return true
    })()`)
    check('点开仍然存在的仓库进入编辑器', opened && (await waitFor(win, `document.querySelector('.app-shell')`)))

    // 主进程直接删掉另一个仓库(等价于用户在资源管理器里删了它)
    await rm(second, { recursive: true, force: true })

    win.webContents.send(IPC.MenuCommand, 'file:open-vault')
    check('菜单「打开仓库」回到选择界面', await waitFor(win, `document.querySelector('.vault-picker')`))
    check(
      '运行中被删掉的仓库也不再列出',
      await waitRows(win, [alive]),
      `实际 ${JSON.stringify(await rows(win))}`
    )
    check('设置同步为清理后的列表', await waitVaults([alive]))
    await checkPersisted([alive], '运行中清理的结果同样落盘')
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[vault-prune] 未捕获异常:', err)
  app.exit(1)
})
