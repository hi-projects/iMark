import { createApp } from 'vue'
import App from './App.vue'
// 全部样式由样式模块统一装配(层叠顺序、主题变量、插件样式注册表都在 ./styles)
import './styles'
import { initPluginService } from './services/pluginService'

createApp(App).mount('#app')

// 插件服务订阅(主进程状态广播 + 「先保存再同步」握手),与组件生命周期无关
initPluginService()
