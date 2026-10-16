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
 * 为什么必须划范围(改造前是「任意绝对路径」):文档正文是可以被插件写入的
 * (插件返回 `editor` 插入指令,宿主照单写进文档)。于是插件写一行
 * `![](../../../../home/你/.ssh/id_rsa)` 就能让编辑器去读仓库外的文件。
 * 渲染层拿不回像素(跨源 + canvas 污染)也拿不回状态(加载失败与成功对插件都是静默的),
 * 所以这不是一条现成的读取通道;但「插件能让应用读任意本地文件」这件事本身,
 * 在插件即将拿到更多权限的当下不该继续成立。
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
      return new Response(buf, {
        headers: { 'content-type': mime }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
