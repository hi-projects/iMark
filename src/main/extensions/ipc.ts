/**
 * 扩展系统的主进程 IPC 面。
 *
 * 这里的返回值一律是**整份扩展视图**：
 * 设置页执行一次启用/保存/写密钥之后，用同一个往返就能拿到最新状态，
 * 不需要再补一次 list。渲染层不做乐观更新 —— 视图的唯一真身在 main。
 *
 * 编辑器桥（`extension:to-main` / `extension:to-renderer`）直接转给
 * `ExtensionService.handleRendererMessage` / `postToRenderer`，不在这一层
 * 解析 DTO：协议定义在 shared/extensionProtocol.ts，多一层转发只会多一处漂移。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  ExtensionCommandResult,
  ExtensionHostSettingsPatch,
  ExtensionView
} from '@shared/extensions'
import type { RendererToMainMessage } from '@shared/extensionProtocol'
import {
  openExternalSettingFile,
  readExternalSetting,
  writeExternalSetting
} from './externalSettings'
import { extensionIconDataUrl } from './icons'
import { getExtensionService, type ExtensionService } from './service'

function service(): ExtensionService {
  const instance = getExtensionService()
  if (!instance) throw new Error('扩展系统尚未就绪')
  return instance
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function views(): Promise<ExtensionView[]> {
  return service().getExtensionViewsWithSecrets()
}

/** 渲染层的请求参数一律当成不可信：类型检查只保证形状，不保证值 */
function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} 不合法`)
  return value
}

export function registerExtensionIpc(): void {
  ipcMain.handle(IPC.ExtensionList, () => views())

  // 图标失败一律回 null:一个图标画不出来不该让设置页或列表报错
  ipcMain.handle(IPC.ExtensionIcon, (_e, id: unknown) => extensionIconDataUrl(id))

  ipcMain.handle(
    IPC.ExtensionExternalGet,
    (_e, payload: { id?: unknown; key?: unknown }) =>
      readExternalSetting(payload?.id, payload?.key)
  )
  ipcMain.handle(
    IPC.ExtensionExternalSet,
    (_e, payload: { id?: unknown; key?: unknown; value?: unknown }) =>
      writeExternalSetting(payload?.id, payload?.key, payload?.value)
  )
  ipcMain.handle(IPC.ExtensionExternalOpen, async (_e, payload: { id?: unknown; key?: unknown }) => {
    const id = stringArg(payload?.id, '扩展 ID')
    const key = stringArg(payload?.key, '配置键')
    await openExternalSettingFile(id, key)
  })

  ipcMain.handle(
    IPC.ExtensionSetEnabled,
    async (_e, payload: { id?: unknown; enabled?: unknown }) => {
      const id = stringArg(payload?.id, '扩展 ID')
      await service().setEnabled(id, payload.enabled === true)
      return views()
    }
  )

  ipcMain.handle(
    IPC.ExtensionSetField,
    async (_e, payload: { id?: unknown; key?: unknown; value?: unknown }) => {
      const id = stringArg(payload?.id, '扩展 ID')
      const key = stringArg(payload?.key, '配置键')
      await service().setExtensionField(id, key, payload?.value)
      return views()
    }
  )

  ipcMain.handle(
    IPC.ExtensionSetSecret,
    async (_e, payload: { id?: unknown; key?: unknown; value?: unknown }) => {
      const id = stringArg(payload?.id, '扩展 ID')
      const key = stringArg(payload?.key, '密钥名')
      const value = payload?.value
      if (value !== null && typeof value !== 'string') throw new Error('密钥值不合法')
      await service().setExtensionSecret(id, key, value)
      return views()
    }
  )

  ipcMain.handle(IPC.ExtensionReload, async (_e, id: unknown) => {
    await service().reloadExtension(stringArg(id, '扩展 ID'))
    return views()
  })

  ipcMain.handle(IPC.ExtensionReloadHost, async (_e, hostId: unknown) => {
    if (typeof hostId !== 'number' || !Number.isInteger(hostId)) throw new Error('宿主编号不合法')
    await service().reloadHost(hostId)
    return views()
  })

  ipcMain.handle(IPC.ExtensionSetHostSettings, async (_e, patch: unknown) => {
    const input = patch && typeof patch === 'object' ? (patch as ExtensionHostSettingsPatch) : {}
    await service().setHostSettings(input)
    return views()
  })

  ipcMain.handle(IPC.ExtensionUninstall, async (_e, id: unknown) => {
    await service().uninstallExtension(stringArg(id, '扩展 ID'))
    return views()
  })

  ipcMain.handle(IPC.ExtensionLogOpen, async (_e, id: unknown) => {
    const extensionId = stringArg(id, '扩展 ID')
    const path = service().getLogPath(extensionId)
    if (!path) throw new Error(`扩展 ${extensionId} 未安装`)
    // 日志文件可能还没产生过：先摸出来一个空文件，openPath 才不会返回
    // “文件不存在”让用户以为扩展出问题了
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, '', 'utf8')
    const problem = await shell.openPath(path)
    if (problem) throw new Error(`打开扩展日志失败：${problem}`)
  })

  ipcMain.handle(IPC.ExtensionContribGet, () => service().getContributions())

  ipcMain.handle(
    IPC.ExtensionCommandRun,
    async (
      _e,
      payload: { command?: unknown; args?: unknown; from?: unknown }
    ): Promise<ExtensionCommandResult> => {
      try {
        const command = stringArg(payload?.command, '命令 ID')
        const args = Array.isArray(payload?.args) ? payload.args : []
        const value = await service().executeCommand(command, args, 'code')
        return { ok: true, value }
      } catch (err) {
        return { ok: false, message: messageOf(err) }
      }
    }
  )

  // ---------- 编辑器桥 ----------
  // 渲染层的每条消息都带可辨识的 `type`；服务端会校验扩展归属与请求版本
  ipcMain.on(IPC.ExtensionToMain, (_e, message: unknown) => {
    if (!message || typeof message !== 'object') return
    try {
      service().handleRendererMessage(message as RendererToMainMessage)
    } catch (err) {
      console.error(`[iMark] 处理编辑器桥消息失败：${messageOf(err)}`)
    }
  })
}
