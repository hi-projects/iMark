import { nextTick } from 'vue'
import type { Settings, VaultNode } from '@shared/types'
import { appStore, type SwitcherMode, type VaultFileRef } from '../stores/app'
import { closeAllTabsForSwitch, openFileByPath, restoreSession } from './fileService'
import { clearTabs, closeDeletedPath, renameTabPaths } from './tabs'
import { isInside, joinPath, relativeTo, replaceName } from '../utils/paths'
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
 * 判据是**扩展名**而不是"有没有点":把「笔记.md」改成「笔记 2.0」时,那个点
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

/**
 * 上一次 `loadVault` 是不是因为「仓库已被另一个窗口打开」而放弃的。
 *
 * 需要这个标记是因为 `loadVault` 的 false 有两种含义:仓库读不出来(调用方按
 * 仓库外文件继续打开),以及已经交给另一个窗口/联系不上那个窗口(本窗口
 * 什么都不该再做)。真正的原因只有这里有,调用方不该去猜。
 */
let vaultHandedOff = false

/**
 * 打开仓库:先认领(多实例下同一个仓库只保留一个窗口),再列出文件树、
 * 记忆路径、自动展开第一层目录。
 *
 * `filePath` 只在「系统递来一个文件」时传入:如果仓库已经在另一个窗口开着,
 * 主进程会把文件一起递过去,那个窗口直接打开它。
 */
export async function loadVault(
  vaultPath: string,
  opts?: { silent?: boolean; filePath?: string | null }
): Promise<boolean> {
  // 认领失败(IPC 出错)按 busy 处理:拿不到结论时宁可不开,也不冒险开第二个窗口
  const claim = await api.claimVault(vaultPath, opts?.filePath ?? null).catch(() => 'busy' as const)
  vaultHandedOff = claim !== 'ok'
  if (claim === 'forwarded') {
    // 这个窗口就是为打开它而存在的(或刚切走旧仓库),没有可保留的内容
    pushNotice('该仓库已在另一个窗口打开,已切换到那个窗口', { title: '打开仓库' })
    window.close()
    return false
  }
  if (claim === 'busy') {
    pushNotice('该仓库已在另一个窗口打开,但没能切换到那个窗口', {
      title: '打开仓库',
      level: 'warn'
    })
    return false
  }

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
    // 认领了但仓库打不开(被删/无权限):退掉,别让别的窗口也打不开
    void api.releaseVault(vaultPath)
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

/**
 * 选择页可见期间被推迟的「最近仓库」新顺序。
 *
 * 置顶如果当场改 appStore.vaults,用户点中的那一项会在加载仓库的这段时间里
 * 从原位跳到第一行 —— 虽然只有一瞬,但看得很清楚。顺序先记在这里,等离开
 * 选择页时一次性应用;那时列表要么已经不在屏幕上,要么是整块重建的。
 */
let pendingVaultOrder: string[] | null = null

function applyPendingVaultOrder(): void {
  if (!pendingVaultOrder) return
  appStore.vaults = pendingVaultOrder
  pendingVaultOrder = null
}

/** 打开仓库成功后置顶记忆:顺序立即写盘,界面上的重排等离开选择页再说 */
async function rememberVault(vaultPath: string): Promise<void> {
  const current = pendingVaultOrder ?? appStore.vaults
  const next = [vaultPath, ...current.filter(v => v !== vaultPath)].slice(0, MAX_RECENT_VAULTS)
  if (appStore.view === 'picker') pendingVaultOrder = next
  else appStore.vaults = next
  await api.saveSettings({ vaults: next })
}

/** 从最近列表移除(不删除磁盘内容) */
export async function forgetVault(vaultPath: string): Promise<void> {
  const next = appStore.vaults.filter(v => v !== vaultPath)
  appStore.vaults = next
  await api.saveSettings({ vaults: next })
}

/**
 * 剔除已经不存在的仓库,并写回设置(否则下次启动它们又会回来)。
 *
 * 列表里记的是绝对路径,文件夹被删除、改名或所在磁盘/外接盘不在时就失效了;
 * 选择页每次出现都查一遍。主进程只报告**确认没了**的项(见 missingVaults),
 * 而且只删这次查过的那些 —— 查询期间用户可能刚打开一个新的仓库,它不在这批
 * 结果里,不能跟着一起消失。
 */
export async function pruneMissingVaults(): Promise<void> {
  // 复制成普通数组再走 IPC:store 里是 reactive 代理,结构化克隆不接受 Proxy
  const paths = [...(pendingVaultOrder ?? appStore.vaults)]
  if (paths.length === 0) return
  const missing = await api.missingVaults(paths).catch(err => {
    console.error('[iMark] 检查仓库路径失败', err)
    return null
  })
  // 查询本身失败时保持原样:宁可多留一项,也不能凭一次失败把用户的仓库弄丢
  if (!missing) return
  const gone = new Set(missing)
  if (gone.size === 0) return
  const filter = (list: string[]): string[] => list.filter(v => !gone.has(v))
  // 按查询结束时的顺序过滤:期间用户可能刚置顶了一个仓库,不能拿旧顺序盖回去。
  // 存盘用**普通数组** —— store 里读到的是 reactive 代理,不能直接过 IPC
  const next = filter(pendingVaultOrder ?? appStore.vaults)
  appStore.vaults = filter(appStore.vaults)
  if (pendingVaultOrder) pendingVaultOrder = filter(pendingVaultOrder)
  try {
    await api.saveSettings({ vaults: next })
  } catch (err) {
    console.error('[iMark] 清理失效仓库后保存设置失败', err)
  }
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
  // 选择页已经让位,这时再重排最近仓库列表
  applyPendingVaultOrder()
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

/**
 * 这个文件落在哪个已知仓库里。取最深的那个 —— 仓库可以嵌套,
 * 选外层会让文件浏览器的根离文件很远。都不包含时返回 null。
 */
function containingVault(filePath: string): string | null {
  const candidates = appStore.vaultPath
    ? [appStore.vaultPath, ...appStore.vaults]
    : appStore.vaults
  let best: string | null = null
  for (const vault of candidates) {
    if (isInside(vault, filePath) && (!best || vault.length > best.length)) best = vault
  }
  return best
}

/**
 * 清掉眼前的仓库上下文。
 *
 * 回到选择界面时旧仓库树还留在 store 里(判定要不要恢复会话时不看它),
 * 这时候打开一个仓库外的文件,不清掉的话侧栏会挂着上一个仓库的目录,
 * 状态栏也写着它的名字 —— 与编辑器里那份文件对不上。
 */
function clearVaultState(): void {
  appStore.vaultPath = null
  appStore.vaultName = null
  appStore.vaultTree = null
  appStore.vaultFiles = []
  appStore.expandedDirs = new Set<string>()
}

/**
 * 打开系统递过来的文件(双击 .md / 资源管理器「打开方式」;见 main/openFile.ts)。
 *
 * 两种到达方式共用这里:启动参数(渲染层初始化完主动来取)与另一个实例转交的文件
 * (主进程推事件)。
 *
 * 还停在仓库选择界面时**不再要求先选仓库**:文件属于某个最近用过的仓库,就静默
 * 载入那个仓库再打开它(文件浏览器、快速切换器才有上下文);不属于任何已知仓库时
 * 直接进编辑器打开这一份,不擅自把上级目录登记成新仓库 —— 那等于递归扫一遍任意
 * 目录(桌面、主目录都可能是它)。
 */
export async function openFileFromSystem(path: string): Promise<void> {
  if (appStore.view === 'picker') {
    const vault = containingVault(path)
    if (vault) {
      // 仓库已在另一个窗口开着时,loadVault 会把文件一起递过去;本窗口不要再打开它
      const loaded = await loadVault(vault, { silent: true, filePath: path })
      if (!loaded) {
        if (vaultHandedOff) return
        // 载入失败(仓库被删/不可读)按「仓库外文件」处理,别把旧仓库留在侧栏
        clearVaultState()
      }
    } else {
      clearVaultState()
    }
    await enterEditorAndWait()
  }
  await openFileByPath(path)
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

/**
 * 把文件/目录移动到另一个目录下(只换位置,不改名)。
 *
 * 目标已存在时由主进程拒绝(见 main/vault.ts),所以拖到一个已有同名项的目录里
 * 会提示失败而不是覆盖。移动的是目录时,它自己的展开状态与打开标签都要跟着换前缀。
 */
export async function moveNode(node: VaultNode, targetDir: string): Promise<boolean> {
  const to = joinPath(targetDir, node.name)
  if (to === node.path) return true
  // 目录不能移进自己或自己的子孙:文件系统会报 EINVAL,先挡住给出说得清的原因
  if (node.type === 'dir' && isInside(node.path, targetDir)) {
    pushNotice('不能把文件夹移动到它自己里面', { title: '文件', level: 'warn' })
    return false
  }
  try {
    await api.renamePath(node.path, to)
  } catch (err) {
    fail(err, '移动')
    return false
  }
  // 展开状态记的是绝对路径:目录挪窝后,它和它下面展开的子目录都要换前缀
  const expanded = new Set<string>()
  for (const p of appStore.expandedDirs) {
    expanded.add(
      node.type === 'dir' && isInside(node.path, p)
        ? to + p.slice(node.path.length)
        : p
    )
  }
  // 落点目录展开,让用户直接看到移进去的东西
  expanded.add(targetDir)
  appStore.expandedDirs = expanded
  await refreshVault()
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
  // 文件没了,盯着它的标签也一起关掉(不再留成未命名文档)
  closeDeletedPath(node.path, node.type === 'dir')
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
