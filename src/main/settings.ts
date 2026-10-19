import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AutoSaveMode, Settings, Theme } from '@shared/types'
import { clampAutoSaveDelay, clampFontSize, EDITOR_DEFAULTS } from '@shared/editorSettings'
import { dataRoot } from './dataDir'

/** 上一版用来表达三种自动保存状态的字段;只用于迁移,不再往磁盘上写 */
type LegacyAutoSave = {
  autoSave?: unknown
  autoSaveRealtime?: unknown
  autoSaveInterval?: unknown
}

const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange']

const THEMES: readonly Theme[] = ['light', 'dark']

/**
 * 主题的迁移与校验。
 *
 * 上一版还有一档纯黑(`black`),现在只保留亮色 / 深色两档。存过纯黑的用户
 * 保留「深色」这个偏好,就地落到 `dark`;被手改成未知值的落回默认亮色。
 */
function normalizeTheme(value: unknown): Theme {
  if ((THEMES as readonly unknown[]).includes(value)) return value as Theme
  if (value === 'black') return 'dark'
  return DEFAULTS.theme
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
  plugins: {},
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
 * 自动保存的迁移与夹取。
 *
 * 新版只有 mode + delay 两个字段。旧配置(没有 autoSaveMode)按上一版的
 * autoSave / autoSaveRealtime / autoSaveInterval 推:
 * - 没开自动保存 → off;
 * - 开的是上一版「实时保存」→ afterDelay + 1 秒(它本来就是短延迟的定时保存);
 * - 开的是定时保存 → afterDelay + 原来的间隔。
 */
function normalizeAutoSave(
  raw: Partial<Settings> & LegacyAutoSave
): Pick<Settings, 'autoSaveMode' | 'autoSaveDelay'> {
  if (isAutoSaveMode(raw.autoSaveMode)) {
    return { autoSaveMode: raw.autoSaveMode, autoSaveDelay: clampAutoSaveDelay(raw.autoSaveDelay) }
  }
  if (raw.autoSave !== true) {
    return { autoSaveMode: 'off', autoSaveDelay: EDITOR_DEFAULTS.autoSaveDelay }
  }
  return {
    autoSaveMode: 'afterDelay',
    // 旧版的默认间隔是 30 秒;没有这个字段时按它兜底,别把老用户的节奏悄悄改成 1 秒
    autoSaveDelay: raw.autoSaveRealtime === true ? 1 : clampAutoSaveDelay(raw.autoSaveInterval, 30)
  }
}

/**
 * 磁盘数据只做顶层合并,这里补一层浅校验:嵌套结构(目前只有 plugins)
 * 若被手改成非法形状,就地落回默认值,避免各处读取时崩。
 * 插件内部的字段级默认值由插件宿主负责补(那里才知道各插件的字段表)。
 */
function normalize(raw: Partial<Settings> & LegacyAutoSave): Settings {
  const merged = { ...DEFAULTS, ...raw } as Settings & Record<string, unknown>
  const plugins = merged.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    merged.plugins = {}
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
  merged.editorFontSize = clampFontSize(merged.editorFontSize)
  merged.lineWrapping = merged.lineWrapping !== false
  merged.explorerWidth = clampSidebarWidth(merged.explorerWidth)
  merged.outlineWidth = clampSidebarWidth(merged.outlineWidth)
  // 旧字段不留在磁盘上:下一次 saveSettings 写出的就是新模型
  for (const key of ['autoSave', 'autoSaveRealtime', 'autoSaveInterval']) {
    delete merged[key]
  }
  return merged
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    cache = normalize(JSON.parse(raw) as Partial<Settings> & LegacyAutoSave)
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function getSettings(): Promise<Settings> {
  return loadSettings()
}

/**
 * 同步读取已载入的设置缓存。**只给那些无法等待的路径用**(插件宿主在加载脚本插件时
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
 * 渲染层、市场配置、插件宿主自己都在写。把「换了仓库要通知插件」挂在其中一条上,
 * 另外几条就静默漏掉了,而漏掉的表现是插件的行为对不上实际设置,极难查。
 * saveSettings 是唯一的漏斗,挂在它上面天然覆盖全部路径。
 *
 * 用订阅而不是让这里直接调插件宿主:host.ts 已经 import 了本文件,
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
 * 写盘串行队列。
 *
 * 渲染层可能连着发两条 saveSettings(切标签、关标签这类操作会连续改状态)。
 * IPC 消息按顺序到达,但两个 writeFile 会并发完成 —— 谁最后写完谁留在磁盘上,
 * 完全可能旧快照后完成,把新状态覆盖掉。cache 本身是对的,错的是磁盘,
 * 而磁盘决定了下次启动读到什么。串起来之后「调用顺序 = 落盘顺序」。
 */
let writeChain: Promise<void> = Promise.resolve()

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const prev = cache ?? (await loadSettings())
  const next: Settings = { ...prev, ...partial }
  cache = next
  const snapshot = JSON.stringify(next, null, 2)
  const write = writeChain.then(async () => {
    try {
      await mkdir(dirname(settingsPath()), { recursive: true })
      await writeFile(settingsPath(), snapshot, 'utf8')
    } catch {
      /* 落盘失败不影响本次会话 */
    }
  })
  writeChain = write
  await write
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
