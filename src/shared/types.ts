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
  /**
   * 插件市场的服务地址。默认指向本机的自托管服务(仓库里的 server/)。
   * 留空表示不使用市场 —— 浏览页会提示去设置里填地址,其余功能照常。
   */
  marketUrl: string
  /** 启动后自动检查插件更新(只在窗口就绪后跑一次,失败静默) */
  marketAutoCheck: boolean
  /**
   * 已经警告过「非回环地址用明文 http」的市场地址。
   * 只警告一次是因为它是个一次性的知情提示,不是每次操作都该弹的确认框。
   */
  marketWarnedPlainHttp: string[]
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
