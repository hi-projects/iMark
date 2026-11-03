import type { AutoSaveMode, Settings } from '@shared/types'
import {
  BLOCK_SPACE_DEFAULTS,
  clampAutoSaveDelay,
  clampBlockSpace,
  clampCodeIndentSize,
  clampFontSize,
  clampHeadingSpace,
  clampLineSpace,
  EDITOR_DEFAULTS,
  HEADING_SPACE_DEFAULTS,
  type BlockSpaceSide,
  type CodeIndentSize,
  type HeadingSpaceSide
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

/** 三个标题间距(档)挂在文档根上,CSS 里再乘 --editor-body-size —— 跟着字号缩放 */
function applyHeadingSpaces(next: { before: number; after: number; between: number }): void {
  appStore.headingSpaceBefore = next.before
  appStore.headingSpaceAfter = next.after
  appStore.headingSpaceBetween = next.between
  const root = document.documentElement.style
  root.setProperty('--md-heading-space-before', String(next.before))
  root.setProperty('--md-heading-space-after', String(next.after))
  root.setProperty('--md-heading-space-between', String(next.between))
}

function headingSpaces(): { before: number; after: number; between: number } {
  return {
    before: appStore.headingSpaceBefore,
    after: appStore.headingSpaceAfter,
    between: appStore.headingSpaceBetween
  }
}

/** 间距档位 → settings.json 字段名 */
const HEADING_SPACE_FIELD = {
  before: 'headingSpaceBefore',
  after: 'headingSpaceAfter',
  between: 'headingSpaceBetween'
} as const

/**
 * 段落之间、代码块 / 列表 / 引用与正文的七个间距(档),同样挂在文档根上,
 * 由 editor.css 乘 --editor-body-size 得到实际留白。
 */
function applyBlockSpaces(next: Record<BlockSpaceSide, number>): void {
  appStore.bodySpaceBetween = next.bodyBetween
  appStore.codeSpaceBefore = next.codeBefore
  appStore.codeSpaceAfter = next.codeAfter
  appStore.listSpaceBefore = next.listBefore
  appStore.listSpaceAfter = next.listAfter
  appStore.quoteSpaceBefore = next.quoteBefore
  appStore.quoteSpaceAfter = next.quoteAfter
  const root = document.documentElement.style
  root.setProperty('--md-body-space-between', String(next.bodyBetween))
  root.setProperty('--md-code-space-before', String(next.codeBefore))
  root.setProperty('--md-code-space-after', String(next.codeAfter))
  root.setProperty('--md-list-space-before', String(next.listBefore))
  root.setProperty('--md-list-space-after', String(next.listAfter))
  root.setProperty('--md-quote-space-before', String(next.quoteBefore))
  root.setProperty('--md-quote-space-after', String(next.quoteAfter))
}

function blockSpaces(): Record<BlockSpaceSide, number> {
  return {
    bodyBetween: appStore.bodySpaceBetween,
    codeBefore: appStore.codeSpaceBefore,
    codeAfter: appStore.codeSpaceAfter,
    listBefore: appStore.listSpaceBefore,
    listAfter: appStore.listSpaceAfter,
    quoteBefore: appStore.quoteSpaceBefore,
    quoteAfter: appStore.quoteSpaceAfter
  }
}

const BLOCK_SPACE_FIELD = {
  bodyBetween: 'bodySpaceBetween',
  codeBefore: 'codeSpaceBefore',
  codeAfter: 'codeSpaceAfter',
  listBefore: 'listSpaceBefore',
  listAfter: 'listSpaceAfter',
  quoteBefore: 'quoteSpaceBefore',
  quoteAfter: 'quoteSpaceAfter'
} as const

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
  applyHeadingSpaces({
    before: clampHeadingSpace(s.headingSpaceBefore, HEADING_SPACE_DEFAULTS.before),
    after: clampHeadingSpace(s.headingSpaceAfter, HEADING_SPACE_DEFAULTS.after),
    between: clampHeadingSpace(s.headingSpaceBetween, HEADING_SPACE_DEFAULTS.between)
  })
  applyBlockSpaces({
    bodyBetween: clampBlockSpace(s.bodySpaceBetween, BLOCK_SPACE_DEFAULTS.bodyBetween),
    codeBefore: clampBlockSpace(s.codeSpaceBefore, BLOCK_SPACE_DEFAULTS.codeBefore),
    codeAfter: clampBlockSpace(s.codeSpaceAfter, BLOCK_SPACE_DEFAULTS.codeAfter),
    listBefore: clampBlockSpace(s.listSpaceBefore, BLOCK_SPACE_DEFAULTS.listBefore),
    listAfter: clampBlockSpace(s.listSpaceAfter, BLOCK_SPACE_DEFAULTS.listAfter),
    quoteBefore: clampBlockSpace(s.quoteSpaceBefore, BLOCK_SPACE_DEFAULTS.quoteBefore),
    quoteAfter: clampBlockSpace(s.quoteSpaceAfter, BLOCK_SPACE_DEFAULTS.quoteAfter)
  })
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

/** 拖标题间距滑块时的即时预览:只改画面,松手才落盘(与字号滑块同一套手感) */
export function previewHeadingSpace(side: HeadingSpaceSide, value: number): void {
  const next = headingSpaces()
  next[side] = clampHeadingSpace(value, HEADING_SPACE_DEFAULTS[side])
  applyHeadingSpaces(next)
}

export async function setHeadingSpace(side: HeadingSpaceSide, value: number): Promise<void> {
  previewHeadingSpace(side, value)
  await api.saveSettings({ [HEADING_SPACE_FIELD[side]]: headingSpaces()[side] })
}

/** 拖块间距滑块时的即时预览:只改画面,松手才落盘 */
export function previewBlockSpace(side: BlockSpaceSide, value: number): void {
  const next = blockSpaces()
  next[side] = clampBlockSpace(value, BLOCK_SPACE_DEFAULTS[side])
  applyBlockSpaces(next)
}

export async function setBlockSpace(side: BlockSpaceSide, value: number): Promise<void> {
  previewBlockSpace(side, value)
  await api.saveSettings({ [BLOCK_SPACE_FIELD[side]]: blockSpaces()[side] })
}

/**
 * 「外观 → 样式」的恢复默认:重置行间距、标题间距与块间距这十一项,
 * 不动主题、自定义样式与「编辑器」页的偏好。
 */
export async function resetSpacingSettings(): Promise<void> {
  applyLineSpace(EDITOR_DEFAULTS.lineSpace)
  applyHeadingSpaces({ ...HEADING_SPACE_DEFAULTS })
  applyBlockSpaces({ ...BLOCK_SPACE_DEFAULTS })
  await api.saveSettings({
    lineSpace: EDITOR_DEFAULTS.lineSpace,
    headingSpaceBefore: HEADING_SPACE_DEFAULTS.before,
    headingSpaceAfter: HEADING_SPACE_DEFAULTS.after,
    headingSpaceBetween: HEADING_SPACE_DEFAULTS.between,
    bodySpaceBetween: BLOCK_SPACE_DEFAULTS.bodyBetween,
    codeSpaceBefore: BLOCK_SPACE_DEFAULTS.codeBefore,
    codeSpaceAfter: BLOCK_SPACE_DEFAULTS.codeAfter,
    listSpaceBefore: BLOCK_SPACE_DEFAULTS.listBefore,
    listSpaceAfter: BLOCK_SPACE_DEFAULTS.listAfter,
    quoteSpaceBefore: BLOCK_SPACE_DEFAULTS.quoteBefore,
    quoteSpaceAfter: BLOCK_SPACE_DEFAULTS.quoteAfter
  })
}

// ---------- Ctrl + 滚轮调正文字号 ----------

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
  applyHeadingSpaces({ ...HEADING_SPACE_DEFAULTS })
  applyBlockSpaces({ ...BLOCK_SPACE_DEFAULTS })
  appStore.autoSaveMode = EDITOR_DEFAULTS.autoSaveMode
  appStore.autoSaveDelay = EDITOR_DEFAULTS.autoSaveDelay
  appStore.autoSavedAt = null
  restartAutoSave()
  await api.saveSettings({ ...EDITOR_DEFAULTS })
}
