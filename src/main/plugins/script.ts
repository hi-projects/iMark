/**
 * 脚本插件加载器:把包里的 main.js 变成宿主认识的 PluginRuntime。
 *
 * 用 createRequire 而不是 vm / 动态 import(),理由:
 *  - vm 在「授予完整 Node 权限」的信任模型下给不了隔离,却要自己重写 CommonJS 解析,纯成本;
 *  - 动态 import() 的 ESM 缓存是**永久**的,插件更新后无法热重载;
 *  - createRequire 配合清 require.cache,既得到干净重载,也支持
 *    「先加载新目录,成功后才删旧目录」的原子升级与回滚。
 *
 * 入口约定是 CommonJS(`module.exports = (imk) => ({ … })`):plugins-src/tsconfig.json
 * 就编译成 CJS,作者无感。较新版本的 Node 能用 require() 直接加载 ESM,所以写成
 * `export default` 的入口通常也能跑起来 —— 但这是运行时的巧合,不是我们承诺的接口,
 * 而且老版本 Node/Electron 上会直接失败。文档与示例一律按 CJS 写。
 */

import { createRequire } from 'node:module'
import { sep } from 'node:path'
import type { ImkApi, PluginRuntime } from '@shared/pluginApi'
import type { PluginManifest } from '@shared/pluginPackage'

/** 入口导出必须是个函数工厂 */
type PluginFactory = (imk: ImkApi) => unknown

const RUNTIME_METHODS = ['onEnable', 'onDisable', 'onConfigChange', 'runAction'] as const

/**
 * 清掉某个插件目录下所有模块的 require 缓存。
 * 不清的话,升级后重新 require 拿到的还是旧代码 —— 这是热重载最容易踩的坑。
 */
function purgeCacheUnder(req: NodeRequire, dir: string): void {
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  for (const key of Object.keys(req.cache)) {
    if (key.startsWith(prefix)) delete req.cache[key]
  }
}

function describeModuleError(err: unknown, mainFile: string): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE') {
    return `插件入口必须是 CommonJS:${mainFile} 用的是 ESM(import/export),而当前运行环境不能直接 require 它。请改成 module.exports = (imk) => ({ … })`
  }
  if (code === 'MODULE_NOT_FOUND') {
    return `插件入口加载失败:找不到 ${mainFile} 或它 require 的模块。${
      (err as Error).message
    }`
  }
  if (err instanceof SyntaxError) {
    // 语法错误是最常见的「插件在本地能跑、装进来就报错」原因:多半是入口没编译
    return `插件入口解析失败(语法错误):${err.message}。若是用 TS/ESM 写的,请先编译成 CommonJS 再打包。`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * 加载并实例化脚本插件。
 * 抛出的异常由调用方(宿主)负责包装成「加载期错误」,不中断其他插件。
 */
export function loadScriptRuntime(
  dir: string,
  manifest: PluginManifest,
  api: ImkApi
): PluginRuntime {
  const mainFile = manifest.main ?? 'main.js'
  // 锚点文件不必真实存在,createRequire 只用它来确定「相对谁解析」
  const req = createRequire(`${dir}${sep}__imk_anchor__.js`)
  const entryPath = `${dir}${sep}${mainFile.replace(/\//g, sep)}`

  purgeCacheUnder(req, dir)

  let mod: unknown
  try {
    mod = req(entryPath)
  } catch (err) {
    throw new Error(describeModuleError(err, mainFile))
  }

  // 兼容 module.exports = fn / export default fn / CJS interop 的 { default: fn }
  const candidate =
    typeof mod === 'function' ? mod : (mod as { default?: unknown } | null)?.default
  if (typeof candidate !== 'function') {
    throw new Error(
      `插件入口必须是工厂函数:module.exports = (imk) => ({ onEnable, onDisable, runAction })` +
        ` —— 实际拿到的是 ${typeof mod}`
    )
  }

  const factory = candidate as PluginFactory
  let runtime: unknown
  try {
    runtime = factory(api)
  } catch (err) {
    throw new Error(`插件初始化失败:${err instanceof Error ? err.message : String(err)}`)
  }
  if (!runtime || typeof runtime !== 'object') {
    throw new Error('插件工厂必须返回一个对象(含 onEnable / onDisable / runAction 等可选方法)')
  }
  if (!RUNTIME_METHODS.some(m => typeof (runtime as Record<string, unknown>)[m] === 'function')) {
    throw new Error(
      `插件没有实现任何生命周期方法(至少要有 ${RUNTIME_METHODS.join(' / ')} 之一)`
    )
  }

  const source = runtime as Record<string, unknown>
  const bound: PluginRuntime = {}
  for (const method of RUNTIME_METHODS) {
    const fn = source[method]
    if (typeof fn === 'function') {
      // 绑回插件自己的对象:作者很可能写成 class 方法,丢 this 会直接崩
      ;(bound as Record<string, unknown>)[method] = (fn as (...a: unknown[]) => unknown).bind(runtime)
    }
  }
  return bound
}

/** 卸载前把该插件占用的模块缓存也清掉,避免残留引用 */
export function forgetScriptRuntime(dir: string): void {
  const req = createRequire(`${dir}${sep}__imk_anchor__.js`)
  purgeCacheUnder(req, dir)
}
