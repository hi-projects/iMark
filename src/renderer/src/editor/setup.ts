import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { classHighlighter } from '@lezer/highlight'
import { wysiwyg } from './wysiwyg'
import { enterAboveTable, selectAdjacentTable, tableInputFilter } from './wysiwyg/widgets'
import { lineMenu } from './lineMenu'
import { mathPreview } from './mathPreview'
import { extensionDecorationsExtension } from './extensionDecorations'
import { editorKeymap } from './keymap'
import { mathExtension } from './math'
import { imagePaste } from './imagePaste'
import { updateActiveOutline } from './outline'

/**
 * 光标颜色等外观覆盖。
 *
 * base theme 的选择器带生成作用域类(编译成 `.ͼN .cm-xxx`,特异度 0-2-0),
 * editor.css 里的裸类(0-1-0)覆盖不到。这里的规则由 EditorView.theme 注入,
 * 挂载顺序在 base theme 之后,可以稳定压过它。
 * (`.cm-cursor` 的 `&dark` 分支只在用 EditorView.darkTheme 标记暗色主题时生效,
 * 本项目靠 CSS 变量换肤、不设该 facet,所以光标颜色必须显式写出来。)
 *
 * 布局类规则(行高、正文栏宽度、行 padding 等)不在这里,见 editor.css 的
 * 「编辑器布局覆盖」一节:它们需要热更新时立即作用到已经建好的视图。
 */
const editorTheme = EditorView.theme({
  '.cm-cursor': { borderLeft: '2px solid var(--caret-color)', marginLeft: '-1px' },
  '.cm-dropCursor': { borderLeft: '2px solid var(--caret-color)', marginLeft: '-1px' }
})

/*
 * 布局类覆盖(字号/行高、正文栏宽度、行 padding、引用缩进)不放在上面这个
 * theme 里,而是放在 styles/editor.css,用提高特异度的选择器盖掉 base theme。
 *
 * 原因:
 *   1. 行 padding 参与 drawSelection 的选区矩形计算,布局规则和别的编辑器
 *      样式待在同一份 CSS 里更好维护;
 *   2. EditorView.theme 的规则在创建视图时注入,开发模式下改了不会作用于
 *      已经建好的编辑器 —— 表现就是"改了没生效,重启才好"。放进全局 CSS
 *      后,HMR 能立刻作用到现有视图上。
 * 详见 editor.css 顶部的「编辑器布局覆盖」一节。
 */

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

/**
 * 空状态(没有打开任何文档)下编辑器应当是**只读**的:能显示、能拖放,但光标不闪、
 * 打字也不会把一片空白悄悄变成「未命名」文档。开始一份文档只能来自明确动作
 * (选中文件 / Ctrl+N / 拖入文件)。
 */
export interface EditorOptions {
  editable?: boolean
}

/**
 * 编辑器更新观察者(扩展桥订阅)。
 *
 * 放在模块级而不是 buildExtensions 的参数里:每个标签的 state 都由同一组
 * 监听器构建,而桥只有一个 —— 参数化会让"哪个 state 属于哪个标签"这件事
 * 散到每个创建点。
 */
let updateObserver: ((update: ViewUpdate) => void) | null = null

export function setEditorUpdateObserver(fn: ((update: ViewUpdate) => void) | null): void {
  updateObserver = fn
}

/** 扩展组装:换行 / 历史 / markdown(GFM+嵌套语言) / WYSIWYG / 键位 */
export function buildExtensions(
  onDocChange: (view: EditorView) => void,
  opts?: EditorOptions
): Extension[] {
  return [
    wrapCompartment.of(wrapping ? EditorView.lineWrapping : []),
    EditorView.editable.of(opts?.editable ?? true),
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
    // 扩展的文本装饰随 state 走:切换标签后装饰还在,后台标签的偏移量也跟着变化映射。
    // 扩展代码只跑在独立的宿主进程,不能往渲染层注入 CM6 扩展 —— 装饰统一走
    // 主进程的 extension bridge(见 services/editorBridge.ts / extensionDecorations.ts)。
    ...extensionDecorationsExtension,
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
      // 桥只关心「文档变了」与「选区变了」;一次事务里两者都发生也只通知一次
      if (update.docChanged || update.selectionSet) updateObserver?.(update)
    }),
    // 滚动/选区变化时跟随高亮大纲激活项
    EditorView.updateListener.of(update => {
      if (update.viewportChanged || update.docChanged || update.selectionSet) {
        updateActiveOutline(update.view)
      }
    })
  ]
}

/**
 * 新建一份文档的 EditorState。
 *
 * 标签页各自持有一份:撤销栈、选区都随 state 走,切换标签不会串历史,
 * 也不需要为每个标签建一个 EditorView(重、且插件只认当前那个视图)。
 */
export function buildDocumentState(
  content: string,
  onDocChange: (view: EditorView) => void,
  opts?: EditorOptions
): EditorState {
  return EditorState.create({ doc: content, extensions: buildExtensions(onDocChange, opts) })
}

export function createEditor(
  parent: HTMLElement,
  onDocChange: (view: EditorView) => void,
  opts?: EditorOptions
): EditorView {
  return new EditorView({
    parent,
    state: buildDocumentState('', onDocChange, opts)
  })
}

