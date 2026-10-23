/**
 * 扩展服务的渲染层侧:视图缓存 + 与主进程的往返。
 *
 * 这里**没有乐观更新**:主进程每执行一次
 * 启用/保存/密钥写入都回传整份 `ExtensionView[]`,这里直接替换缓存。
 * 这样设置页、状态栏、导航栏看到的永远是同一份状态,不存在"界面先变了、
 * 主进程其实失败了"的中间态。
 */

import { reactive } from 'vue'
import type {
  ExtensionCommandInvocation,
  ExtensionCommandResult,
  ExtensionContributionsSnapshot,
  ExtensionHostSettings,
  ExtensionHostSettingsPatch,
  ExtensionView
} from '@shared/extensions'
import { openSettings } from '../stores/app'
import { notifyError, pushNotice } from './notice'
import { settingsNav } from './settingsNav'
import { api } from './api'

export const extensionStore = reactive<{
  list: ExtensionView[]
  contribs: ExtensionContributionsSnapshot | null
  hostSettings: ExtensionHostSettings
  /** 正在执行的动作用 `${id}:${what}` 表示 */
  busy: string | null
}>({
  list: [],
  contribs: null,
  hostSettings: { mode: 'shared', affinity: {} },
  busy: null
})

export function extensionById(id: string): ExtensionView | undefined {
  return extensionStore.list.find(item => item.descriptor.id === id)
}

/** reactive 代理过不了 contextBridge 的结构化克隆,先转成普通对象 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T
}

function fail(err: unknown, action: string): void {
  notifyError(action, err)
}

function applyContributions(snapshot: ExtensionContributionsSnapshot): void {
  extensionStore.contribs = snapshot
}

export async function refreshExtensions(): Promise<void> {
  try {
    const [list, contribs] = await Promise.all([
      api.listExtensions(),
      api.getExtensionContributions()
    ])
    extensionStore.list = list
    applyContributions(contribs)
  } catch (err) {
    fail(err, '读取扩展')
  }
}

async function refreshHostSettings(): Promise<void> {
  try {
    const settings = await api.getSettings()
    extensionStore.hostSettings = settings.extensionHost
  } catch {
    // 读设置失败不阻塞扩展页面:显示上一次已知的宿主设置比整页报错好
  }
}

async function mutate(action: string, run: () => Promise<ExtensionView[]>): Promise<boolean> {
  if (extensionStore.busy) return false
  extensionStore.busy = action
  try {
    extensionStore.list = await run()
    return true
  } catch (err) {
    fail(err, action)
    return false
  } finally {
    extensionStore.busy = null
  }
}

export function setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
  return mutate(enabled ? '启用扩展' : '停用扩展', () => api.setExtensionEnabled(id, enabled))
}

/** 保存单个配置项:主进程按清单声明决定写全局层还是当前仓库层 */
export function saveExtensionField(id: string, key: string, value: unknown): Promise<boolean> {
  return mutate('保存扩展配置', () => api.setExtensionField(id, key, plain(value)))
}

/** key 是完整密钥键(`<id>:<property>[:<slot>]`);value 为 null 时删除 */
export function saveExtensionSecret(
  id: string,
  key: string,
  value: string | null
): Promise<boolean> {
  return mutate(value === null ? '清除密钥' : '保存密钥', () =>
    api.setExtensionSecret(id, key, value)
  )
}

export function reloadExtension(id: string): Promise<boolean> {
  return mutate('重新加载扩展', () => api.reloadExtension(id))
}

export function reloadExtensionHost(hostId: number): Promise<boolean> {
  return mutate(`重新加载进程 #${hostId}`, () => api.reloadExtensionHost(hostId))
}

export function uninstallExtension(id: string): Promise<boolean> {
  return mutate('卸载扩展', () => api.uninstallExtension(id))
}

export async function setExtensionHostSettings(
  patch: ExtensionHostSettingsPatch
): Promise<boolean> {
  const ok = await mutate('保存宿主设置', () =>
    api.setExtensionHostSettings(plain(patch))
  )
  if (ok) await refreshHostSettings()
  return ok
}

/**
 * 执行一条命令。失败时弹一条提示 —— 用户点了什么却什么都没发生,
 * 比一句直白的错误更让人困惑。成功不提示:该说什么由扩展自己决定。
 */
export async function runExtensionCommand(
  command: string,
  args: unknown[] = [],
  from: ExtensionCommandInvocation['from'] = 'code'
): Promise<ExtensionCommandResult> {
  try {
    const result = await api.runExtensionCommand(command, plain(args), from)
    if (!result.ok) {
      const owner = extensionStore.contribs?.commands.find(item => item.command === command)
      pushNotice(result.message || '执行失败', {
        title: owner?.extensionName ?? '扩展',
        level: 'warn'
      })
    }
    return result
  } catch (err) {
    const owner = extensionStore.contribs?.commands.find(item => item.command === command)
    pushNotice(`执行失败:${err instanceof Error ? err.message : String(err)}`, {
      title: owner?.extensionName ?? '扩展',
      level: 'error'
    })
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function selectExtensionSettings(extensionId: string): void {
  settingsNav.page = 'plugin'
  settingsNav.pluginId = extensionId
}

/** 打开设置面板并定位到某个扩展;不指定时选第一个已安装的 */
export function openExtensionSettings(extensionId?: string): void {
  selectExtensionSettings(extensionId ?? extensionStore.list[0]?.descriptor.id ?? '')
  openSettings()
}

/**
 * 由 main.ts 在挂载后调用;返回取消订阅函数。
 *
 * 首帧主动拉一次:主进程只在变化时广播,而渲染层刷新(改主题、换仓库后重载)
 * 时贡献点并没有变,只靠推送会看到一张空菜单。
 */
export function initExtensionService(): () => void {
  const offContribs = api.onExtensionContributions(applyContributions)
  // 原生菜单/快捷键:执行入口在渲染层(它才知道光标在哪)
  const offCommand = api.onExtensionCommand(({ command, from }) => {
    void runExtensionCommand(command, [], from)
  })
  void refreshExtensions()
  void refreshHostSettings()
  return () => {
    offContribs()
    offCommand()
  }
}
