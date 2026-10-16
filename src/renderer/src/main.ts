import { createApp } from 'vue'
import App from './App.vue'
// 全部样式由样式模块统一装配(层叠顺序、主题变量、插件样式注册表都在 ./styles)
import './styles'
import { initPluginService } from './services/pluginService'
import { initPluginUi } from './services/pluginUi'
import { initPluginHostOps } from './services/pluginHostOps'
import { initMarketService } from './services/marketService'
import { initLineMenu } from './services/lineMenu'
import { initDocEvents } from './services/docEvents'
import { initUserStyleService } from './services/userStyleService'

createApp(App).mount('#app')

// 插件服务订阅(主进程状态广播 + 「先保存再同步」握手),与组件生命周期无关
initPluginService()
// 界面贡献点(命令 / 状态栏 / 右键菜单)+ 通知气泡
initPluginUi()
// 把「文档变了 / 编辑器开着」告诉主进程,插件的事件钩子与命令可用性靠它
initDocEvents()
// 行首「+」菜单:跟着插件列表刷新(插件装好/停用后按钮要立刻跟着出现或消失)
initLineMenu()
// 编辑器扩展点与界面注入的执行端(插件请宿主做的事都落在这里)
initPluginHostOps()
// 市场进度播报(安装/下载);没有在安装时它只是挂着,不产生任何流量
initMarketService()
// 自定义样式(~/.imark/css):目录一变就重新注入,与设置面板开没开无关
initUserStyleService()
