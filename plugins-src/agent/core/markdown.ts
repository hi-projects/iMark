/**
 * 把 Markdown 渲染结果里的图片换成 data URI。
 *
 * 对话面板与产物预览跑在 `imark-webview://` 里，CSP 只放行同源 / data: / blob:，
 * 而 Agent 的图片通常就在会话目录的 `prepared/` 下。这里只在会话目录内读取，
 * 避免模型诱导去读任意本地文件；图片不存在、类型不支持或超过上限时保留原
 * `src`，界面上显示为坏图。
 */

import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与产物图片预览的上限保持一致 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

const IMG_SRC = /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** 只读取会话目录内的文件；绝对路径也必须落在 root 里 */
async function dataUriOf(src: string, root: string, base: string): Promise<string | null> {
  let candidate: string
  if (/^file:/i.test(src)) {
    try {
      candidate = fileURLToPath(src)
    } catch {
      return null
    }
  } else {
    candidate = isAbsolute(src) ? src : resolve(base, src)
  }
  const abs = resolve(candidate)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const mime = IMAGE_MIME[extname(abs).toLowerCase()]
  if (!mime) return null
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile() || info.size > MAX_IMAGE_BYTES) return null
  const buf = await readFile(abs).catch(() => null)
  if (!buf) return null
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * @param html       markdown-it 渲染出的 HTML
 * @param sessionDir 会话目录；相对路径按它解析，且读取范围不能超出它
 * @param baseDir    相对路径的基准（产物预览传入产物所在目录），默认同 sessionDir
 */
export async function inlineImageSources(
  html: string,
  sessionDir: string | undefined,
  baseDir?: string
): Promise<string> {
  if (!sessionDir || !html.includes('<img')) return html
  const root = resolve(sessionDir)
  const base = baseDir ? resolve(baseDir) : root
  const matches = [...html.matchAll(IMG_SRC)]
  if (matches.length === 0) return html
  let out = html
  for (const match of matches) {
    const raw = decodeEntities(match[2] ?? '')
    if (!raw || /^(?:data:|blob:|https?:|imark:)/i.test(raw)) continue
    const dataUri = await dataUriOf(raw, root, base)
    if (!dataUri) continue
    out = out.replace(match[0], `${match[1]}${dataUri}${match[3]}`)
  }
  return out
}
