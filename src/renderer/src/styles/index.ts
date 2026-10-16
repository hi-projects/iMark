/**
 * 样式模块入口 —— 应用所有样式的唯一装配点。
 *
 * **手动导入(核心)**:`main.ts` 里只写一行 `import './styles'`,
 * 层叠顺序与主题变量都在这里统一维护,组件与服务不再直接引用 CSS 文件。
 *
 * **间接导入(插件)**:插件模块从 `@renderer/styles` 取注册表 API
 * (`registerStyle` / `unregisterStyle`),把自己的一段 CSS 交给注册表运行时注入 ——
 * 用法与样式约定见 `./registry.ts`。
 *
 * 分层(导入顺序即层叠顺序):
 *   1. 第三方样式(KaTeX,编辑器公式与导出共用)
 *   2. tokens —— 设计令牌:CSS 变量,三档主题(亮/暗/纯黑)都在这里
 *   3. base   —— 全局 reset 与基础排版
 *   4. shell  —— 应用外壳:三栏布局、侧栏(文件列表/大纲)、状态栏
 *   5. editor —— CodeMirror 外观与所见即所得样式(标题/强调/代码/公式/widget)
 *   6. components —— 独立组件:快速切换器、仓库选择界面、设置面板、行首「+」菜单、
 *                    自定义样式
 *
 * 用户自己的样式走 `registry.ts` 运行时注入(见 `userStyleService.ts`),
 * 落在 head 末尾,同特异性下赢过这里的所有层 —— 那是刻意的,它们是用户的意思。
 */

import 'katex/dist/katex.min.css'

// 令牌从 @shared 来:同一份文件还要被主进程(?raw 内联)与插件 preload(insertCSS)消费,
// 插件窗口的配色必须与应用逐字一致,各存一份迟早会漂移
import '@shared/theme/tokens.css'
import './base.css'
import './shell.css'
import './editor.css'
import './components/switcher.css'
import './components/picker.css'
import './components/settings.css'
import './components/plugins.css'
import './components/market.css'
import './components/lineMenu.css'
import './components/toast.css'
// 放最后:它要盖掉 .plugin-icon-btn:hover 的红色(hover 变红是给「删除」用的,
// 「重新读取」是中性操作)
import './components/userstyle.css'

export { registerStyle, unregisterStyle, hasStyle, listStyles } from './registry'
