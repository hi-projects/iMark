import { app, protocol } from 'electron'
import { createMainWindow, getMainWindow, setMainWindowClosedHandler } from './window'
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
import { fileFromArgv, setPendingOpenFile } from './openFile'
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
 *   - 必须在 `requestSingleInstanceLock()` **之前**:那把锁就绑在 userData 上,
 *     先后颠倒会让不同安装的两个实例互相看不见(同时跑两个实例写同一份 profile);
 *   - **同步**:写成 async 会跟 Chromium 自己的初始化抢跑(它是主脚本返回后继续
 *     跑的),而这一步只是几次 mkdir 与 setPath。
 */
prepareDataDirs()
if (!app.isPackaged) console.log(`[iMark] ${describeDataPaths()}`)

if (!app.requestSingleInstanceLock()) {
  // 开发期诊断:另一实例持有单实例锁时这里会静默退出(exit 0),容易被误判为"崩了"
  if (!app.isPackaged) console.warn('[iMark] 单实例锁被占用,本实例退出')
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      // 双击 .md 时 Windows 起的是**新实例**:文件在它的 argv 里。
      // 窗口已经开着,直接递过去;还在加载就暂存,等渲染层初始化完来取
      const file = fileFromArgv(argv, app.isPackaged)
      if (file) {
        if (win.webContents.isLoading()) setPendingOpenFile(file)
        else win.webContents.send(IPC.OpenFileFromSystem, file)
      }
    }
  })

  app.whenReady().then(async () => {
    registerIpc()
    registerImarkProtocol()
    registerExtensionWebviewProtocol()
    // 样式目录要在渲染层首次读取之前备好(不存在则创建并播种示例)
    await ensureUserStylesDir()
    const settings = await loadSettings()

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
    setPendingOpenFile(fileFromArgv(process.argv, app.isPackaged))
    const win = createMainWindow(settings)
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
    void shutdownExtensions()
  })
}
