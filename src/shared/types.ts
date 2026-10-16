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
  /** 定时保存:按固定间隔把改动写回文件(设置面板「编辑器」页) */
  autoSave: boolean
  /**
   * 定时保存间隔(秒)。只对**已经落过盘**的文件生效 ——
   * 未命名文档不会自动弹「另存为」,那会打断正在打字的人。
   */
  autoSaveInterval: number
  /** 编辑器软换行(长行折行显示) */
  lineWrapping: boolean
  /** 编辑器正文字号(px) */
  editorFontSize: number
  /** 最近打开的仓库列表(最新的在前) */
  vaults: string[]
  /** 启动时跳过仓库选择界面,直接打开上次仓库 */
  skipVaultPicker: boolean
  /**
   * 当前生效的自定义样式文件名(`~/.imark/css` 下的某一个);null = 不使用自定义样式。
   *
   * 只存名字,不存内容 —— 内容永远以磁盘上的那份为准。文件被删掉时这里不会自动清空,
   * 而是「什么都不生效」;把同名文件放回来,它就又生效了。
   */
  userStyle: string | null
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
