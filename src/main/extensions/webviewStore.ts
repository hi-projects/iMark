/**
 * webview 面板的跨启动状态（`extensions-data/webviews.json`）。
 *
 * 只存**恢复所需的元数据**：面板 id、归属扩展、viewType、`webview.state`、
 * token、位置与尺寸。HTML 不存 —— 它由扩展在 `deserializeWebviewPanel` 里重新生成，
 * 存一份 HTML 既会让磁盘膨胀，也会让「上次的页面」绕过扩展的当前逻辑。
 *
 * 与 globalState 一样是防抖写盘：面板拖动尺寸会连续触发 setPresentation，
 * 每次拖一像素写一次文件没有意义。启动时一次性读入，恢复完成后由 service 合并
 * 未恢复的记录继续写回。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  WebviewAnchorDto,
  WebviewPresentationDto
} from '@shared/extensionProtocol'
import { writeFileAtomic } from '../files'
import { extensionDataRoot, isValidExtensionId } from './paths'

export interface PersistedWebviewPanel {
  panelId: string
  extensionId: string
  viewType: string
  title: string
  presentation: WebviewPresentationDto
  width: number
  height: number
  transparent: boolean
  anchor: WebviewAnchorDto
  visible: boolean
  active: boolean
  retainContextWhenHidden: boolean
  token: string
  state: unknown
}

interface StoreFile {
  version: 1
  panels: PersistedWebviewPanel[]
}

const PRESENTATIONS = new Set<WebviewPresentationDto>(['sidebar', 'overlay', 'floating'])
const ANCHORS = new Set<WebviewAnchorDto>([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
])
const TOKEN_RE = /^[a-f0-9]{32,64}$/i

function panelFile(): string {
  return join(extensionDataRoot(), 'webviews.json')
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function sanitize(raw: unknown): PersistedWebviewPanel | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const panelId = typeof item.panelId === 'string' ? item.panelId : ''
  const extensionId = typeof item.extensionId === 'string' ? item.extensionId : ''
  const viewType = typeof item.viewType === 'string' ? item.viewType.trim() : ''
  const token = typeof item.token === 'string' ? item.token : ''
  if (!panelId || !viewType || !TOKEN_RE.test(token)) return null
  if (!isValidExtensionId(extensionId)) return null
  const presentation = PRESENTATIONS.has(item.presentation as WebviewPresentationDto)
    ? (item.presentation as WebviewPresentationDto)
    : 'sidebar'
  const anchor = ANCHORS.has(item.anchor as WebviewAnchorDto)
    ? (item.anchor as WebviewAnchorDto)
    : 'bottom-right'
  return {
    panelId,
    extensionId,
    viewType,
    title: typeof item.title === 'string' ? item.title.slice(0, 200) : viewType,
    presentation,
    width: Math.max(0, Math.round(num(item.width, presentation === 'sidebar' ? 420 : 360))),
    height: Math.max(0, Math.round(num(item.height, 480))),
    transparent: item.transparent === true,
    anchor,
    visible: item.visible !== false,
    active: item.active === true,
    retainContextWhenHidden: item.retainContextWhenHidden === true,
    token,
    state: item.state
  }
}

export class WebviewStore {
  private panels: PersistedWebviewPanel[] = []
  private timer: NodeJS.Timeout | null = null
  private loaded = false

  async load(): Promise<PersistedWebviewPanel[]> {
    if (this.loaded) return [...this.panels]
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(panelFile(), 'utf8')) as Partial<StoreFile>
      const raw = parsed.version === 1 && Array.isArray(parsed.panels) ? parsed.panels : []
      const seen = new Set<string>()
      this.panels = raw
        .map(sanitize)
        .filter((panel): panel is PersistedWebviewPanel => {
          if (!panel || seen.has(panel.panelId)) return false
          seen.add(panel.panelId)
          return true
        })
    } catch {
      /* 没有/损坏：按空表处理，不阻塞启动 */
    }
    return [...this.panels]
  }

  /** 全量替换；调用方负责把「尚未恢复」的旧记录一起传进来 */
  replace(panels: readonly PersistedWebviewPanel[]): void {
    this.panels = panels.map(panel => ({ ...panel }))
    this.schedule()
  }

  /** 面板被显式关闭 / 扩展被卸载：从持久化列表里剔除，不等下一次全量写 */
  forget(panelId: string): void {
    this.panels = this.panels.filter(panel => panel.panelId !== panelId)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 200)
    timer.unref?.()
    this.timer = timer
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const file: StoreFile = { version: 1, panels: this.panels }
    try {
      await mkdir(dirname(panelFile()), { recursive: true })
      await writeFileAtomic(panelFile(), JSON.stringify(file, null, 2))
    } catch (err) {
      console.error('[iMark] webview 面板状态写盘失败:', err)
    }
  }
}
