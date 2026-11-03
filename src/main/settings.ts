import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AutoSaveMode, Settings, Theme } from '@shared/types'
import {
  clampAutoSaveDelay,
  clampCodeIndentSize,
  clampBlockSpace,
  clampFontSize,
  clampHeadingSpace,
  clampLineSpace,
  EDITOR_DEFAULTS,
  EDITOR_FONT_SIZE_VERSION
} from '@shared/editorSettings'
import { dataRoot } from './dataDir'
import { writeFileAtomic } from './files'

const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange']

const THEMES: readonly Theme[] = ['light', 'dark']

/** 主题校验 */
function normalizeTheme(value: unknown): Theme {
  return (THEMES as readonly unknown[]).includes(value) ? (value as Theme) : DEFAULTS.theme
}

/**
 * 侧栏宽度:settings.json 是纯文本,可能被手改成 0、负数或字符串。
 * 夹在 [160, 640] —— 再窄按钮会被裁掉,再宽正文栏就没有位置了。
 */
function clampSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 240
  return Math.round(Math.min(Math.max(value, 160), 640))
}

const DEFAULTS: Settings = {
  theme: 'light',
  outline: true,
  explorer: true,
  explorerWidth: 240,
  outlineWidth: 240,
  vaultPath: null,
  lastFile: null,
  openFiles: [],
  ...EDITOR_DEFAULTS,
  vaults: [],
  skipVaultPicker: false,
  // 默认不选:新用户开箱就自己挑一个样式,比替他把示例选上更合直觉
  userStyle: null,
  extensions: {},
  extensionHost: { mode: 'shared', affinity: {} },
  // 默认指向仓库里自带的那个自托管服务(`npm run market` 起的那个)
  marketUrl: 'http://127.0.0.1:8787',
  marketAutoCheck: true,
  marketWarnedPlainHttp: []
}

let cache: Settings | null = null

function settingsPath(): string {
  return join(dataRoot(), 'settings.json')
}

function isAutoSaveMode(v: unknown): v is AutoSaveMode {
  return typeof v === 'string' && (AUTO_SAVE_MODES as readonly string[]).includes(v)
}

/**
 * 字号迁移:旧版 settings.json 里没有版本号,那个值是「基准」,
 * 实际正文是它的 1.375 倍。新版直接存实际 px —— 读到旧文件时换算一次,
 * 升级后字号不会突然变小。
 */
const LEGACY_EDITOR_FONT_SCALE = 1.375

function normalizeEditorFontSize(raw: Partial<Settings>): number {
  const legacy = raw.editorFontSizeVersion !== EDITOR_FONT_SIZE_VERSION
  const px =
    legacy && typeof raw.editorFontSize === 'number' && Number.isFinite(raw.editorFontSize)
      ? raw.editorFontSize * LEGACY_EDITOR_FONT_SCALE
      : raw.editorFontSize
  return clampFontSize(px)
}

/** 自动保存:两个字段都只做校验与夹取 */
function normalizeAutoSave(
  raw: Partial<Settings>
): Pick<Settings, 'autoSaveMode' | 'autoSaveDelay'> {
  return {
    autoSaveMode: isAutoSaveMode(raw.autoSaveMode) ? raw.autoSaveMode : DEFAULTS.autoSaveMode,
    autoSaveDelay: clampAutoSaveDelay(raw.autoSaveDelay)
  }
}

/**
 * 磁盘数据只做顶层合并,这里补一层浅校验:嵌套结构若被手改成非法形状,
 * 就地落回默认值,避免各处读取时崩。扩展内部的字段级默认值由扩展服务负责补
 * (那里才知道各扩展的字段表)。
 */
function normalize(raw: Partial<Settings>): Settings {
  const merged = { ...DEFAULTS, ...raw } as Settings & Record<string, unknown>
  if (!merged.extensions || typeof merged.extensions !== 'object' || Array.isArray(merged.extensions)) {
    merged.extensions = {}
  }
  const host = merged.extensionHost
  if (!host || typeof host !== 'object' || Array.isArray(host)) {
    merged.extensionHost = { mode: 'shared', affinity: {} }
  } else {
    // 默认共享;只有明确选择「独立进程」时才保留 isolated
    const mode = host.mode === 'isolated' ? 'isolated' : 'shared'
    const affinity: Record<string, number> = {}
    if (host.affinity && typeof host.affinity === 'object' && !Array.isArray(host.affinity)) {
      for (const [id, value] of Object.entries(host.affinity)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        const n = Math.trunc(value)
        if (n >= 0) affinity[id] = n
      }
    }
    merged.extensionHost = { mode, affinity }
  }
  // 标签会话:只接受非空字符串。被手改成别的形状时当作「没有记住任何标签」,
  // 而不是让恢复流程拿着一串对象去读文件
  if (!Array.isArray(merged.openFiles)) merged.openFiles = []
  else {
    merged.openFiles = merged.openFiles.filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    )
  }
  // 数值型的编辑器偏好逐个夹回区间:settings.json 是纯文本,手改成 0 秒会让渲染层的
  // 定时器变成疯狂写盘,改成字符串则会让它一直空转。放在这里比在各处读时判要可靠
  Object.assign(merged, normalizeAutoSave(raw))
  merged.theme = normalizeTheme(merged.theme)
  merged.editorFontSize = normalizeEditorFontSize(raw)
  merged.editorFontSizeVersion = EDITOR_FONT_SIZE_VERSION
  merged.lineSpace = clampLineSpace(merged.lineSpace, EDITOR_DEFAULTS.lineSpace)
  // 旧版「行间距」存的是行高倍数(1.9 = 1.9 × 字号),现在改成档位(行高 = 1 + 档)。
  // 该字段只在本轮开发里出现过、没有发布,读到就丢掉,由 lineSpace 的默认 1 档接手。
  delete (merged as Record<string, unknown>).lineHeight
  merged.codeIndentSize = clampCodeIndentSize(merged.codeIndentSize)
  merged.headingSpaceBefore = clampHeadingSpace(
    merged.headingSpaceBefore,
    EDITOR_DEFAULTS.headingSpaceBefore
  )
  merged.headingSpaceAfter = clampHeadingSpace(
    merged.headingSpaceAfter,
    EDITOR_DEFAULTS.headingSpaceAfter
  )
  merged.headingSpaceBetween = clampHeadingSpace(
    merged.headingSpaceBetween,
    EDITOR_DEFAULTS.headingSpaceBetween
  )
  merged.bodySpaceBetween = clampBlockSpace(
    merged.bodySpaceBetween,
    EDITOR_DEFAULTS.bodySpaceBetween
  )
  merged.codeSpaceBefore = clampBlockSpace(merged.codeSpaceBefore, EDITOR_DEFAULTS.codeSpaceBefore)
  merged.codeSpaceAfter = clampBlockSpace(merged.codeSpaceAfter, EDITOR_DEFAULTS.codeSpaceAfter)
  merged.listSpaceBefore = clampBlockSpace(merged.listSpaceBefore, EDITOR_DEFAULTS.listSpaceBefore)
  merged.listSpaceAfter = clampBlockSpace(merged.listSpaceAfter, EDITOR_DEFAULTS.listSpaceAfter)
  merged.quoteSpaceBefore = clampBlockSpace(
    merged.quoteSpaceBefore,
    EDITOR_DEFAULTS.quoteSpaceBefore
  )
  merged.quoteSpaceAfter = clampBlockSpace(merged.quoteSpaceAfter, EDITOR_DEFAULTS.quoteSpaceAfter)
  merged.lineWrapping = merged.lineWrapping !== false
  merged.explorerWidth = clampSidebarWidth(merged.explorerWidth)
  merged.outlineWidth = clampSidebarWidth(merged.outlineWidth)
  return merged
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    cache = normalize(JSON.parse(raw) as Partial<Settings>)
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function getSettings(): Promise<Settings> {
  return loadSettings()
}

/**
 * 同步读取已载入的设置缓存。**只给那些无法等待的路径用**(扩展宿主在加载脚本扩展时
 * 必须立即拿到配置,没法把 createRequire 变成异步)。
 * 返回 null 表示还没载入过 —— 应用启动流程保证 `loadSettings()` 早就跑过了。
 */
export function getSettingsSync(): Settings | null {
  return cache
}

/**
 * 设置变更的订阅者。
 *
 * 为什么要在这里、而不是在 IPC 处理器里判:改设置的路径不止一条 ——
 * 渲染层、市场配置、扩展宿主自己都在写。把「换了仓库要通知扩展」挂在其中一条上,
 * 另外几条就静默漏掉了,而漏掉的表现是扩展的行为对不上实际设置,极难查。
 * saveSettings 是唯一的漏斗,挂在它上面天然覆盖全部路径。
 *
 * 用订阅而不是让这里直接调扩展宿主:extensions/service.ts 已经 import 了本文件,
 * 反过来 import 会绕成一个圈。
 */
type SettingsListener = (next: Settings, prev: Settings) => void
const listeners = new Set<SettingsListener>()

export function onSettingsChanged(fn: SettingsListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * 保存队列:**整个「读盘 → 合并 → 写盘」都要串行**,不只是写。
 *
 * 渲染层可能连着发几条 saveSettings —— 切标签、关标签这类操作会连续改状态,
 * 设置页里连着拖几根滑块也一样。原来只把 writeFile 串起来,读盘还在队列外面:
 * 后一条的「读盘」可能读到前一条落盘前的旧快照,合并时又把旧值盖回 cache,
 * 于是「改了三项、磁盘只留下两项」。串行之后每条 saveSettings 都能看到前一条
 * 刚写下的结果,「调用顺序 = 落盘顺序」。
 *
 * 每条仍会在队列里重读磁盘:多开时另一个实例可能刚改过别的字段,写入时要
 * 保留人家那份。
 */
let saveChain: Promise<unknown> = Promise.resolve()

async function commitSettings(partial: Partial<Settings>): Promise<Settings> {
  const prev = cache ?? (await loadSettings())
  // 多开时另一个实例可能刚改过别的字段。写前再读一次磁盘,只把本次的 partial
  // 叠上去;否则本实例内存里的整份快照会把人家刚写的改动盖回旧值。
  // 读失败(第一次保存/文件正在被替换)就按没有磁盘状态处理。
  let onDisk: Partial<Settings> = {}
  try {
    // 先按与加载相同的规则归一化:旧文件的字号要在这里也换算一次。
    // 否则「内存里已迁移、磁盘还是旧值」时,这次写入会把旧值原样盖回来。
    onDisk = normalize(JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<Settings>)
  } catch {
    /* 忽略,用内存里的 */
  }
  const next = normalize({ ...prev, ...onDisk, ...partial })
  cache = next
  try {
    await mkdir(dirname(settingsPath()), { recursive: true })
    // 原子写:另一个实例随时可能在读,不能让它看到写了一半的 JSON
    await writeFileAtomic(settingsPath(), JSON.stringify(next, null, 2))
  } catch {
    /* 落盘失败不影响本次会话 */
  }
  // 订阅者的异常不能反过来把保存搞失败 —— 保存是用户按下的动作,必须成功
  for (const fn of listeners) {
    try {
      fn(next, prev)
    } catch (err) {
      console.error('[iMark] 设置变更通知出错:', err)
    }
  }
  return next
}

export function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const run = saveChain.then(() => commitSettings(partial))
  // 队列本身不传播失败:一次保存出错不该把后续保存全部卡住
  saveChain = run.catch(() => undefined)
  return run
}
