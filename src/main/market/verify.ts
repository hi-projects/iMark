/**
 * 插件包校验 —— 安装路径上**唯一**被信任的判据。
 *
 * 三道关,顺序不能反:
 * 1. `validateEnvelope()`(纯函数,shared 里):结构、路径、扩展名、体积、文件数;
 * 2. 逐文件 sha256:把 `data` 里的 base64 解出来重算,与 `files` 里声明的一致;
 * 3. 整体 integrity:按 `integrityInput()` 重算,与信封里的一致。
 *
 * 第 3 步覆盖第 2 步(integrity 的输入就是 files 的 sha256 表),第 2 步覆盖内容 ——
 * 所以 data 是被传递覆盖的。第 2 步仍然要做:只有它能告诉你**具体哪个文件**坏了。
 *
 * 「服务端声明的 integrity」与「包内自带的 integrity」是两回事,两者都要比:
 * 前者防的是「市场被换了一个包」,后者防的是「传输过程中包坏了 / 有人改了包内字节」。
 */

import { createHash } from 'node:crypto'
import {
  integrityInput,
  validateEnvelope,
  type PackageFileEntry,
  type PluginManifest,
  type PluginPackageEnvelope
} from '@shared/pluginPackage'

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 整包 integrity:输入形状必须与打包端完全一致(见 shared/pluginPackage.ts) */
export function computeIntegrity(
  manifest: PluginManifest,
  files: Record<string, PackageFileEntry>
): string {
  return sha256(integrityInput(manifest, files))
}

export interface VerifiedPackage {
  envelope: PluginPackageEnvelope
  manifest: PluginManifest
  /** main 入口的 sha256(没有 main 层时为 null),记进登记表便于比对「跑的是不是这一份」 */
  mainSha256: string | null
  /** render 入口的 sha256(没有 render 层时为 null) */
  renderSha256: string | null
}

/**
 * 全量校验一个信封。
 * `expectedIntegrity` 是**外部**给出的期望值(下载时来自响应头 `X-Imk-Integrity`),
 * 本地文件安装时不传。
 */
export function verifyEnvelope(
  raw: unknown,
  expectedIntegrity?: string | null
): { ok: true; value: VerifiedPackage } | { ok: false; errors: string[] } {
  const structural = validateEnvelope(raw)
  if (!structural.ok || !structural.value) {
    return { ok: false, errors: structural.errors }
  }
  const envelope = structural.value
  const manifest = envelope.manifest
  const errors: string[] = []

  for (const name of Object.keys(envelope.files)) {
    const meta = envelope.files[name] as PackageFileEntry
    const buf = Buffer.from(envelope.data[name] as string, 'base64')
    if (buf.byteLength !== meta.size) {
      errors.push(`${name}:实际大小 ${buf.byteLength} 与声明的 ${meta.size} 不符`)
      continue
    }
    const actual = sha256(buf)
    if (actual !== meta.sha256) {
      errors.push(`${name}:内容校验失败(文件已损坏或被篡改)`)
    }
  }

  const computed = computeIntegrity(manifest, envelope.files)
  if (computed !== envelope.integrity) {
    errors.push('整包 integrity 与实际内容不符(包已损坏或被篡改)')
  }
  if (expectedIntegrity && computed !== expectedIntegrity) {
    errors.push(`下载到的包与市场登记的 integrity 不符(期望 ${short(expectedIntegrity)})`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const mainSha256 = manifest.main
    ? (envelope.files[manifest.main.entry]?.sha256 ?? null)
    : null
  const renderSha256 = manifest.render
    ? (envelope.files[manifest.render.entry]?.sha256 ?? null)
    : null
  return { ok: true, value: { envelope, manifest, mainSha256, renderSha256 } }
}

/** 界面上展示 sha256 时统一截断成 `abc123…def456`,完整值留给「复制」按钮 */
export function short(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 6)}…${sha.slice(-6)}` : sha
}
