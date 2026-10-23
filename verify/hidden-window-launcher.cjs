// 验收 harness 的无感启动器(Windows/macOS 开发机用;Linux 无头仍用 xvfb-run)。
//
//   electron verify/hidden-window-launcher.cjs <harness 产物.cjs> [electron 参数...]
//
// 只做一件事:窗口照常创建、显示、获得焦点并渲染(harness 的 isVisible()/focus()/
// sendInputEvent()/capturePage() 都按原样工作),但对用户不可见 —— 透明度 0、不进
// 任务栏、鼠标可穿透、置顶以免被别的窗口遮挡后合成器停摆(见 verify 记忆第 9 条)。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.on('browser-window-created', (_event, win) => {
  try {
    win.setOpacity(0)
    win.setSkipTaskbar(true)
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true)
  } catch {
    // 个别窗口/平台不支持某项,忽略即可 —— 它只影响可见性,不影响断言。
  }
})

const entry = process.argv[2]
if (!entry) {
  console.error('用法:electron verify/hidden-window-launcher.cjs <harness 产物.cjs>')
  process.exit(2)
}
require(path.resolve(entry))
