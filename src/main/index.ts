import { app, protocol } from 'electron'
import { createMainWindow, getMainWindow } from './window'
import { registerIpc } from './ipc'
import { registerImarkProtocol } from './protocol'
import { buildAppMenu } from './menu'
import { loadSettings } from './settings'
import { getPluginHost, initPluginHost } from './plugins/host'

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
    const settings = await loadSettings()
    // 插件宿主依赖 settings 与 safeStorage,必须在建窗之前就绪
    await initPluginHost()
    buildAppMenu()
    createMainWindow(settings)
    if (!app.isPackaged) console.log('[iMark] 应用就绪,窗口已创建')
  })

  app.on('window-all-closed', () => {
    if (!app.isPackaged) console.log('[iMark] 所有窗口已关闭 → 退出')
    app.quit()
  })

  // 退出前释放插件资源(定时器、在跑的 git 子进程)
  app.on('will-quit', () => {
    void getPluginHost()?.shutdown()
  })
}
