import { reactive, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import type { AutoSaveMode, Theme, VaultNode } from '@shared/types'
import type { CodeIndentSize } from '@shared/editorSettings'
import { api } from '../services/api'
import type { DocTab } from '../services/tabs'

/** 主题枚举顺序(设置面板的选项顺序,也是循环切换顺序) */
export const THEME_ORDER: Theme[] = ['light', 'dark']

export const THEME_LABELS: Record<Theme, string> = {
  light: '亮色',
  dark: '深色'
}

/** 大纲条目:标题级别 + 纯文本 + 文档位置 */
export interface OutlineItem {
  level: number
  text: string
  /** 标题在文档中的起始偏移(用于跳转与激活判定) */
  from: number
  line: number
}

/** 快速切换器用的仓库文件索引项 */
export interface VaultFileRef {
  /** 仓库内相对路径(以 \ 分隔,不含仓库前缀) */
  rel: string
  name: string
  path: string
}

/** 应用视图:picker 仓库选择界面 / editor 编辑器 */
export type AppView = 'picker' | 'editor'

interface AppState {
  view: AppView
  /** 最近打开的仓库列表(最新的在前),来自 settings */
  vaults: string[]
  theme: Theme
  /**
   * 打开的标签页(顺序即标签栏顺序)。
   * 每个标签各持有一份 EditorState(见 services/tabs.ts)。
   */
  tabs: DocTab[]
  /** 当前激活的标签 id;null = 没有打开任何文档 */
  activeTabId: string | null
  outlineVisible: boolean
  /** 大纲侧栏宽度(px),拖动分界线时更新 */
  outlineWidth: number
  /** 当前激活(视口顶部所在章节)标题的 from 值 */
  outlineActive: number | null
  vaultPath: string | null
  vaultName: string | null
  vaultTree: VaultNode | null
  vaultFiles: VaultFileRef[]
  /** 编辑器偏好(来自 settings,由 services/editorSettings 套用) */
  autoSaveMode: AutoSaveMode
  /** afterDelay 模式下的延迟(秒) */
  autoSaveDelay: number
  lineWrapping: boolean
  editorFontSize: number
  /** 代码块内 Tab 插入的空格数 */
  codeIndentSize: CodeIndentSize
  /** 最近一次自动保存成功的时刻;null 表示不显示提示 */
  autoSavedAt: number | null
  /** 自动保存失败的说明(状态栏红字);成功后清掉 */
  autoSaveError: string | null
  /** 展开的目录路径集合(刷新/重载后保留) */
  expandedDirs: Set<string>
  explorerVisible: boolean
  /** 文件浏览器宽度(px),拖动分界线时更新 */
  explorerWidth: number
  switcherOpen: boolean
  /**
   * 切换器的打开方式:「搜文件」还是「搜命令」。
   *
   * 打开的那一刻定下来,之后就由输入框里的内容说了算(以 `>` 开头 = 搜命令)——
   * 两种模式在同一个面板里,靠一个前缀切换,而不是两个长得一样、
   * 快捷键还差不多的面板(那才真的记不住)。
   */
  switcherMode: SwitcherMode
  settingsOpen: boolean
  /** 启动时跳过仓库选择界面(来自 settings) */
  skipVaultPicker: boolean
}

/** 切换器的两种模式:搜仓库里的文件 / 搜扩展命令 */
export type SwitcherMode = 'file' | 'command'

export const appStore = reactive<AppState>({
  view: 'picker',
  vaults: [],
  theme: 'light',
  tabs: [],
  activeTabId: null,
  outlineVisible: true,
  outlineWidth: 240,
  outlineActive: null,
  vaultPath: null,
  vaultName: null,
  vaultTree: null,
  vaultFiles: [],
  autoSaveMode: 'off',
  autoSaveDelay: 1,
  lineWrapping: true,
  editorFontSize: 13,
  codeIndentSize: 4,
  autoSavedAt: null,
  autoSaveError: null,
  expandedDirs: new Set<string>(),
  explorerVisible: true,
  explorerWidth: 240,
  switcherOpen: false,
  switcherMode: 'file',
  settingsOpen: false,
  skipVaultPicker: false
})

/**
 * 当前激活的标签。状态栏、窗口标题、大纲、自动保存都从这里读文档，
 * 不在 store 里另存一份镜像。
 */
export function activeTab(): DocTab | null {
  const id = appStore.activeTabId
  return id ? (appStore.tabs.find(tab => tab.id === id) ?? null) : null
}

/** 当前编辑器实例与文档变更回调(由 EditorPane 注入) */
export const editorHolder: {
  view: EditorView | null
  onDocChange: ((view: EditorView) => void) | null
} = {
  view: null,
  onDocChange: null
}

let watching = false

export function initStoreWatchers(): void {
  if (watching) return
  watching = true
  /**
   * 窗口关闭前的脏检查看的是**所有**标签,不是当前这一个:
   * 后台标签里未保存的改动同样会随窗口一起消失。
   * 顺便把名字带过去,原生提示才能说清是哪几份。
   */
  watch(
    () => appStore.tabs.map(t => `${t.dirty ? '*' : ''}${t.fileName}`).join('\n'),
    () => {
      const dirtyTabs = appStore.tabs.filter(t => t.dirty)
      api.setDocDirty(
        dirtyTabs.length > 0,
        dirtyTabs.map(t => t.fileName)
      )
    },
    { immediate: true }
  )
  watch(
    () => {
      const tab = activeTab()
      return [appStore.view, tab?.fileName ?? null, tab?.dirty ?? false, appStore.vaultName] as const
    },
    ([view, fileName, dirty, vaultName]) => {
      // 没有文档上下文时标题不该编一个「未命名」出来:
      // - 仓库选择页:连仓库名都不显示,只留应用名;
      // - 编辑器里但没打开页面:显示仓库名,告诉用户现在在哪个仓库里。
      const atPicker = view === 'picker'
      api.setWindowTitle(atPicker ? null : fileName, dirty, atPicker ? null : vaultName)
    },
    { immediate: true }
  )
  // 窗口状态跟着视图走:选择页是启动尺寸,打开仓库后最大化。
  // 不要 immediate —— 主进程建窗时已按启动时的视图定好状态,这里只管之后的切换;
  // 否则「启动即恢复上次仓库」时视图会先以 picker 触发一次,把最大化的窗口还原掉。
  watch(
    () => appStore.view,
    view => {
      api.setWindowView(view)
    }
  )
  // 文档路径单独盯:上面那个 watcher 盯的是文件名,而两个目录下的同名文件互相切换时
  // 文件名根本不变 —— 主进程却必须跟着换基准(imark:// 的允许根、扩展写文件的冲突判断)
  watch(
    () => activeTab()?.filePath ?? null,
    path => {
      api.setDocPath(path)
    },
    { immediate: true }
  )
}

export function applyTheme(theme: Theme): void {
  appStore.theme = theme
  document.documentElement.dataset.theme = theme
}

/** 由设置面板调用:立即生效并写盘 */
export async function setTheme(theme: Theme): Promise<void> {
  applyTheme(theme)
  await api.saveSettings({ theme })
}

/** 状态栏快捷键:亮色 ↔ 深色 */
export async function toggleTheme(): Promise<void> {
  const i = THEME_ORDER.indexOf(appStore.theme)
  await setTheme(THEME_ORDER[(i + 1) % THEME_ORDER.length]!)
}

export function openSettings(): void {
  appStore.settingsOpen = true
}

export function closeSettings(): void {
  appStore.settingsOpen = false
}

/** 仅初始化内存状态,不写盘(启动时读取 settings 后调用) */
export function initOutlineVisible(visible: boolean): void {
  appStore.outlineVisible = visible
}

export function toggleOutlineVisible(): void {
  const next = !appStore.outlineVisible
  appStore.outlineVisible = next
  void api.saveSettings({ outline: next })
}

export function initExplorerVisible(visible: boolean): void {
  appStore.explorerVisible = visible
}

/** 仅初始化内存状态,不写盘(启动时读取 settings 后调用) */
export function initSidebarWidths(explorerWidth: number, outlineWidth: number): void {
  appStore.explorerWidth = explorerWidth
  appStore.outlineWidth = outlineWidth
}

/** 仅初始化内存状态,不写盘(启动时读取 settings 后调用) */
export function initSkipVaultPicker(skip: boolean): void {
  appStore.skipVaultPicker = skip
}

export function toggleExplorerVisible(): void {
  const next = !appStore.explorerVisible
  appStore.explorerVisible = next
  void api.saveSettings({ explorer: next })
}

/** 文档所在目录(用于解析相对路径图片),无文件路径时为 null */
export function getDocDir(): string | null {
  const filePath = activeTab()?.filePath
  if (!filePath) return null
  const stripped = filePath.replace(/[\\/][^\\/]*$/, '')
  return stripped || null
}
