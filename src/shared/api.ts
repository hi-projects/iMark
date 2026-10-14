import type { MenuCommandId } from './ipc-channels'
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
}
