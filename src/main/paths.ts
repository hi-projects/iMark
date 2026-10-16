/**
 * 主进程的路径包含判断。
 *
 * 渲染层有一份同名的 `utils/paths.ts`(那边要跨平台处理用户手输的路径,还得防
 * 「`\` 在 Linux 上只是普通字符」这类坑)。这一份的职责完全不同:**拿来做安全判断**,
 * 所以它一律先 `resolve()` 再比 —— 前缀比较必须发生在规范化之后,
 * 否则 `/vault/../etc` 这种在字符串上看着在仓库里、实际在仓库外。
 *
 * 两处都不能用 `startsWith(parent)` 了事:`/vault` 与 `/vault-secret` 共享前缀。
 * 分隔符要跟着 `resolve` 的结果走(Windows 上是 `\`)。
 */

import { resolve, sep } from 'node:path'

/** child 是否就是 parent 本身,或位于其下(规范化之后比较) */
export function isInside(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const base = resolve(parent)
  const target = resolve(child)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** child 是否落在 parents 里的任意一个之下 */
export function isInsideAny(parents: readonly string[], child: string): boolean {
  return parents.some(parent => isInside(parent, child))
}
