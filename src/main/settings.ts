import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Settings } from '@shared/types'

const DEFAULTS: Settings = {
  theme: 'light',
  outline: true,
  explorer: true,
  vaultPath: null,
  lastFile: null,
  vaults: [],
  skipVaultPicker: false,
  plugins: {}
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

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(cache ?? (await loadSettings())), ...partial }
  cache = next
  try {
    await mkdir(dirname(settingsPath()), { recursive: true })
    await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 落盘失败不影响本次会话 */
  }
  return next
}
