import { BrowserWindow, dialog } from 'electron'
import type { SaveDialogOptions } from '@shared/types'

const MD_FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'txt'] }]

export async function showOpenFileDialog(win: BrowserWindow): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: MD_FILTERS
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

export async function showSaveFileDialog(win: BrowserWindow, o: SaveDialogOptions): Promise<string | null> {
  const filters = o.kind === 'html' ? [{ name: 'HTML', extensions: ['html'] }] : MD_FILTERS
  const r = await dialog.showSaveDialog(win, {
    defaultPath: o.defaultPath ?? o.defaultName,
    filters
  })
  return r.canceled || !r.filePath ? null : r.filePath
}

/**
 * 挑一个样式文件导入。过滤器里保留「所有文件」:有些用户把 CSS 存成 .txt,
 * 让他自己判断比拦在门外强 —— 反正内容读进来是什么就是什么。
 */
export async function showOpenCssDialog(win: BrowserWindow): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'CSS', extensions: ['css'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

/** 挑一个文件夹,把它整个复制成 ~/.imark/css 下的一个样式目录 */
export async function showOpenCssDirDialog(win: BrowserWindow): Promise<string | null> {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

export function showConfirmDiscard(win: BrowserWindow, fileName: string): 'save' | 'discard' | 'cancel' {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    message: `是否保存对「${fileName}」的更改?`,
    detail: '如果不保存,所有更改将丢失。',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })
  return choice === 0 ? 'save' : choice === 1 ? 'discard' : 'cancel'
}

/** 删除确认(回收站语义) */
export function showConfirmDelete(win: BrowserWindow, name: string, isDir: boolean): boolean {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    message: `确定删除「${name}」?`,
    detail: isDir ? '文件夹内的所有内容将移到系统回收站。' : '文件将移到系统回收站。',
    buttons: ['移到回收站', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return choice === 0
}
