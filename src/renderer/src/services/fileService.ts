import type { EditorView } from '@codemirror/view'
import type { Settings } from '@shared/types'
import { managedImageRefs } from '@shared/imageAssets'
import { activeTab, appStore, editorHolder } from '../stores/app'
import { flushTableEdits } from '../editor/wysiwyg/widgets'
import { basename, stripMarkdownExt, toEol } from '../utils/text'
import { isInside } from '../utils/paths'
import { renderHtml } from './exportHtml'
import { notifyError } from './notice'
import { takePastedImages } from './pastedImages'
import { api } from './api'
import {
  activateTab,
  addTab,
  captureActiveTab,
  clearTabs,
  closeTabNow,
  markTabSaved,
  persistSession,
  replaceTabDocument,
  setSessionPersistSuspended,
  setTabPath,
  tabById,
  tabByPath,
  tabText,
  type DocTab
} from './tabs'

function requireView(): EditorView | null {
  const view = editorHolder.view
  if (!view) console.error('[iMark] 编辑器实例未就绪')
  return view
}

/**
 * 保存成功后,回收正文里已经不再出现的粘贴图片(主进程负责移到系统回收站)。
 *
 * 两类来源:
 * 1. 上一次落盘时还在、这次不在了的引用(保存前后比较);
 * 2. 本会话刚粘贴、还没经过任何一次保存就被删掉的图片(见 pastedImages)——
 *    这类图从未出现在「保存前正文」里,只靠比较是发现不了的。
 *
 * 只传裸文件名,真正的校验与「同目录其他笔记是否还引用」由主进程复核。
 * 清理失败只记日志:一次已经成功的保存不能因此变成失败。
 */
async function trashRemovedImages(
  docPath: string | null,
  before: string,
  after: string
): Promise<void> {
  if (!docPath) return
  // 记账取出即清空:这次落盘之后,正文里的引用归「保存前后比较」管
  const pasted = takePastedImages(docPath)
  const beforeRefs = managedImageRefs(before)
  // 常见情况是这份文档从来没出现过粘贴图片:旧正文扫完就能收工,新正文那遍省掉
  if (!beforeRefs.size && !pasted.size) return
  const afterRefs = managedImageRefs(after)
  const names = new Set<string>()
  for (const name of beforeRefs) {
    if (!afterRefs.has(name)) names.add(name)
  }
  for (const name of pasted) {
    if (!afterRefs.has(name)) names.add(name)
  }
  if (!names.size) return
  try {
    await api.trashImageAssets(docPath, [...names])
  } catch (err) {
    console.error('[iMark] 回收已删除的图片失败', err)
  }
}

/**
 * 新建未命名标签页。
 *
 * 不再「替换当前文档」:当前文档留在它自己的标签里,新建只是再开一页。
 * 因此也不需要对旧文档做脏确认 —— 它没有被关掉。
 */
export async function newFile(): Promise<void> {
  addTab({ filePath: null, fileName: '未命名', content: '', eol: 'LF' })
  editorHolder.view?.focus()
}

export interface OpenFileOptions {
  /** 打开失败时不弹提示(启动恢复用) */
  silent?: boolean
  /** 已经在标签里也重新读盘(外部改动后刷新) */
  force?: boolean
  /** 只建标签、不激活(恢复会话时先把标签全建出来) */
  background?: boolean
  /** 是否立刻写会话设置;恢复期间由调用方统一写一次 */
  persist?: boolean
}

/**
 * 打开文件 → 标签页。
 *
 * 已经开着的文件不会再开一份,而是激活它 —— 否则同一个文件会出现两个标签,
 * 各自持有不同的未保存内容,谁也不知道最后保存的是哪一份。
 */
export async function openFileByPath(path: string, opts?: OpenFileOptions): Promise<boolean> {
  const existing = tabByPath(path)
  if (existing && !opts?.force) {
    if (!opts?.background) activateTab(existing.id)
    return true
  }
  try {
    const { content, eol } = await api.readFile(path)
    if (existing) {
      replaceTabDocument(existing.id, content, eol)
      if (!opts?.background) activateTab(existing.id)
      return true
    }
    addTab(
      { filePath: path, fileName: basename(path), content, eol },
      { activate: !opts?.background, persist: opts?.persist }
    )
    if (!opts?.background) editorHolder.view?.focus()
    return true
  } catch (err) {
    if (!opts?.silent) {
      notifyError('打开文件', err)
    }
    return false
  }
}

export async function openFileViaDialog(): Promise<void> {
  const path = await api.openFileDialog()
  if (path) await openFileByPath(path)
}

/**
 * 打开系统递过来的文件(双击 .md / 资源管理器「打开方式」;见 main/openFile.ts)。
 *
 * 两种到达方式共用这里:启动参数(渲染层初始化完主动来取)与运行中的第二个实例
 * (主进程推事件)。停在仓库选择界面时**不处理** —— 那时没有编辑器实例,
 * 而把一个文件硬塞进「还没选仓库」的界面只会让状态说不清;用户先开仓库,再双击文件即可。
 */
export async function openFileFromSystem(path: string): Promise<void> {
  if (!editorHolder.view) return
  await openFileByPath(path)
}

/**
 * 恢复上次会话:先恢复所有文件标签,再激活上次那一页。
 *
 * 规则:
 * - lastFile 为空但 openFiles 还有文件 = 上次停在未命名页 → 恢复那些文件,
 *   激活最后打开的那个(未命名页本身没有路径,内容恢复不了);
 * - 一个可恢复的文件都没有 → 回到空状态;
 * - 连 lastFile 都读不出来(被删了)→ 全部不开,并清掉记忆;
 * - 其余打开的标签读不出来的逐个跳过,不因一个坏文件拖垮整个会话。
 */
export async function restoreSession(
  vaultPath: string,
  settings: Pick<Settings, 'lastFile' | 'openFiles'>
): Promise<void> {
  let lastFile = settings.lastFile
  const remembered = settings.openFiles.filter(p => isInside(vaultPath, p))
  if (!lastFile) {
    // 当前页是未命名文档(它没有路径,内容也不跨启动保存),但同一会话里开着的
    // 文件标签仍然要恢复 —— 它们并没有被关掉。一个文件标签都没有才回空状态
    lastFile = remembered[remembered.length - 1] ?? null
    if (!lastFile) {
      clearTabs()
      return
    }
  } else if (!isInside(vaultPath, lastFile)) {
    // 当前页在仓库外(Ctrl+O 打开了别的目录里的文件):仓库内的标签仍然值得恢复,
    // 激活它们当中最后打开的那个;一个仓库内标签都没有才回到空状态
    lastFile = remembered[remembered.length - 1] ?? null
    if (!lastFile) {
      clearTabs()
      return
    }
  }

  setSessionPersistSuspended(true)
  try {
    // 当前页必须能读出来;这个判断决定了「上次的文件被删了」时是否整组放弃
    let lastRead: { content: string; eol: 'LF' | 'CRLF' }
    try {
      lastRead = await api.readFile(lastFile)
    } catch {
      setSessionPersistSuspended(false)
      clearTabs()
      return
    }

    clearTabs()
    const order: string[] = []
    for (const p of remembered) if (!order.includes(p)) order.push(p)
    if (!order.includes(lastFile)) order.push(lastFile)

    for (const path of order) {
      let read: { content: string; eol: 'LF' | 'CRLF' } | null = null
      if (path === lastFile) read = lastRead
      else {
        try {
          read = await api.readFile(path)
        } catch {
          // 文件在两次启动之间被删/改名:跳过它,别让整个会话打不开
        }
      }
      if (!read) continue
      addTab(
        { filePath: path, fileName: basename(path), content: read.content, eol: read.eol },
        { activate: false, index: appStore.tabs.length, persist: false }
      )
    }

    const target = tabByPath(lastFile)
    if (target) activateTab(target.id, { persist: false })
    else if (appStore.tabs[0]) activateTab(appStore.tabs[0].id, { persist: false })
  } finally {
    setSessionPersistSuspended(false)
    persistSession()
  }
}

// ---------- 保存 ----------

/** 未命名文档的默认文件名 */
function defaultSaveName(tab: DocTab): string {
  return tab.fileName.endsWith('.md')
    ? tab.fileName
    : `${stripMarkdownExt(tab.fileName)}.md`
}

/**
 * 把某个标签的内容写回指定路径。
 *
 * 单独抽出来是给自动保存用的:那条路径上没有人看着,不能像"保存"那样
 * 在没有路径时回落到「另存为」—— 那会凭空弹出一个对话框打断正在打字的人。
 * 内容在这里现取,不吃调用方的时间差。
 */
export async function writeTabInPlace(tabId: string, path: string): Promise<void> {
  const tab = tabById(tabId)
  if (!tab) throw new Error('标签页不存在')
  // 正在编辑的表格单元格里可能还有没提交的字:先刷回文档再取文本
  const text = tabText(tabId, { flush: true })
  if (text === null) throw new Error('编辑器未就绪')
  // 这一轮写盘之前的「已保存正文」:保存成功后拿它和 text 比,找出被删掉的图片引用。
  // 取目标标签自己的基准 —— 自动保存/关闭流程可能正在后台保存别人
  const before = tab.savedContent
  await api.writeFile(path, toEol(text, tab.eol))
  // markTabSaved 会在写盘这一小会儿里用户又改过/切走时保留脏标记
  // (只有内容仍是刚写的那份才清);两个判断都以目标标签为准
  markTabSaved(tabId, text)
  // 无论这段时间里用户是否又改过/切走了,这次写盘的正文都是确定的:
  // 按它清理,而不是按编辑器里此刻的内容。先更新保存状态再清理 ——
  // 回收资产要跟回收站打交道,不该拖着脏标记不放
  await trashRemovedImages(path, before, text)
}

/** 保存指定标签;未落过盘就走「另存为」 */
export async function saveTab(tabId: string): Promise<boolean> {
  const tab = tabById(tabId)
  if (!tab) return false
  if (!tab.filePath) return saveTabAs(tabId)
  try {
    await writeTabInPlace(tabId, tab.filePath)
    return true
  } catch (err) {
    notifyError('保存', err)
    return false
  }
}

export async function saveCurrentFile(): Promise<boolean> {
  const tab = activeTab()
  // 没有打开文档时保存没有对象 —— 别为此弹出一个「另存为」把空文件落盘
  if (!tab) return false
  return saveTab(tab.id)
}

export async function saveFileAs(): Promise<boolean> {
  const tab = activeTab()
  if (!tab) return false
  return saveTabAs(tab.id)
}

export async function saveTabAs(tabId: string): Promise<boolean> {
  const tab = tabById(tabId)
  if (!tab) return false
  const view = requireView()
  if (!view) return false
  // 正在编辑的表格单元格里可能还有没提交的字
  flushTableEdits()
  const text = tabText(tabId, { flush: false })
  if (text === null) return false

  const target = await api.saveFileDialog({
    defaultPath: tab.filePath ?? undefined,
    defaultName: defaultSaveName(tab),
    kind: 'md'
  })
  if (!target) return false

  // 另存为之前的那份文档:旧路径旁的 assets/ 里可能已有被删掉的图片,清理要按它算
  const previousPath = tab.filePath
  const before = tab.savedContent
  try {
    await api.writeFile(target, toEol(text, 'LF'))
  } catch (err) {
    notifyError('保存', err)
    return false
  }
  setTabPath(tab.id, target, 'LF')
  markTabSaved(tab.id, text)
  // 旧文件如果还在原地,它自己的正文仍可能引用着这些图片 —— 主进程会扫描同目录
  // 笔记,那种情况自然保留
  await trashRemovedImages(previousPath, before, text)
  return true
}

/** 逐个保存所有脏标签;任何一步取消/失败都返回 false(关闭流程据此中止) */
export async function saveAllDirtyTabs(): Promise<boolean> {
  for (const tab of [...appStore.tabs]) {
    if (!tab.dirty) continue
    if (!(await saveTab(tab.id))) return false
  }
  return true
}

/**
 * 静默保存所有**有路径**的脏标签(未命名文档跳过,绝不弹「另存为」)。
 * 扩展同步前刷盘、切换窗口时自动保存走这条。
 */
export async function saveAllFileTabsSilently(): Promise<void> {
  for (const tab of [...appStore.tabs]) {
    if (!tab.dirty || !tab.filePath) continue
    try {
      await writeTabInPlace(tab.id, tab.filePath)
    } catch (err) {
      console.error('[iMark] 自动保存失败', err)
    }
  }
}

/** 关闭窗口前由主进程触发的保存流程,完成后必须通知主进程 */
export async function saveBeforeClose(): Promise<void> {
  // 仓库选择界面下没有编辑器实例、或一个标签都没开,无需保存,直接放行关闭
  if (!editorHolder.view || appStore.tabs.length === 0) {
    api.notifySaveDone(true)
    return
  }
  const ok = await saveAllDirtyTabs()
  api.notifySaveDone(ok)
}

export async function exportHtmlFile(): Promise<void> {
  const view = requireView()
  const tab = activeTab()
  if (!view || !tab) return
  flushTableEdits()
  // Mermaid 是异步渲染,导出得等所有图表画完再落盘
  const html = await renderHtml(view.state.doc.toString(), tab.fileName)
  const target = await api.saveFileDialog({
    defaultName: `${stripMarkdownExt(tab.fileName)}.html`,
    kind: 'html'
  })
  if (!target) return
  try {
    await api.writeFile(target, html)
  } catch (err) {
    notifyError('导出', err)
  }
}

// ---------- 关闭 ----------

/** 脏标签关闭前的确认;返回 false = 用户取消(或保存失败) */
async function confirmDiscardTab(tab: DocTab): Promise<boolean> {
  if (!tab.dirty) return true
  const choice = await api.confirmDiscard(tab.fileName)
  if (choice === 'cancel') return false
  if (choice === 'save') return saveTab(tab.id)
  return true
}

/** 关闭一个标签(带脏确认) */
export async function closeTab(tabId: string): Promise<boolean> {
  const tab = tabById(tabId)
  if (!tab) return false
  // 脏标记是 250ms 防抖出来的。刚敲完字就点关闭时它可能还是 false,
  // 关之前把当前视图收一次,别让最后几个字被静默丢掉
  if (appStore.activeTabId === tabId) captureActiveTab()
  if (!(await confirmDiscardTab(tab))) return false
  closeTabNow(tabId)
  return true
}

/**
 * 切仓库前关闭全部标签:逐个处理脏文档;全部处理完才清空。
 * 任何一步取消都停在原地 —— 半关一半会让用户以为仓库切换失败。
 */
export async function closeAllTabsForSwitch(): Promise<boolean> {
  // 同 closeTab:先把当前视图里尚未结算的改动收进标签,再逐个问
  captureActiveTab()
  for (const tab of [...appStore.tabs]) {
    if (!(await confirmDiscardTab(tab))) return false
  }
  clearTabs()
  return true
}
