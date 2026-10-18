/**
 * **宿主请渲染层替插件办事**的那一端。
 *
 * 这里只剩一件事:**render 层的生命周期**。编辑器读写、装饰、DOM、样式都由
 * render 层直接操作(它与主界面同 realm),不再经主进程转发;旧宿主注入界面/
 * 停靠面板/宿主代渲染装饰这一整套通道已经删除。
 *
 * 纪律只有一条:**每个请求都必须回执**,包括出错的那种。主进程在等
 * (`askRenderer` 的超时),漏一次回执就是一个看起来像"插件卡住"的等待。
 */

import type { RendererOpReply } from '@shared/plugins'
import { handleRenderOp } from './renderLayer'
import { api } from './api'

function reply(value: RendererOpReply): void {
  api.replyHostRequest(value)
}

export function initPluginHostOps(): () => void {
  const offRequest = api.onPluginHostRequest(req => {
    // handle 可能返回 Promise(render.* 是异步的),统一 await 后再回执。
    // 用 Promise.resolve().then(...) 而不是 async 回调:回执必须在**任何**同步异常下也发出去。
    void Promise.resolve()
      .then(() => handleRenderOp(req))
      .then(value => reply({ id: req.id, ok: true, value: value ?? null }))
      .catch(err =>
        reply({ id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) })
      )
  })

  // 报到放在**最后**:主进程收到这条就会开始发请求(包括 render.prepare)。
  // 早于订阅发送的话,第一条请求会落在没有监听器的窗口里被静默丢掉。
  api.notifyPluginUiReady()

  return () => {
    offRequest()
  }
}
