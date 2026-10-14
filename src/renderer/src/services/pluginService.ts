import { reactive } from 'vue'
import type { PluginActionResult, PluginView } from '@shared/plugins'
import { appStore, editorHolder, openSettings } from '../stores/app'
import { saveCurrentFile } from './fileService'

/** 设置面板当前选中项:外观,或某个插件的配置(与设置面板共享,便于从状态栏直达) */
export const settingsNav = reactive<{ page: 'appearance' | 'plugin'; pluginId: string | null }>({
  page: 'appearance',
  pluginId: null
})

/** 选中某个插件(右侧直接显示它的配置) */
export function selectPluginSettings(pluginId: string): void {
  settingsNav.page = 'plugin'
  settingsNav.pluginId = pluginId
}

/** 打开设置面板并定位到插件(不指定就选第一个) */
export function openPluginSettings(pluginId?: string): void {
  selectPluginSettings(pluginId ?? pluginStore.list[0]?.descriptor.id ?? '')
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

/** 状态栏用的主同步插件(内置插件里第一个带状态的) */
export function primaryPlugin(): PluginView | undefined {
  return pluginStore.list[0]
}

function fail(err: unknown, action: string): void {
  alert(`${action}失败:${err instanceof Error ? err.message : String(err)}`)
}

/**
 * 转成纯 JSON 再交给 IPC。
 *
 * pluginStore 是 reactive 的,读出来的 config 是 **Proxy**;而 contextBridge 走结构化克隆,
 * 遇到 Proxy 会直接抛 "An object could not be cloned." —— 而且嵌套在数组里的元素同样是代理,
 * 所以展开一层({...config})没用,必须整体序列化一次。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

export async function refreshPlugins(): Promise<void> {
  try {
    pluginStore.list = await window.api.listPlugins()
  } catch (err) {
    fail(err, '读取插件')
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
    pluginStore.list = await window.api.savePlugin(id, payload)
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
    pluginStore.list = await window.api.setPluginSecret(id, fieldKey, targetId, value)
  } catch (err) {
    fail(err, value === null ? '清除密钥' : '保存密钥')
  }
}

export async function runPluginAction(
  id: string,
  action: string,
  targetId?: string
): Promise<PluginActionResult | null> {
  const key = `${id}:${action}${targetId ? `:${targetId}` : ''}`
  if (pluginStore.busy) return { ok: false, message: '已有动作正在执行' }
  pluginStore.busy = key
  try {
    const result = await window.api.runPluginAction(id, action, targetId)
    pluginStore.list = await window.api.listPlugins()
    return result
  } catch (err) {
    fail(err, '执行插件动作')
    return null
  } finally {
    pluginStore.busy = null
  }
}

/** 一键手动同步(状态栏图标用) */
export async function syncNow(): Promise<void> {
  const plugin = primaryPlugin()
  if (!plugin) return
  if (!plugin.state.enabled) {
    alert('定时上传插件未启用:请在 设置 → 插件 中开启')
    return
  }
  await runPluginAction(plugin.descriptor.id, 'sync-now')
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
    window.api.notifyPluginFlushed()
  }
}

/** 由 main.ts 在挂载后调用;返回取消订阅函数 */
export function initPluginService(): () => void {
  const offStatus = window.api.onPluginStatus(list => {
    pluginStore.list = list
  })
  const offFlush = window.api.onPluginFlushDoc(() => {
    void flushCurrentDocument()
  })
  void refreshPlugins()
  return () => {
    offStatus()
    offFlush()
  }
}
