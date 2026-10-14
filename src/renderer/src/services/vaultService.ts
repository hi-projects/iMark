import { nextTick } from 'vue'
import type { VaultNode } from '@shared/types'
import { appStore, type VaultFileRef } from '../stores/app'
import { basename } from '../utils/text'
import { openFileByPath, resetToEmpty, saveCurrentFile } from './fileService'
import { isInside, relativeTo } from '../utils/paths'

/** Windows 名称非法字符 */
const INVALID_NAME = /[\\/:*?"<>|]/

function fail(err: unknown, action: string): void {
  alert(`${action}失败:${err instanceof Error ? err.message : String(err)}`)
}

export function validName(name: string): boolean {
  return name.length > 0 && !INVALID_NAME.test(name) && !name.endsWith(' ') && !name.endsWith('.')
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
    const tree = await window.api.listVault(vaultPath)
    if (!tree) throw new Error('无法读取该文件夹')
    appStore.vaultPath = vaultPath
    appStore.vaultName = tree.name
    appStore.vaultTree = tree
    appStore.expandedDirs = new Set<string>()
    for (const c of tree.children ?? []) {
      if (c.type === 'dir') appStore.expandedDirs.add(c.path)
    }
    rebuildVaultFiles()
    await window.api.saveSettings({ vaultPath })
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
  await window.api.saveSettings({ vaults: next })
}

/** 从最近列表移除(不删除磁盘内容) */
export async function forgetVault(vaultPath: string): Promise<void> {
  const next = appStore.vaults.filter(v => v !== vaultPath)
  appStore.vaults = next
  await window.api.saveSettings({ vaults: next })
}

export function showVaultPicker(): void {
  appStore.view = 'picker'
}

/**
 * 从编辑器请求切换仓库(状态栏仓库名 / 菜单「打开仓库」):
 * 先对脏文档做出决定(保存/丢弃/取消),再回到仓库选择界面。
 */
export async function requestVaultSwitch(): Promise<boolean> {
  if (appStore.dirty) {
    const choice = await window.api.confirmDiscard(appStore.fileName)
    if (choice === 'cancel') return false
    if (choice === 'save') {
      const ok = await saveCurrentFile()
      if (!ok) return false
    } else {
      // 用户选择丢弃:清掉脏标记,否则编辑器卸载后关闭守卫会再次索要保存
      appStore.dirty = false
    }
  }
  showVaultPicker()
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
  await window.api.saveSettings({ skipVaultPicker: skip })
}

/**
 * 从选择界面打开仓库:加载文件树并进入编辑器;
 * 若该仓库有上次打开的文件且仍存在则恢复,否则清空编辑器。
 */
export async function openVaultFromPicker(vaultPath: string): Promise<boolean> {
  const settings = await window.api.getSettings()
  const ok = await loadVault(vaultPath)
  if (!ok) return false
  await enterEditorAndWait()
  if (settings.lastFile && isInside(vaultPath, settings.lastFile)) {
    await openFileByPath(settings.lastFile, { silent: true, force: true })
  } else {
    await resetToEmpty()
  }
  return true
}

/** 通过文件夹对话框打开仓库(选择界面 & 菜单入口) */
export async function openVaultViaDialog(): Promise<boolean> {
  const dir = await window.api.selectVaultDialog()
  if (!dir) return false
  return openVaultFromPicker(dir)
}

/** 新建仓库:在父目录下创建同名文件夹并打开 */
export async function createVaultAt(parentDir: string, name: string): Promise<boolean> {
  if (!validName(name)) {
    alert('仓库名称不合法(不能包含 \\ / : * ? " < > | 等字符)')
    return false
  }
  const target = `${parentDir}\\${name}`
  try {
    await window.api.createDir(target)
  } catch (err) {
    fail(err, '创建仓库')
    return false
  }
  return openVaultFromPicker(target)
}

export async function refreshVault(): Promise<void> {
  if (!appStore.vaultPath) return
  try {
    const tree = await window.api.listVault(appStore.vaultPath)
    appStore.vaultTree = tree
    rebuildVaultFiles()
  } catch (err) {
    console.error('[iMark] 刷新仓库失败', err)
  }
}

/** 菜单/空状态入口:选择文件夹 → 加载(切换前由调用方负责脏确认) */
export async function openVaultDialog(): Promise<void> {
  const dir = await window.api.selectVaultDialog()
  if (dir) await loadVault(dir)
}

export async function createFile(parentPath: string, name: string): Promise<VaultNode | null> {
  if (!validName(name)) {
    alert('文件名不合法(不能包含 \\ / : * ? " < > | 等字符)')
    return null
  }
  const p = `${parentPath}\\${name}`
  try {
    await window.api.createFile(p)
  } catch (err) {
    fail(err, '新建文件')
    return null
  }
  await refreshVault()
  return appStore.vaultTree ? findNode(appStore.vaultTree, p) : null
}

export async function createDir(parentPath: string, name: string): Promise<boolean> {
  if (!validName(name)) {
    alert('文件夹名不合法(不能包含 \\ / : * ? " < > | 等字符)')
    return false
  }
  try {
    await window.api.createDir(`${parentPath}\\${name}`)
  } catch (err) {
    fail(err, '新建文件夹')
    return false
  }
  await refreshVault()
  return true
}

/** 重命名;若涉及当前打开文件(或其所在目录),同步修正状态与 lastFile 记忆 */
export async function renamePath(node: VaultNode, newName: string): Promise<boolean> {
  if (!validName(newName)) {
    alert('名称不合法(不能包含 \\ / : * ? " < > | 等字符)')
    return false
  }
  const parent = node.path.slice(0, node.path.length - node.name.length - 1)
  const to = `${parent}\\${newName}`
  if (to === node.path) return true
  try {
    await window.api.renamePath(node.path, to)
  } catch (err) {
    fail(err, '重命名')
    return false
  }
  await refreshVault()
  if (appStore.filePath) {
    const fp = appStore.filePath
    if (fp === node.path) {
      applyOpenFilePath(to)
    } else if (node.type === 'dir' && isInside(node.path, fp)) {
      applyOpenFilePath(to + fp.slice(node.path.length))
    }
  }
  return true
}

function applyOpenFilePath(newPath: string): void {
  appStore.filePath = newPath
  appStore.fileName = basename(newPath)
  void window.api.saveSettings({ lastFile: newPath })
}

/** 删除(回收站);若删除的是打开文件,内容保留但转为未保存的未命名状态 */
export async function deleteNode(node: VaultNode): Promise<boolean> {
  const ok = await window.api.confirmDelete(node.name, node.type === 'dir')
  if (!ok) return false
  try {
    await window.api.trashPath(node.path)
  } catch (err) {
    fail(err, '删除')
    return false
  }
  await refreshVault()
  const fp = appStore.filePath
  if (fp && isInside(node.path, fp)) {
    appStore.filePath = null
    appStore.fileName = '未命名'
    appStore.savedContent = ''
    void window.api.saveSettings({ lastFile: null })
  }
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

/** 从仓库内打开文件(记录 lastFile) */
export async function openVaultFile(path: string, opts?: { silent?: boolean }): Promise<void> {
  await openFileByPath(path, opts)
  if (appStore.filePath === path && appStore.vaultPath && isInside(appStore.vaultPath, path)) {
    await window.api.saveSettings({ lastFile: path })
  }
}

// ---------- 快速切换器 ----------

export function toggleSwitcher(): void {
  appStore.switcherOpen = !appStore.switcherOpen
}

export function closeSwitcher(): void {
  appStore.switcherOpen = false
}

/** 简易模糊匹配:子序列命中,连续/词首加权;返回 -1 表示不匹配 */
function fuzzyScore(query: string, target: string): number {
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
