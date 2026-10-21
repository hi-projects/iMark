// ⚠️ 必须是**第一条 import**:它把宿主桥一次性取走(见 services/api.ts 的说明)。
// 取走之后再加载任何插件代码,`window.__imarkTakeApi()` 都只能拿到 null —— 这是
// "渲染层插件没有系统能力"的前提。ESM 的 import 按声明顺序求值,所以它排第一。
import './services/api'
import { createApp } from 'vue'
import App from './App.vue'
// 全部样式由样式模块统一装配(层叠顺序、主题变量、插件样式注册表都在 ./styles)
import './styles'
import { initExtensionService } from './services/extensionService'
import { initExtensionUiHost } from './services/extensionUiHost'
import { initEditorBridge } from './services/editorBridge'
import { initWebviews } from './services/webviews'
import { initMarketService } from './services/marketService'
import { initLineMenu } from './services/lineMenu'
import { initUserStyleService } from './services/userStyleService'
import { initNotificationCapture } from './services/notificationCapture'

// 先接管浏览器的 Notification,再挂载界面:扩展的通知也要进通知中心
initNotificationCapture()
// 编辑器桥必须在 EditorPane 挂载前就位:它要接住第一条事务与「编辑器就绪」快照
initEditorBridge()
// 扩展服务订阅(贡献点快照 + 原生菜单/快捷键触发的命令)
initExtensionService()
// 扩展的模态请求:必须在挂载前订阅,否则启动早期的 showInformationMessage 会丢
initExtensionUiHost()
// webview 面板:同样要在挂载前订阅,启动激活时创建的面板不能丢
initWebviews()
createApp(App).mount('#app')

// 行首「+」菜单:跟着贡献点快照刷新(扩展装好/停用后按钮要立刻出现或消失)
initLineMenu()
// 市场进度播报(安装/下载);没有在安装时它只是挂着,不产生任何流量
initMarketService()
// 自定义样式(~/.imark/css):目录一变就重新注入,与设置面板开没开无关
initUserStyleService()
