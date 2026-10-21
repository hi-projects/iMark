/**
 * 对话 webview 的入口。
 *
 * shim 必须先于 render.ts 求值：render.ts 在模块末尾调用 `imk.plugin.handle(...)`。
 * ES 模块的 import 按书写顺序深度优先求值，所以这里的先后就是运行顺序。
 */

import './shim'
import '../render'
