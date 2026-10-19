import type { PluginConfigEntry } from './plugins'

/** light 亮色 / dark 深色(底色对齐 Obsidian Minimal,文字保持 iMark 默认) */
export type Theme = 'light' | 'dark'

/**
 * 「设为默认 Markdown 编辑器」的当前状态(设置 → 系统)。
 *
 * 刻意不是单个 boolean:Windows 8 起,应用**不能**把自己的关联静默设成默认
 * (UserChoice 有哈希保护,写不进去)。所以这里要分别回答三件事 ——
 * 这个平台能不能由应用代劳、现在默认的是谁、iMark 是不是它。
 */
export interface DefaultEditorStatus {
  /** 当前平台是否支持由应用发起注册(目前只有 Windows 做了实现) */
  supported: boolean
  /** iMark 是否已经是 .md 的默认打开程序 */
  isDefault: boolean
  /** 当前 .md 的默认程序(ProgID 或 `Applications\xxx.exe`;查不到为 null) */
  current: string | null
  /** 注册 / 查询失败时的说明;成功时没有 */
  error?: string
}

/**
 * 自动保存方式(与 VS Code 的 `files.autoSave` 对齐):
 * - `off`:只能手动保存;
 * - `afterDelay`:停止输入一段时间后写盘(延迟可短到 1 秒);
 * - `onFocusChange`:编辑器失去焦点时写盘;
 * - `onWindowChange`:切换到其他窗口时写盘。
 */
export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange'

export interface Settings {
  theme: Theme
  /** 侧栏大纲是否可见 */
  outline: boolean
  /** 文件浏览器是否可见 */
  explorer: boolean
  /** 文件浏览器宽度(px):拖动分界线时写入 */
  explorerWidth: number
  /** 大纲侧栏宽度(px):拖动分界线时写入 */
  outlineWidth: number
  /** 当前仓库根目录(未打开为 null) */
  vaultPath: string | null
  /** 上次激活的仓库内文件(启动时恢复会话用;未命名文档为 null) */
  lastFile: string | null
  /**
   * 上次会话开着的仓库内文件,顺序即标签页顺序(不含无法跨启动恢复的未命名文档)。
   *
   * 与 lastFile 并存而不是替代它:lastFile 是「当前页」,决定启动后激活哪个标签;
   * 这个数组是「还有哪些页开着」。旧设置里没有这个字段时按空数组处理,
   * 恢复逻辑会退回到只有 lastFile 的单标签行为。
   */
  openFiles: string[]
  /** 自动保存方式(设置面板「编辑器」页) */
  autoSaveMode: AutoSaveMode
  /**
   * `afterDelay` 模式下,停止输入多久后写盘(秒)。
   *
   * 只对**已经落过盘**的文件生效 —— 未命名文档不会自动弹「另存为」,
   * 那会打断正在打字的人。
   */
  autoSaveDelay: number
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
   * 密钥(token 等)不在这里,单独加密存于数据根下的 secrets.json(即 ~/.imark/secrets.json)。
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
