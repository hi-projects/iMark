import * as fs from 'node:fs'
import * as path from 'node:path'
import { protocol } from 'electron'
import { getSettingsSync } from './settings'
import { currentDocPath } from './window'
import { isInsideAny } from './paths'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/**
 * 允许从这个协议读文件的根目录。
 *
 * 只有两个:**当前文档所在目录**与**仓库根**。这个协议存在的全部意义是
 * 「把笔记里引用的图片显示出来」,而笔记引用的图片就在这两处之一。
 *
 * 为什么必须划范围:文档正文是可以被扩展写入的
 * (扩展返回 `editor` 插入指令,宿主照单写进文档)。于是扩展写一行
 * `![](../../../../home/你/.ssh/id_rsa)` 就能让编辑器去读仓库外的文件。
 * 渲染层拿不回像素(跨源 + canvas 污染)也拿不回状态(加载失败与成功对扩展都是静默的),
 * 所以这不是一条现成的读取通道;但「扩展能让应用读任意本地文件」这件事本身
 * 不该继续成立。
 */
function allowedRoots(): string[] {
  const roots: string[] = []
  const vaultPath = getSettingsSync()?.vaultPath
  if (vaultPath) roots.push(vaultPath)
  const doc = currentDocPath()
  if (doc) {
    const dir = path.dirname(doc)
    if (dir && dir !== '.') roots.push(dir)
  }
  return roots
}

/**
 * iDraw 画布在笔记里的显示方式。
 *
 * 文件本身保留白色页面和「页面 ∪ 内容」的 viewBox —— 外部查看器看到的是一张
 * 固定尺寸、白底的图;`data-idraw-fit` 是引擎写下的内容紧边界。笔记里的图片
 * 去掉白底、按这个边界收边:背景就是笔记自己的主题背景,图片也不会用一整张
 * 空页面把内容压得很小。
 */
const IDRAW_PAGE_RE = /<rect\b[^>]*\bdata-idraw-page="1"[^>]*\/>\s*/i
const MAX_FIT_SVG_BYTES = 8 * 1024 * 1024
/** 与 iDraw 的 CONTENT_MARGIN 一致:紧边界四周留出的空白 */
const IDRAW_MARGIN = 40

/** 读一个数字属性;缺失或不是数字返回 null */
function attrNumber(tag: string, name: string): number | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** 根节点自己的 viewBox(x y w h) */
function rootViewBox(text: string): [number, number, number, number] | null {
  const tag = /<svg\b[^>]*>/.exec(text)?.[0]
  if (!tag) return null
  const raw = /\sviewBox="([^"]*)"/.exec(tag)?.[1]
  const parts = raw?.trim().split(/[\s,]+/).map(Number)
  if (parts?.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
    return parts as [number, number, number, number]
  }
  const w = attrNumber(tag, 'width')
  const h = attrNumber(tag, 'height')
  return w && h && w > 0 && h > 0 ? [0, 0, w, h] : null
}

/** 旧文件没有 data-idraw-fit:按节点框算一个紧边界(连线端点都在节点上) */
function nodeFit(text: string): [number, number, number, number] | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false
  for (const [tag] of text.matchAll(/<g\b[^>]*\bdata-idraw-node="[^"]*"[^>]*>/g)) {
    const x = attrNumber(tag, 'data-idraw-x')
    const y = attrNumber(tag, 'data-idraw-y')
    const w = attrNumber(tag, 'data-idraw-w')
    const h = attrNumber(tag, 'data-idraw-h')
    if (x === null || y === null || w === null || h === null) continue
    found = true
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  if (!found) return null
  return [minX - IDRAW_MARGIN, minY - IDRAW_MARGIN, maxX - minX + IDRAW_MARGIN * 2, maxY - minY + IDRAW_MARGIN * 2]
}

function fitCanvasPreview(buf: Buffer): Buffer | null {
  if (buf.byteLength > MAX_FIT_SVG_BYTES) return null
  const text = buf.toString('utf8')
  // 不是 iDraw 画布(没有这个标记)就原样返回
  if (!/\bdata-idraw-canvas="1"/.test(text)) return null
  const m = /\bdata-idraw-fit="([^"]+)"/.exec(text)
  let box: [number, number, number, number] | null = null
  if (m) {
    const parts = m[1]!.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
      box = parts as [number, number, number, number]
    }
  }
  box ??= nodeFit(text) ?? rootViewBox(text)
  if (!box) return null
  const [x, y, w, h] = box
  let out = text.replace(IDRAW_PAGE_RE, '')
  out = out.replace(/<svg\b[^>]*>/, tag => {
    const attrs: [string, string][] = [
      ['width', String(w)],
      ['height', String(h)],
      ['viewBox', `${x} ${y} ${w} ${h}`]
    ]
    let next = tag
    for (const [name, value] of attrs) {
      const re = new RegExp(`\\s${name}="[^"]*"`)
      next = re.test(next)
        ? next.replace(re, ` ${name}="${value}"`)
        : next.replace(/^<svg\b/, `<svg ${name}="${value}"`)
    }
    return next
  })
  return Buffer.from(out, 'utf8')
}

/**
 * imark://img/<encodeURIComponent(绝对路径)>
 * 渲染层的 <img> 通过该协议加载本地图片。直接 fs 读取,不走 net.fetch(file://),规避二次编码问题。
 *
 * 三重门,顺序无所谓但一个都不能少:绝对路径 → 图片扩展名 → 落在允许的根里。
 * 扩展名那关不是「顺手校验」:它把「这个协议只提供图片」这件事变成代码里的规则,
 * 而不是靠调用方自觉。
 */
export function registerImarkProtocol(): void {
  protocol.handle('imark', async request => {
    try {
      const url = new URL(request.url)
      // pathname 首字符是 '/',去掉后整体 decodeURIComponent 还原出原始绝对路径
      const raw = decodeURIComponent(url.pathname.slice(1))
      const p = path.normalize(raw)
      if (!path.isAbsolute(p)) {
        return new Response('Bad path', { status: 400 })
      }
      const ext = path.extname(p).slice(1).toLowerCase()
      const mime = MIME[ext]
      if (!mime) {
        return new Response('Not an image', { status: 403 })
      }
      // path.normalize 已经把 `..` 折掉了,所以这里比的是真实目标;
      // resolve() 在 isInside 内部再做一次,挡的是 `/vault/../etc` 这类。
      if (!isInsideAny(allowedRoots(), p)) {
        return new Response('Outside allowed roots', { status: 403 })
      }
      const buf = await fs.promises.readFile(p)
      const preview = mime === 'image/svg+xml' ? fitCanvasPreview(buf) : null
      return new Response(preview ?? buf, {
        headers: { 'content-type': mime }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
