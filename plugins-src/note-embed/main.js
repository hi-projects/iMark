/**
 * 笔记引用面板 —— 沙箱插件样板。
 *
 * 这个文件跑在**插件自己的页面**里(不是主进程、不是 Node):
 *   - 没有 `require`、没有 `fs`、没有 `process`;
 *   - 一切能力都从 `window.imark` 上取,没用到的能力由宿主按清单注入;
 *   - 页面里的 `fetch('https://…')` 会被 CSP 直接拦掉,联网要走 `imark.net.fetch`
 *     (那一层宿主看得见、也能拒)。
 *
 * 它同时演示两件事:
 *   1. **同一个插件既可以是后台的、也可以有界面** —— 这里两者都有:状态栏常驻一个
 *      入口,点开才建窗显示。作者不必为两种形态写两套代码。
 *   2. **文档只由宿主来改** —— 面板只把文本交出去(`imark.editor.insert`),
 *      插到哪儿、怎么插由宿主决定。
 */

/** 探针:页面加载完成的标志,宿主看不见它,但它让 main.js 的"跑没跑"可查 */
window.__imarkNoteEmbedLoaded = true

window.imark.plugin.handle({
  onEnable() {
    // 状态栏与命令都在清单里声明了(`statusBar` / `actions`),宿主会自己画。
    // 这里只做"启动时要不要把窗口亮出来"这种事。
    window.imark.setState({ status: 'ok', lastMessage: '面板就绪' })
    report('面板已启用')
  },

  onDisable() {
    report('面板已停用')
  },

  /**
   * 清单里的 action、状态栏条目、命令面板条目最终都落到这里。
   * @param {string} actionId
   */
  runAction(actionId) {
    if (actionId !== 'toggle') return { ok: false, message: `未知动作:${actionId}` }
    // 窗口由插件自己决定什么时候显示 —— 这是有界面插件最自然的样子
    window.imark.window.show()
    return { ok: true, message: '面板已打开' }
  }
})

function report(message) {
  window.imark.setState({ status: 'ok', lastMessage: message })
}

// 宿主也会推事件过来(见 on('tick') / on('vault')):不需要就在页面里不订阅
window.imark.on('config', config => {
  // 配置变了(用户在设置里改了「预览字数上限」),面板会自己重读 —— 这里只是示意
  console.debug('[note-embed] 配置更新', config)
})
