import { computed, reactive, type Component } from 'vue'
import {
  AlertTriangle,
  ArrowUpCircle,
  Bell,
  Check,
  CloudUpload,
  Clock,
  FileText,
  GitBranch,
  Link,
  List,
  Pin,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Terminal,
  Zap
} from 'lucide-vue-next'
import type {
  PluginCommand,
  PluginCommandContext,
  PluginContrib,
  PluginContribInvoke,
  PluginContribsSnapshot,
  PluginMenuItem,
  PluginMenuWhere,
  PluginStatusItem
} from '@shared/plugins'
import { commandAvailable } from '@shared/plugins'
import { pluginById } from './pluginService'
import { fuzzyScore } from './vaultService'
import { pushNotice } from './notice'
import { appStore } from '../stores/app'
import { reloadFileInTab } from './fileService'
import { api } from './api'

/**
 * 界面贡献点的渲染层侧。
 *
 * 这里**不解析插件给的任何东西**:主进程已经把它削成「一个 id、一个标签、一个动作」
 * 这三样,渲染层只负责摆放。所以这张表里没有一行是"根据插件说的去算点什么"——
 * 那种代码迟早会变成一套只有插件作者看得懂的界面语言。
 */
export const pluginUiStore = reactive<{
  contribs: PluginContrib[]
  context: PluginCommandContext
}>({
  contribs: [],
  // 还不知道状态时按"什么都没有"算:命令先灰着,比先亮着再变灰更不容易误点
  context: { hasEditor: false, hasVault: false }
})

/**
 * 图标名 → 图标。**白名单,不是查找**。
 *
 * 插件给的是个字符串,如果拿它去 `require` 或者当作组件名动态解析,插件就等于
 * 拿到了"让宿主渲染任意东西"的能力。这里认不出的名字一律退回文字 ——
 * 一条状态栏条目少个图标没什么,宿主被插件指挥着渲染才是问题。
 */
const ICONS: Record<string, Component> = {
  'cloud-upload': CloudUpload,
  'refresh': RefreshCw,
  'git': GitBranch,
  'clock': Clock,
  'check': Check,
  'alert': AlertTriangle,
  'bell': Bell,
  'list': List,
  'search': Search,
  'settings': Settings,
  'sparkles': Sparkles,
  'star': Star,
  'terminal': Terminal,
  'zap': Zap,
  'link': Link,
  'pin': Pin,
  'file': FileText,
  'update': ArrowUpCircle
}

export function pluginIcon(name: string | undefined): Component | null {
  return (name && ICONS[name]) || null
}

/** 状态栏条目 + 它属于哪个插件(渲染时要一起用) */
export interface StatusEntry {
  pluginId: string
  pluginName: string
  item: PluginStatusItem
}

/**
 * 状态栏里所有插件条目。**顺序即插件顺序**。
 *
 * 每个插件最多一条(清单校验里就是这么限的):状态栏是全应用最挤的一条,
 * 它属于文档本身(字数、行数),不该变成插件的公告板。
 */
export const statusEntries = computed<StatusEntry[]>(() => {
  const out: StatusEntry[] = []
  for (const c of pluginUiStore.contribs) {
    if (c.statusItem) out.push({ pluginId: c.pluginId, pluginName: c.pluginName, item: c.statusItem })
  }
  return out
})

/** 一条命令现在能不能用(用主进程下发的上下文判定,两边结论一致) */
export function commandUsable(cmd: PluginCommand): boolean {
  return commandAvailable(cmd.when, pluginUiStore.context)
}

export interface PaletteCommand extends PluginCommand {
  pluginId: string
  pluginName: string
  usable: boolean
}

/** 命令面板的数据源 */
export const paletteCommands = computed<PaletteCommand[]>(() => {
  const out: PaletteCommand[] = []
  for (const c of pluginUiStore.contribs) {
    for (const cmd of c.commands) {
      out.push({
        ...cmd,
        pluginId: c.pluginId,
        pluginName: c.pluginName,
        usable: commandAvailable(cmd.when, pluginUiStore.context)
      })
    }
  }
  return out
})

/**
 * 按关键词给命令排序。
 *
 * 匹配的是「命令名 + 插件名 + 说明」三处合起来:用户记不住命令叫什么,
 * 但记得住是哪个插件干的 —— 只匹配 label 的话,「git 同步」这种搜法就落空了。
 * 不可用的命令照样列出来(排在后面、标明原因):"为什么没有这条命令"的答案,
 * 比"干净利落的空列表"有用。
 */
export function searchPluginCommands(query: string, limit = 12): PaletteCommand[] {
  const q = query.trim()
  const all = paletteCommands.value
  if (!q) return all.slice(0, limit)
  const scored: Array<{ cmd: PaletteCommand; score: number }> = []
  for (const cmd of all) {
    const s = Math.max(
      fuzzyScore(q, cmd.label) * 2,
      fuzzyScore(q, cmd.pluginName),
      cmd.detail ? fuzzyScore(q, cmd.detail) : -1
    )
    if (s >= 0) scored.push({ cmd, score: s + (cmd.usable ? 0 : -1) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(x => x.cmd)
}

/** 某张右键菜单上要挂的插件条目 */
export function menuItems(where: PluginMenuWhere): Array<PluginMenuItem & { pluginId: string; pluginName: string }> {
  const out: Array<PluginMenuItem & { pluginId: string; pluginName: string }> = []
  for (const c of pluginUiStore.contribs) {
    for (const item of c.menus) {
      if (item.where === where) out.push({ ...item, pluginId: c.pluginId, pluginName: c.pluginName })
    }
  }
  return out
}

/**
 * 状态栏条目的悬停文字。
 *
 * 静态部分来自清单(tooltip),动态部分来自插件的 state —— 把 state 拼进来是
 * 宿主替插件做的一件事,否则清单里那句 tooltip 永远是死的("定时上传"),
 * 用户真正想知道的是"上次什么时候、成没成"。
 */
export function statusTitle(entry: StatusEntry): string {
  const view = pluginById(entry.pluginId)
  const head = entry.item.tooltip || entry.pluginName
  const lines = [head]
  const st = view?.state
  if (st?.lastMessage) lines.push(st.lastMessage)
  if (st?.lastRunAt) {
    lines.push(`上次 ${new Date(st.lastRunAt).toLocaleString('zh-CN', { hour12: false })}`)
  }
  if (st?.lastDetail) lines.push(st.lastDetail)
  if (!st) lines.push('插件已不在')
  return lines.join('\n')
}

/**
 * 执行一次贡献点。失败时说一声。
 *
 * **成功不弹提示**:插件干了什么由插件自己决定要不要说(`imark.ui.notify`),
 * 宿主在这里插一句"已执行"会让每个插件都被套上一层一样的回声。
 * 失败则必须说 —— 那是用户点了点什么都没发生,不说等于坏了。
 */
export async function invokeContrib(invoke: PluginContribInvoke): Promise<void> {
  try {
    const result = await api.runPluginContrib(invoke)
    if (!result.ok) {
      pushNotice(result.message || '执行失败', {
        title: pluginById(invoke.pluginId)?.descriptor.name ?? '插件',
        level: 'warn'
      })
    }
  } catch (err) {
    pushNotice(`执行失败:${err instanceof Error ? err.message : String(err)}`, {
      title: '插件',
      level: 'error'
    })
  }
}

/**
 * 挂上贡献点通道。由 main.ts 在挂载后调用;返回取消订阅函数。
 *
 * 首帧要靠 `getPluginContribs()` 主动拉一次:主进程只在**变化时**广播,
 * 而渲染层刷新(改主题、切换仓库后重载窗口)时贡献点并没有变。
 */
export function initPluginUi(): () => void {
  const apply = (snap: PluginContribsSnapshot): void => {
    pluginUiStore.contribs = snap.contribs
    pluginUiStore.context = snap.context
  }
  const offContribs = api.onPluginContribs(apply)
  const offNotice = api.onPluginNotice(notice => {
    pushNotice(notice.message, { title: notice.pluginName, level: notice.level })
  })
  const offCommand = api.onPluginCommand(({ pluginId, itemId }) => {
    // 从菜单/快捷键进来的命令:光标上下文由渲染层现取(主进程不知道光标在哪)
    void invokeContrib({ pluginId, itemId, from: 'command' })
  })
  /**
   * 插件改了某个文件:如果那正是编辑器里开着的这一份,重新加载。
   *
   * `force` 是有意的:插件写之前已经让编辑器落过盘了(见 ops 的 vault.write),
   * 这里再弹一次"要不要放弃更改"只会让人以为出了什么错。
   */
  const offExternal = api.onFileExternalChange(path => {
    // 正开着才需要刷新;多个标签里任意一个命中都要处理,而且不抢当前焦点
    if (!appStore.tabs.some(t => t.filePath === path)) return
    void reloadFileInTab(path)
  })
  void api
    .getPluginContribs()
    .then(apply)
    .catch(() => undefined)
  return () => {
    offContribs()
    offNotice()
    offCommand()
    offExternal()
  }
}
