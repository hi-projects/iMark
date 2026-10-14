import { reactive, watch } from 'vue'
import type { EditorView } from '@codemirror/view'
import type { Theme, VaultNode } from '@shared/types'

/** 主题枚举顺序(设置面板的选项顺序,也是循环切换顺序) */
export const THEME_ORDER: Theme[] = ['light', 'dark', 'black']

export const THEME_LABELS: Record<Theme, string> = {
  light: '亮色',
  dark: '暗色',
  black: '黑色'
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
  /** 展开的目录路径集合(刷新/重载后保留) */
  expandedDirs: Set<string>
  explorerVisible: boolean
  switcherOpen: boolean
  settingsOpen: boolean
  /** 启动时跳过仓库选择界面(来自 settings) */
  skipVaultPicker: boolean
}

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
  expandedDirs: new Set<string>(),
  explorerVisible: true,
  switcherOpen: false,
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
      window.api.setDocDirty(value)
    }
  )
  watch(
    () => [appStore.fileName, appStore.dirty, appStore.vaultName] as const,
    () => {
      window.api.setWindowTitle(appStore.fileName, appStore.dirty, appStore.vaultName)
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
  await window.api.saveSettings({ theme })
}

/** 状态栏快捷键:亮色 → 暗色 → 黑色 → 亮色 */
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
  void window.api.saveSettings({ outline: next })
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
  void window.api.saveSettings({ explorer: next })
}

/** 文档所在目录(用于解析相对路径图片),无文件路径时为 null */
export function getDocDir(): string | null {
  if (!appStore.filePath) return null
  const stripped = appStore.filePath.replace(/[\\/][^\\/]*$/, '')
  return stripped || null
}
