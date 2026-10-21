/**
 * `imark-webview://` 资源解析（纯函数，不依赖 service）。
 *
 * 与 `webviewProtocol.ts` 分开是为了避免循环依赖：service 需要调用它来响应请求，
 * 而协议注册器需要 service 的单例。这里只认「token → 面板信息」的查表结果。
 */

import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { EXTENSION_WEBVIEW_SCHEME } from '@shared/extensionProtocol'
import { isWithinRoots } from './webviews'

export const WEBVIEW_PANEL_ENTRY = '/__imark_panel__/index.html'

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf'
}

export interface WebviewResourceTarget {
  extensionId: string
  root: string
  localResourceRoots: string[]
  html: string
}

function mimeOf(path: string): string {
  return MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

function headers(contentType: string, cache: 'no-store' | 'no-cache'): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': cache,
    'x-content-type-options': 'nosniff'
  }
}

/** URL pathname → 相对路径；编码坏掉、空段或含 NUL 的一律拒绝 */
function decodePath(pathname: string): string | null {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (!raw) continue
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (segment.includes('\0')) return null
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

export async function serveWebviewResource(
  urlString: string,
  lookup: (token: string) => WebviewResourceTarget | null
): Promise<Response> {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return new Response('Bad URL', { status: 400 })
  }
  if (url.protocol !== `${EXTENSION_WEBVIEW_SCHEME}:`) {
    return new Response('Bad scheme', { status: 400 })
  }

  // token 是唯一的凭据：panelId 出现在 renderer 的消息里，但资源地址只带 token
  const token = url.searchParams.get('token')
  if (!token) return new Response('Missing token', { status: 403 })
  const panel = lookup(token)
  if (!panel) return new Response('Unknown panel', { status: 403 })

  // standard scheme 会把 host 小写化；扩展 ID 本来就只允许小写
  if (url.hostname !== panel.extensionId) {
    return new Response('Panel does not belong to this extension', { status: 403 })
  }

  if (url.pathname === WEBVIEW_PANEL_ENTRY) {
    return new Response(panel.html, {
      status: 200,
      headers: headers('text/html; charset=utf-8', 'no-store')
    })
  }

  const relativePath = decodePath(url.pathname)
  if (!relativePath) return new Response('Bad path', { status: 400 })
  // URL 解析器已经折掉 `..`；再 resolve 一次并按真实路径比较，挡住编码变体
  const fullPath = resolve(panel.root, relativePath)
  // 符号链接可能指到根外：扩展本身拥有用户权限，这里挡的是「renderer 被诱导去读
  // 一个不属于该扩展的路径」，不是沙箱边界。用 realpath 会拒绝掉尚未创建的文件。
  if (!isWithinRoots(fullPath, panel.localResourceRoots)) {
    return new Response('Outside localResourceRoots', { status: 403 })
  }

  try {
    const data = await readFile(fullPath)
    return new Response(data, {
      status: 200,
      headers: headers(mimeOf(fullPath), 'no-cache')
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
