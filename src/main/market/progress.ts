/**
 * 安装/下载进度广播。
 *
 * 主进程 → 渲染层的单向播报,与 PluginStatus 一样「没有任何请求对应」——
 * 装一个扩展可能耗时几秒(下载 + 校验 + 加载),用户需要看见它在动。
 */

import { IPC } from '@shared/ipc-channels'
import type { MarketProgress } from '@shared/market'
import { getMainWindow } from '../window'

export function reportProgress(progress: MarketProgress): void {
  const win = getMainWindow()
  if (!win || win.webContents.isDestroyed()) return
  win.webContents.send(IPC.MarketProgress, progress)
}
