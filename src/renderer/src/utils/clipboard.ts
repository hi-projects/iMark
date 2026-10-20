/**
 * 复制纯文本。
 *
 * 渲染层是 secure 的自定义协议,`navigator.clipboard` 通常可用;万一不可用就退回
 * 临时 textarea + execCommand —— 这是唯一一条不依赖权限的退路。
 *
 * 返回是否成功,调用方据此决定给什么反馈(市场里的 hash、代码块的「已复制」)。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}
