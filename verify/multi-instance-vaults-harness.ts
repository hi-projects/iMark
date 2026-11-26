/**
 * 验收:多开时,另一个实例打开的仓库要能出现在本实例的「历史仓库」里。
 *
 * 做法:
 *   1. 数据根里只有仓库 A,应用停在仓库选择页;
 *   2. 模拟另一个实例:直接改盘上的 settings.json,把仓库 B 加到最近列表最前;
 *   3. 让窗口重新获得焦点(真实场景:关掉另一个窗口后回到本窗口);
 *   4. 断言选择页的历史仓库里出现 B,且排在最前。
 *
 * 跑法:xvfb-run -a node verify/run.mjs multi-instance-vaults
 */
import { app, dialog, protocol } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings, getSettingsSync } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { APP_VERSION } from './appVersion'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
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
  const vaultA = join(ud, 'vault-a')
  const vaultB = join(ud, 'vault-b')
  await mkdir(vaultA, { recursive: true })
  await mkdir(vaultB, { recursive: true })
  const settingsPath = join(ud, 'settings.json')
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        skipVaultPicker: false,
        vaultPath: null,
        vaults: [vaultA],
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(1200, 800)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1600)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const rows = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('.vault-picker-list .vault-row-path')].map(el => el.textContent.trim())`
    )

  const initial = await rows()
  console.log('[initial]', JSON.stringify(initial))
  check('启动时历史仓库只有 A', initial.length === 1 && initial[0] === vaultA, JSON.stringify(initial))

  // 模拟另一个实例打开仓库 B:直接改盘上的设置(它走的是同一份 settings.json)
  const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
  raw.vaults = [vaultB, vaultA]
  raw.vaultPath = vaultB
  await writeFile(settingsPath, JSON.stringify(raw, null, 2), 'utf8')
  console.log('[external] 已写入另一个实例的设置(仓库 B 置顶)')

  // 回到本窗口
  await evalJs(`(() => { window.dispatchEvent(new Event('focus')); return true })()`)
  await sleep(600)

  const after = await rows()
  console.log('[after]', JSON.stringify(after))
  check('焦点回来之后历史仓库里出现了 B', after.includes(vaultB), JSON.stringify(after))
  check('B 排在最前', after[0] === vaultB, JSON.stringify(after))

  const cache = getSettingsSync()
  check('主进程缓存也读到了最新列表', !!cache && cache.vaults[0] === vaultB, JSON.stringify(cache?.vaults))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
