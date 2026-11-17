/**
 * 启动耗时分解（临时诊断用）。
 *
 * 用一份用户真实 settings 的副本 + 仓库副本，走与 main/index.ts 相同的启动顺序，
 * 打印各阶段毫秒数：app ready / settings / initExtensions / 内置包补装 / 建窗 /
 * did-finish-load / 激活扩展 / 仓库树与编辑器就绪。
 *
 *   IMARK_VERIFY_HIDDEN=1 node verify/run.mjs startup-profile
 */
import { app, BrowserWindow, dialog, protocol } from 'electron'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerExtensionWebviewProtocol } from '../src/main/extensions/webviewProtocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import { APP_VERSION } from './appVersion'

const REPO = join(__dirname, '..', '..')
const USER_DATA = join(REPO, '.imark')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function ms(value: number): string {
  return `${Math.round(value)} ms`
}

async function main(): Promise<void> {
  const t0 = performance.now()
  await app.whenReady()
  const tReady = performance.now()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const userSettings = JSON.parse(
    await readFile(join(USER_DATA, 'settings.json'), 'utf8')
  ) as Record<string, unknown> & { vaultPath?: string; vaults?: string[] }
  const vault = userSettings.vaultPath
  if (!vault) throw new Error('用户 settings 里没有 vaultPath')
  const settingsCopy = {
    ...userSettings,
    skipVaultPicker: true,
    autoSaveMode: 'off',
    vaults: [vault],
    // 不把真实项目的远端带进来，避免启动后台同步碰网络/真实仓库
    projectGit: {}
  }
  const tWrite0 = performance.now()
  await writeFile(join(ud, 'settings.json'), JSON.stringify(settingsCopy, null, 2), 'utf8')
  const tWriteDone = performance.now()

  registerIpc()
  registerImarkProtocol()
  registerExtensionWebviewProtocol()

  const tSettings0 = performance.now()
  const settings = await loadSettings()
  const tSettings = performance.now()

  const tInit0 = performance.now()
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  const tInit = performance.now()

  const tBundled0 = performance.now()
  await ensureBundledProvisioned(service)
  const tBundled = performance.now()
  const tBundled2 = performance.now()
  await ensureBundledProvisioned(service)
  const tBundledAgain = performance.now()

  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  const tWindow = performance.now()
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  const tLoaded = performance.now()

  const tStartup0 = performance.now()
  const startupDone = service.startup().then(() => performance.now())

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const waitFor = async (code: string, until = 20_000): Promise<number | null> => {
    const start = performance.now()
    const deadline = Date.now() + until
    while (Date.now() < deadline) {
      try {
        if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
          return performance.now()
        }
      } catch {
        /* 页面还在加载 */
      }
      await sleep(50)
    }
    return null
  }
  const tShell = await waitFor(`document.querySelector('.app-shell')`)
  const tTree = await waitFor(`document.querySelector('.explorer-list .explorer-name')`)
  const tEditor = await waitFor(`document.querySelector('.cm-content')`)
  const tTab = await waitFor(`document.querySelector('.tab-active .tab-title')`)
  const tStartup = await startupDone
  const waitActivated = async (id: string, until = 15_000): Promise<number | null> => {
    const start = performance.now()
    const deadline = Date.now() + until
    while (Date.now() < deadline) {
      if (service.isActivated(id)) return performance.now()
      await sleep(50)
    }
    return null
  }
  const tAgent = await waitActivated('imark.agent')
  const tGitSync = await waitActivated('imark.git-sync')

  const activated = {
    agent: service.isActivated('imark.agent'),
    gitSync: service.isActivated('imark.git-sync'),
    idraw: service.isActivated('idraw.canvas')
  }
  const timing = await evalJs<{
    nav: number
    domContentLoaded: number
    loadEvent: number
    fcp: number | null
  }>(`(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]
    return {
      nav: Math.round(performance.now()),
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      loadEvent: Math.round(nav?.loadEventEnd ?? 0),
      fcp: fcp ? Math.round(fcp.startTime) : null
    }
  })()`)

  console.log('\n启动耗时分解：')
  console.log(`  app.whenReady           ${ms(tReady - t0)}`)
  console.log(`  写 settings              ${ms(tWriteDone - tWrite0)}`)
  console.log(`  loadSettings            ${ms(tSettings - tSettings0)}`)
  console.log(`  initExtensions          ${ms(tInit - tInit0)}`)
  console.log(`  ensureBundledProvisioned${ms(tBundled - tBundled0)}`)
  console.log(`  ensureBundled（第二次）  ${ms(tBundledAgain - tBundled2)}`)
  console.log(`  createMainWindow        ${ms(tWindow - tBundled)}`)
  console.log(`  did-finish-load         ${ms(tLoaded - tWindow)}`)
  console.log(`  扩展 startup 完成        ${ms((tStartup ?? tLoaded) - tStartup0)}`)
  console.log(`  agent 激活               ${tAgent === null ? '超时' : ms(tAgent - tLoaded)}`)
  console.log(`  git-sync 激活            ${tGitSync === null ? '超时' : ms(tGitSync - tLoaded)}`)
  console.log(
    `  渲染层：shell             ${tShell === null ? '超时' : ms(tShell - tLoaded)}`
  )
  console.log(`          文件树            ${tTree === null ? '超时' : ms(tTree - tLoaded)}`)
  console.log(`          编辑器            ${tEditor === null ? '超时' : ms(tEditor - tLoaded)}`)
  console.log(`          标签标题          ${tTab === null ? '超时' : ms(tTab - tLoaded)}`)
  console.log(`  激活：${JSON.stringify(activated)}`)
  console.log(`  渲染层性能：${JSON.stringify(timing)}`)
  console.log(`  总耗时（到编辑器）      ${tEditor === null ? '超时' : ms(tEditor - t0)}`)

  await shutdownExtensions()
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(0)
}

void main().catch(err => {
  console.error('[startup-profile] 失败：', err)
  app.exit(1)
})
