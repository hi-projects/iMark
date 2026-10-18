/**
 * **render 层**加载器(主进程侧)。
 *
 * render 层的代码跑在**主窗口渲染进程**里(和宿主界面同一个 realm,因此能拿到 CM6
 * 与 DOM),但它**不直接使用任何宿主系统能力**:能力都在 main 层(restricted 隐藏页
 * 或主进程 node),两层之间只传消息。主进程在这里负责四件事:
 *
 *   1. **注入**:读 `manifest.render.entry` → 生成一次性 nonce → 请渲染层登记 →
 *      `executeJavaScript` 注入 `(function (imk) { … })(window.__imkRenderLayerApi(nonce))`。
 *      注入走的是 Electron 的脚本执行通道,不受页面 CSP 的 `script-src` 限制;
 *      但**注入代码内部**的 `eval` / `new Function` 仍会被 CSP 拦 —— 所以插件入口
 *      必须是自带打包好的普通脚本(不是 ESM,也不能靠运行时求值)。
 *   2. **生命周期**:onEnable / onDisable / onConfigChange / runAction 经
 *      `askRenderer` 进入渲染层(复用"渲染层不在就明确失败 + 超时清挂起"那套)。
 *   3. **就绪/重载**:渲染层每次报到(含页面重载)都会重新注入所有已启用的 render 层 ——
 *      重载后渲染层里的会话全没了,不重注入就等于插件悄悄消失。
 *   4. **消息中继**:render → main(IPC 收)与 main → render(op `render.send` 发)。
 *
 * 安全边界必须写死在这里:**render 层与应用界面同权**(能改 UI、读文档、看键盘输入)。
 * 进程隔离无从谈起 —— 这是形态本身的代价,能力门禁只约束 main 层。
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { PluginContext, PluginRuntime } from '@shared/pluginApi'
import type { PluginActionPayload, PluginActionResult } from '@shared/plugins'
import { LIMITS, type PluginManifest } from '@shared/pluginPackage'
import { getMainWindow } from '../window'
import { askRenderer, isRendererReady, onRendererReady } from './rendererBridge'

export interface RenderLayerTarget {
  id: string
  /** 插件安装目录 */
  dir: string
  manifest: PluginManifest
  /** 归一化后的配置快照(注入时带给 render 层) */
  config: Record<string, unknown>
}

/** 已经成功注入并调用过 onEnable 的 render 层 */
const loaded = new Set<string>()

/** 用户动作可能真的在等 git/网络;与 host.ts 的 ACTION_TIMEOUT 对齐 */
const ACTION_TIMEOUT = 120_000

export function isRenderLayerLoaded(id: string): boolean {
  return loaded.has(id)
}

/** 渲染层重载前调用:旧页面里的会话全没了,状态必须一起清掉 */
export function markAllRenderLayersUnloaded(): void {
  loaded.clear()
}

/**
 * 注册"渲染层就绪/重新就绪"的回调。
 * 宿主在这一刻重新注入所有已启用的 render 层(首次启动与页面重载走同一条路)。
 */
export function initRenderLayer(onReady: () => void): void {
  onRendererReady(onReady)
}

/**
 * 注入一个 render 层。**调用前请确认渲染层已就绪** —— 未就绪时抛错,由调用方决定
 * 是延后(启动期)还是记为失败(用户在界面上主动启用时)。
 */
export async function injectRenderLayer(target: RenderLayerTarget): Promise<void> {
  const win = getMainWindow()
  const wc = win && !win.webContents.isDestroyed() ? win.webContents : null
  if (!wc) throw new Error('主界面还没就绪,render 层稍后再加载')
  if (!isRendererReady()) throw new Error('主界面还没报到,render 层稍后再加载')

  const entry = target.manifest.render?.entry
  if (!entry) throw new Error('renderer 清单缺少 render.entry')
  const buf = await readFile(join(target.dir, entry))
  if (buf.byteLength > LIMITS.entryBytes) {
    throw new Error(`render 入口超过 ${LIMITS.entryBytes} 字节上限`)
  }
  const code = buf.toString('utf8')

  // nonce 只出现在 executeJavaScript 的字符串里 —— 其他页面脚本观察不到它。
  const nonce = randomBytes(16).toString('hex')
  await askRenderer('render.prepare', target.id, {
    nonce,
    config: target.config,
    hasMain: Boolean(target.manifest.main),
    name: target.manifest.name,
    version: target.manifest.version
  })

  // 入口是**普通脚本**:宿主把它包进一个立即执行函数,并以参数形式交出 imk。
  // 不能用 import/require/eval —— CSP 会在运行期拦掉它们。
  const wrapper =
    `(function () {\n` +
    `  try {\n` +
    `    (function (imk) {\n${code}\n    })(window.__imkRenderLayerApi(${JSON.stringify(nonce)}));\n` +
    `    return null;\n` +
    `  } catch (e) {\n` +
    `    return 'ERR:' + ((e && (e.stack || e.message)) || String(e));\n` +
    `  }\n` +
    `})();`

  let failure: unknown = null
  try {
    failure = await wc.executeJavaScript(wrapper, true)
  } catch (err) {
    await askRenderer('render.unload', target.id, {}).catch(() => undefined)
    throw new Error(
      `render 层脚本无法执行(多半是语法错误,或用了 import/eval):${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (typeof failure === 'string' && failure.startsWith('ERR:')) {
    await askRenderer('render.unload', target.id, {}).catch(() => undefined)
    throw new Error(`render 层执行失败:${failure.slice(4)}`)
  }

  // 插件必须在顶层同步调用 imk.plugin.handle(...);这里才能立刻看到 onEnable
  try {
    await askRenderer('render.enable', target.id, {})
  } catch (err) {
    await askRenderer('render.unload', target.id, {}).catch(() => undefined)
    throw err
  }
  loaded.add(target.id)
}

/** 停用/卸载:调用 onDisable、移除它注册的 CM6 扩展、丢掉会话。幂等。 */
export async function unloadRenderLayer(id: string): Promise<void> {
  loaded.delete(id)
  try {
    await askRenderer('render.unload', id, {})
  } catch {
    /* 界面已经重载/关闭:渲染层里的会话本来就不在了 */
  }
}

/** 配置变化 → render 层(没有加载过就跳过;它会在下次注入时拿到新配置) */
export async function notifyRenderConfig(
  id: string,
  config: Record<string, unknown>
): Promise<void> {
  if (!loaded.has(id)) return
  await askRenderer('render.config', id, { config })
}

/** 宿主条目(菜单/命令/状态栏)的动作 → render 层 */
export async function runRenderAction(
  id: string,
  actionId: string,
  targetId?: string,
  payload?: PluginActionPayload
): Promise<PluginActionResult> {
  const value = await askRenderer(
    'render.runAction',
    id,
    {
      actionId,
      targetId: targetId ?? null,
      payload: payload ?? null
    },
    ACTION_TIMEOUT
  )
  if (value && typeof value === 'object') return value as PluginActionResult
  return { ok: false, message: '插件没有返回动作结果' }
}

/**
 * 主进程 → render 层的一条消息(main 层的 `render.send` 走到这里)。
 * 渲染层不在时静默丢弃并记一行日志 —— 消息不是持久化的,重发由插件自己决定。
 */
export function sendToRenderLayer(id: string, channel: string, data: unknown): void {
  const win = getMainWindow()
  if (!win || win.webContents.isDestroyed()) {
    console.warn(`[iMark] 插件 ${id} 的消息没有送达:主界面不在`)
    return
  }
  win.webContents.send(IPC.PluginRenderMessage, { pluginId: id, channel, data })
}

/**
 * render 层的运行时适配器。
 *
 * 只负责 render 这一半;与 main 层的组合由 host.ts 的 `createCompositeRuntime` 决定。
 * 动作、消息、生命周期顺序都在组合层统一处理。
 */
export function createRenderRuntime(deps: {
  id: string
  dir: string
  manifest: PluginManifest
  getConfig: () => Record<string, unknown>
}): PluginRuntime {
  const target = (): RenderLayerTarget => ({
    id: deps.id,
    dir: deps.dir,
    manifest: deps.manifest,
    config: deps.getConfig()
  })

  return {
    async onEnable(_ctx: PluginContext): Promise<void> {
      // 启动期窗口可能还没建好:此时**不算失败**,等渲染层报到后由宿主统一注入
      if (!isRendererReady()) return
      await injectRenderLayer(target())
    },

    async onDisable(): Promise<void> {
      await unloadRenderLayer(deps.id)
    },

    async onConfigChange(config: unknown): Promise<void> {
      await notifyRenderConfig(deps.id, (config ?? {}) as Record<string, unknown>)
    },

    async runAction(
      actionId: string,
      _ctx: PluginContext,
      targetId?: string,
      payload?: PluginActionPayload
    ): Promise<PluginActionResult> {
      return runRenderAction(deps.id, actionId, targetId, payload)
    }
  }
}
