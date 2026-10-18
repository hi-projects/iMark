import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { classHighlighter } from '@lezer/highlight'
import { wysiwyg } from './wysiwyg'
import {
  enterAboveTable,
  flushTableEdits,
  selectAdjacentTable,
  tableInputFilter
} from './wysiwyg/widgets'
import { lineMenu } from './lineMenu'
import { mathPreview } from './mathPreview'
import { pluginExtensionsCompartment } from './pluginExtensions'
import { editorKeymap } from './keymap'
import { mathExtension } from './math'
import { imagePaste } from './imagePaste'
import { updateActiveOutline } from './outline'

/**
 * 需要盖掉 CodeMirror base theme 的编辑器外观。
 *
 * base theme 的规则选择器都带生成作用域类(编译成 `.ͼN .cm-xxx`,特异度 0-2-0),
 * 而 editor.css 里直接写 `.cm-xxx`(0-1-0)一律覆盖不到:光标颜色、正文字体、
 * 内容内边距这几条都曾是静默失效的死规则(实际生效的是 base 默认值——光标写死
 * 黑色、正文强制 monospace、内边距 4px)。其中 `.cm-cursor` 的 `&dark` 分支只在用
 * EditorView.darkTheme 标记暗色主题时才生效,而本项目靠 CSS 变量换肤,不设该 facet,
 * 于是深色主题下光标完全看不见。
 *
 * EditorView.theme 的规则同样带作用域类但挂载顺序必然在 base theme 之后,是覆盖
 * 它的唯一可靠途径(`/&/` 之外的写法只能收敛到 `&` 对应元素之外的元素上)。
 * 值里可以照常引用主题变量。
 */
const editorTheme = EditorView.theme({
  '.cm-cursor': { borderLeft: '2px solid var(--caret-color)', marginLeft: '-1px' },
  '.cm-dropCursor': { borderLeft: '2px solid var(--caret-color)', marginLeft: '-1px' },
  // 字号走 CSS 变量(设置面板「编辑器」页里可调):标题、代码块都按 em 跟着缩
  '.cm-scroller': {
    fontFamily: 'var(--font-editor)',
    fontSize: 'var(--editor-font-size)',
    lineHeight: '1.7'
  },
  // 可读行宽:与 Obsidian 一样把正文收进一条居中的窄栏,两侧留白
  '.cm-content': {
    padding: '20px 0 40vh',
    maxWidth: 'var(--editor-line-width)',
    margin: '0 auto'
  },
  // position: relative 是行首「+」按钮的落点:它挂在行内(Decoration.widget),
  // 只有相对本行定位才能用绝对定位藏进左侧这段 padding 里 ——
  // 行内元素是占位的,不脱流就会把整行文字往右推
  '.cm-line': { padding: '0 28px', position: 'relative' },
  /*
   * 引用行内容相对竖线缩进 1em:竖线画在 26px 处(见 editor.css),文字从
   * 28px + 1em 开始,竖线到首个字符之间正好留出一个字符的宽度。
   * padding 必须在这里覆盖 —— editor.css 的 .cm-md-quote 特异度低于这条 .cm-line。
   */
  '.cm-md-quote': { paddingLeft: 'calc(28px + 1em)' }
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
    // 用户输入绝不能落进渲染表格的隐藏源码(输入法组合也在这一层兜底)
    EditorState.transactionFilter.of(tr => tableInputFilter(tr)),
    drawSelection(),
    editorTheme,
    history(),
    // base 必须显式给 markdownLanguage:markdown() 默认 base 是 commonmarkLanguage,
    // 那样任务列表 / 删除线 / 表格这些 GFM 节点根本不会出现在语法树里
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: mathExtension }),
    syntaxHighlighting(classHighlighter),
    wysiwyg(),
    // 剪贴板图片:先于 CM 自带的 paste handler 拦下图片数据
    imagePaste(),
    // 光标进入公式后源码态旁边浮一块实时预览
    mathPreview(),
    lineMenu(),
    // 插件的编辑器扩展点(读/改由宿主代劳,这里只负责把它们的标记画出来)
    // render 层自己注册的 CM6 扩展(按插件分桶,可精确移除)。
    // 每次重建 state 都要重新装一遍 —— 所以它每次都从模块级注册表现读。
    pluginExtensionsCompartment(),
    keymap.of([
      // 光标贴在表格上一行行尾 / 下一行行首时:第一次选中整表,第二次才删。
      // 必须排在默认删除之前 —— 否则第一次按键就把表格和正文间的换行删了
      { key: 'Delete', run: view => selectAdjacentTable(view, 'after') },
      { key: 'Backspace', run: view => selectAdjacentTable(view, 'before') },
      // 上一行行尾回车:自己插空行,防止表格 autoFocus 把光标带进单元格
      { key: 'Enter', run: view => enterAboveTable(view) },
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
  // 表格单元格里的最后几个字还只在 contenteditable 里:setState 会把那块 DOM 整个换掉,
  // 必须先刷回文档,否则切换文件/新建会静默吞掉正在输入的内容
  flushTableEdits()
  view.setState(EditorState.create({ doc: content, extensions: buildExtensions(onDocChange) }))
}
