import type { AutoSaveMode, Settings } from '@shared/types'
import {
  BLOCK_KINDS,
  clampAutoSaveDelay,
  clampCodeIndentSize,
  clampFontSize,
  clampLineSpace,
  clampPairSpace,
  EDITOR_DEFAULTS,
  PAIR_SPACE_DEFAULT,
  type CodeIndentSize
} from '@shared/editorSettings'
import { appStore, editorHolder } from '../stores/app'
import { applyWrapping, setWrappingPreference } from '../editor/setup'
import { setCodeIndentPreference } from '../editor/codeIndent'
import { restartAutoSave } from './autoSave'
import { api } from './api'

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

/**
 * 行间距(档)挂在文档根上,editor.css 用 var --editor-line-space 算行高
 * (行高 = 1 + 档)。用档而不是 px:正文字号变了,行距自动同比例缩放。
 */
function applyLineSpace(value: number): void {
  appStore.lineSpace = value
  document.documentElement.style.setProperty('--editor-line-space', String(value))
}

/** 全部有序配对 key,如 body-heading、heading-body……共 9 × 9 条 */
const PAIR_KEYS: string[] = BLOCK_KINDS.flatMap(a => BLOCK_KINDS.map(b => `${a}-${b}`))

/**
 * 块与块之间的配对间距(档)。每个有序配对在根上写一个 CSS 变量
 * `--md-gap-<上块>-<下块>`,editor.css 的配对规则用它算下方块的 padding-top。
 * 结构空行在渲染时完全折叠,间距只由这些配对值决定;没设置的按 1 档。
 */
function applyPairGaps(next: Record<string, number>): void {
  const clean: Record<string, number> = {}
  for (const key of PAIR_KEYS) {
    clean[key] = clampPairSpace(next[key], PAIR_SPACE_DEFAULT)
  }
  appStore.pairGaps = clean
  const root = document.documentElement.style
  for (const key of PAIR_KEYS) root.setProperty(`--md-gap-${key}`, String(clean[key]))
}

/**
 * Tab 缩进只影响「下一次按键」,所以既不用碰 EditorView,也不用重建 state:
 * 记到 appStore(设置面板的选中态)和 editor/codeIndent 的模块变量(按键时读)。
 */
function applyCodeIndent(size: CodeIndentSize): void {
  appStore.codeIndentSize = size
  setCodeIndentPreference(size)
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
  appStore.autoSaveMode = s.autoSaveMode
  appStore.autoSaveDelay = clampAutoSaveDelay(s.autoSaveDelay)
  applyLineWrapping(s.lineWrapping)
  applyFontSize(clampFontSize(s.editorFontSize))
  applyLineSpace(clampLineSpace(s.lineSpace, EDITOR_DEFAULTS.lineSpace))
  applyCodeIndent(clampCodeIndentSize(s.codeIndentSize))
  applyPairGaps(s.pairGaps ?? {})
  restartAutoSave()
}

// ---------- 设置面板的写入入口 ----------

/** 切换保存方式。延迟值原样保留:切回定时时还是用户上次挑的那一档 */
export async function setAutoSaveMode(mode: AutoSaveMode): Promise<void> {
  appStore.autoSaveMode = mode
  if (mode === 'off') appStore.autoSavedAt = null
  restartAutoSave()
  await api.saveSettings({ autoSaveMode: mode })
}

export async function setAutoSaveDelay(sec: number): Promise<void> {
  const value = clampAutoSaveDelay(sec)
  appStore.autoSaveDelay = value
  restartAutoSave()
  await api.saveSettings({ autoSaveDelay: value })
}

export async function setLineWrapping(on: boolean): Promise<void> {
  applyLineWrapping(on)
  await api.saveSettings({ lineWrapping: on })
}

export async function setEditorFontSize(px: number): Promise<void> {
  const value = clampFontSize(px)
  applyFontSize(value)
  await api.saveSettings({ editorFontSize: value })
}

/** 拖字号滑块时的即时预览:只改画面,松手才落盘 —— 每挪一格写一次 settings.json 没必要 */
export function previewFontSize(px: number): void {
  applyFontSize(clampFontSize(px))
}

/** 拖行间距滑块时的即时预览:只改画面,松手才落盘(与字号滑块同一套手感) */
export function previewLineSpace(value: number): void {
  applyLineSpace(clampLineSpace(value))
}

export async function setLineSpace(value: number): Promise<void> {
  const next = clampLineSpace(value)
  applyLineSpace(next)
  await api.saveSettings({ lineSpace: next })
}

export async function setCodeIndentSize(size: number): Promise<void> {
  const value = clampCodeIndentSize(size)
  applyCodeIndent(value)
  await api.saveSettings({ codeIndentSize: value })
}

/** 拖配对间距滑块时的即时预览:只改画面,松手才落盘 */
export function previewPairGap(key: string, value: number): void {
  applyPairGaps({ ...appStore.pairGaps, [key]: clampPairSpace(value, PAIR_SPACE_DEFAULT) })
}

export async function setPairGap(key: string, value: number): Promise<void> {
  previewPairGap(key, value)
  await api.saveSettings({ pairGaps: { ...appStore.pairGaps } })
}

/**
 * 「外观 → 间距」的恢复默认:重置正文字号、行间距与全部配对间距,
 * 不动主题、自定义样式与「编辑器」页的偏好。
 */
export async function resetSpacingSettings(): Promise<void> {
  applyFontSize(EDITOR_DEFAULTS.editorFontSize)
  applyLineSpace(EDITOR_DEFAULTS.lineSpace)
  applyPairGaps({})
  await api.saveSettings({
    editorFontSize: EDITOR_DEFAULTS.editorFontSize,
    lineSpace: EDITOR_DEFAULTS.lineSpace,
    pairGaps: {}
  })
}

/**
 * 滚轮走多少距离算一格。鼠标滚轮一格通常是 53/100px(按下 Ctrl 有些平台会变),
 * 触控板则是每帧几个像素的连续小增量 —— 先攒到阈值再走 1px,两种设备的手感才一致。
 */
const FONT_WHEEL_STEP = 40

/** 连续滚动时只在停下来之后写一次盘(和滑块「松手才落盘」同一个道理) */
const FONT_WHEEL_COMMIT_DELAY = 250

let wheelAccum = 0
let wheelCommitTimer: ReturnType<typeof setTimeout> | null = null

function onFontSizeWheel(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  // Ctrl+滚轮在 Chromium 里默认是页面缩放/滚动:拦下来,统一改成正文字号。
  // 捕获阶段就 stopPropagation,编辑器和其他滚动容器不会再用这次滚轮滚动。
  e.preventDefault()
  e.stopPropagation()
  if (e.deltaY === 0) return

  // deltaMode:0 = 像素,1 = 行,2 = 页。归一成像素再累计
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
  wheelAccum += e.deltaY * scale
  if (Math.abs(wheelAccum) < FONT_WHEEL_STEP) return

  // 向上滚(deltaY < 0)放大,向下滚缩小
  const direction = wheelAccum < 0 ? 1 : -1
  wheelAccum = 0
  applyFontSize(clampFontSize(appStore.editorFontSize + direction))

  // 走的是和设置面板同一个落点:appStore 一并更新,面板里的滑块/读数即时跟上
  if (wheelCommitTimer) clearTimeout(wheelCommitTimer)
  wheelCommitTimer = setTimeout(() => {
    wheelCommitTimer = null
    void setEditorFontSize(appStore.editorFontSize)
  }, FONT_WHEEL_COMMIT_DELAY)
}

/**
 * 全窗口监听 Ctrl + 滚轮调字号。
 *
 * 捕获阶段 + passive:false:CodeMirror 和各个滚动容器都会消费 wheel,
 * 冒泡到 window 时常常已经晚了;Ctrl 组合下 preventDefault 同时挡住页面缩放。
 * 返回解绑函数,调用方负责在卸载时收掉(目前 App 常驻,但别留无人回收的全局监听)。
 */
export function installFontSizeWheelZoom(): () => void {
  window.addEventListener('wheel', onFontSizeWheel, { capture: true, passive: false })
  return () => window.removeEventListener('wheel', onFontSizeWheel, { capture: true })
}

/** 「恢复默认」:只重置本页这几项,不碰主题与侧栏 */
export async function resetEditorSettings(): Promise<void> {
  applyLineWrapping(EDITOR_DEFAULTS.lineWrapping)
  applyFontSize(EDITOR_DEFAULTS.editorFontSize)
  applyLineSpace(EDITOR_DEFAULTS.lineSpace)
  applyCodeIndent(EDITOR_DEFAULTS.codeIndentSize)
  applyPairGaps({})
  appStore.autoSaveMode = EDITOR_DEFAULTS.autoSaveMode
  appStore.autoSaveDelay = EDITOR_DEFAULTS.autoSaveDelay
  appStore.autoSavedAt = null
  restartAutoSave()
  await api.saveSettings({ ...EDITOR_DEFAULTS })
}
