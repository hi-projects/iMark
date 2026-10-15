/**
 * 目录 → 插件信封(打包)。
 *
 * 这是 `scripts/build-plugins.mjs` 的运行时孪生:前者在命令行里打包 plugins-src/ 下的
 * 官方插件,后者让用户在界面里挑一个目录打包。两者有约 30 行重复的遍历与组装逻辑,
 * **这是有意接受的** —— 它们从不同时出场,而且正确性的唯一权威是安装时的
 * `verifyEnvelope()`:打包端算错了,自己就会被拒。
 *
 * 只做 JS:不在这里编译 TypeScript。用 TS 写的插件先自己编译成 `main.js`,
 * 或者干脆用 `npm run plugins:build`(官方插件走的就是那条路)。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  integrityInput,
  isSafeRelPath,
  LIMITS,
  validateManifest,
  type PackageFileEntry,
  type PluginManifest,
  type PluginPackageEnvelope
} from '@shared/pluginPackage'
import { sha256 } from './verify'

/** 不参与打包的目录 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github', '.vscode'])
/** 不参与打包的文件:源码、构建产物、清单(清单进 envelope.manifest,不进 files) */
const SKIP_FILE = /(^|\/)(manifest\.json|.*\.(ts|tsx|mts|cts|map))$/

export interface PackResult {
  envelope: PluginPackageEnvelope
  manifest: PluginManifest
  files: { name: string; size: number }[]
  totalBytes: number
}

/** 递归收集要进包的文件(相对路径,已过滤) */
async function collect(dir: string, base = dir, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 3) return out
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      await collect(full, base, out, depth + 1)
      continue
    }
    if (!info.isFile()) continue
    if (info.size > LIMITS.fileBytes) throw new Error(`${name} 超过单文件大小上限`)
    const rel = relative(base, full).split(/[/\\]/).join('/')
    if (SKIP_FILE.test(rel)) continue
    out.push(rel)
  }
  return out
}

/**
 * 把一个目录打成信封。抛出的错误直接可展示给用户。
 * 注意:**不写入磁盘** —— 是否发布/安装由调用方决定。
 */
export async function packDirectory(dir: string): Promise<PackResult> {
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('这个目录里没有可读的 manifest.json —— 插件目录必须包含一份清单')
  }

  // 用与应用同一份校验:这样「能打包」与「能安装」是同一套标准,不会出现
  // 界面里打包成功、装的时候被拒的困惑
  const checked = validateManifest(manifestRaw)
  if (!checked.ok || !checked.value) {
    throw new Error(`清单不合法:${checked.errors.slice(0, 5).join(';')}`)
  }
  const manifest = checked.value

  const names = (await collect(dir)).sort()
  if (names.length === 0) throw new Error('这个目录里没有任何可打包的文件')

  if (manifest.kind === 'script') {
    const main = manifest.main ?? 'main.js'
    if (!names.includes(main)) {
      throw new Error(
        `清单声明的入口 ${main} 不在目录里。若是 TypeScript 写的,请先编译出 ${main} 再打包。`
      )
    }
  }
  if (manifest.icon && !names.includes(manifest.icon)) {
    throw new Error(`清单声明的图标 ${manifest.icon} 不在目录里`)
  }

  const files: Record<string, PackageFileEntry> = {}
  const data: Record<string, string> = {}
  let totalBytes = 0
  for (const name of names) {
    if (!isSafeRelPath(name)) throw new Error(`非法文件路径:${name}`)
    const buf = await readFile(join(dir, name))
    const limit = name === 'README.md' ? LIMITS.readmeBytes : LIMITS.fileBytes
    if (buf.byteLength > limit) throw new Error(`${name} 超过大小上限(${limit} 字节)`)
    files[name] = { encoding: 'base64', size: buf.byteLength, sha256: sha256(buf) }
    data[name] = buf.toString('base64')
    totalBytes += buf.byteLength
  }

  const envelope: PluginPackageEnvelope = {
    format: 'imk-plugin',
    formatVersion: 1,
    manifest,
    files,
    data,
    integrity: sha256(integrityInput(manifest, files))
  }

  const size = Buffer.byteLength(JSON.stringify(envelope))
  if (size > LIMITS.envelopeBytes) {
    throw new Error(
      `打包后体积 ${(size / 1024 / 1024).toFixed(1)} MiB 超过上限 ${LIMITS.envelopeBytes / 1024 / 1024} MiB`
    )
  }

  return {
    envelope,
    manifest,
    files: names.map(name => ({ name, size: files[name]!.size })),
    totalBytes
  }
}
