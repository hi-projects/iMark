import type { MenuCommandId } from './ipc-channels'
import type {
  MarketAuthStatus,
  MarketDetail,
  MarketInstalledData,
  MarketProgress,
  MarketQuery,
  MarketSearchResult,
  MarketSource,
  MarketUpdate,
  PendingInstall,
  PublishPreview,
  PublishResult
} from './market'
import type {
  DefaultEditorStatus,
  LaunchIntent,
  ReadResult,
  SaveDialogOptions,
  Settings,
  Theme,
  VaultClaimResult,
  VaultNode
} from './types'
import type { UserStyleImportResult, UserStyleState } from './userStyles'
import type {
  ExtensionCommandInvocation,
  ExtensionCommandResult,
  ExtensionContributionsSnapshot,
  ExtensionHostSettingsPatch,
  ExtensionView
} from './extensions'
import type { MainToRendererMessage, RendererToMainMessage } from './extensionProtocol'

/** preload 暴露给渲染层、由一次性取用函数返回的接口 */
export interface WindowApi {
  openFileDialog(): Promise<string | null>
  saveFileDialog(o: SaveDialogOptions): Promise<string | null>
  readFile(path: string): Promise<ReadResult>
  writeFile(path: string, content: string): Promise<void>
  /**
   * 把剪贴板图片存到 `docPath` 旁的 `assets/` 目录,返回相对文档目录的引用路径
   * (如 `assets/image-20261019-143012-ab12cd34.png`)。文档没有路径时调用方应先提示保存。
   */
  saveImageAsset(docPath: string, mime: string, data: Uint8Array): Promise<string>
  /**
   * 回收 `docPath` 旁 `assets/` 里已经不再被正文引用的粘贴图片。
   *
   * 只在保存成功后调用。`names` 是裸文件名(如 `image-20261019-143012-ab12cd34.png`),
   * 主进程会复核命名规则、路径,并跳过仍被同目录其他笔记引用的文件。
   */
  trashImageAssets(docPath: string, names: string[]): Promise<void>
  confirmDiscard(fileName: string): Promise<'save' | 'discard' | 'cancel'>
  getSettings(): Promise<Settings>
  saveSettings(s: Partial<Settings>): Promise<Settings>
  openExternal(url: string): Promise<void>
  /** name 传 null 表示没有文档上下文(仓库选择页),标题只显示应用名 */
  setWindowTitle(name: string | null, dirty: boolean, vaultName?: string | null): void
  /** 让主进程跟着视图调窗口状态:选择页是启动尺寸,编辑器最大化 */
  setWindowView(view: 'picker' | 'editor'): void
  /**
   * 告诉主进程界面**实际**用着哪档主题。窗口右上角的系统按钮由主进程画,
   * 必须跟界面同色 —— 以渲染层为准,而不是以设置文件为准。
   */
  setWindowTheme(theme: Theme): void
  /**
   * 编辑器里有没有未保存的改动。`dirtyNames` 是这些标签页的名字,
   * 窗口关闭提示要据此告诉用户到底有几份、分别是哪几份。
   */
  setDocDirty(dirty: boolean, dirtyNames?: string[]): void
  /** 当前文档的绝对路径(没打开文件时 null)—— 主进程据此划定 imark:// 能读的范围 */
  setDocPath(path: string | null): void
  notifySaveDone(ok: boolean): void
  /** 必须在 preload 同步调用 webUtils.getPathForFile,主世界无法直接访问 */
  getPathForFile(file: File): string
  onMenuCommand(cb: (id: MenuCommandId) => void): () => void
  onSaveBeforeClose(cb: () => void): () => void
  // ---------- 系统集成 ----------
  /**
   * 取走启动参数里带的文件(双击 .md 启动时那一个)。只交付一次;没有则 null。
   * 必须等渲染层初始化完再调 —— 这也是它设计成「拉」而不是「推」的原因。
   */
  takePendingOpenFile(): Promise<string | null>
  /**
   * 本次启动的意图:任务栏中键 / Shift+点击「新开一个」时 `newWindow` 为 true,
   * 渲染层不要自动恢复上次仓库,停在仓库选择页。
   */
  getLaunchIntent(): Promise<LaunchIntent>
  /**
   * 运行中主进程递来一个文件:另一个实例打开同一个仓库时会把文件转交过来,
   * 验收工具也可以直接投放。
   */
  onOpenFile(cb: (path: string) => void): () => void
  /** 设置 → 系统:现在 .md 的默认程序是谁、iMark 是不是它 */
  defaultEditorStatus(): Promise<DefaultEditorStatus>
  /** 设置 → 系统:注册进「打开方式」并打开系统默认应用设置(最后一步只能由用户点) */
  setDefaultEditor(): Promise<DefaultEditorStatus>
  selectVaultDialog(): Promise<string | null>
  /**
   * 认领仓库:同一个仓库已经开在另一个窗口时,会把那个窗口叫到前面并返回
   * `forwarded`(filePath 给了就同时打开它);联系不上主人返回 `busy`。
   * 只有 `ok` 才可以在本窗口继续打开。
   */
  claimVault(vaultPath: string, filePath?: string | null): Promise<VaultClaimResult>
  /** 打开失败/离开仓库时退掉认领,别让其他窗口也打不开 */
  releaseVault(vaultPath: string): Promise<void>
  listVault(path: string): Promise<VaultNode>
  /**
   * 这些路径里**确认已经不是目录**的那些(保持传入顺序):路径不存在,或被同名
   * 文件占住。暂时查不了的(权限、网络超时)不算 —— 不能凭一次失败就把仓库弄丢。
   */
  missingVaults(paths: string[]): Promise<string[]>
  createFile(path: string, content?: string): Promise<void>
  createDir(path: string): Promise<void>
  renamePath(from: string, to: string): Promise<void>
  trashPath(path: string): Promise<void>
  confirmDelete(name: string, isDir: boolean): Promise<boolean>
  // ---------- 扩展 ----------
  listExtensions(): Promise<ExtensionView[]>
  /** 扩展包内图标(data: URL);没有图标或读取失败为 null */
  extensionIcon(id: string): Promise<string | null>
  /** 读扩展清单声明的外部 JSON 设置;键不存在返回空串 */
  readExtensionExternal(id: string, key: string): Promise<string>
  /** 写扩展清单声明的外部 JSON 设置;空串表示删除该键 */
  writeExtensionExternal(id: string, key: string, value: string): Promise<void>
  setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionView[]>
  /** 保存一个配置项(key 为完整配置键);保存范围由清单的 imark.scope 决定 */
  setExtensionField(id: string, key: string, value: unknown): Promise<ExtensionView[]>
  /** value 为 null 时清除该密钥;key 是完整键(`<id>:<property>[:<slot>]`) */
  setExtensionSecret(id: string, key: string, value: string | null): Promise<ExtensionView[]>
  reloadExtension(id: string): Promise<ExtensionView[]>
  reloadExtensionHost(hostId: number): Promise<ExtensionView[]>
  setExtensionHostSettings(patch: ExtensionHostSettingsPatch): Promise<ExtensionView[]>
  uninstallExtension(id: string): Promise<ExtensionView[]>
  openExtensionLog(id: string): Promise<void>
  /** 打开扩展清单声明的外部设置文件(如 ~/.claude/settings.json) */
  openExtensionExternalFile(id: string, key: string): Promise<void>
  getExtensionContributions(): Promise<ExtensionContributionsSnapshot>
  runExtensionCommand(
    command: string,
    args?: unknown[],
    from?: ExtensionCommandInvocation['from']
  ): Promise<ExtensionCommandResult>
  onExtensionMessage(cb: (message: MainToRendererMessage) => void): () => void
  onExtensionContributions(cb: (snapshot: ExtensionContributionsSnapshot) => void): () => void
  sendExtensionMessage(message: RendererToMainMessage): void
  onExtensionCommand(
    cb: (invocation: Pick<ExtensionCommandInvocation, 'command' | 'from'>) => void
  ): () => void
  // ---------- 扩展市场 ----------
  /**
   * 挑一个本地扩展包并**预览**(不安装)。用户取消返回 null。
   * 返回的令牌是一次性的:确认安装时只回传令牌,字节始终留在主进程。
   */
  pickMarketPackage(): Promise<PendingInstall | null>
  /** 挑一个扩展目录 → 打包 → 预览(不安装)。用户取消返回 null */
  packMarketDir(): Promise<PendingInstall | null>
  /** 用户点了取消:把待确认项丢掉 */
  dropMarketPending(token: string): Promise<void>
  /** 确认安装,返回最新的扩展视图列表 */
  installMarketPending(token: string): Promise<ExtensionView[]>
  /**
   * 从市场页卸载扩展。**程序文件、配置、密钥、globalState 与日志一起删除** ——
   * 扩展 id 可能被其他人重新使用,凭据不能留给下一个同名扩展。
   */
  uninstallMarketExtension(id: string): Promise<ExtensionView[]>
  /** 已安装扩展 + 哪些是应用自带的 */
  listMarketInstalled(): Promise<MarketInstalledData>
  /** 把应用自带的扩展重新装回来(离线可用) */
  restoreBundledExtensions(): Promise<ExtensionView[]>
  onMarketProgress(cb: (p: MarketProgress) => void): () => void
  /** 设置市场地址;返回规范化后的地址。空串表示不使用市场 */
  setMarketRegistry(url: string): Promise<string>
  /** 连一下某个地址的 /health,确认它是 iMark 扩展市场;失败抛中文错误 */
  testMarketRegistry(url: string): Promise<string>
  searchMarket(query: MarketQuery): Promise<MarketSearchResult>
  marketDetail(id: string): Promise<MarketDetail>
  /** 图标以 data: URL 返回;CSP 不允许渲染层直接加载 http 图片 */
  marketIcon(id: string): Promise<string | null>
  /**
   * 从市场下载某个版本并**预览**(不安装)。version 传 null 表示最新非下架版本。
   * 与本地安装一样只回令牌,字节留在主进程。
   */
  installFromMarket(id: string, version: string | null): Promise<PendingInstall>
  marketAuthStatus(): Promise<MarketAuthStatus>
  marketLogin(username: string, password: string): Promise<MarketAuthStatus>
  marketRegister(username: string, password: string): Promise<MarketAuthStatus>
  marketLogout(): Promise<MarketAuthStatus>
  /** 用户看过了「你在用明文 http」的提示,不再提 */
  acknowledgeMarketPlainHttp(): Promise<void>
  /** 挑一个目录 → 打包 → 预览(不上传)。用户取消返回 null */
  previewMarketPublish(): Promise<{ dir: string; preview: PublishPreview } | null>
  /** 重新打包该目录并上传 */
  publishToMarket(dir: string): Promise<PublishResult>
  /**
   * 检查已安装的扩展在市场上有没有新版本;离线或没配地址时返回空数组。
   * 结果在主进程缓存 10 分钟,`force` 为真时跳过缓存。
   */
  checkMarketUpdates(force?: boolean): Promise<MarketUpdate[]>
  /**
   * 读某个版本包里的文本文件 —— 装之前先看源码。
   * version 为 null 表示最新非下架版本;包里的二进制文件不会出现在结果里。
   */
  marketSource(id: string, version: string | null): Promise<MarketSource>

  // ---------- 自定义样式(~/.imark/css) ----------
  /**
   * 读样式目录里的全部候选项(单个 .css 与样式目录,都带内容)。
   * **永不 reject**:坏项在返回值里逐条标出。
   */
  listUserStyles(): Promise<UserStyleState>
  /**
   * 在文件管理器里打开样式目录(不存在则先创建)。
   * 「当前生效的是哪个」不在这里 —— 它是设置项,走 `saveSettings({ userStyle })`。
   */
  openUserStylesDir(): Promise<void>
  /** 挑一个 .css 复制进样式目录;用户取消返回 null。内容重复的不复制,只在 outcome 里报出来 */
  importUserStyle(): Promise<UserStyleImportResult | null>
  /** 挑一个文件夹,整棵复制成样式目录(之后是一个可勾选的目录项);用户取消返回 null */
  importUserStylesFromDir(): Promise<UserStyleImportResult | null>
  /** 把一个样式项(文件或目录)移到回收站;返回最新清单 */
  removeUserStyle(name: string): Promise<UserStyleState>
  /** 目录内容变化时主进程推来的整份清单(渲染层自己与已注入的做 diff) */
  onUserStylesChanged(cb: (state: UserStyleState) => void): () => void
}
