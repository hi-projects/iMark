import { app, protocol } from 'electron'
import { createMainWindow, setMainWindowClosedHandler } from './window'
import { registerIpc } from './ipc'
import { registerImarkProtocol } from './protocol'
import { buildAppMenu, setExtensionCommands, reservedAccelerators } from './menu'
import { loadSettings } from './settings'
import { initExtensions, getExtensionService, shutdownExtensions } from './extensions/service'
import { registerExtensionWebviewProtocol } from './extensions/webviewProtocol'
import { EXTENSION_WEBVIEW_SCHEME } from '@shared/extensionProtocol'
import type { ExtensionContributionsSnapshot } from '@shared/extensions'
import { checkUpdates } from './market/updates'
import { ensureBundledProvisioned } from './market/bundled'
import { ensureUserStylesDir, startUserStylesWatch, stopUserStylesWatch } from './userStyles'
import { describeDataPaths, prepareDataDirs } from './dataDir'
import { prepareTaskbarIcon } from './system'
import { fileFromArgv, setPendingOpenFile } from './openFile'
import { APP_USER_MODEL_ID, launchedForNewWindow } from './launchArgs'
import {
  claimVault,
  flushPendingFocus,
  startInstanceBroker,
  stopInstanceBroker,
  vaultContaining,
  vaultOpenInAnotherWindow
} from './vaultHandoff'
import { IPC } from '@shared/ipc-channels'
import type { ExtensionMenuGroup } from './menu'

/**
 * 启动后查一次扩展更新。
 *
 * 三条自我约束,都是为了让这件事**不打扰人**:
 *   - 延迟 8 秒:窗口刚出来时正在加载仓库、渲染首屏,别在这会儿抢网络与磁盘;
 *   - 只跑**一次**:没有任何重试、没有定时器。更新检查失败是正常状态
 *     (离线、市场没起、地址没配),下次开应用再说;
 *   - 结果只存进内存供界面读取,不弹任何东西 —— 角标是唯一的提示方式。
 */
function scheduleUpdateCheck(enabled: boolean): void {
  if (!enabled) return
  const timer = setTimeout(() => {
    void checkUpdates().catch(() => undefined)
  }, 8000)
  // 别让这个定时器把进程吊在退出前
  timer.unref()
}

/**
 * 把贡献点快照翻译成菜单分组。
 *
 * 只放**有命令**的扩展:一个只贡献了状态栏的扩展不该在菜单里凭空多出一栏。
 * `dropped` 取自快照里已经判过冲突的快捷键 —— 菜单与命令面板读同一份结论,
 * 不再各自比较一次。
 */
function menuGroupsOf(snapshot: ExtensionContributionsSnapshot): ExtensionMenuGroup[] {
  const dropped = new Set(
    snapshot.keybindings
      .filter(binding => binding.dropped)
      .map(binding => `${binding.extensionId}\u0000${binding.command}`)
  )
  const groups = new Map<string, ExtensionMenuGroup>()
  for (const command of snapshot.commands) {
    let group = groups.get(command.extensionId)
    if (!group) {
      group = {
        extensionId: command.extensionId,
        extensionName: command.extensionName,
        commands: []
      }
      groups.set(command.extensionId, group)
    }
    group.commands.push({
      command: command.command,
      title: command.title,
      ...(command.category ? { category: command.category } : {}),
      ...(command.keybinding ? { keybinding: command.keybinding } : {}),
      available: command.available,
      ...(command.keybinding && dropped.has(`${command.extensionId}\u0000${command.command}`)
        ? { dropped: true }
        : {})
    })
  }
  return [...groups.values()]
}

/** 菜单重建时被摘掉的扩展快捷键,写进该扩展自己的日志 */
function applyContributionMenu(snapshot: ExtensionContributionsSnapshot): void {
  const dropped = setExtensionCommands(menuGroupsOf(snapshot))
  const service = getExtensionService()
  for (const item of dropped) {
    service?.addLog(
      item.extensionId,
      'warn',
      `快捷键 ${item.key} 与「${item.takenBy}」冲突,已从菜单摘掉(命令 ${item.command} 仍可从命令面板执行)`
    )
  }
}

// Windows 任务栏按 AppUserModelID 分组。打包版必须与 electron-builder.yml 的 appId
// 一致,否则任务栏快捷方式与运行中的窗口会分成两组,中键「新开一个」也就对不上号;
// 开发版用带 .dev 后缀的独立 ID(原因见 launchArgs.ts 的说明)。
// (登记 RelaunchCommand 见 window.ts 的 applyTaskbarRelaunch。)
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

// 开发模式下 Electron 的 Crashpad handler 有时不会启动,Chromium 会在控制台打印
// `registration_protocol_win.cc ... CreateFile ... (0x2)`。它是崩溃上报的注册噪声,
// 不影响应用运行。开发期关掉崩溃上报,保持控制台干净;打包版保留。
if (!app.isPackaged) {
  app.commandLine.appendSwitch('disable-breakpad')
  app.commandLine.appendSwitch('disable-crash-reporter')
}

// 必须在 app.ready 之前注册特权协议
// standard: true 保证 Windows 大小写敏感路径不被当作 host 小写化
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'imark',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    // 扩展 webview 的 origin。`standard` 让 `<host>` 参与 origin 比较（每个扩展
    // 一个稳定 origin，localStorage 跨启动保留），`secure` 让它能用 fetch 与
    // crypto.subtle 之类的安全上下文 API。token 与资源根校验在协议处理器里。
    scheme: EXTENSION_WEBVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

/**
 * 数据目录:`app.getPath('userData')` / `sessionData` 指到数据根下的 `profile/`,
 * 应用自有数据(扩展、设置、密钥、窗口几何、样式)放在数据根顶层
 * (见 main/dataDir.ts:应用目录可写时是 `<应用目录>/.imark`,否则回退 `~/.imark`)。
 *
 * 位置与"同步"这两个要求都是硬的:
 *   - 必须在 `app.whenReady()` **之前**:Chromium 按这两个路径开 profile,
 *     晚了就成了"Chromium 用默认路径、应用代码用数据根";
 *   - **同步**:写成 async 会跟 Chromium 自己的初始化抢跑(它是主脚本返回后继续
 *     跑的),而这一步只是几次 mkdir 与 setPath。
 *
 * 多开也在这里定下来(见 dataDir.ts 的 claimProfile):数据根共用,但每个实例
 * 占一个独立的 Chromium profile 槽位,所以第二个实例不会跟第一个抢缓存与
 * Local Storage。只有显式 `--user-data-dir` 被占用时返回 false。
 */
if (!prepareDataDirs()) {
  // 显式指定的 profile 已被另一个实例占着。普通启动不会走到这里。
  if (!app.isPackaged) console.warn('[iMark] 指定的 profile 已被另一个实例占用,本实例退出')
  app.quit()
} else {
  if (!app.isPackaged) console.log(`[iMark] ${describeDataPaths()}`)

  app.whenReady().then(async () => {
    registerIpc()
    registerImarkProtocol()
    registerExtensionWebviewProtocol()
    // 多实例协调端点先起来:别的实例可能正要把「聚焦已有窗口」的请求发过来,
    // 而本实例下一步也可能去认领仓库
    await startInstanceBroker()
    // 样式目录要在渲染层首次读取之前备好(不存在则创建并播种示例)
    await ensureUserStylesDir()
    const settings = await loadSettings()
    const pendingFile = fileFromArgv(process.argv, app.isPackaged)

    // 启动时真正会打开哪个仓库:带文件时以**文件所属仓库**为准(渲染层也优先处理
    // 文件,不会恢复上次仓库);没带文件时才看「直接打开上次仓库」。
    // 判断顺序很重要:先问已经开着仓库的窗口(只要它的目录包含这个文件就递过去),
    // 再看 settings 里的最近仓库。只看 settings 会在「对方仓库的子目录恰好也是一个
    // 最近仓库」时错误地新开窗口,也看不到对方刚打开、设置还没落盘的仓库。
    // 文件不属于任何已知仓库时渲染层会单独打开它、不载入仓库,这里也不认领。
    let startupVault: string | null = null
    if (pendingFile) {
      startupVault =
        vaultOpenInAnotherWindow(pendingFile) ??
        vaultContaining(pendingFile, [settings.vaultPath, ...settings.vaults])
    } else if (settings.skipVaultPicker) {
      startupVault = settings.vaultPath
    }

    // 先看别的窗口是不是已经开着它。是的话把那个窗口叫到前面(文件也递过去),
    // 本实例连窗口都不建。没勾「直接打开上次仓库」且没带文件时不认领:用户可能
    // 只是要停在选择页,真正打开哪个仓库由渲染层在打开时再认领。
    // `--new-window` 是任务栏中键/Shift+点击明确要求的新窗口:不恢复、不转交。
    if (startupVault && !launchedForNewWindow) {
      const claim = await claimVault(startupVault, pendingFile)
      if (claim === 'forwarded') {
        if (!app.isPackaged) {
          console.log('[iMark] 仓库已在另一个窗口打开,已切换过去;本实例退出')
        }
        app.quit()
        return
      }
      if (claim === 'busy' && !app.isPackaged) {
        console.warn('[iMark] 仓库已被另一个窗口占用,但联系不上那个窗口,本实例不打开它')
      }
    }

    // 扩展服务要先于窗口就绪:渲染层首个 editor.ready 到达时它必须已经在听。
    const service = await initExtensions({
      reservedKeys: reservedAccelerators,
      onContributions: applyContributionMenu
    })
    // 四款官方扩展按内置包补装:开发阶段版本固定为 1.0.0,内容按 integrity 对齐,
    // 同 ID 的本地/市场副本也会被内置包替换。必须在建菜单之前:它们贡献的命令与快捷键是菜单来源。
    await ensureBundledProvisioned(service)
    // 窗口出现之前先建一次菜单:扩展贡献的快捷键是靠原生菜单加速键生效的,
    // 等窗口建完再建菜单的话,首屏那几十毫秒里按键会丢。
    buildAppMenu()
    // 双击 .md 启动时,文件在 argv 里;暂存起来,等渲染层初始化完自己来取
    // (窗口刚建好就推过去的话,渲染层的服务可能还没挂上监听)
    setPendingOpenFile(pendingFile)
    // 任务栏按钮的图标要在建窗之前备好(Windows 只认真实文件路径,见 system.ts)
    await prepareTaskbarIcon()
    const win = createMainWindow(
      settings,
      // 任务栏「新开一个」要的是仓库选择页,而不是恢复上次仓库
      launchedForNewWindow && !pendingFile ? { startAtPicker: true } : undefined
    )
    // 冷启动竞态:本实例占到仓库记录时窗口可能还没建好,另一个实例的切换请求
    // 会先存在 pendingFocus 里。等首帧就绪再聚焦/投递文件,别把窗口提前 show 出来
    win.once('ready-to-show', () => flushPendingFocus())
    service.setRendererSender(message => {
      if (!win.isDestroyed()) win.webContents.send(IPC.ExtensionToRenderer, message)
    })
    // 激活 `*` 与 `onStartupFinished` 的时机定在页面加载完成之后:
    // 扩展在 activate 里就会去要编辑器状态与文档镜像,早于渲染层初始化只能拿到空值。
    win.webContents.once('did-finish-load', () => {
      void service.startup().catch(err => {
        console.error('[iMark] 激活扩展失败:', err)
      })
    })
    // 看门狗要等窗口出来才挂:目录一变就要广播给渲染层,没有窗口时广播是空转
    startUserStylesWatch()
    scheduleUpdateCheck(settings.marketAutoCheck)
    if (!app.isPackaged) console.log('[iMark] 应用就绪,窗口已创建')
  })

  /**
   * 退出路径:**主窗口关了才退**,不是"所有窗口都关了才退"。
   *
   * webview 面板挂在主窗口的渲染层里,没有独立的 BrowserWindow;扩展宿主是
   * utilityProcess,不会阻止窗口关闭。真正的退出仍由主窗口的 closed 触发。
   */
  app.on('window-all-closed', () => {
    if (!app.isPackaged) console.log('[iMark] 所有窗口已关闭(等待主窗口的关闭流程)')
  })

  setMainWindowClosedHandler(() => {
    if (!app.isPackaged) console.log('[iMark] 主窗口已关闭 → 退出')
    app.quit()
  })

  // 退出前停掉所有扩展宿主,并把 globalState 的待写回刷盘
  app.on('will-quit', () => {
    stopUserStylesWatch()
    stopInstanceBroker()
    void shutdownExtensions()
  })
}
