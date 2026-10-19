import { nextTick } from 'vue'
import type { Settings, VaultNode } from '@shared/types'
import { appStore, type SwitcherMode, type VaultFileRef } from '../stores/app'
import { closeAllTabsForSwitch, openFileByPath, restoreSession } from './fileService'
import { clearTabs, detachDeletedPath, renameTabPaths } from './tabs'
import { joinPath, relativeTo, replaceName } from '../utils/paths'
import { notifyError, pushNotice } from './notice'
import { api } from './api'

/** Windows 名称非法字符 */
const INVALID_NAME = /[\\/:*?"<>|]/

/**
 * Windows 保留设备名。`CON`、`NUL`、`COM1` 这些**带不带扩展名都一样不能用**
 * (`con.md` 同样建不出来),Linux 上却是合法名字 —— 一律拒掉,免得同一个仓库
 * 在两个系统上表现不一致。
 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

function fail(err: unknown, action: string): void {
  notifyError(action, err)
}

/** 名字无效的原因;有效返回空串。分开写是因为"不合法"这三个字说不清到底哪儿不合适 */
function invalidReason(name: string): string {
  if (!name) return '名字不能为空'
  // 控制字符 Linux 允许、Windows 不允许,一律拒掉
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名字里不能有控制字符'
  if (INVALID_NAME.test(name)) return '不能包含 \\ / : * ? " < > | 等字符'
  if (name.endsWith(' ')) return '结尾不能是空格'
  if (name.endsWith('.')) return '结尾不能是点'
  if (RESERVED_NAME.test(name)) return 'CON、PRN、AUX、NUL、COM1-9、LPT1-9 是 Windows 保留名'
  return ''
}

export function validName(name: string): boolean {
  return invalidReason(name) === ''
}

/** 仓库树能显示、编辑器能打开的类型(与主进程 src/main/vault.ts 的 FILE_EXTS 一致) */
const EDITABLE_EXTS = new Set(['md', 'markdown', 'mdown', 'txt'])

/**
 * 补全扩展名:名字没带扩展名、或带了个仓库树不认的扩展名,一律按 .md 处理。
 *
 * 判据是**扩展名**而不是"有没有点":把「笔记.md」改成「笔记 v1.2」时,那个点
 * 属于名字不属于扩展名,按"有没有点"判会让文件直接消失在文件树里。
 */
export function withExtension(name: string): string {
  if (!name) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return EDITABLE_EXTS.has(ext) ? name : `${name}.md`
}

function flatten(node: VaultNode, vaultPath: string, out: VaultFileRef[]): void {
  if (node.type === 'file') {
    const rel = relativeTo(vaultPath, node.path) ?? node.path
    out.push({ rel, name: node.name, path: node.path })
  }
  for (const c of node.children ?? []) flatten(c, vaultPath, out)
}

function rebuildVaultFiles(): void {
  const files: VaultFileRef[] = []
  if (appStore.vaultTree && appStore.vaultPath) {
    flatten(appStore.vaultTree, appStore.vaultPath, files)
  }
  appStore.vaultFiles = files
}

/** 打开仓库:列出文件树、记忆路径、自动展开第一层目录 */
export async function loadVault(vaultPath: string, opts?: { silent?: boolean }): Promise<boolean> {
  try {
    const tree = await api.listVault(vaultPath)
    if (!tree) throw new Error('无法读取该文件夹')
    appStore.vaultPath = vaultPath
    appStore.vaultName = tree.name
    appStore.vaultTree = tree
    appStore.expandedDirs = new Set<string>()
    for (const c of tree.children ?? []) {
      if (c.type === 'dir') appStore.expandedDirs.add(c.path)
    }
    rebuildVaultFiles()
    await api.saveSettings({ vaultPath })
    await rememberVault(vaultPath)
    return true
  } catch (err) {
    if (!opts?.silent) fail(err, '打开仓库')
    return false
  }
}

// ---------- 仓库选择界面(启动流程 & 切换) ----------

const MAX_RECENT_VAULTS = 20

/** 从 settings 初始化最近仓库列表(不写盘) */
export function initVaultList(vaults: string[]): void {
  appStore.vaults = [...vaults]
}

/** 打开仓库成功后置顶记忆 */
async function rememberVault(vaultPath: string): Promise<void> {
  const next = [vaultPath, ...appStore.vaults.filter(v => v !== vaultPath)].slice(
    0,
    MAX_RECENT_VAULTS
  )
  appStore.vaults = next
  await api.saveSettings({ vaults: next })
}

/** 从最近列表移除(不删除磁盘内容) */
export async function forgetVault(vaultPath: string): Promise<void> {
  const next = appStore.vaults.filter(v => v !== vaultPath)
  appStore.vaults = next
  await api.saveSettings({ vaults: next })
}

/**
 * 回到仓库选择界面。
 *
 * 页面这时就不算打开了:把「上次打开的页面」一并清掉,持久化状态才与用户
 * 眼前看到的一致 —— 否则在选择界面关掉应用,下次启动还会莫名其妙恢复一个文件。
 */
export async function showVaultPicker(): Promise<void> {
  // 回到选择界面 = 眼前没有页面:标签会话一并清掉,否则下次启动又会
  // 恢复一批用户在界面上已经关掉的文档。调用方负责先处理脏文档。
  clearTabs()
  appStore.view = 'picker'
  await api.saveSettings({ lastFile: null, openFiles: [] })
}

/**
 * 从编辑器请求切换仓库(状态栏仓库名 / 菜单「打开仓库」):
 * 先对**每个**脏标签做出决定(保存/丢弃/取消),再回到仓库选择界面。
 * 有一个取消就停在原地 —— 切仓库会丢掉所有标签,不能只问当前那一份。
 */
export async function requestVaultSwitch(): Promise<boolean> {
  if (!(await closeAllTabsForSwitch())) return false
  await showVaultPicker()
  return true
}

/** 进入编辑器视图(仓库已加载) */
export function enterEditor(): void {
  appStore.view = 'editor'
}

/**
 * 进入编辑器视图并等待 EditorPane 挂载完成。
 * 直接调用 enterEditor() 后立刻装载文档会拿不到编辑器实例(挂载在下一个 tick),
 * 所有「切换视图后马上打开文件」的路径都要用这个。
 */
export async function enterEditorAndWait(): Promise<void> {
  enterEditor()
  await nextTick()
}

export async function setSkipVaultPicker(skip: boolean): Promise<void> {
  await api.saveSettings({ skipVaultPicker: skip })
}

/**
 * 进入编辑器后恢复「上次打开的那个页面」。
 *
 * 没有可恢复的页面(从来没打开过 / 新建了未命名文档 / 文件已被删掉)时,
 * **什么都不打开**,而不是塞一份未命名文档进去 —— 那会让人以为有内容待保存。
 */
export async function restoreLastDocument(
  vaultPath: string,
  settings: Pick<Settings, 'lastFile' | 'openFiles'>
): Promise<void> {
  await restoreSession(vaultPath, settings)
}

/**
 * 从选择界面打开仓库:加载文件树并进入编辑器;
 * 若该仓库有上次打开的文件且仍存在则恢复,否则什么都不打开。
 */
export async function openVaultFromPicker(vaultPath: string): Promise<boolean> {
  const settings = await api.getSettings()
  const ok = await loadVault(vaultPath)
  if (!ok) return false
  await enterEditorAndWait()
  await restoreLastDocument(vaultPath, settings)
  return true
}

/** 通过文件夹对话框打开仓库(选择界面 & 菜单入口) */
export async function openVaultViaDialog(): Promise<boolean> {
  const dir = await api.selectVaultDialog()
  if (!dir) return false
  return openVaultFromPicker(dir)
}

/** 新建仓库:在父目录下创建同名文件夹并打开 */
export async function createVaultAt(parentDir: string, name: string): Promise<boolean> {
  if (!validName(name)) {
    pushNotice(`仓库名称不合法:${invalidReason(name)}`, { title: '仓库', level: 'warn' })
    return false
  }
  const target = joinPath(parentDir, name)
  try {
    await api.createDir(target)
  } catch (err) {
    fail(err, '创建仓库')
    return false
  }
  return openVaultFromPicker(target)
}

export async function refreshVault(): Promise<void> {
  if (!appStore.vaultPath) return
  try {
    const tree = await api.listVault(appStore.vaultPath)
    appStore.vaultTree = tree
    rebuildVaultFiles()
  } catch (err) {
    console.error('[iMark] 刷新仓库失败', err)
  }
}

/** 菜单/空状态入口:选择文件夹 → 加载(切换前由调用方负责脏确认) */
export async function openVaultDialog(): Promise<void> {
  const dir = await api.selectVaultDialog()
  if (dir) await loadVault(dir)
}

export async function createFile(parentPath: string, name: string): Promise<VaultNode | null> {
  const fileName = withExtension(name.trim())
  if (!validName(fileName)) {
    pushNotice(`文件名不合法:${invalidReason(fileName)}`, { title: '文件', level: 'warn' })
    return null
  }
  const p = joinPath(parentPath, fileName)
  try {
    await api.createFile(p)
  } catch (err) {
    fail(err, '新建文件')
    return null
  }
  await refreshVault()
  return appStore.vaultTree ? findNode(appStore.vaultTree, p) : null
}

export async function createDir(parentPath: string, name: string): Promise<boolean> {
  if (!validName(name)) {
    pushNotice(`文件夹名不合法:${invalidReason(name)}`, { title: '文件', level: 'warn' })
    return false
  }
  try {
    await api.createDir(joinPath(parentPath, name))
  } catch (err) {
    fail(err, '新建文件夹')
    return false
  }
  await refreshVault()
  return true
}

/** 重命名;若涉及当前打开文件(或其所在目录),同步修正状态与 lastFile 记忆 */
export async function renamePath(node: VaultNode, newName: string): Promise<boolean> {
  // 文件改名同样补扩展名:把「笔记.md」改成「笔记」会让它从树里消失
  const name = node.type === 'file' ? withExtension(newName) : newName
  if (!validName(name)) {
    pushNotice(`名称不合法:${invalidReason(name)}`, { title: '文件', level: 'warn' })
    return false
  }
  const to = replaceName(node.path, name)
  if (to === node.path) return true
  try {
    await api.renamePath(node.path, to)
  } catch (err) {
    fail(err, '重命名')
    return false
  }
  await refreshVault()
  // 改名可能同时命中多个标签(目录改名时,目录下打开的每一份都要跟着换路径)
  renameTabPaths(node.path, to, node.type === 'dir')
  return true
}

/** 删除(回收站);若删除的是打开文件,内容保留但转为未保存的未命名状态 */
export async function deleteNode(node: VaultNode): Promise<boolean> {
  const ok = await api.confirmDelete(node.name, node.type === 'dir')
  if (!ok) return false
  try {
    await api.trashPath(node.path)
  } catch (err) {
    fail(err, '删除')
    return false
  }
  await refreshVault()
  // 删除的是磁盘文件,不是用户眼前的文字:受影响的标签转为未保存的未命名文档
  detachDeletedPath(node.path, node.type === 'dir')
  return true
}

function findNode(root: VaultNode, target: string): VaultNode | null {
  if (root.path === target) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, target)
    if (hit) return hit
  }
  return null
}

/** 从仓库内打开文件(「上次打开的页面」由 openFileByPath 统一记录) */
export async function openVaultFile(path: string, opts?: { silent?: boolean }): Promise<void> {
  await openFileByPath(path, opts)
}

// ---------- 快速切换器 ----------

export function toggleSwitcher(): void {
  if (appStore.switcherOpen) {
    appStore.switcherOpen = false
    return
  }
  openSwitcher('file')
}

/** 打开切换器并指定初始模式(命令面板走这条;Ctrl+P 走上面的搜文件) */
export function openSwitcher(mode: SwitcherMode): void {
  appStore.switcherMode = mode
  appStore.switcherOpen = true
}

export function closeSwitcher(): void {
  appStore.switcherOpen = false
}

/**
 * 简易模糊匹配:子序列命中,连续/词首加权;返回 -1 表示不匹配。
 *
 * 导出给命令面板共用 —— 同一个面板里,搜文件和搜命令的匹配手感必须是同一套
 * (同一串字符在两种模式下给出不同的命中顺序,会让人怀疑自己打错了)。
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let streak = 0
  let last = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak = ti === last + 1 ? streak + 1 : 0
      score += 1 + streak * 2 + (ti === 0 || t[ti - 1] === '\\' || t[ti - 1] === '/' || t[ti - 1] === ' ' ? 5 : 0)
      last = ti
      qi++
    }
  }
  return qi === q.length ? score : -1
}

export function searchVaultFiles(query: string, limit = 12): VaultFileRef[] {
  const files = appStore.vaultFiles
  if (!query.trim()) return files.slice(0, limit)
  const scored: { ref: VaultFileRef; score: number }[] = []
  for (const f of files) {
    const s = Math.max(fuzzyScore(query, f.name) * 2, fuzzyScore(query, f.rel))
    if (s >= 0) scored.push({ ref: f, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(x => x.ref)
}
