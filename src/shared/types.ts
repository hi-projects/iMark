import type { ExtensionHostSettings, ExtensionPreference } from './extensions'
import type { CodeIndentSize } from './editorSettings'
import type { PluginAuthMode } from './plugins'

/** light 亮色 / dark 深色(底色对齐 Obsidian Minimal,文字保持 iMark 默认) */
export type Theme = 'light' | 'dark'

/**
 * 「设为默认 Markdown 编辑器」的当前状态(设置 → 系统)。
 *
 * 刻意不是单个 boolean:Windows 8 起,应用**不能**把自己的关联静默设成默认
 * (UserChoice 有哈希保护,写不进去)。所以这里要分别回答三件事 ——
 * 这个平台能不能由应用代劳、现在默认的是谁、iMark 是不是它。
 *
 * Linux 是另一回事:`mimeapps.list` 没有哈希保护,应用可以一条 `xdg-mime`
 * 直接改完(见 `direct`)。
 */
export interface DefaultEditorStatus {
  /** 当前平台是否支持由应用发起注册(Windows 与 Linux 已实现) */
  supported: boolean
  /** iMark 是否已经是 .md 的默认打开程序 */
  isDefault: boolean
  /** 当前 .md 的默认程序(Windows 是 ProgID、`Applications\xxx.exe`;Linux 是显示名或桌面条目 ID;查不到为 null) */
  current: string | null
  /** 注册 / 查询失败时的说明;成功时没有 */
  error?: string
  /**
   * 「设为默认」能否由应用一步做完。
   * Windows 为 false/缺省(最后一下必须用户在系统设置里点);Linux 为 true。
   */
  direct?: boolean
  /**
   * 仅 Linux:找到的 iMark 桌面条目 ID(如 `iMark.desktop`);
   * 没找到为 null —— 说明还没装成桌面应用,没有可关联的目标。其它平台没有这个字段。
   */
  desktopEntry?: string | null
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
   * 这个数组是「还有哪些页开着」。
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
  /** 编辑器正文字号(px):就是实际渲染大小,标题/代码块按 em 跟着缩放 */
  editorFontSize: number
  /**
   * 正文行间距(档,1 档 = 正文字号):同一段里行与行之间额外留出的空白(含折行)。
   * 实际行高 = 1 个字号 + 这一档。设置面板「外观 → 样式」里可调;
   * 标题有自己的行高,代码块 / 公式块也有各自的行距,都不受它影响。
   */
  lineSpace: number
  /** 代码块内部行间距(档);与正文行间距独立,「块内间距」里可调 */
  codeLineSpace: number
  /** 公式块内部行间距(档);管多行公式渲染与编辑时的源码行 */
  mathLineSpace: number
  /** 列表内部行间距(档);与正文行间距独立 */
  listLineSpace: number
  /** 引用内部行间距(档);与正文行间距独立 */
  quoteLineSpace: number
  /**
   * 字号设置的语义版本。
   *
   * 旧版 settings.json 没有这个字段,那时的值是「基准」,实际正文 = 基准 × 1.375;
   * 读到没有版本的旧文件会换算一次并写回(见 main/settings.ts)。
   */
  editorFontSizeVersion: number
  /** 代码块内按 Tab 插入的空格数(2 或 4) */
  codeIndentSize: CodeIndentSize
  /**
   * 块与块之间的间距:有序配对 `<上块>-<下块>` → 档数(1 档 = 正文字号)。
   *
   * 结构空行在渲染时完全折叠,间距由下方块首行的 padding-top 承担;没出现的
   * 配对按 1 档处理。块类型:body / heading / code / list / quote / image /
   * table / math / mermaid。
   */
  pairGaps: Record<string, number>
  /** 最近打开的仓库列表(最新的在前) */
  vaults: string[]
  /**
   * 每个仓库上次关闭时的目录展开状态:仓库根路径 → 已展开目录的绝对路径。
   *
   * 按仓库分开存,切仓库不会互相串。第一次打开的仓库没有记录,文件树默认
   * 全部收起(只列第一层)。
   */
  vaultExpandedDirs: Record<string, string[]>
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
   * 扩展配置:扩展 ID(`${publisher}.${name}`)→ { 是否启用, 非密配置 }。
   * 密钥不在这里,只以掩码形式出现在视图层;明文由主进程 safeStorage 保管。
   */
  extensions: Record<string, ExtensionPreference>
  /**
   * 项目级 Git 远端:归一化后的仓库根路径 → 远端配置(不含密钥)。
   *
   * 以前这份配置属于「远程同步」扩展的 workspace 覆盖层。克隆仓库和项目切换都
   * 已经是应用自身的能力,所以远端跟着项目走;扩展只读,不再自己声明一份。
   * 密钥不进 settings.json,见 main/projectGit.ts 与 secrets.ts。
   */
  projectGit: Record<string, ProjectGitRemoteConfig>
  /** 宿主拓扑:shared(默认,所有扩展共用一个进程)或 isolated(每扩展一进程);affinity 按扩展 ID 分组 */
  extensionHost: ExtensionHostSettings
  /**
   * 扩展市场的服务地址。默认指向本机的自托管服务(仓库里的 server/)。
   * 留空表示不使用市场 —— 浏览页会提示去设置里填地址,其余功能照常。
   */
  marketUrl: string
  /** 启动后自动检查扩展更新(只在窗口就绪后跑一次,失败静默) */
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

/** 本次启动的意图(见 main/launchArgs.ts) */
export interface LaunchIntent {
  /**
   * true = 任务栏中键 / Shift+点击「新开一个」拉起的进程。
   */
  newWindow: boolean
  /**
   * true = 本实例必须停在仓库选择页。除了上面的「新开一个」,还包括
   * 「上次仓库已经开在别的窗口」—— 本实例恢复不了它,就作为多开出来的
   * 新窗口让用户另选仓库。渲染层据此跳过「自动恢复上次仓库」。
   */
  startAtPicker: boolean
}

/**
 * 多实例下认领仓库的结果(见 main/vaultHandoff.ts):
 * - `ok`        本窗口可以打开;
 * - `forwarded` 另一个窗口已经开着它,本窗口不要再打开(渲染层打开时那个窗口
 *               会被叫到前面;启动流程只问状态时不会);
 * - `busy`      记录在,但联系不上那个窗口(端口没起来/超时),暂时不要打开。
 */
export type VaultClaimResult = 'ok' | 'forwarded' | 'busy'

/**
 * 项目级 Git 远端配置本身(不含密钥)。
 *
 * 按归一化后的仓库根路径保存在 settings.projectGit 里,由应用而非某个扩展拥有。
 */
export interface ProjectGitRemoteConfig {
  url: string
  auth: PluginAuthMode
  username: string
  /** 本地分支(必填) */
  localBranch: string
  /** 远端分支;空串 = 与本地分支同名 */
  remoteBranch: string
}

/**
 * 仓库(项目)的 Git 远端在界面上的视图。
 *
 * 数据源是 settings.projectGit 与主进程的密钥库 —— 仓库选择页、克隆流程和
 * 「远程同步」扩展读的是同一份项目配置,不会出现两处不一致。
 */
export interface VaultGitRemote {
  url: string
  auth: PluginAuthMode
  username: string
  /** 本地分支(必填) */
  localBranch: string
  /** 远端分支;空串 = 与本地分支同名 */
  remoteBranch: string
  /** 是否已经存过访问令牌 / 密码(明文永远不离开主进程) */
  hasSecret: boolean
}

/** 在选择页写回某个项目的 Git 远端 */
export interface VaultGitRemoteInput {
  url: string
  auth: PluginAuthMode
  username: string
  localBranch: string
  remoteBranch: string
  /**
   * 密钥:`undefined` = 保持已保存的;空串 = 清除;非空 = 写入新的。
   * 这样只改分支/地址时不必重新输入令牌。
   */
  secret?: string
  /**
   * 从哪个项目路径沿用已保存的密钥(设置页选择「已有远程」时)。
   * 只在 `secret === undefined` 时生效;源项目地址 / 认证方式与本次一致才复制。
   */
  reuseSecretFrom?: string
}

/** 已经配置过的项目远程:设置页「已有远程」下拉里的候选项 */
export interface KnownProjectGitRemote extends VaultGitRemote {
  /** 配置来源项目路径;选中后从这个路径沿用密钥 */
  path: string
}

/** 从远端克隆一个仓库作为项目 */
export interface CloneVaultRequest extends VaultGitRemoteInput {
  /** 克隆到哪个目录下 */
  parentDir: string
  /** 新建文件夹名(空串 = 从仓库地址推导) */
  name: string
  /** 只克隆这一条分支;空串 = 远端默认分支 */
  branch: string
}

export interface CloneVaultResult {
  /** 克隆出来的仓库根目录 */
  path: string
  /** 克隆后检出的分支名(读不到时为空串) */
  branch: string
  /** 项目级 Git 远端是否已经写入项目配置(供「远程同步」扩展读取) */
  remoteSaved: boolean
}

/** 克隆过程中从 git 输出解析出的一步进度 */
export interface CloneProgress {
  /** 阶段名(已本地化,如「接收对象」) */
  phase: string
  /** 0-100;这一阶段还没有百分比信息时为 null */
  percent: number | null
  /** 当前计数/速率,如「56/123, 1.20 MiB | 300.00 KiB/s」;没有时为空串 */
  detail: string
}
