/**
 * 用户自定义样式服务:把 `~/.imark/css` 里**选中的那一项**注入成 `<style>`。
 *
 * **只注入一项。** 候选可以是单个 .css,也可以是一个目录(目录里所有 .css 由主进程
 * 递归收齐、拼成一份送过来,这里一视同仁)。多项同时生效时「谁赢」要靠文件名顺序去
 * 推,用户看到的是一份说不清的叠加结果;而样式本来就是「我此刻想要哪一种」——
 * 单选是个比级联更好回答的问题。
 *
 * 「选中哪个」是**设置项**(`settings.userStyle`),不是目录里的状态:文件随时可以
 * 增删改名,而选择不该跟着名字漂。选中项不在了就什么都不生效 —— 不自动改选别人
 * (那会莫名其妙地换掉你的外观),把同名的东西放回来它就又生效了。
 *
 * 注入走 `styles/registry.ts` 的注册表:它把 `<style>` 追加到 head 末尾,
 * 所以自定义样式在同特异性下必然赢过内置样式。
 *
 * 与主进程的分工:主进程只管「目录里现在有什么」,不做任何节流;这里按「文本变了
 * 没有」做 diff。用户在外部编辑器里每保存一次都会触发一轮广播,而把同一段文本重新
 * 设进 textContent 也会让浏览器重新解析并重算全文档样式。
 *
 * 关于主题:`var(--accent)` 这类变量在**计算值阶段**解析,`data-theme` 一变就自动
 * 跟随 —— 所以这里不需要监听主题切换,也不需要重新注入。
 */

import { reactive } from 'vue'
import type { UserStyleImportOutcome, UserStyleItem, UserStyleState } from '@shared/userStyles'
import { registerStyle, unregisterStyle } from '../styles'
import { api } from './api'

/** 注入 id 前缀,与将来可能出现的其他样式来源(插件等)区分开 */
const ID_PREFIX = 'user:'

export const styleStore = reactive<{
  dir: string
  /** 候选项:单个 .css 与样式目录混在一起,按名字排序 */
  items: UserStyleItem[]
  /** 当前生效项的名字(文件全名或目录名);null = 不使用自定义样式 */
  active: string | null
  /** 整份清单都没读上来(比如目录权限);单项的问题在各自的 error 上 */
  error: string
}>({ dir: '', items: [], active: null, error: '' })

/** 当前真正注入在页面上的东西。模块级普通变量:它不进模板,不必是响应式 */
let appliedId: string | null = null
let appliedText: string | null = null

/**
 * 让页面上生效的样式与 `styleStore` 一致。
 *
 * 选中项读不出来(被删了、过大、被独占锁住,或目录里一个能用的 .css 都没有)时
 * **什么都不注入** —— 保留上一次的样式等于对用户撒谎:界面写着「读取失败」,
 * 页面却还在按那份样式渲染。
 */
function applyActiveStyle(): void {
  const selected = styleStore.active
    ? styleStore.items.find(f => f.name === styleStore.active)
    : undefined
  const next = selected && selected.css !== null ? selected : undefined
  const nextId = next ? ID_PREFIX + next.name : null

  if (nextId === appliedId) {
    // 还是同一项:内容变了才重新注入(在外部编辑器里保存一次就会走到这)
    if (next && next.css !== appliedText) {
      registerStyle(nextId as string, next.css as string)
      appliedText = next.css
    }
    return
  }

  if (appliedId) unregisterStyle(appliedId)
  appliedId = nextId
  appliedText = next?.css ?? null
  if (next && nextId) registerStyle(nextId, next.css as string)
}

function setUserStyles(state: UserStyleState): void {
  styleStore.dir = state.dir
  styleStore.items = state.items
  styleStore.error = ''
  applyActiveStyle()
}

function fail(err: unknown, action: string): string {
  return `${action}失败：${err instanceof Error ? err.message : String(err)}`
}

/**
 * 选中一项样式(null = 不使用)。先改本地再落盘:选择要立刻看见效果,
 * 不该等一次 IPC 往返。写盘失败只提示,不回滚 —— 下次启动最多是选回旧的。
 */
export async function selectUserStyle(name: string | null): Promise<void> {
  if (styleStore.active === name) return
  styleStore.active = name
  applyActiveStyle()
  try {
    await api.saveSettings({ userStyle: name })
  } catch (err) {
    styleStore.error = fail(err, '保存样式选择')
  }
}

async function load(): Promise<void> {
  try {
    const [settings, state] = await Promise.all([
      api.getSettings(),
      api.listUserStyles()
    ])
    styleStore.active = settings.userStyle ?? null
    setUserStyles(state)
  } catch (err) {
    // 刻意不 alert:这一步是应用自己发起的,用户没做任何事,不该被打断
    // (同 market/updates.ts 的取向)。错误留在面板里,打开那一页时才看到
    styleStore.error = fail(err, '读取样式文件')
  }
}

export async function refreshUserStyles(): Promise<void> {
  try {
    setUserStyles(await api.listUserStyles())
  } catch (err) {
    styleStore.error = fail(err, '读取样式文件')
  }
}

export async function openUserStylesDir(): Promise<void> {
  try {
    await api.openUserStylesDir()
  } catch (err) {
    styleStore.error = fail(err, '打开样式文件夹')
  }
}

/**
 * 把一次导入的结果说成给用户看的话。
 *
 * 重复导入**必须**报出来,而且要报全:同一个文件点两次「导入」是最容易发生的事,
 * 让它悄悄什么都不发生,用户只会以为按钮坏了。
 */
export function describeImport(outcome: UserStyleImportOutcome): string {
  const parts: string[] = []
  if (outcome.imported.length > 0) {
    parts.push(`已导入 ${outcome.imported.map(n => `「${n}」`).join('、')}`)
  }
  for (const dup of outcome.duplicates) {
    const same = dup.sameAs.map(n => `「${n}」`).join('、')
    parts.push(`「${dup.name}」与已有的 ${same} 内容相同，没有重复导入`)
  }
  for (const bad of outcome.failed) {
    parts.push(`「${bad.name}」导入失败：${bad.error}`)
  }
  return parts.length > 0 ? parts.join('；') : '这个文件夹里没有 .css 文件'
}

/** 导入一个文件;用户取消返回 null */
export async function importUserStyle(): Promise<string | null> {
  return runImport(() => api.importUserStyle())
}

/** 导入一个文件夹(整个拷成样式目录);用户取消返回 null */
export async function importUserStylesFromDir(): Promise<string | null> {
  return runImport(() => api.importUserStylesFromDir())
}

async function runImport(call: () => Promise<{ state: UserStyleState; outcome: UserStyleImportOutcome } | null>): Promise<string | null> {
  try {
    const result = await call()
    if (!result) return null
    setUserStyles(result.state)
    return describeImport(result.outcome)
  } catch (err) {
    styleStore.error = fail(err, '导入样式')
    return null
  }
}

export async function removeUserStyle(name: string): Promise<void> {
  try {
    setUserStyles(await api.removeUserStyle(name))
  } catch (err) {
    styleStore.error = fail(err, '删除样式')
  }
}

/** 由 main.ts 在挂载后调用;返回取消订阅函数 */
export function initUserStyleService(): () => void {
  // 订阅先挂上:目录变化是随时可能发生的,漏掉一次就要等下一次事件
  const off = api.onUserStylesChanged(setUserStyles)
  void load()
  return off
}
