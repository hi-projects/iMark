/**
 * 交给渲染半插件的编辑器 SDK。
 *
 * **关键约束(比任何文档都重要)**:插件必须用这里给的构造器构建 CM6 扩展,
 * 不要自己 bundle `@codemirror/*`。CM6 的 facet 靠**模块实例身份**匹配,
 * 两份 `@codemirror/state` 之间 facet 永远不相等 —— 结果不是报错,而是扩展
 * **静默失效**(看起来像"注册了但没效果")。
 *
 * 导出的是模块命名空间本身(不是拷贝):`editorKit.view.EditorView` 与宿主
 * 编辑器用的是同一个类。
 */
import * as commands from '@codemirror/commands'
import * as language from '@codemirror/language'
import * as state from '@codemirror/state'
import * as view from '@codemirror/view'
import { editorHolder } from '../stores/app'
import { registerPluginExtension } from './pluginExtensions'

export const editorKit = Object.freeze({ state, view, language, commands })

/** 当前 `EditorView`(仓库选择页/没有打开文档时为 null) */
export function getEditorView(): view.EditorView | null {
  return editorHolder.view
}

/**
 * 文档内容变化。用一个 `updateListener` 扩展实现 —— 它同样走注册表,
 * 停用插件时会被一并移除,不会留下幽灵回调。
 *
 * 回调包一层 try/catch:插件抛错不能打断 CM6 的 update 周期 ——
 * 一个坏处理器不该让整个编辑器卡住。
 */
export function onEditorDocChanged(pluginId: string, handler: () => void): () => void {
  return registerPluginExtension(
    pluginId,
    view.EditorView.updateListener.of(update => {
      if (!update.docChanged) return
      try {
        handler()
      } catch (err) {
        console.warn(`[plugin:${pluginId}] onDocChanged 抛错(已忽略):`, err)
      }
    })
  )
}
