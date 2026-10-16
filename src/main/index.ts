import { app, protocol } from 'electron'
import { createMainWindow, getMainWindow } from './window'
import { registerIpc } from './ipc'
import { registerImarkProtocol } from './protocol'
import { buildAppMenu } from './menu'
import { loadSettings } from './settings'
import { getPluginHost, initPluginHost } from './plugins/host'
import { devDirsFromArgv } from './plugins/dev'
import { ensureBundledProvisioned } from './market/bundled'
import { checkUpdates } from './market/updates'
import { ensureUserStylesDir, startUserStylesWatch, stopUserStylesWatch } from './userStyles'

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

// 必须在 app.ready 之前注册特权协议
// standard: true 保证 Windows 大小写敏感路径不被当作 host 小写化
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'imark',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

if (!app.requestSingleInstanceLock()) {
  // 开发期诊断:另一实例持有单实例锁时这里会静默退出(exit 0),容易被误判为"崩了"
  if (!app.isPackaged) console.warn('[iMark] 单实例锁被占用,本实例退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
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
    buildAppMenu()
    createMainWindow(settings)
    // 看门狗要等窗口出来才挂:目录一变就要广播给渲染层,没有窗口时广播是空转
    startUserStylesWatch()
    scheduleUpdateCheck(settings.marketAutoCheck)
    if (!app.isPackaged) console.log('[iMark] 应用就绪,窗口已创建')
  })

  app.on('window-all-closed', () => {
    if (!app.isPackaged) console.log('[iMark] 所有窗口已关闭 → 退出')
    app.quit()
  })

  // 退出前释放插件资源(定时器、在跑的 git 子进程)与样式目录的看门狗
  app.on('will-quit', () => {
    stopUserStylesWatch()
    void getPluginHost()?.shutdown()
  })
}
