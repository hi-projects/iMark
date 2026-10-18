import { reactive, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import type { AutoSaveMode, Theme, VaultNode } from '@shared/types'
import { api } from '../services/api'

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
  filePath: string | null
  fileName: string
  dirty: boolean
  eol: 'LF' | 'CRLF'
  /** 最近一次保存/打开时的内容快照,脏检查用字符串全等比较 */
  savedContent: string
  words: number
  chars: number
  lines: number
  outline: OutlineItem[]
  outlineVisible: boolean
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
  /** 最近一次自动保存成功的时刻;null 表示不显示提示 */
  autoSavedAt: number | null
  /** 自动保存失败的说明(状态栏红字);成功后清掉 */
  autoSaveError: string | null
  /** 展开的目录路径集合(刷新/重载后保留) */
  expandedDirs: Set<string>
  explorerVisible: boolean
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

/** 切换器的两种模式:搜仓库里的文件 / 搜插件命令 */
export type SwitcherMode = 'file' | 'command'

export const appStore = reactive<AppState>({
  view: 'picker',
  vaults: [],
  theme: 'light',
  filePath: null,
  fileName: '未命名',
  dirty: false,
  eol: 'LF',
  savedContent: '',
  words: 0,
  chars: 0,
  lines: 1,
  outline: [],
  outlineVisible: true,
  outlineActive: null,
  vaultPath: null,
  vaultName: null,
  vaultTree: null,
  vaultFiles: [],
  autoSaveMode: 'off',
  autoSaveDelay: 1,
  lineWrapping: true,
  editorFontSize: 16,
  autoSavedAt: null,
  autoSaveError: null,
  expandedDirs: new Set<string>(),
  explorerVisible: true,
  switcherOpen: false,
  switcherMode: 'file',
  settingsOpen: false,
  skipVaultPicker: false
})

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
  watch(
    () => appStore.dirty,
    value => {
      api.setDocDirty(value)
    }
  )
  watch(
    () => [appStore.view, appStore.fileName, appStore.dirty, appStore.vaultName] as const,
    () => {
      // 仓库选择页没有文档上下文,标题只留应用名(传 null 而不是「未命名」)
      const atPicker = appStore.view === 'picker'
      api.setWindowTitle(
        atPicker ? null : appStore.fileName,
        appStore.dirty,
        appStore.vaultName
      )
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
  // 文件名根本不变 —— 主进程却必须跟着换基准(imark:// 的允许根、插件写文件的冲突判断)
  watch(
    () => appStore.filePath,
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
  if (!appStore.filePath) return null
  const stripped = appStore.filePath.replace(/[\\/][^\\/]*$/, '')
  return stripped || null
}
