/**
 * 市场侧的包校验入口 —— 与扩展安装路径共用同一份实现。
 *
 * 校验只存在于 `extensions/installer.ts` 一处:结构校验(`validateEnvelope`,
 * 在 shared 里)、逐文件 sha256、整包 integrity。市场模块再抄一份的后果是
 * 「界面上校验通过、装的时候被拒」—— 所以这里只做转发,不重新实现。
 *
 * 「服务端声明的 integrity」与「包内自带的 integrity」是两回事,两者都要比:
 * 前者防的是「市场被换了一个包」,后者防的是「传输过程中包坏了 / 有人改了包内字节」。
 */

import { createHash } from 'node:crypto'
import { extensionIdOf, type ExtensionManifest } from '@shared/extensionPackage'
import {
  verifyExtensionPackage,
  type VerifiedExtensionPackage
} from '../extensions/installer'

/**
 * 从一个尚未校验的信封里读身份。
 * 读不出来返回 null —— 结构问题交给后续校验去报，这里只给「装的是谁」。
 */
export function peekIdentity(raw: unknown): { id: string; version: string } | null {
  const manifest = (raw as { manifest?: ExtensionManifest } | null)?.manifest
  if (!manifest || typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string') {
    return null
  }
  try {
    return {
      id: extensionIdOf(manifest),
      version: typeof manifest.version === 'string' ? manifest.version : ''
    }
  } catch {
    return null
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 全量校验一个信封。
 * `expectedIntegrity` 是**外部**给出的期望值(下载时来自响应头 `X-Imk-Integrity`),
 * 本地文件安装时不传。
 */
export function verifyEnvelope(
  raw: unknown,
  expectedIntegrity?: string | null
): { ok: true; value: VerifiedExtensionPackage } | { ok: false; errors: string[] } {
  return verifyExtensionPackage(raw, expectedIntegrity)
}
