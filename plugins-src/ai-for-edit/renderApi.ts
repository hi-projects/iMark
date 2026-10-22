/**
 * render.ts 用到的页面 API 形状。
 *
 * 这层 API 由 `webview/shim.ts` 在 iframe 内实现：对话 UI 按「同步读取当前文档、
 * 同步 dispatch」编写，shim 把这些调用翻译成 postMessage 与宿主侧
 * `TextEditor.edit`。这里只有类型，编译后不留下任何运行时代码。
 */

export type RenderLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RenderPluginHooks {
  onEnable?(): void
  onDisable?(): void
  onConfigChange?(): void
}

export interface RenderDocumentRef {
  key: string
  fileName: string
  filePath: string | null
}

/** shim 伪造的 CM6 文档：只实现 render.ts 真正读到的几个成员 */
export interface RenderDocState {
  readonly doc: { readonly length: number; toString(): string }
  readonly selection: { readonly main: { readonly head: number } }
  facet(facet: unknown): unknown
}

export interface RenderChangeSpec {
  from: number
  to?: number
  insert: string
}

export interface RenderEditorView {
  readonly state: RenderDocState
  dispatch(spec: {
    changes?: RenderChangeSpec
    selection?: { anchor: number }
    scrollIntoView?: boolean
  }): void
}

export interface ImkRenderLayerApi {
  plugin: {
    log(level: RenderLogLevel, message: string): void
    getConfig<T>(): T
    handle(hooks: RenderPluginHooks): void
    /** 关闭承载这个页面的 webview 面板 */
    close(): void
  }
  main: {
    send(channel: string, payload: unknown): Promise<void>
    onMessage(callback: (channel: string, data: unknown) => void): () => void
  }
  /** webview 总能拿到宿主渲染器 */
  markdown: { render(text: string): Promise<string> }
  editor: {
    getView(): RenderEditorView | null
    getDocumentRef(): RenderDocumentRef
    onDocChanged(callback: () => void): () => void
    kit: { view: { EditorView: { editable: unknown } } }
  }
}
