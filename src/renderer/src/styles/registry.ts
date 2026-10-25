/**
 * 扩展样式注册表。
 *
 * 内置样式由 `styles/index.ts` 静态导入(Vite 在构建时就打进产物);
 * 扩展样式走这里**运行时注入** —— 扩展不需要知道宿主用了哪些 CSS 文件、
 * 也不依赖具体文件路径,只把自己的一段 CSS 交给注册表即可。
 *
 * ## 样式约定(扩展请遵守)
 *
 * - 类名统一加 `imk-` 前缀,避免与内置样式(`cm-*` 来自 CodeMirror、
 *   `cm-md-*` 来自所见即所得装饰层、其余为语义化类名)冲突;
 * - 颜色 / 边框 / 间距一律使用 `tokens.css` 里的 CSS 变量
 *   (`--bg-app` `--bg-editor` `--bg-toolbar` `--bg-toolbar-btn-hover`
 *   `--bg-active` `--bg-selection` `--text-primary` `--text-secondary`
 *   `--border` `--accent` `--shadow` `--font-editor` `--font-text`
 *   `--font-mono`),
 *   这样亮色 / 深色两档主题自动适配;
 * - 需要覆盖 CodeMirror base theme 已定义的属性(`.cm-cursor` `.cm-scroller` 等)时,
 *   必须走 `EditorView.theme`(外部 CSS 会因特异度不足被静默忽略),
 *   见 `editor/setup.ts` 的 `editorTheme`。
 *
 * ## 用法(扩展模块内)
 *
 * ```ts
 * import css from './my-plugin.css?inline'          // Vite 的 ?inline:读成字符串,不自动注入
 * import { registerStyle, unregisterStyle } from '@renderer/styles'
 *
 * export function activate(): void { registerStyle('my-plugin', css) }
 * export function deactivate(): void { unregisterStyle('my-plugin') }
 * ```
 */

const STYLE_ATTR = 'data-imarkdown-style'

/** id → 已注入的 <style> 元素 */
const injected = new Map<string, HTMLStyleElement>()

/** 注册(或更新)一段扩展样式。同一个 id 重复注册会替换原内容,不会重复插入。 */
export function registerStyle(id: string, css: string): void {
  let el = injected.get(id)
  if (!el) {
    el = document.createElement('style')
    el.setAttribute(STYLE_ATTR, id)
    document.head.appendChild(el)
    injected.set(id, el)
  }
  el.textContent = css
}

/** 卸载扩展样式(扩展禁用/卸载时调用)。未注册过的 id 静默忽略。 */
export function unregisterStyle(id: string): void {
  const el = injected.get(id)
  if (!el) return
  el.remove()
  injected.delete(id)
}

export function hasStyle(id: string): boolean {
  return injected.has(id)
}

/** 当前已注入的扩展样式 id 列表(调试用) */
export function listStyles(): string[] {
  return [...injected.keys()]
}
