import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { classHighlighter } from '@lezer/highlight'
import { wysiwyg } from './wysiwyg'
import { lineMenu } from './lineMenu'
import { pluginEditorExtension } from './pluginExt'
import { editorKeymap } from './keymap'
import { mathExtension } from './math'
import { updateActiveOutline } from './outline'

/**
 * 需要盖掉 CodeMirror base theme 的编辑器外观。
 *
 * base theme 的规则选择器都带生成作用域类(编译成 `.ͼN .cm-xxx`,特异度 0-2-0),
 * 而 editor.css 里直接写 `.cm-xxx`(0-1-0)一律覆盖不到:光标颜色、正文字体、
 * 内容内边距这几条都曾是静默失效的死规则(实际生效的是 base 默认值——光标写死
 * 黑色、正文强制 monospace、内边距 4px)。其中 `.cm-cursor` 的 `&dark` 分支只在用
 * EditorView.darkTheme 标记暗色主题时才生效,而本项目靠 CSS 变量换肤,不设该 facet,
 * 于是暗色/黑色主题下光标完全看不见。
 *
 * EditorView.theme 的规则同样带作用域类但挂载顺序必然在 base theme 之后,是覆盖
 * 它的唯一可靠途径(`/&/` 之外的写法只能收敛到 `&` 对应元素之外的元素上)。
 * 值里可以照常引用主题变量。
 */
const editorTheme = EditorView.theme({
  '.cm-cursor': { borderLeft: '2px solid var(--accent)', marginLeft: '-1px' },
  '.cm-dropCursor': { borderLeft: '2px solid var(--accent)', marginLeft: '-1px' },
  // 字号走 CSS 变量(设置面板「编辑器」页里可调):标题、代码块都按 em 跟着缩
  '.cm-scroller': {
    fontFamily: 'var(--font-editor)',
    fontSize: 'var(--editor-font-size)',
    lineHeight: '1.7'
  },
  '.cm-content': { padding: '20px 0 40vh' },
  // position: relative 是行首「+」按钮的落点:它挂在行内(Decoration.widget),
  // 只有相对本行定位才能用绝对定位藏进左侧这段 padding 里 ——
  // 行内元素是占位的,不脱流就会把整行文字往右推
  '.cm-line': { padding: '0 28px', position: 'relative' }
})

/**
 * 软换行是唯一一个要能**运行时**改的扩展(设置面板里就一个开关,不该为它重建 state、
 * 丢光标和撤销栈),所以单独装进 compartment。其余扩展都随 state 重建。
 */
const wrapCompartment = new Compartment()
let wrapping = true

/** 切开关时立即改当前文档 */
export function applyWrapping(view: EditorView, on: boolean): void {
  wrapping = on
  view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) })
}

/**
 * 记住换行偏好:打开/新建文件会重建整个 state,新 state 得跟当前开关一致,
 * 否则切一次文件就悄悄弹回默认值。
 */
export function setWrappingPreference(on: boolean): void {
  wrapping = on
}

/** 扩展组装:换行 / 历史 / markdown(GFM+嵌套语言) / WYSIWYG / 键位 */
export function buildExtensions(onDocChange: (view: EditorView) => void): Extension[] {
  return [
    wrapCompartment.of(wrapping ? EditorView.lineWrapping : []),
    drawSelection(),
    editorTheme,
    history(),
    // base 必须显式给 markdownLanguage:markdown() 默认 base 是 commonmarkLanguage,
    // 那样任务列表 / 删除线 / 表格这些 GFM 节点根本不会出现在语法树里
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: mathExtension }),
    syntaxHighlighting(classHighlighter),
    wysiwyg(),
    lineMenu(),
    // 插件的编辑器扩展点(读/改由宿主代劳,这里只负责把它们的标记画出来)
    pluginEditorExtension(),
    keymap.of([
      ...editorKeymap,
      ...markdownKeymap,
      ...historyKeymap,
      ...defaultKeymap
    ]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) onDocChange(update.view)
    }),
    // 滚动/选区变化时跟随高亮大纲激活项
    EditorView.updateListener.of(update => {
      if (update.viewportChanged || update.docChanged || update.selectionSet) {
        updateActiveOutline(update.view)
      }
    })
  ]
}

export function createEditor(
  parent: HTMLElement,
  onDocChange: (view: EditorView) => void
): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions: buildExtensions(onDocChange) })
  })
}

/** 打开/新建文件时重建编辑器状态(干净的历史栈,旧文档内容不会出现在 undo 里) */
export function loadDocument(view: EditorView, content: string, onDocChange: (view: EditorView) => void): void {
  view.setState(EditorState.create({ doc: content, extensions: buildExtensions(onDocChange) }))
}
