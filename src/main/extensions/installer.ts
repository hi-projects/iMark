/**
 * v2 扩展包的校验与安装。
 *
 * 校验顺序（与 v1 相同，报告更具体）：
 * 1. `validateEnvelope()`：结构、路径、扩展名、体积、文件数、清单；
 * 2. 逐文件 sha256：把 base64 解出来重算；
 * 3. 整包 integrity：`sha256(stableStringify({ manifest, files }))`。
 *
 * 安装失败不会留下半份目录：先解到 `.staging/<id>.<随机>`，全部校验通过后
 * 才 rename 就位；旧目录在 rename 成功前一直保留，失败会回滚。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  satisfiesRange,
  stableIntegrityInput,
  validateEnvelope,
  type ExtensionManifest,
  type ExtensionPackageEnvelope
} from '@shared/extensionPackage'
import type { ExtensionRecord, ExtensionSource } from '@shared/extensions'
import { setRecord, activateStaged, cleanupStaging, stagingDirFor } from './installedStore'
import { extensionDir, safeJoin, sha256 } from './paths'

export interface VerifiedExtensionPackage {
  envelope: ExtensionPackageEnvelope
  manifest: ExtensionManifest
  mainSha256: string | null
  warnings: string[]
}

export function verifyExtensionPackage(
  raw: unknown,
  expectedIntegrity?: string | null
): { ok: true; value: VerifiedExtensionPackage } | { ok: false; errors: string[] } {
  const structural = validateEnvelope(raw)
  if (!structural.ok || !structural.value) {
    return { ok: false, errors: structural.errors }
  }
  const envelope = structural.value
  const errors: string[] = []

  for (const name of Object.keys(envelope.files)) {
    const meta = envelope.files[name]!
    const data = envelope.data[name]
    if (typeof data !== 'string') {
      errors.push(`${name}：缺少内容`)
      continue
    }
    const buf = Buffer.from(data, 'base64')
    if (buf.byteLength !== meta.size) {
      errors.push(`${name}：实际大小 ${buf.byteLength} 与声明的 ${meta.size} 不符`)
      continue
    }
    if (sha256(buf) !== meta.sha256) {
      errors.push(`${name}：内容校验失败（文件已损坏或被篡改）`)
    }
  }

  const computed = sha256(stableIntegrityInput(envelope.manifest, envelope.files))
  if (computed !== envelope.integrity) {
    errors.push('整包 integrity 与实际内容不符（包已损坏或被篡改）')
  }
  if (expectedIntegrity && computed !== expectedIntegrity) {
    errors.push(`下载到的包与市场登记的 integrity 不符（期望 ${short(expectedIntegrity)}）`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const mainSha256 = envelope.manifest.main
    ? (envelope.files[envelope.manifest.main.replace(/^\.\//, '')]?.sha256 ?? null)
    : null
  return {
    ok: true,
    value: {
      envelope,
      manifest: envelope.manifest,
      mainSha256,
      warnings: structural.warnings
    }
  }
}

export interface InstallExtensionOptions {
  source: Exclude<ExtensionSource, 'dev'>
  registryUrl?: string | null
  /** 外部给出的期望 integrity（市场响应头）；本地/内置包不传 */
  expectedIntegrity?: string | null
  /** 当前应用版本；留空跳过 engines 检查（验收里用） */
  appVersion?: string
}

export interface InstallExtensionOutcome {
  record: ExtensionRecord
  manifest: ExtensionManifest
  warnings: string[]
  previousVersion: string | null
}

export async function installExtensionPackage(
  raw: unknown,
  options: InstallExtensionOptions
): Promise<InstallExtensionOutcome> {
  const verified = verifyExtensionPackage(raw, options.expectedIntegrity)
  if (!verified.ok) {
    throw new Error(`扩展包校验失败：${verified.errors.join('；')}`)
  }
  const { envelope, manifest, mainSha256, warnings } = verified.value
  const id = `${manifest.publisher}.${manifest.name}`

  if (options.appVersion && !satisfiesRange(options.appVersion, manifest.engines.imark)) {
    throw new Error(
      `扩展 ${id} 要求 iMark ${manifest.engines.imark}，当前版本 ${options.appVersion} 不满足`
    )
  }

  const staged = stagingDirFor(id)
  try {
    await mkdir(staged, { recursive: true })
    const names = Object.keys(envelope.files)
    for (const name of names) {
      const target = safeJoin(staged, name)
      await mkdir(dirname(target), { recursive: true }).catch(() => {})
      const buf = Buffer.from(envelope.data[name]!, 'base64')
      await writeFile(target, buf, { mode: 0o644 })
    }

    // 落盘后再算一次入口哈希：防的是解包/写盘阶段出的问题（磁盘满、杀毒软件改写）
    const entry = manifest.main?.replace(/^\.\//, '')
    if (entry) {
      const onDisk = await readFile(safeJoin(staged, entry))
      if (sha256(onDisk) !== envelope.files[entry]?.sha256) {
        throw new Error('入口文件写入后校验失败')
      }
    }

    await writeFile(
      safeJoin(staged, 'package.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    )

    const previous = await readFile(safeJoin(extensionDir(id), 'package.json'), 'utf8').catch(
      () => null
    )
    const previousVersion = previous
      ? (JSON.parse(previous) as { version?: unknown }).version
      : null

    await activateStaged(id, staged)

    const record: ExtensionRecord = {
      id,
      publisher: manifest.publisher,
      name: manifest.name,
      version: manifest.version,
      main: entry ?? null,
      activationEvents: manifest.activationEvents ?? [],
      capabilities: manifest.capabilities ?? {},
      integrity: envelope.integrity,
      mainSha256,
      installedAt: Date.now(),
      source: options.source,
      registryUrl: options.registryUrl ?? null
    }
    await setRecord(record)
    return {
      record,
      manifest,
      warnings,
      previousVersion: typeof previousVersion === 'string' ? previousVersion : null
    }
  } catch (err) {
    await cleanupStaging(staged)
    throw err
  }
}

/** 界面展示 sha256 时统一截断 */
export function short(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 6)}…${sha.slice(-6)}` : sha
}
