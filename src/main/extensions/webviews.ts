/**
 * webview 面板登记表（main 侧）。
 *
 * main 不渲染 webview：它只保管 `panelId`、归属扩展、token、HTML 与位置尺寸，
 * 把这些变成渲染层的 `WebviewHost.vue` 要的 DTO。三件事必须在这里做对：
 *
 * - **归属**：每条消息都带 `extensionId`，与记录不符就丢弃。renderer 也无法伪造
 *   另一扩展的消息 —— 它拿到的 panelId 只属于自己的面板。
 * - **token**：宿主在 `createWebviewPanel()` 里同步生成，main 校验格式与唯一性。
 *   资源协议会再校验一次 token；这里先保证不会有两个面板共用一个 token。
 * - **HTML**：只存字符串。真正的 CSP 由扩展 HTML 的 meta 提供，iframe 是 sandbox。
 */

import { randomBytes } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'
import type {
  WebviewAnchorDto,
  WebviewPanelCreateRequest,
  WebviewPanelCreateResult,
  WebviewPanelStateDto,
  WebviewPresentationDto
} from '@shared/extensionProtocol'
import type { ExtensionWebviewPanelView } from '@shared/extensions'
import type { PersistedWebviewPanel } from './webviewStore'

const TOKEN_RE = /^[a-f0-9]{32,64}$/i

export interface WebviewRecord {
  panelId: string
  extensionId: string
  /** 扩展根目录；`imark-webview://` 用它解析静态资源 */
  root: string
  viewType: string
  title: string
  presentation: WebviewPresentationDto
  width: number
  height: number
  transparent: boolean
  anchor: WebviewAnchorDto
  visible: boolean
  active: boolean
  html: string
  token: string
  retainContextWhenHidden: boolean
  enableScripts: boolean
  localResourceRoots: string[]
  state: unknown
}

function shortId(): string {
  return randomBytes(6).toString('hex')
}

function defaultSize(presentation: WebviewPresentationDto): { width: number; height: number } {
  return presentation === 'sidebar' ? { width: 420, height: 0 } : { width: 360, height: 480 }
}

export class WebviewRegistry {
  private readonly panels = new Map<string, WebviewRecord>()
  private readonly tokens = new Set<string>()
  private seq = 0

  create(
    extensionId: string,
    extensionRoot: string,
    options: WebviewPanelCreateRequest
  ): { record: WebviewRecord; result: WebviewPanelCreateResult } {
    const token =
      typeof options.token === 'string' && TOKEN_RE.test(options.token) && !this.tokens.has(options.token)
        ? options.token
        : randomBytes(16).toString('hex')
    this.tokens.add(token)

    const presentation = options.presentation ?? 'sidebar'
    const size = defaultSize(presentation)
    const record: WebviewRecord = {
      panelId: `wv-${++this.seq}-${shortId()}`,
      extensionId,
      root: resolve(extensionRoot),
      viewType: options.viewType,
      title: options.title,
      presentation,
      width: options.width ?? size.width,
      height: options.height ?? size.height,
      transparent: options.transparent === true,
      anchor: options.anchor ?? 'bottom-right',
      visible: true,
      active: true,
      html: options.html,
      token,
      retainContextWhenHidden: options.retainContextWhenHidden === true,
      enableScripts: options.enableScripts === true,
      localResourceRoots: normalizeRoots(extensionRoot, options.localResourceRoots),
      state: options.state
    }
    this.panels.set(record.panelId, record)
    const baseUri = `imark-webview://${extensionId}`
    return {
      record,
      result: {
        panelId: record.panelId,
        token,
        baseUri,
        cspSource: baseUri,
        webviewRoot: extensionRoot
      }
    }
  }

  /**
   * 从持久化记录恢复一个面板。
   *
   * 沿用持久化记录里的 panelId 与 token：扩展在 `deserializeWebviewPanel` 里会立刻用
   * `asWebviewUri()` 重新拼资源地址，换 token 会让那批地址在第一帧之后失效。
   * 万一这个 token 已被别的面板占用（正常不会发生），退化成新 token 并通过
   * `webview.restore` 把新值告诉宿主。
   */
  restore(saved: PersistedWebviewPanel, extensionRoot: string): WebviewRecord {
    let token = saved.token
    if (this.tokens.has(token)) token = randomBytes(16).toString('hex')
    this.tokens.add(token)

    const record: WebviewRecord = {
      panelId: saved.panelId,
      extensionId: saved.extensionId,
      root: resolve(extensionRoot),
      viewType: saved.viewType,
      title: saved.title,
      presentation: saved.presentation,
      width: saved.width,
      height: saved.height,
      transparent: saved.transparent,
      anchor: saved.anchor,
      visible: saved.visible,
      active: saved.active,
      html: '',
      token,
      retainContextWhenHidden: saved.retainContextWhenHidden,
      enableScripts: true,
      localResourceRoots: normalizeRoots(extensionRoot, []),
      state: saved.state
    }
    this.panels.set(record.panelId, record)
    return record
  }

  /** 资源协议用：token 是每次面板创建时随机生成的，不能靠 panelId 猜 */
  findByToken(token: string): WebviewRecord | null {
    if (!TOKEN_RE.test(token)) return null
    for (const record of this.panels.values()) {
      if (record.token === token) return record
    }
    return null
  }

  persistedOf(record: WebviewRecord): PersistedWebviewPanel {
    return {
      panelId: record.panelId,
      extensionId: record.extensionId,
      viewType: record.viewType,
      title: record.title,
      presentation: record.presentation,
      width: record.width,
      height: record.height,
      transparent: record.transparent,
      anchor: record.anchor,
      visible: record.visible,
      active: record.active,
      retainContextWhenHidden: record.retainContextWhenHidden,
      token: record.token,
      state: record.state
    }
  }

  get(panelId: string): WebviewRecord | null {
    return this.panels.get(panelId) ?? null
  }

  /** 归属校验：不是这个扩展的面板一律当作不存在 */
  getOwned(panelId: string, extensionId: string): WebviewRecord | null {
    const record = this.panels.get(panelId)
    return record && record.extensionId === extensionId ? record : null
  }

  list(): WebviewRecord[] {
    return [...this.panels.values()]
  }

  listOf(extensionId: string): WebviewRecord[] {
    return this.list().filter(record => record.extensionId === extensionId)
  }

  setHtml(record: WebviewRecord, html: string): void {
    record.html = html
  }

  setTitle(record: WebviewRecord, title: string): void {
    record.title = title
  }

  setState(record: WebviewRecord, state: unknown): void {
    record.state = state
  }

  setPresentation(
    record: WebviewRecord,
    patch: {
      presentation: WebviewPresentationDto
      width?: number
      height?: number
      transparent?: boolean
      anchor?: WebviewAnchorDto
    }
  ): void {
    record.presentation = patch.presentation
    if (patch.width !== undefined) record.width = patch.width
    if (patch.height !== undefined) record.height = patch.height
    if (patch.transparent !== undefined) record.transparent = patch.transparent
    if (patch.anchor !== undefined) record.anchor = patch.anchor
  }

  setViewState(record: WebviewRecord, visible: boolean, active: boolean): void {
    record.visible = visible
    record.active = active
  }

  /** 从登记表移除；返回被移除的记录（调用方负责通知渲染层） */
  remove(panelId: string): WebviewRecord | null {
    const record = this.panels.get(panelId)
    if (!record) return null
    this.panels.delete(panelId)
    this.tokens.delete(record.token)
    return record
  }

  removeOf(extensionId: string): WebviewRecord[] {
    return this.listOf(extensionId)
      .map(record => this.remove(record.panelId))
      .filter((record): record is WebviewRecord => Boolean(record))
  }

  stateOf(record: WebviewRecord): WebviewPanelStateDto {
    return {
      panelId: record.panelId,
      title: record.title,
      presentation: record.presentation,
      width: record.width,
      height: record.height,
      transparent: record.transparent,
      anchor: record.anchor,
      visible: record.visible,
      active: record.active
    }
  }

  viewOf(record: WebviewRecord): ExtensionWebviewPanelView {
    return {
      panelId: record.panelId,
      extensionId: record.extensionId,
      viewType: record.viewType,
      title: record.title,
      presentation: record.presentation,
      width: record.width,
      height: record.height,
      transparent: record.transparent,
      anchor: record.anchor,
      visible: record.visible,
      active: record.active
    }
  }
}

/**
 * `localResourceRoots` 只保留扩展目录内的绝对路径。
 *
 * 空数组按“扩展根目录”处理 —— 这是 VS Code 的默认值，也是唯一安全的默认值。
 * 路径穿越（`..`）与社会工程学式的“直接把 /tmp 写进去”都在这里挡掉。
 */
function normalizeRoots(extensionRoot: string, roots: readonly string[] | undefined): string[] {
  const base = resolve(extensionRoot)
  const out: string[] = []
  for (const raw of roots ?? []) {
    const full = resolve(raw)
    if (full !== base && !full.startsWith(base + sep)) continue
    out.push(full)
  }
  if (out.length === 0) out.push(base)
  return out
}

/** 资源路径是否落在允许的根目录内（imark-webview:// 处理器复用） */
export function isWithinRoots(filePath: string, roots: readonly string[]): boolean {
  const full = resolve(filePath)
  return roots.some(root => full === root || full.startsWith(root + sep))
}

/** 扩展 HTML 里允许的本地资源相对路径（不含 token）；用于校验 asWebviewUri 的结果 */
export function relativeResourcePath(extensionRoot: string, filePath: string): string | null {
  const rel = relative(extensionRoot, filePath)
  if (rel.startsWith('..') || rel.startsWith(sep) || rel === '') return null
  return rel
}
