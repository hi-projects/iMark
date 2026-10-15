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
import type { PluginActionResult, PluginView } from './plugins'
import type { ReadResult, SaveDialogOptions, Settings, VaultNode } from './types'

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
  setWindowTitle(name: string, dirty: boolean, vaultName?: string | null): void
  setDocDirty(dirty: boolean): void
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
  /** targetId 只在 descriptor.targetActions 的动作上出现(对目标列表的某一行执行) */
  runPluginAction(id: string, action: string, targetId?: string): Promise<PluginActionResult>
  /** 主进程要求保存脏文档时的回执 */
  notifyPluginFlushed(): void
  onPluginFlushDoc(cb: () => void): () => void
  onPluginStatus(cb: (plugins: PluginView[]) => void): () => void

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
}
