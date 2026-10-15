/**
 * 插件市场服务:已安装列表、待确认的安装、进度与卸载。
 *
 * 与 pluginService 一样,状态放在本模块而不是 appStore —— 只有设置面板的市场页用。
 *
 * **这个模块不持有字节。** 从文件/目录/市场来的插件包始终留在主进程,
 * 渲染层拿到的只有一个一次性令牌和一份用于展示的预览(见主进程 market/pending.ts)。
 * 所以「确认框里展示的那份」与「真正装进去的那份」在物理上就是同一份字节,
 * 不存在界面被掉包的可能。
 */

import { reactive } from 'vue'
import type {
  MarketAuthStatus,
  MarketDetail,
  MarketInstalledData,
  MarketProgress,
  MarketSearchResult,
  MarketSource,
  MarketUpdate,
  PackagePreview,
  PendingInstall,
  PublishPreview,
  PublishResult
} from '@shared/market'
import { isNewerVersion } from '@shared/pluginPackage'
import { plain, pluginStore, settingsNav } from './pluginService'

export const marketStore = reactive<{
  installed: MarketInstalledData | null
  /** 已装上、且应用自带兜底副本的 id(用于区分「自带」与「自己装的」) */
  bundled: string[]
  /** 等待用户确认的安装;非 null 时确认框显示 */
  pending: PendingInstall | null
  /** 正在进行的安装/卸载进度 */
  progress: MarketProgress | null
  /** 本地操作(安装/卸载)在飞时按钮据此禁用 */
  busy: boolean
  /** 有网络往返在飞 —— 与 busy 分开,因为「正在下载」和「正在读取市场」是两件事 */
  loading: boolean
  /** 上一次操作的失败信息(显示在市场页顶部,不用 alert 打断) */
  error: string
}>({
  installed: null,
  bundled: [],
  pending: null,
  progress: null,
  busy: false,
  loading: false,
  error: ''
})

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 已安装视图同时刷两份:市场页的(含 bundled 标记)与全局插件列表的 */
function applyPlugins(list: MarketInstalledData['plugins']): void {
  pluginStore.list = list
  if (marketStore.installed) marketStore.installed.plugins = list
}

export async function refreshInstalled(): Promise<void> {
  try {
    const data = await window.api.listMarketInstalled()
    marketStore.installed = data
    marketStore.bundled = data.bundled
    pluginStore.list = data.plugins
    marketStore.error = ''
  } catch (err) {
    marketStore.error = `读取已安装插件失败:${message(err)}`
  }
}

/**
 * 挑一个本地插件包 → 预览(不安装)。
 * 用户取消返回 false(不是错误),预览准备好后确认框会自动弹出。
 */
export async function pickPackage(): Promise<boolean> {
  if (marketStore.busy) return false
  marketStore.busy = true
  try {
    const pending = await window.api.pickMarketPackage()
    if (!pending) return false
    marketStore.pending = pending
    marketStore.error = ''
    return true
  } catch (err) {
    marketStore.error = message(err)
    return false
  } finally {
    marketStore.busy = false
  }
}

/** 挑一个插件目录 → 打包 → 预览(给自己的插件用,免去手工打包) */
export async function packDirectory(): Promise<boolean> {
  if (marketStore.busy) return false
  marketStore.busy = true
  try {
    const pending = await window.api.packMarketDir()
    if (!pending) return false
    marketStore.pending = pending
    marketStore.error = ''
    return true
  } catch (err) {
    marketStore.error = message(err)
    return false
  } finally {
    marketStore.busy = false
  }
}

/** 用户在确认框里点了「安装」 */
export async function confirmInstall(): Promise<void> {
  const pending = marketStore.pending
  if (!pending) return
  marketStore.busy = true
  try {
    const list = await window.api.installMarketPending(pending.token)
    marketStore.pending = null
    applyPlugins(list)
    marketStore.error = ''
  } catch (err) {
    // 令牌可能已被消耗(主进程那边一次性),所以无论如何都关掉确认框
    marketStore.pending = null
    marketStore.error = `安装失败:${message(err)}`
  } finally {
    marketStore.busy = false
    marketStore.progress = null
  }
}

/**
 * 用户在确认框里点了「取消」。
 * 只回传令牌,主进程据此丢掉那份字节;失败也不影响界面(最坏情况是 5 分钟后自然过期)。
 */
export async function cancelInstall(): Promise<void> {
  const token = marketStore.pending?.token
  marketStore.pending = null
  if (!token) return
  try {
    await window.api.dropMarketPending(token)
  } catch {
    /* 令牌过期/已被丢掉都无所谓,静默 */
  }
}

/**
 * 卸载插件。
 *
 * 密钥**总是**被删除(理由见 host.uninstall);`removeConfig` 只决定插件的配置
 * 是否一并删掉 —— 为假时配置留着,重装回来不用重填其余字段,只需重新输入令牌。
 */
export async function uninstallPlugin(id: string, removeConfig: boolean): Promise<void> {
  if (marketStore.busy) return
  marketStore.busy = true
  try {
    applyPlugins(await window.api.uninstallPlugin(id, { removeConfig }))
    marketStore.error = ''
  } catch (err) {
    marketStore.error = `卸载失败:${message(err)}`
  } finally {
    marketStore.busy = false
  }
}

/** 把应用自带的兜底插件装回来(离线可用,不联网) */
export async function restoreBundled(): Promise<void> {
  if (marketStore.busy) return
  marketStore.busy = true
  try {
    applyPlugins(await window.api.restoreBundledPlugins())
    marketStore.error = ''
  } catch (err) {
    marketStore.error = `恢复自带插件失败:${message(err)}`
  } finally {
    marketStore.busy = false
  }
}

/** 由 main.ts 在挂载后调用;返回取消订阅函数 */
export function initMarketService(): () => void {
  const off = window.api.onMarketProgress(p => {
    marketStore.progress = p.phase === 'done' || p.phase === 'error' ? null : p
  })
  return off
}

// ======================================================================
// 联网的那一半:浏览、账号、发布
// ======================================================================

/**
 * 远程市场的界面状态。
 *
 * 与 marketStore 分开是因为它们的**生命周期不同**:那一半是本地事实(装了哪些插件),
 * 这一半是「上一次问服务端问到了什么」—— 换一个注册表地址,这里的东西整体作废。
 */
export const remoteStore = reactive<{
  auth: MarketAuthStatus | null
  result: MarketSearchResult | null
  detail: MarketDetail | null
  /** 图标按 id 缓存成 data: URL;加载不出来记 null(不重试,免得列表滚动时反复打网络) */
  icons: Record<string, string | null>
  loading: boolean
  updates: MarketUpdate[]
  /** 发布:选中的目录与打包预览 */
  publishDir: string | null
  publishPreview: PublishPreview | null
  lastPublished: PublishResult | null
  /** 源码查看器:非 null 时飘在详情页上面 */
  source: MarketSource | null
}>({
  auth: null,
  result: null,
  detail: null,
  icons: {},
  loading: false,
  updates: [],
  publishDir: null,
  publishPreview: null,
  lastPublished: null,
  source: null
})

function failRemote(err: unknown): string {
  const text = message(err)
  marketStore.error = text
  return text
}

/** 注册表地址变了:所有来自旧地址的结论都作废 */
function resetRemote(): void {
  remoteStore.result = null
  remoteStore.detail = null
  remoteStore.icons = {}
  remoteStore.updates = []
  remoteStore.publishDir = null
  remoteStore.publishPreview = null
  remoteStore.lastPublished = null
  remoteStore.source = null
}

// ---------- 地址与账号 ----------

export async function loadAuth(): Promise<void> {
  try {
    remoteStore.auth = await window.api.marketAuthStatus()
    marketStore.error = ''
  } catch (err) {
    failRemote(err)
  }
}

export async function setRegistry(url: string): Promise<boolean> {
  marketStore.loading = true
  try {
    await window.api.setMarketRegistry(url)
    resetRemote()
    remoteStore.auth = await window.api.marketAuthStatus()
    marketStore.error = ''
    return true
  } catch (err) {
    failRemote(err)
    return false
  } finally {
    marketStore.loading = false
  }
}

/** 「测试连接」:不写设置,只是试着问一句。成功返回给用户看的一句话 */
export async function testRegistry(url: string): Promise<string | null> {
  marketStore.loading = true
  try {
    const text = await window.api.testMarketRegistry(url)
    marketStore.error = ''
    return text
  } catch (err) {
    failRemote(err)
    return null
  } finally {
    marketStore.loading = false
  }
}

export async function loginMarket(username: string, password: string): Promise<boolean> {
  return withBusy(async () => {
    remoteStore.auth = await window.api.marketLogin(username, password)
    marketStore.error = ''
  })
}

export async function registerMarket(username: string, password: string): Promise<boolean> {
  return withBusy(async () => {
    remoteStore.auth = await window.api.marketRegister(username, password)
    marketStore.error = ''
  })
}

/** 关掉「明文 http」提示。只影响当前这个地址,换一个地址会重新提示 */
export async function acknowledgePlainHttp(): Promise<void> {
  try {
    await window.api.acknowledgeMarketPlainHttp()
    await loadAuth()
  } catch {
    /* 记不住也无所谓:最坏情况是下次再提示一遍 */
  }
}

export async function logoutMarket(): Promise<void> {
  await withBusy(async () => {
    remoteStore.auth = await window.api.marketLogout()
    remoteStore.publishPreview = null
    remoteStore.publishDir = null
    remoteStore.lastPublished = null
  })
}

/** 包一层「有往返在飞 + 统一错误」的外壳,省得每个动作写一遍 try/finally */
async function withBusy(fn: () => Promise<void>): Promise<boolean> {
  if (marketStore.loading) return false
  marketStore.loading = true
  try {
    await fn()
    return true
  } catch (err) {
    failRemote(err)
    return false
  } finally {
    marketStore.loading = false
  }
}

// ---------- 浏览 ----------

/**
 * 搜索。参数从 `settingsNav.market` 来(那里才是「这一屏长什么样」的唯一来源),
 * 于是切页签、返回、重开设置都能回到同一屏。
 */
export async function searchMarket(): Promise<void> {
  const nav = settingsNav.market
  await withBusy(async () => {
    remoteStore.result = await window.api.searchMarket(
      plain({ q: nav.query, page: nav.page, pageSize: 20, sort: nav.sort, kind: null })
    )
    marketStore.error = ''
  })
}

export async function openDetail(id: string): Promise<void> {
  settingsNav.market.detailId = id
  remoteStore.detail = null
  await withBusy(async () => {
    remoteStore.detail = await window.api.marketDetail(id)
    marketStore.error = ''
  })
}

export function closeDetail(): void {
  settingsNav.market.detailId = null
  remoteStore.detail = null
  remoteStore.source = null
}

/**
 * 打开源码查看器。
 *
 * 版本号是从界面传进来的:详情页上写着「安装此版本」,那用户就该能先看那一版的代码。
 * 整个过程走的是与安装**同一个**下载与校验路径,所以看到的确实是会被装进去的那份字节。
 */
export async function openSource(version: string | null): Promise<void> {
  const id = settingsNav.market.detailId
  if (!id) return
  remoteStore.source = null
  await withBusy(async () => {
    remoteStore.source = await window.api.marketSource(id, version)
    marketStore.error = ''
  })
}

export function closeSource(): void {
  remoteStore.source = null
}

/**
 * 图标只在第一次真的用到时才取,取不到就永久记成 null。
 * 一次列表滚动会触发几十个图标请求,不缓存的话每滚回去一次就要重来一轮。
 */
export async function loadIcon(id: string): Promise<string | null> {
  if (id in remoteStore.icons) return remoteStore.icons[id] as string | null
  remoteStore.icons[id] = null // 先占位:并发调用时只有一个真的发出去
  try {
    remoteStore.icons[id] = await window.api.marketIcon(id)
  } catch {
    remoteStore.icons[id] = null
  }
  return remoteStore.icons[id] as string | null
}

// ---------- 更新 ----------

export async function checkUpdates(force = false): Promise<void> {
  try {
    remoteStore.updates = await window.api.checkMarketUpdates(force)
  } catch {
    // 更新检查是**背景动作**,失败不该在界面上留下任何东西 —— 见 updates.ts
    remoteStore.updates = []
  }
}

// ---------- 从市场安装 ----------

/**
 * 下载某个版本并弹出确认框。返回 false 表示这次没成(用户在顶部看到原因)。
 * 与本地安装共用同一条确认路径:字节留在主进程,渲染层只拿到令牌与预览。
 */
export async function installFromMarket(id: string, version: string | null): Promise<boolean> {
  return withBusy(async () => {
    marketStore.pending = await window.api.installFromMarket(id, version)
    marketStore.error = ''
  })
}

// ---------- 发布 ----------

export async function previewPublish(): Promise<boolean> {
  return withBusy(async () => {
    const picked = await window.api.previewMarketPublish()
    if (!picked) return // 用户取消
    remoteStore.publishDir = picked.dir
    remoteStore.publishPreview = picked.preview
    remoteStore.lastPublished = null
    marketStore.error = ''
  })
}

export async function publishNow(): Promise<boolean> {
  const dir = remoteStore.publishDir
  if (!dir) return false
  const ok = await withBusy(async () => {
    remoteStore.lastPublished = await window.api.publishToMarket(dir)
    marketStore.error = ''
  })
  if (ok) {
    // 发布之后这份预览里的「服务端状态」就不准了(版本已存在、拥有者已确定),
    // 直接丢掉,让用户重新选一次目录 —— 也顺便避免了「连点两次发布」
    remoteStore.publishPreview = null
    remoteStore.publishDir = null
    // 列表里那份搜索结果同样是发布**之前**问到的,它会缺掉刚发上去的这个插件。
    // 置空而不是立刻重查:用户不一定会去浏览页,重新查询交给它自己的 onMounted。
    remoteStore.result = null
    await checkUpdates(true)
    await refreshInstalled()
  }
  return ok
}

// ---------- 展示用的小工具 ----------

/**
 * 本地已装版本;没装过为 null。
 *
 * 列表页用它把「安装」变成「已安装 v1.2.0」或「更新到 v1.3.0」——
 * 服务端不知道谁装了什么,这个 join 只能在客户端做。
 */
export function localVersion(id: string): string | null {
  const view = pluginStore.list.find(p => p.descriptor.id === id)
  return view?.installed?.version ?? null
}

/** 市场上有比本地更新的版本吗。注意 isNewerVersion 的参数序是 (新, 旧) */
export function hasUpdate(id: string, remoteVersion: string): boolean {
  const local = localVersion(id)
  if (!local) return false
  return isNewerVersion(remoteVersion, local)
}

/** 已安装插件的来源标签 */
export function sourceLabel(source: string | undefined, bundled: boolean): string {
  switch (source) {
    case 'bundled':
      return '应用自带'
    case 'market':
      return '来自市场'
    case 'local':
      return '本地安装'
    case 'builtin':
      return '内置'
    default:
      return bundled ? '应用自带' : '未知来源'
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

export function formatTime(ts: number | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 预览里的一句话摘要(列表行、确认框标题都用它) */
export function previewTitle(p: PackagePreview): string {
  return `${p.name} ${p.version}`
}

/**
 * 复制一段文本(sha256 与 integrity 要能被用户拿去和别人核对,所以必须能复制)。
 * 渲染层是 secure 的自定义协议,`navigator.clipboard` 通常可用;万一不可用就退回
 * 临时 textarea + execCommand —— 这是唯一一条不依赖权限的退路。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}
