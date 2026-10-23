/**
 * 把图标字节转成渲染层能直接放进 `<img src>` 的 data URL。
 *
 * 图标有两个来源:市场下载与扩展包内文件。两处用同一套体积与格式校验 ——
 * content-type 可能来自服务端或文件扩展名,只有字节自己说的才算数。
 */

import { EXTENSION_LIMITS } from '@shared/extensionPackage'

export function iconDataUrl(buf: Buffer, type: string): string | null {
  if (type !== 'image/png' && type !== 'image/svg+xml') return null
  if (buf.byteLength > EXTENSION_LIMITS.iconBytes) return null
  if (
    type === 'image/png' &&
    !(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
  ) {
    return null
  }
  if (type === 'image/svg+xml' && !/<svg[\s>]/i.test(buf.subarray(0, 512).toString('utf8'))) {
    return null
  }
  return `data:${type};base64,${buf.toString('base64')}`
}
