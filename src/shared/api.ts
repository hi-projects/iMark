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
  PluginActionPayload,
  PluginActionResult,
  PluginContribInvoke,
  PluginContribsSnapshot,
  PluginNotice,
  PluginView
} from './plugins'
import type { ReadResult, SaveDialogOptions, Settings, VaultNode } from './types'
import type { UserStyleImportResult, UserStyleState } from './userStyles'

/** preload 通过 contextBridge 暴露到 window.api 的接口 */
export interface WindowApi {
  openFileDialog(): Promise<string | null>
  saveFileDialog(o: SaveDialogOptions): Promise<string | null>
  readFile(path: string): Promise<ReadResult>
  writeFile(path: string, content: string): Promise<void>
  confirmDiscard(fileName: string): Promise<'save' | 'discard' | 'cancel'>
  getSettings(): Promise<Settings>
  saveSettings(s: Partial<Settings>): Promise<Settings>
  openExternal(url: string): Promise<void>
  /** name 传 null 表示没有文档上下文(仓库选择页),标题只显示应用名 */
  setWindowTitle(name: string | null, dirty: boolean, vaultName?: string | null): void
  /** 让主进程跟着视图调窗口状态:选择页是启动尺寸,编辑器最大化 */
  setWindowView(view: 'picker' | 'editor'): void
  setDocDirty(dirty: boolean): void
  /** 当前文档的绝对路径(没打开文件时 null)—— 主进程据此划定 imark:// 能读的范围 */
  setDocPath(path: string | null): void
  notifySaveDone(ok: boolean): void
  /** 必须在 preload 同步调用 webUtils.getPathForFile,主世界无法直接访问 */
  getPathForFile(file: File): string
  onMenuCommand(cb: (id: MenuCommandId) => void): () => void
  onSaveBeforeClose(cb: () => void): () => void
  selectVaultDialog(): Promise<string | null>
  listVault(path: string): Promise<VaultNode>
  createFile(path: string, content?: string): Promise<void>
  createDir(path: string): Promise<void>
  renamePath(from: string, to: string): Promise<void>
  trashPath(path: string): Promise<void>
  confirmDelete(name: string, isDir: boolean): Promise<boolean>
  // ---------- 插件 ----------
  listPlugins(): Promise<PluginView[]>
  savePlugin(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<PluginView[]>
  /** value 为 null 时清除该密钥;返回值是最新的插件视图列表 */
  setPluginSecret(
    id: string,
    fieldKey: string,
    targetId: string | null,
    value: string | null
  ): Promise<PluginView[]>
  /** 沙箱插件:放开/收回「允许访问本机地址」(默认拒) */
  setPluginNetAccess(id: string, allow: boolean): Promise<PluginView[]>
  /** 沙箱插件:唤出它自己的窗口 */
  openPluginWindow(id: string): Promise<void>
  /**
   * targetId 只在 descriptor.targetActions 的动作上出现(对目标列表的某一行执行);
   * payload 只在行首菜单的动作上出现(对话框里填的值 + 触发那一行的快照)。
   */
  runPluginAction(
    id: string,
    action: string,
    targetId?: string,
    payload?: PluginActionPayload
  ): Promise<PluginActionResult>
  /** 主进程要求保存脏文档时的回执 */
  notifyPluginFlushed(): void
  onPluginFlushDoc(cb: () => void): () => void
  onPluginStatus(cb: (plugins: PluginView[]) => void): () => void
  /** 首次挂载时主动要一次贡献点快照(不必等下一次变更) */
  getPluginContribs(): Promise<PluginContribsSnapshot>
  /** 执行一次界面贡献点(命令面板/状态栏/右键菜单共用一条通道) */
  runPluginContrib(invoke: PluginContribInvoke): Promise<PluginActionResult>
  onPluginContribs(cb: (snapshot: PluginContribsSnapshot) => void): () => void
  onPluginNotice(cb: (notice: PluginNotice) => void): () => void
  /**
   * 插件要求往当前文档里插入内容(沙箱插件的 `editor.insert`)。
   * 位置由宿主决定(当前光标所在行的下面),插件只给文本。
   */
  onPluginEditorInsert(cb: (o: { text: string; cursorOffset?: number }) => void): () => void
  /** 某个文件被插件改了 —— 如果那正是开着的这一份,渲染层负责重新加载 */
  onFileExternalChange(cb: (filePath: string) => void): () => void
  /** 「插件」菜单(含快捷键)点了某条命令 */
  onPluginCommand(cb: (o: { pluginId: string; itemId: string }) => void): () => void
  /** 文档内容变了。**调用方负责节流** —— 每次按键都过一次 IPC 是不可接受的 */
  notifyDocChanged(o: { dirty: boolean; words: number; chars: number }): void
  setEditorPresence(present: boolean): void
  /**
   * 一份文档成功写进了磁盘(插件的 document:save 钩子靠它触发)。
   *
   * 传**刚写的那份文档的路径**:写盘期间用户可能已经切走了,
   * 让主进程拿"当前文档"去猜会张冠李戴。
   */
  notifyDocSaved(filePath: string): void

  // ---------- 插件市场 ----------
  /**
   * 挑一个本地插件包并**预览**(不安装)。用户取消返回 null。
   * 返回的令牌是一次性的:确认安装时只回传令牌,字节始终留在主进程。
   */
  pickMarketPackage(): Promise<PendingInstall | null>
  /** 挑一个插件目录 → 打包 → 预览(不安装)。用户取消返回 null */
  packMarketDir(): Promise<PendingInstall | null>
  /** 用户点了取消:把待确认项丢掉 */
  dropMarketPending(token: string): Promise<void>
  /** 确认安装,返回最新的插件视图列表 */
  installMarketPending(token: string): Promise<PluginView[]>
  /**
   * 卸载插件。**密钥一定会被删除**(见 host.uninstall 的说明),与 `removeConfig` 无关;
   * 该选项只决定插件的配置是否一起删掉。
   */
  uninstallPlugin(id: string, options: { removeConfig: boolean }): Promise<PluginView[]>
  /** 已安装插件 + 哪些是应用自带的 */
  listMarketInstalled(): Promise<MarketInstalledData>
  /** 把应用自带的兜底插件重新装回来(离线可用) */
  restoreBundledPlugins(): Promise<PluginView[]>
  onMarketProgress(cb: (p: MarketProgress) => void): () => void
  /** 设置市场地址;返回规范化后的地址。空串表示不使用市场 */
  setMarketRegistry(url: string): Promise<string>
  /** 连一下某个地址的 /health,确认它是 iMark 插件市场;失败抛中文错误 */
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
   * 检查已安装的插件在市场上有没有新版本;离线或没配地址时返回空数组。
   * 结果在主进程缓存 10 分钟,`force` 为真时跳过缓存。
   */
  checkMarketUpdates(force?: boolean): Promise<MarketUpdate[]>
  /**
   * 读某个版本包里的文本文件 —— 装之前先看源码。
   * version 为 null 表示最新非下架版本;包里的二进制文件不会出现在结果里。
   */
  marketSource(id: string, version: string | null): Promise<MarketSource>

  // ---------- 自定义样式(~/.imark/css) ----------
  /** 读样式目录里的全部 .css(含内容)。**永不 reject**:坏文件在返回值里逐条标出 */
  listUserStyles(): Promise<UserStyleState>
  /**
   * 在文件管理器里打开样式目录(不存在则先创建)。
   * 「当前生效的是哪个」不在这里 —— 它是设置项,走 `saveSettings({ userStyle })`。
   */
  openUserStylesDir(): Promise<void>
  /** 挑一个 .css 复制进样式目录;用户取消返回 null。内容重复的不复制,只在 outcome 里报出来 */
  importUserStyle(): Promise<UserStyleImportResult | null>
  /** 挑一个文件夹,把它顶层的 .css 全部复制进来;用户取消返回 null */
  importUserStylesFromDir(): Promise<UserStyleImportResult | null>
  /** 把一个样式文件移到回收站;返回最新清单 */
  removeUserStyle(name: string): Promise<UserStyleState>
  /** 目录内容变化时主进程推来的整份清单(渲染层自己与已注入的做 diff) */
  onUserStylesChanged(cb: (state: UserStyleState) => void): () => void
}
