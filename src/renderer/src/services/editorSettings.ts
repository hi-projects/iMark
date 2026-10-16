import type { Settings } from '@shared/types'
import { clampFontSize, clampInterval, EDITOR_DEFAULTS } from '@shared/editorSettings'
import { appStore, editorHolder } from '../stores/app'
import { applyWrapping, setWrappingPreference } from '../editor/setup'
import { restartAutoSave } from './autoSave'

/**
 * 设置面板「编辑器」页背后的一组偏好:读设置套用、改设置落盘。
 *
 * 与主题、侧栏开关一样是「立即生效 + 写盘」,不走「确定/取消」——
 * 设置面板没有确认按钮,改完就该看见效果。
 */

/** 字号挂在文档根上:CSS 变量一路继承到编辑器,改一个值整块正文跟着缩 */
function applyFontSize(px: number): void {
  appStore.editorFontSize = px
  document.documentElement.style.setProperty('--editor-font-size', `${px}px`)
}

function applyLineWrapping(on: boolean): void {
  appStore.lineWrapping = on
  // 先记偏好:打开/新建文件会重建 state,新 state 得跟当前开关一致
  setWrappingPreference(on)
  const view = editorHolder.view
  if (view) applyWrapping(view, on)
}

/** 启动时套用(读设置这件事只在这里做一次,其余入口都是「改一项、写一项」) */
export function initEditorSettings(s: Settings): void {
  appStore.autoSave = s.autoSave
  appStore.autoSaveInterval = clampInterval(s.autoSaveInterval)
  applyLineWrapping(s.lineWrapping)
  applyFontSize(clampFontSize(s.editorFontSize))
  restartAutoSave()
}

// ---------- 设置面板的写入入口 ----------

export async function setAutoSave(on: boolean): Promise<void> {
  appStore.autoSave = on
  if (!on) appStore.autoSavedAt = null
  restartAutoSave()
  await window.api.saveSettings({ autoSave: on })
}

export async function setAutoSaveInterval(sec: number): Promise<void> {
  const value = clampInterval(sec)
  appStore.autoSaveInterval = value
  restartAutoSave()
  await window.api.saveSettings({ autoSaveInterval: value })
}

export async function setLineWrapping(on: boolean): Promise<void> {
  applyLineWrapping(on)
  await window.api.saveSettings({ lineWrapping: on })
}

export async function setEditorFontSize(px: number): Promise<void> {
  const value = clampFontSize(px)
  applyFontSize(value)
  await window.api.saveSettings({ editorFontSize: value })
}

/** 拖字号滑块时的即时预览:只改画面,松手才落盘 —— 每挪一格写一次 settings.json 没必要 */
export function previewFontSize(px: number): void {
  applyFontSize(clampFontSize(px))
}

/** 「恢复默认」:只重置本页这几项,不碰主题与侧栏 */
export async function resetEditorSettings(): Promise<void> {
  applyLineWrapping(EDITOR_DEFAULTS.lineWrapping)
  applyFontSize(EDITOR_DEFAULTS.editorFontSize)
  appStore.autoSave = EDITOR_DEFAULTS.autoSave
  appStore.autoSaveInterval = EDITOR_DEFAULTS.autoSaveInterval
  appStore.autoSavedAt = null
  restartAutoSave()
  await window.api.saveSettings({ ...EDITOR_DEFAULTS })
}
