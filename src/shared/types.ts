import type { PluginConfigEntry } from './plugins'

/** light 亮色 / dark 深灰 / black 纯黑(OLED) */
export type Theme = 'light' | 'dark' | 'black'

export interface Settings {
  theme: Theme
  /** 侧栏大纲是否可见 */
  outline: boolean
  /** 文件浏览器是否可见 */
  explorer: boolean
  /** 当前仓库根目录(未打开为 null) */
  vaultPath: string | null
  /** 上次打开的仓库内文件 */
  lastFile: string | null
  /** 最近打开的仓库列表(最新的在前) */
  vaults: string[]
  /** 启动时跳过仓库选择界面,直接打开上次仓库 */
  skipVaultPicker: boolean
  /**
   * 插件配置:插件 id → { 是否启用, 非密配置 }。
   * 密钥(token 等)不在这里,单独加密存于 userData/secrets.json。
   */
  plugins: Record<string, PluginConfigEntry>
}

export interface ReadResult {
  content: string
  eol: 'LF' | 'CRLF'
}

export interface SaveDialogOptions {
  defaultPath?: string
  defaultName: string
  kind: 'md' | 'html'
}

/** 仓库文件树节点 */
export interface VaultNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: VaultNode[]
}
