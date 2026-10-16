import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'
import { clampFontSize, clampInterval, EDITOR_DEFAULTS } from '@shared/editorSettings'

const DEFAULTS: Settings = {
  theme: 'light',
  outline: true,
  explorer: true,
  vaultPath: null,
  lastFile: null,
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
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * 磁盘数据只做顶层合并,这里补一层浅校验:嵌套结构(目前只有 plugins)
 * 若被手改成非法形状,就地落回默认值,避免各处读取时崩。
 * 插件内部的字段级默认值由插件宿主负责补(那里才知道各插件的字段表)。
 */
function normalize(raw: Partial<Settings>): Settings {
  const merged = { ...DEFAULTS, ...raw }
  const plugins = merged.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    merged.plugins = {}
  }
  // 数值型的编辑器偏好逐个夹回区间:settings.json 是纯文本,手改成 0 秒会让渲染层的
  // 定时器变成疯狂写盘,改成字符串则会让它一直空转。放在这里比在各处读时判要可靠
  merged.autoSaveInterval = clampInterval(merged.autoSaveInterval)
  merged.editorFontSize = clampFontSize(merged.editorFontSize)
  merged.autoSave = merged.autoSave === true
  merged.lineWrapping = merged.lineWrapping !== false
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

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const prev = cache ?? (await loadSettings())
  const next: Settings = { ...prev, ...partial }
  cache = next
  try {
    await mkdir(dirname(settingsPath()), { recursive: true })
    await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
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
