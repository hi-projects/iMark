import { reactive } from 'vue'
import type { PluginActionPayload, PluginActionResult, PluginView } from '@shared/plugins'
import { appStore, editorHolder, openSettings } from '../stores/app'
import { saveCurrentFile } from './fileService'
import { notifyError } from './notice'
import { api } from './api'

/** 市场页内部的子导航:三个页签 + 列表页的搜索条件 */
export interface MarketNav {
  tab: 'browse' | 'installed' | 'publish'
  /** 打开某个插件的详情页(仅 browse 页签用);null = 显示列表 */
  detailId: string | null
  query: string
  page: number
  sort: 'updated' | 'name' | 'downloads'
}

/** 设置面板当前选中项:外观、编辑器、某个插件的配置,或插件市场(与设置面板共享,便于从状态栏/菜单直达) */
export const settingsNav = reactive<{
  page: 'appearance' | 'editor' | 'system' | 'plugin' | 'market'
  pluginId: string | null
  /**
   * 市场内部的子导航放在这里,而不是继续往 page 联合里塞 ——
   * 市场里的「列表 / 详情 / 发布」是同一页的状态,不是三个并列的设置页,
   * 拆成三个 page 会让「从哪个入口进来的」变得无从恢复。
   */
  market: MarketNav
}>({
  page: 'appearance',
  pluginId: null,
  // 默认落在「已安装」:没有市场服务端时这一页照样有内容,不会一进来就看到报错
  market: { tab: 'installed', detailId: null, query: '', page: 1, sort: 'updated' }
})

/** 选中某个插件(右侧直接显示它的配置) */
export function selectPluginSettings(pluginId: string): void {
  settingsNav.page = 'plugin'
  settingsNav.pluginId = pluginId
}

/**
 * 打开设置面板并定位到插件市场(菜单项与左栏入口用)。
 *
 * 固定落在「浏览市场」页签 —— 入口的名字就叫这个,点进去却停在别的页签
 * 会让人以为点错了。(曾经还收一个 tab 参数,是给插件设置页的「在市场里管理」
 * 用的;那个入口撤掉之后,就没有谁需要跳到别的页签了。)
 */
export function openMarketSettings(): void {
  settingsNav.market.tab = 'browse'
  settingsNav.market.detailId = null
  settingsNav.page = 'market'
  openSettings()
}

/**
 * 打开设置面板并定位到某个插件。
 * 不指定时优先选「定时上传（Git）」—— 它是绝大多数用户唯一装的插件,
 * 而 `list[0]` 只是「谁先被扫到」,没有任何意义。
 */
export function openPluginSettings(pluginId?: string): void {
  selectPluginSettings(pluginId ?? gitSyncPlugin()?.descriptor.id ?? pluginStore.list[0]?.descriptor.id ?? '')
  openSettings()
}

/**
 * 插件服务:插件视图状态 + 与主进程的往返。
 *
 * 状态刻意放在本模块(而不是 appStore),一是插件列表只有设置面板和状态栏用,
 * 二是避免与并行改动 appStore 的冲突。
 */
export const pluginStore = reactive<{
  list: PluginView[]
  /** 正在执行的动作用 `${id}:${action}` 表示 */
  busy: string | null
}>({ list: [], busy: null })

export function pluginById(id: string): PluginView | undefined {
  return pluginStore.list.find(p => p.descriptor.id === id)
}

/** 「定时上传（Git）」插件的 id(disc 里的同步按钮与状态栏都按它来找) */
export const GIT_SYNC_ID = 'git-sync'

/**
 * 取「定时上传（Git）」这个插件。
 *
 * 从前这里写的是 `pluginStore.list[0]`,在插件只有内置那一个、且固定排在数组首位时
 * 恰好等价。现在插件可以任意装/卸,`list[0]` 会是**随便哪个**插件 ——
 * 那样状态栏的同步按钮就会拿着别的插件 id 去跑 `sync-now`,得到一句「未知动作」。
 * 所以这里按 id 明确地找,找不到就是不显示。
 */
export function gitSyncPlugin(): PluginView | undefined {
  return pluginById(GIT_SYNC_ID)
}

function fail(err: unknown, action: string): void {
  notifyError(action, err)
}

/**
 * 转成纯 JSON 再交给 IPC。
 *
 * pluginStore 是 reactive 的,读出来的 config 是 **Proxy**;而 contextBridge 走结构化克隆,
 * 遇到 Proxy 会直接抛 "An object could not be cloned." —— 而且嵌套在数组里的元素同样是代理,
 * 所以展开一层({...config})没用,必须整体序列化一次。
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

export async function refreshPlugins(): Promise<void> {
  try {
    pluginStore.list = await api.listPlugins()
  } catch (err) {
    fail(err, '读取插件')
  }
}

/**
 * 沙箱插件:放开/收回「允许访问本机地址」。
 *
 * 与插件自己的配置分开走:那是**用户对插件的授权**,不是插件要说的事。
 */
export async function setPluginNetAccess(id: string, allow: boolean): Promise<void> {
  try {
    pluginStore.list = await api.setPluginNetAccess(id, allow)
  } catch (err) {
    fail(err, '保存网络访问设置')
  }
}

export async function savePlugin(
  id: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> }
): Promise<void> {
  try {
    const payload: { enabled?: boolean; config?: Record<string, unknown> } = {}
    if (patch.enabled !== undefined) payload.enabled = patch.enabled
    if (patch.config !== undefined) payload.config = plain(patch.config)
    pluginStore.list = await api.savePlugin(id, payload)
  } catch (err) {
    fail(err, '保存插件配置')
  }
}

export async function setPluginSecret(
  id: string,
  fieldKey: string,
  targetId: string | null,
  value: string | null
): Promise<void> {
  try {
    pluginStore.list = await api.setPluginSecret(id, fieldKey, targetId, value)
  } catch (err) {
    fail(err, value === null ? '清除密钥' : '保存密钥')
  }
}

export async function runPluginAction(
  id: string,
  action: string,
  targetId?: string,
  payload?: PluginActionPayload
): Promise<PluginActionResult | null> {
  const key = `${id}:${action}${targetId ? `:${targetId}` : ''}`
  if (pluginStore.busy) return { ok: false, message: '已有动作正在执行' }
  pluginStore.busy = key
  try {
    const result = await api.runPluginAction(
      id,
      action,
      targetId,
      payload ? plain(payload) : undefined
    )
    pluginStore.list = await api.listPlugins()
    return result
  } catch (err) {
    fail(err, '执行插件动作')
    return null
  } finally {
    pluginStore.busy = null
  }
}

/**
 * 主进程要发提交前会要求先把脏文档落盘。这里即使保存失败也要回执,
 * 否则主进程要白等超时(同步仍会按磁盘现状继续)。
 */
async function flushCurrentDocument(): Promise<void> {
  try {
    const view = editorHolder.view
    // 未命名文档不做「另存为」弹窗,直接按磁盘现状同步
    if (view && appStore.filePath) {
      const text = view.state.doc.toString()
      if (text !== appStore.savedContent) await saveCurrentFile()
    }
  } finally {
    api.notifyPluginFlushed()
  }
}

/** 由 main.ts 在挂载后调用;返回取消订阅函数 */
export function initPluginService(): () => void {
  const offStatus = api.onPluginStatus(list => {
    pluginStore.list = list
  })
  const offFlush = api.onPluginFlushDoc(() => {
    void flushCurrentDocument()
  })
  void refreshPlugins()
  return () => {
    offStatus()
    offFlush()
  }
}
