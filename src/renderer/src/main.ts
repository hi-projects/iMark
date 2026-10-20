// ⚠️ 必须是**第一条 import**:它把宿主桥一次性取走(见 services/api.ts 的说明)。
// 取走之后再加载任何插件代码,`window.__imarkTakeApi()` 都只能拿到 null —— 这是
// "渲染层插件没有系统能力"的前提。ESM 的 import 按声明顺序求值,所以它排第一。
import './services/api'
import { createApp } from 'vue'
import App from './App.vue'
// 全部样式由样式模块统一装配(层叠顺序、主题变量、插件样式注册表都在 ./styles)
import './styles'
import { initPluginService } from './services/pluginService'
import { initPluginUi } from './services/pluginUi'
import { initPluginHostOps } from './services/pluginHostOps'
import { initRenderLayer } from './services/renderLayer'
import { initMarketService } from './services/marketService'
import { initLineMenu } from './services/lineMenu'
import { initDocEvents } from './services/docEvents'
import { initUserStyleService } from './services/userStyleService'
import { initNotificationCapture } from './services/notificationCapture'

// 先接管浏览器的 Notification,再挂载界面:render 层插件的通知也要进通知中心
initNotificationCapture()
createApp(App).mount('#app')

// 插件服务订阅(主进程状态广播 + 「先保存再同步」握手),与组件生命周期无关
initPluginService()
// 界面贡献点(命令 / 状态栏 / 右键菜单)+ 通知气泡
initPluginUi()
// 把「文档变了 / 编辑器开着」告诉主进程,插件的事件钩子与命令可用性靠它
initDocEvents()
// 行首「+」菜单:跟着插件列表刷新(插件装好/停用后按钮要立刻跟着出现或消失)
initLineMenu()
// render 层执行端:先把 __imkRenderLayerApi 与消息订阅装好,
// 再让 initPluginHostOps 发"界面就绪" —— 主进程收到报到后会立刻请求 render.prepare
initRenderLayer()
// render 层生命周期请求的执行端(插件请宿主做的事都落在这里)
initPluginHostOps()
// 市场进度播报(安装/下载);没有在安装时它只是挂着,不产生任何流量
initMarketService()
// 自定义样式(~/.imark/css):目录一变就重新注入,与设置面板开没开无关
initUserStyleService()
