import * as fs from 'node:fs'
import * as path from 'node:path'
import { protocol } from 'electron'

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
 * imark://img/<encodeURIComponent(绝对路径)>
 * 渲染层的 <img> 通过该协议加载本地图片。直接 fs 读取,不走 net.fetch(file://),规避二次编码问题。
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
      const mime = MIME[ext] ?? 'application/octet-stream'
      const buf = await fs.promises.readFile(p)
      return new Response(buf, {
        headers: { 'content-type': mime }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
