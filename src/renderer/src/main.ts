import { createApp } from 'vue'
import App from './App.vue'
// 全部样式由样式模块统一装配(层叠顺序、主题变量、插件样式注册表都在 ./styles)
import './styles'
import { initPluginService } from './services/pluginService'
import { initMarketService } from './services/marketService'
import { initUserStyleService } from './services/userStyleService'

createApp(App).mount('#app')

// 插件服务订阅(主进程状态广播 + 「先保存再同步」握手),与组件生命周期无关
initPluginService()
// 市场进度播报(安装/下载);没有在安装时它只是挂着,不产生任何流量
initMarketService()
// 自定义样式(~/.imark/css):目录一变就重新注入,与设置面板开没开无关
initUserStyleService()
