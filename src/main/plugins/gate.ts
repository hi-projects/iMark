/**
 * 能力闸门 —— **所有** op 调用的唯一入口(沙箱走 IPC,trusted 走 `api.ts` 生成的薄壳)。
 *
 * 顺序是刻意的,每一步都在回答一个不同的问题:
 *
 *   1. **表里有没有这个 op**  —— 没有就 `E_UNKNOWN_OP`。这挡的是"把函数名传过来执行"
 *   2. **清单声明了没有**      —— 没声明就 `E_PERMISSION`,并**写进插件日志**
 *      (设置界面能直接看到"哪一步被拒",作者不必来问宿主作者)
 *   3. **用户同意了没有**      —— 见 host.ts 的 `effectiveGrants`:权限是
 *      「用户在安装确认框里同意的」∩「清单现在声明的」。升级偷偷加了权限,
 *      在用户重新确认之前不生效 —— 这个语义空洞是改造前就存在的,沙箱下必须堵上
 *   4. **参数**               —— JSON 归一(结构化克隆之外的东西一律拒)+ 体积上限
 *   5. **频率与并发**          —— 超限 `E_BUSY`("等会儿再试"是可用信息,不是错误)
 *   6. **超时**               —— `E_TIMEOUT`
 *
 * 前六步都不通过时,插件拿到的是一个**结构化错误**而不是异常 —— 见 pluginRpc.ts 的说明。
 */

import type { PluginPermission } from '@shared/pluginPackage'
import {
  RPC_MAX_ARGS_BYTES,
  type PluginRpcError,
  type PluginRpcErrorCode,
  type PluginRpcResult
} from '@shared/pluginRpc'
import { getOp, OpError, type OpContext } from './ops'

/** 频率限制:一个窗口内最多几次 */
interface Limiter {
  times: number[]
  windowMs: number
  max: number
}

/** 每插件每 op 一个计数器:插件之间不互相影响(否则 A 刷爆了会拖累 B) */
const limiters = new Map<string, Limiter>()
/** 每插件每 op 的在飞请求数(并发上限) */
const inflight = new Map<string, number>()

function parseLimit(spec: string): { max: number; windowMs: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(spec)
  if (!m) return null
  return { max: Number(m[1]), windowMs: Number(m[2]) }
}

function allowRate(key: string, spec: string): boolean {
  const parsed = parseLimit(spec)
  if (!parsed) return true
  const now = Date.now()
  let limiter = limiters.get(key)
  if (!limiter) {
    limiter = { times: [], windowMs: parsed.windowMs, max: parsed.max }
    limiters.set(key, limiter)
  }
  limiter.times = limiter.times.filter(t => now - t < limiter.windowMs)
  if (limiter.times.length >= limiter.max) return false
  limiter.times.push(now)
  return true
}

/** 插件被卸载/停用时清掉它的计数器,免得注册表随插件数量无限长大 */
export function forgetLimits(pluginId: string): void {
  for (const key of [...limiters.keys()]) {
    if (key.startsWith(`${pluginId}\u0000`)) limiters.delete(key)
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(`${pluginId}\u0000`)) inflight.delete(key)
  }
}

/**
 * 参数归一。
 *
 * 两个目的:**体积**(一个插件把 200 MiB 的字符串塞过来,宿主的 IPC 会先炸)、
 * **形状**(结构化克隆能过的东西未必能 JSON 化 —— 一个含循环引用的对象过不了
 * 后面的 JSON.stringify,而错误会出现在离作者很远的地方)。
 * 归一之后 ops 拿到的一定是纯数据。
 */
export function normalizeArgs(value: unknown): { ok: true; value: unknown } | { ok: false; error: PluginRpcError } {
  let json: string
  try {
    json = JSON.stringify(value ?? null) ?? 'null'
  } catch {
    return {
      ok: false,
      error: { code: 'E_BAD_ARGS', message: '参数必须是可以 JSON 化的数据(不能含函数、循环引用等)' }
    }
  }
  if (json.length > RPC_MAX_ARGS_BYTES) {
    return {
      ok: false,
      error: {
        code: 'E_BAD_ARGS',
        message: `参数过大(${Math.round(json.length / 1024)} KiB,上限 ${RPC_MAX_ARGS_BYTES / 1024} KiB)`
      }
    }
  }
  return { ok: true, value: JSON.parse(json) }
}

export interface InvokeOptions {
  /** 调用来源:沙箱(IPC)还是 trusted(直接调用)。只影响审计文案 */
  source: 'sandbox' | 'trusted'
  /** 被拒时写进哪里(插件日志)。不传就不记 */
  audit?(line: string): void
}

/**
 * 执行一次能力调用。**永远 resolve**。
 */
export async function invokeOp(
  ctx: OpContext,
  opName: unknown,
  args: unknown,
  opts: InvokeOptions
): Promise<PluginRpcResult> {
  const fail = (error: PluginRpcError, audit = true): PluginRpcResult => {
    if (audit && opts.audit) {
      opts.audit(`[warn] ${String(opName)} 被拒(${error.code}):${error.message}`)
    }
    return { ok: false, error }
  }

  const def = getOp(opName)
  if (!def) {
    return fail(
      {
        code: 'E_UNKNOWN_OP',
        message: `不认识的能力「${String(opName)}」。可用能力见作者文档,宿主不提供通用调用通道。`
      },
      false
    )
  }
  const name = String(opName)

  // 权限:两道都要过 —— 清单声明过(declared),用户也同意过(granted)。
  // ctx.grants 已经是两者的交集(见 host.ts 的 effectiveGrants),这里只需判一次;
  // 分开判会在"用户没同意"与"清单没声明"时给出不同的文案,那对作者没有帮助。
  if (def.perm !== null && !ctx.grants.includes(def.perm)) {
    return fail({
      code: 'E_PERMISSION',
      message:
        `「${name}」需要「${def.perm}」权限。` +
        `请确认清单 permissions 里写了它,并且你在应用里重新确认过这个插件的权限。`
    })
  }

  // 形态专属的能力:不是权限问题(作者申请也没用),而是"这个形态根本没有那件东西"。
  // 说清楚哪一半缺、该走哪条路,比笼统地拒掉强
  if (def.sandboxOnly && !ctx.isSandbox) {
    return fail({
      code: 'E_PERMISSION',
      message: `「${name}」只有沙箱插件能用 —— 它需要插件自己的一整个页面。脚本插件请用自己的代码直接做。`
    })
  }
  if (def.trustedOnly && ctx.isSandbox) {
    return fail({
      code: 'E_PERMISSION',
      message:
        `「${name}」只有脚本插件能用(往 iMark 的界面里挂东西)。` +
        `沙箱插件走的是另一条路:在清单里声明 ui.dock,把**自己的页面**停靠到侧栏 —— 宿主不去渲染它的 HTML。`
    })
  }

  const normalized = normalizeArgs(args)
  if (!normalized.ok) return fail(normalized.error, false)

  const key = `${ctx.pluginId}\u0000${name}`
  if (def.limit && !allowRate(key, def.limit)) {
    return fail(
      {
        code: 'E_BUSY',
        message: `「${name}」调用太频繁(${def.limit} —— 分子是次数,分母是毫秒),请降低频率。`
      },
      false
    )
  }
  if (def.maxConcurrent !== undefined) {
    const now = inflight.get(key) ?? 0
    if (now >= def.maxConcurrent) {
      return fail(
        { code: 'E_BUSY', message: `「${name}」同时最多 ${def.maxConcurrent} 个请求,请等前面的完成。` },
        false
      )
    }
    inflight.set(key, now + 1)
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => def.run(ctx, normalized.value)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new OpError('E_TIMEOUT', `「${name}」超过 ${def.timeoutMs / 1000} 秒未完成`)),
          def.timeoutMs
        )
      })
    ])
    return { ok: true, value: value ?? null }
  } catch (err) {
    if (err instanceof OpError) {
      return fail({ code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) })
    }
    const message = err instanceof Error ? err.message : String(err)
    // 未被归一的异常:把栈留在宿主的控制台(那里才有开发者在看),只回一句话给插件
    console.error(`[iMark] 插件 ${ctx.pluginId} 的能力 ${name} 出错:`, err)
    return fail({ code: 'E_FAILED', message: `${name} 执行失败:${message}` })
  } finally {
    if (timer) clearTimeout(timer)
    if (def.maxConcurrent !== undefined) {
      const left = (inflight.get(key) ?? 1) - 1
      if (left <= 0) inflight.delete(key)
      else inflight.set(key, left)
    }
  }
}

/** trusted 侧要的「权限 + 参数」两问,不跑 op(api.ts 生成只读属性时用) */
export function opRequires(opName: string): PluginPermission | null {
  return getOp(opName)?.perm ?? null
}

export type { PluginRpcErrorCode }
