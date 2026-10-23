/**
 * 把浏览器的 HTML5 通知也接到通知中心。
 *
 * 应用内自己的通知走 `services/notice.ts`,但渲染进程里还有一个绕开它的入口:
 * `new Notification(title, options)`。页面脚本可以直接调用它 ——
 * 那些通知会交给 Chromium / 系统,应用内看不见。
 *
 * 这里包一层构造器,**只记录,不改行为**:通知该不该弹、弹成什么样,仍然由
 * 浏览器决定;通知中心只是多留一份历史。包装放在 `main.ts` 的最前面,
 * 保证任何扩展界面起来之前就已经生效。
 *
 * 静态成员(`permission` / `requestPermission`)由 Proxy 原样透传,
 * `instanceof Notification` 也仍然成立(原型还是原生构造器的原型)。
 */
import { recordBrowserNotice } from './notice'

let installed = false

export function initNotificationCapture(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof window.Notification !== 'function') return
  installed = true

  const Native = window.Notification
  const Wrapped = new Proxy(Native, {
    construct(target, args) {
      try {
        const [title, options] = args as [unknown, NotificationOptions | undefined]
        recordBrowserNotice(
          String(title ?? ''),
          typeof options?.body === 'string' ? options.body : ''
        )
      } catch {
        // 记录失败不能拦住通知本身:通知中心少一条,比通知发不出去好
      }
      return Reflect.construct(target, args)
    }
  })

  try {
    window.Notification = Wrapped as typeof Notification
  } catch {
    // 某些环境里 Notification 是只读属性:那就退回"不接管",不影响其它功能
    installed = false
  }
}
