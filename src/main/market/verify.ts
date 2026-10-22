/**
 * 市场侧的包校验入口 —— 与扩展安装路径共用同一份实现。
 *
 * v2 的校验只存在于 `extensions/installer.ts` 一处:结构校验(`validateEnvelope`,
 * 在 shared 里)、逐文件 sha256、整包 integrity。市场模块再抄一份的后果是
 * 「界面上校验通过、装的时候被拒」—— 所以这里只做转发,不重新实现。
 *
 * 「服务端声明的 integrity」与「包内自带的 integrity」是两回事,两者都要比:
 * 前者防的是「市场被换了一个包」,后者防的是「传输过程中包坏了 / 有人改了包内字节」。
 */

import { createHash } from 'node:crypto'
import {
  stableIntegrityInput,
  type ExtensionManifest,
  type PackageFileEntry
} from '@shared/extensionPackage'
import {
  verifyExtensionPackage,
  type VerifiedExtensionPackage
} from '../extensions/installer'

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 整包 integrity:输入形状必须与打包端、服务端完全一致 */
export function computeIntegrity(
  manifest: ExtensionManifest,
  files: Record<string, PackageFileEntry>
): string {
  return sha256(stableIntegrityInput(manifest, files))
}

export type VerifiedPackage = VerifiedExtensionPackage

/**
 * 全量校验一个信封。
 * `expectedIntegrity` 是**外部**给出的期望值(下载时来自响应头 `X-Imk-Integrity`),
 * 本地文件安装时不传。
 */
export function verifyEnvelope(
  raw: unknown,
  expectedIntegrity?: string | null
): { ok: true; value: VerifiedPackage } | { ok: false; errors: string[] } {
  return verifyExtensionPackage(raw, expectedIntegrity)
}

/** 界面上展示 sha256 时统一截断成 `abc123…def456`,完整值留给「复制」按钮 */
export function short(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 6)}…${sha.slice(-6)}` : sha
}
