import { app, protocol } from 'electron'
import { createMainWindow, getMainWindow, setMainWindowClosedHandler } from './window'
import { registerIpc } from './ipc'
import { registerImarkProtocol } from './protocol'
import { buildAppMenu } from './menu'
import { loadSettings } from './settings'
import { getPluginHost, initPluginHost } from './plugins/host'
import { devDirsFromArgv } from './plugins/dev'
import { ensureBundledProvisioned } from './market/bundled'
import { checkUpdates } from './market/updates'
import { ensureUserStylesDir, startUserStylesWatch, stopUserStylesWatch } from './userStyles'
import { registerPluginScheme } from './plugins/restrictedPage'
import { describeDataPaths, prepareDataDirs } from './dataDir'
import { markRendererGone } from './plugins/rendererBridge'
import { closeAllRestrictedPages } from './plugins/restrictedPage'
import { fileFromArgv, setPendingOpenFile } from './openFile'
import { IPC } from '@shared/ipc-channels'

/**
 * 启动后查一次插件更新。
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
  }
])
// 沙箱插件页面的协议(imk-plugin://)。同样必须在 ready 之前 —— Electron 只认
// 这一次注册,晚了就永远拿不到那些特权(standard / secure / 可 fetch),
// 而症状是插件界面一片空白
registerPluginScheme()

/**
 * 数据目录:`app.getPath('userData')` / `sessionData` 指到 `~/.imark/profile`,
 * 应用自有数据(插件、设置、密钥、窗口几何、样式)放在 `~/.imark` 顶层;
 * 老用户第一次跑新版时在这里做一次性搬迁(见 main/dataDir.ts)。
 *
 * 位置与"同步"这两个要求都是硬的:
 *   - 必须在 `app.whenReady()` **之前**:Chromium 按这两个路径开 profile,
 *     晚了就成了"Chromium 用旧路径、应用代码用新路径";
 *   - 必须在 `requestSingleInstanceLock()` **之前**:那把锁就绑在 userData 上,
 *     先后颠倒会让新旧版本互相看不见(同时跑两个实例写同一份 profile);
 *   - **同步**:写成 async 会跟 Chromium 自己的初始化抢跑(它是主脚本返回后继续
 *     跑的),而这一步只是几次 rename。
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
    // 样式目录要在渲染层首次读取之前备好(不存在则创建并播种示例)
    await ensureUserStylesDir()
    const settings = await loadSettings()
    // 插件宿主依赖 settings 与 safeStorage,必须在建窗之前就绪。
    // 第二个参数负责补装应用自带的兜底插件包(如「定时上传（Git）」)——
    // 老用户升级上来时,它的配置与密钥都原封不动,只是从内置变成了一个正常安装的插件。
    // 第三个是 `--plugin-dev=<目录>`:插件作者的开发模式(见 plugins/dev.ts)。
    // 它是**这一次运行**的事,不写进任何设置,所以从命令行读而不是从 settings 读。
    const devDirs = devDirsFromArgv(process.argv)
    if (devDirs.length > 0) console.log(`[iMark] 开发模式插件目录:${devDirs.join(', ')}`)
    await initPluginHost(ensureBundledProvisioned, devDirs)
    // 双击 .md 启动时,文件在 argv 里;暂存起来,等渲染层初始化完自己来取
    // (窗口刚建好就推过去的话,渲染层的服务可能还没挂上监听)
    setPendingOpenFile(fileFromArgv(process.argv, app.isPackaged))
    buildAppMenu()
    createMainWindow(settings)
    // 看门狗要等窗口出来才挂:目录一变就要广播给渲染层,没有窗口时广播是空转
    startUserStylesWatch()
    scheduleUpdateCheck(settings.marketAutoCheck)
    if (!app.isPackaged) console.log('[iMark] 应用就绪,窗口已创建')
  })

  /**
   * 退出路径:**主窗口关了才退**,不是"所有窗口都关了才退"。
   *
   * 有了沙箱插件之后,"所有窗口"里包含插件的隐藏执行器页面 —— 纯后台插件
   * (没有 ui 的那个)会一直挂着一个 `show:false` 的窗口。照旧写 `window-all-closed`
   * 的话,用户关掉主窗口,应用**不会退出**:进程留在后台,插件还在跑,
   * 而任务栏里什么都没有。这种"看着已经关了其实没关"的 bug 极难被发现,
   * 所以这里改成盯主窗口自己的 closed 事件。
   */
  app.on('window-all-closed', () => {
    // 这里不再退出,只留一句日志。真正的退出由主窗口的 closed 触发(见下)
    if (!app.isPackaged) console.log('[iMark] 所有窗口已关闭(等待主窗口的关闭流程)')
  })

  setMainWindowClosedHandler(() => {
    // 界面没了:还在等回执的那些渲染层请求永远等不到了,现在就把它们结束掉 ——
    // 不结束的话插件要等满 12 秒才拿到一句"超时",而真正的原因是窗口关了
    markRendererGone('主界面已关闭')
    if (!app.isPackaged) console.log('[iMark] 主窗口已关闭 → 退出')
    app.quit()
  })

  // 退出前释放插件资源(定时器、在跑的 git 子进程、插件窗口)与样式目录的看门狗
  app.on('will-quit', () => {
    stopUserStylesWatch()
    // **先停用、再兜底关页**:onDisable 需要受限页面还活着;
    // host 的 disable 自己会关页面。反过来先关页会让 onDisable 拿到
    // "插件的页面不在",在退出时制造一条看似严重的失败日志。
    void (async () => {
      await getPluginHost()?.shutdown()
      await closeAllRestrictedPages()
    })()
  })
}
