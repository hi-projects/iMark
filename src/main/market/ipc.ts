/**
 * 扩展市场的 IPC 处理。
 *
 * 全部遵循项目里已有的惯例:**凡改动扩展状态的,都返回最新的 `ExtensionView[]`**,
 * 渲染层拿到就直接替换本地列表,不额外再发一次 list 请求
 * (这样「装完立刻能看到」是同一个往返里保证的,不会出现中间态)。
 *
 * 与「安装」有关的入口(本地文件 / 本地目录 / 市场下载)都只做**预览**:
 * 读包、校验、发令牌,但什么都不落盘。真正的安装发生在用户按下确认之后
 * (见 pending.ts 里对这条设计的说明)。
 *
 * 需要连网的那部分(搜索、详情、账号、发布)一律是**薄的一层**:
 * 它们只把渲染层传来的参数交给 registry.ts,再把结果交回去。业务逻辑不在这里,
 * 因为这一层的职责是「跨进程的搬运」,不是「决定怎么做」。
 */

import { dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { EXTENSION_LIMITS, extensionIdOf } from '@shared/extensionPackage'
import { IPC } from '@shared/ipc-channels'
import type { MarketInstalledData, MarketQuery, PendingInstall } from '@shared/market'
import type { ExtensionView } from '@shared/extensions'
import { getMainWindow } from '../window'
import { getExtensionService, type ExtensionService } from '../extensions/service'
import { ensureBundledProvisioned, bundledIds } from './bundled'
import { acknowledgePlainHttp, authStatus, getRegistryUrl, registryKey, setRegistryUrl } from './config'
import { safeHost } from './http'
import { assertInstallable, installFromEnvelope, previewEnvelope } from './installer'
import { packDirectory } from './pack'
import { dropPending, putPending, takePending } from './pending'
import { previewPublish, publishDirectory } from './publish'
import { fetchSource } from './source'
import { reportProgress } from './progress'
import { detail, fetchEnvelope, health, iconDataUrl, login, logout, register, search } from './registry'
import { checkUpdates, invalidateUpdates } from './updates'
import { peekIdentity } from './verify'

/** 与 index.ts 一样:扩展服务在窗口创建前初始化,这里只做兜底断言 */
function requireExtensionService(): ExtensionService {
  const service = getExtensionService()
  if (!service) throw new Error('扩展系统尚未就绪')
  return service
}

async function views(): Promise<ExtensionView[]> {
  // 市场与设置页共用同一份 extensionStore;带上密钥掩码,切到设置页时不会先看到空掩码
  return requireExtensionService().getExtensionViewsWithSecrets()
}

/** 已安装扩展的版本与 integrity 快照 —— 生成预览时用来判断「这是升级还是降级」 */
async function installedSnapshot(
  id: string
): Promise<{ version: string; integrity: string } | null> {
  const installed = (await requireExtensionService().getExtensionView(id))?.installed
  return installed ? { version: installed.version, integrity: installed.integrity } : null
}

export function registerMarketIpc(): void {
  // ---------- 从本地文件安装 ----------

  ipcMain.handle(IPC.MarketPickPackage, async (): Promise<PendingInstall | null> => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: '选择扩展包',
      properties: ['openFile'],
      filters: [
        { name: 'iMark 扩展包', extensions: ['json'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const path = picked.filePaths[0]

    // 先看大小再读:一个几百 MB 的文件不该被整个读进内存
    const info = await stat(path)
    if (info.size > EXTENSION_LIMITS.envelopeBytes) {
      throw new Error(
        `文件太大(${(info.size / 1024 / 1024).toFixed(1)} MiB),扩展包上限 ${EXTENSION_LIMITS.envelopeBytes / 1024 / 1024} MiB`
      )
    }
    const raw = await readFile(path, 'utf8')

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('这不是一个合法的 JSON 文件,扩展包应当是一份 .imkpkg.json')
    }

    const id = peekId(parsed)
    const preview = previewEnvelope(
      parsed,
      { kind: 'local-file', label: path },
      id ? await installedSnapshot(id) : null
    )
    if (!preview.ok) {
      throw new Error(`扩展包校验失败:${preview.errors.slice(0, 4).join(';')}`)
    }
    assertInstallable(parsed)
    const token = putPending({
      envelope: parsed,
      source: 'local',
      registryUrl: null,
      expectedIntegrity: null
    })
    return { token, preview: preview.value }
  })

  // ---------- 从目录打包再安装(给自己的扩展用) ----------

  ipcMain.handle(IPC.MarketPackDir, async (): Promise<PendingInstall | null> => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: '选择扩展目录（需含 package.json）',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const dir = picked.filePaths[0]

    const packed = await packDirectory(dir)
    const preview = previewEnvelope(
      packed.envelope,
      { kind: 'local-dir', label: dir },
      await installedSnapshot(extensionIdOf(packed.manifest))
    )
    if (!preview.ok) {
      // 打包出来的包理应自洽;走到这里说明打包器与校验器对不上,属于内部缺陷
      throw new Error(`打包结果未通过校验:${preview.errors.slice(0, 4).join(';')}`)
    }
    assertInstallable(packed.envelope)
    const token = putPending({
      envelope: packed.envelope,
      source: 'local',
      registryUrl: null,
      expectedIntegrity: null
    })
    return { token, preview: preview.value }
  })

  // ---------- 确认 / 取消 ----------

  ipcMain.handle(IPC.MarketDropPending, (_e, token: string) => {
    dropPending(token)
  })

  ipcMain.handle(IPC.MarketInstallPending, async (_e, token: string) => {
    const service = requireExtensionService()
    const item = takePending(token)
    if (!item) throw new Error('这次安装已过期,请重新选择扩展包')

    await installFromEnvelope(service, item.envelope, {
      source: item.source,
      registryUrl: item.registryUrl,
      expectedIntegrity: item.expectedIntegrity,
      onProgress: reportProgress
    })
    invalidateUpdates()
    return service.getExtensionViewsWithSecrets()
  })

  // ---------- 卸载 ----------

  ipcMain.handle(IPC.MarketUninstall, async (_e, id: string) => {
    // 卸载总是清掉配置、密钥、globalState 与日志:扩展 id 可能被其他人
    // 重新使用,凭据不能留给下一个同名扩展。
    await requireExtensionService().uninstallExtension(id)
    invalidateUpdates()
    return views()
  })

  // ---------- 列表 ----------

  ipcMain.handle(IPC.MarketInstalled, async (): Promise<MarketInstalledData> => {
    return { extensions: await views(), bundled: bundledIds() }
  })

  // 应用启动时已经补装过一次;这里再挂一个入口,是为了让用户在设置里
  // 「卸载了自带扩展又后悔」时能一键装回来 —— 不需要联网,也不需要重新下载。
  ipcMain.handle(IPC.MarketRestoreBundled, async () => {
    const service = requireExtensionService()
    await ensureBundledProvisioned(service)
    return service.getExtensionViews()
  })

  // ---------- 市场地址 ----------

  ipcMain.handle(IPC.MarketSetRegistry, async (_e, url: string) => {
    const registry = await setRegistryUrl(url)
    invalidateUpdates()
    return registry
  })

  ipcMain.handle(IPC.MarketTestRegistry, async (_e, url: string) => {
    const info = await health(url)
    return `连接成功:${safeHost(registryKey(url) ?? url)} 上是 iMark 市场 ${info.version}`
  })

  // ---------- 浏览 ----------

  ipcMain.handle(IPC.MarketSearch, async (_e, query: MarketQuery) => search(query))

  ipcMain.handle(IPC.MarketDetail, async (_e, id: string) => detail(id))

  // 图标失败一律回 null:一个图标加载不出来不该让整个列表变成错误状态
  ipcMain.handle(IPC.MarketIcon, async (_e, id: string) => iconDataUrl(id))

  // 源码查看:渲染层拿到的是解码后的文本,二进制文件不会出现在结果里
  ipcMain.handle(IPC.MarketSource, async (_e, id: string, version: string | null) =>
    fetchSource(id, version)
  )

  // force 只在「用户刚做过会改变结论的事」时才为真(发布完、手动点刷新)
  ipcMain.handle(IPC.MarketCheckUpdates, (_e, force?: boolean) => checkUpdates(Boolean(force)))

  // ---------- 从市场安装 ----------

  ipcMain.handle(
    IPC.MarketInstall,
    async (_e, o: { id: string; version: string | null }): Promise<PendingInstall> => {
      const registry = await getRegistryUrl()
      if (!registry) throw new Error('还没有设置扩展市场地址')

      // 版本号为空表示「最新非下架版本」;顺便把发布者也取回来 ——
      // 它是安装确认框的一部分(用户有权知道包是谁发的),而下载响应里没有它
      const info = await detail(o.id)
      const version = o.version ?? info.version

      reportProgress({
        id: o.id,
        phase: 'download',
        percent: 5,
        message: `正在下载 ${info.displayName || info.name} ${version}…`
      })
      const fetched = await fetchEnvelope(o.id, version, (received, total) => {
        reportProgress({
          id: o.id,
          phase: 'download',
          // 下载占进度条的前 35%,后面的校验/安装由 installer 接着报
          percent: total ? Math.max(5, Math.min(35, Math.round((received / total) * 35))) : 20,
          message: `正在下载 ${info.displayName || info.name} ${version}…`
        })
      })

      const preview = previewEnvelope(
        fetched.envelope,
        { kind: 'market', label: registry, publisher: info.publisher },
        await installedSnapshot(o.id)
      )
      if (!preview.ok) {
        reportProgress({
          id: o.id,
          phase: 'error',
          percent: 100,
          message: '下载到的扩展包没有通过校验',
          detail: preview.errors.slice(0, 4).join(';')
        })
        throw new Error(`扩展包校验失败:${preview.errors.slice(0, 4).join(';')}`)
      }

      assertInstallable(fetched.envelope)
      const token = putPending({
        envelope: fetched.envelope,
        source: 'market',
        registryUrl: registry,
        expectedIntegrity: fetched.integrity
      })
      return { token, preview: preview.value }
    }
  )

  // ---------- 账号 ----------

  ipcMain.handle(IPC.MarketAuthStatus, () => authStatus())
  ipcMain.handle(IPC.MarketLogin, (_e, o: { username: string; password: string }) =>
    login(o.username, o.password)
  )
  ipcMain.handle(IPC.MarketRegister, (_e, o: { username: string; password: string }) =>
    register(o.username, o.password)
  )
  ipcMain.handle(IPC.MarketLogout, () => logout())
  ipcMain.handle(IPC.MarketAckPlainHttp, async () => {
    await acknowledgePlainHttp()
  })

  // ---------- 发布 ----------

  ipcMain.handle(IPC.MarketPublishPreview, async () => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await dialog.showOpenDialog(win, {
      title: '选择要发布的扩展目录（需含 package.json）',
      properties: ['openDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    const dir = picked.filePaths[0]
    return { dir, preview: await previewPublish(dir) }
  })

  ipcMain.handle(IPC.MarketPublish, async (_e, dir: string) => {
    const result = await publishDirectory(dir)
    // 刚发布的版本会让「有没有更新」的缓存结论过期
    invalidateUpdates()
    return result
  })
}

/** 从信封里读 id(仅用于查已装版本;读不出来就让后续校验去报错) */
function peekId(raw: unknown): string | null {
  return peekIdentity(raw)?.id ?? null
}
