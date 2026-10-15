/**
 * 内置能力:Webhook 推送 —— 声明式插件的示范实现,也是「无代码插件」这条路走通了的证明。
 *
 * 典型的声明式插件(markdown 转 JSON 即可发布,包内不含任何代码):
 *   {
 *     "id": "notify-feishu", "kind": "declarative", "capability": "webhook",
 *     "permissions": ["network", "vault:read"],
 *     "fields": [
 *       { "key": "targets", "kind": "targets", "label": "推送地址", "default": [],
 *         "targetSecret": { "label": "签名令牌（可选）" } },
 *       { "key": "method", "kind": "select", "label": "请求方法", "default": "POST",
 *         "options": [{ "value": "POST", "label": "POST" }, { "value": "GET", "label": "GET" }] },
 *       { "key": "timeoutMs", "kind": "number", "label": "超时（毫秒）", "default": 10000 }
 *     ],
 *     "actions": [{ "id": "test", "label": "发送测试请求" }],
 *     "targetActions": [{ "id": "test-target", "label": "测试这一条" }],
 *     "targetFieldKey": "targets"
 *   }
 */

import type { ImkApi, PluginRuntime } from '@shared/pluginApi'
import type { PluginTarget } from '@shared/plugins'
import type { Capability } from '../capabilities'

interface WebhookConfig {
  targets: PluginTarget[]
  method: string
  timeoutMs: number
}

/**
 * 把 fetch 的异常翻成一句有用的话。
 *
 * `fetch` 抛出来的 `err.message` 常常只有一句「fetch failed」,真正的原因
 * (ECONNREFUSED / 证书过期 / DNS 查不到)在 `cause` 链上。用户看到的必须是后者:
 * 「fetch failed」既不能告诉他哪里错了,也不能告诉他该改什么。
 */
function describeFetchError(err: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const message = (cur as { message?: unknown }).message
    if (typeof message === 'string' && message && !parts.includes(message)) parts.push(message)
    cur = (cur as { cause?: unknown }).cause
  }
  const text = parts.join(' → ') || String(err)
  // fetch 规范把一批端口(25/110/143/465/587/993/995/6667…)列为禁止访问,
  // 撞上它们时浏览器只给一句 "bad port"。用户需要的是「换一个端口」这个动作
  if (/bad port/i.test(text)) return `${text}(这个端口被 fetch 规范列为禁止访问,换一个端口试试)`
  return text
}

function labelOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return url.trim() || '(空地址)'
  }
}

async function send(
  api: ImkApi,
  target: PluginTarget,
  method: string,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  const url = target.url.trim()
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, detail: '地址必须是 http(s) 开头' }
  }
  // 目标行的密钥是可选签名令牌(声明式插件不强制)
  const token = api.secrets ? await api.secrets.get('targets', target.id) : null
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  try {
    const res = await fetch(url, {
      method: method === 'GET' ? 'GET' : 'POST',
      headers,
      body:
        method === 'GET'
          ? undefined
          : JSON.stringify({ source: 'iMark', plugin: api.plugin.id, at: Date.now() }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs || 10000, 60_000)))
    })
    return {
      ok: res.ok,
      detail: res.ok ? `${labelOf(url)}:HTTP ${res.status}` : `${labelOf(url)}:HTTP ${res.status}`
    }
  } catch (err) {
    return { ok: false, detail: `${labelOf(url)}:${describeFetchError(err)}` }
  }
}

export const webhookCapability: Capability = {
  id: 'webhook',
  name: 'Webhook 推送',
  description: '把事件以 HTTP 请求推送到你配置的地址(如企业微信 / 飞书机器人、自建服务)。',
  permissions: ['network'],
  requiredFields: ['targets'],
  actions: [{ id: 'test', label: '发送测试请求' }],
  targetActions: [{ id: 'test-target', label: '测试这一条' }],
  targetFieldKey: 'targets',

  create({ api }: { manifest: unknown; api: ImkApi }): PluginRuntime {
    const run = async (only?: string): Promise<{ ok: boolean; message: string; detail?: string }> => {
      const cfg = api.getConfig<WebhookConfig>()
      const all = (cfg.targets ?? []).filter(t => t.url.trim().length > 0)
      const targets = only ? all.filter(t => t.id === only) : all
      if (targets.length === 0) {
        return { ok: false, message: only ? '该地址已不存在' : '尚未配置推送地址' }
      }

      api.setState({ status: 'running', lastMessage: '正在推送…', lastDetail: undefined })
      const lines: string[] = []
      for (const target of targets) {
        const r = await send(api, target, cfg.method, cfg.timeoutMs)
        lines.push(r.detail)
        if (!r.ok) {
          api.setState({
            status: 'error',
            lastRunAt: Date.now(),
            lastMessage: '推送失败',
            lastDetail: lines.join('\n')
          })
          return { ok: false, message: '推送失败', detail: lines.join('\n') }
        }
      }
      api.setState({
        status: 'ok',
        lastRunAt: Date.now(),
        lastMessage: `已推送到 ${targets.length} 个地址`,
        lastDetail: lines.join('\n')
      })
      return { ok: true, message: `已推送到 ${targets.length} 个地址`, detail: lines.join('\n') }
    }

    return {
      onEnable: () => {
        api.setState({ status: 'idle', lastMessage: '已就绪' })
      },
      runAction: async (actionId: string, _ctx: unknown, targetId?: string) => {
        if (actionId === 'test') return run()
        if (actionId === 'test-target') return run(targetId)
        return { ok: false, message: `未知动作:${actionId}` }
      }
    }
  }
}
