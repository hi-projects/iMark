/**
 * `imark-webview://` 协议注册。资源校验在 `webviewResources.ts`。
 *
 * URL 形态：
 *   imark-webview://<extensionId>/__imark_panel__/index.html?token=<token>
 *   imark-webview://<extensionId>/<相对扩展根的资源路径>?token=<token>
 *
 * 这个文件只做「注册 + 取 service」；真正的四道门（privileged scheme、token、
 * 归属、localResourceRoots）分别在 index.ts 与 webviewResources.ts 里。
 */

import { protocol } from 'electron'
import { EXTENSION_WEBVIEW_SCHEME } from '@shared/extensionProtocol'
import { getExtensionService } from './service'

export function registerExtensionWebviewProtocol(): void {
  protocol.handle(EXTENSION_WEBVIEW_SCHEME, async request => {
    try {
      const service = getExtensionService()
      if (!service) return new Response('Extension system not ready', { status: 503 })
      return await service.serveWebviewRequest(request.url)
    } catch (err) {
      console.error('[iMark] webview 资源请求失败:', err)
      return new Response('Not found', { status: 404 })
    }
  })
}
