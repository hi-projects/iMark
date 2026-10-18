#!/usr/bin/env node
/**
 * 把 plugins-src/ 下的每个插件目录打包成插件信封,产出
 * `src/main/market/builtin/<id>.imkpkg.json`(应用内置的兜底包)。
 *
 * 插件由两层组成,构建也按层取产物:
 *   - `main.mode: 'node'`       → tsc CommonJS 产物(dist/node)
 *   - `main.mode: 'restricted'` → tsc ES module 产物(dist/restricted)
 *   - `render`                  → tsc ES2022 产物(dist/render),入口必须是普通脚本
 *
 * 这些包不是「另一套格式」——它们与从市场下载的包**逐字节同构**,
 * 应用补装时走的是完全相同的校验与安装代码路径。
 *
 * 零依赖:只用 Node 内置模块 + 仓库里已有的 typescript。
 *
 *   npm run plugins:build
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'plugins-src')
const OUT = join(ROOT, 'src/main/market/builtin')

/** 三套 tsc 产物根(见 plugins-src/tsconfig.*.json 的 rootDir/outDir) */
const DIST = {
  node: join(SRC, 'dist/node/plugins-src'),
  restricted: join(SRC, 'dist/restricted/plugins-src'),
  render: join(SRC, 'dist/render/plugins-src')
}

const LIMITS = {
  envelopeBytes: 8 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  entryBytes: 1024 * 1024
}
/** 插件源码目录里不参与打包的目录 */
const EXCLUDE = new Set(['node_modules', 'dist', '.git'])
/** 也不参与打包的文件:源码与构建中间产物。清单单独处理(它进 envelope.manifest,不进 files) */
const EXCLUDE_FILE = /(^|\/)(manifest\.json|.*\.(ts|tsx|mts|cts|map))$/

/**
 * 与 src/shared/pluginPackage.ts 共用的格式数据(清单键序、扩展名白名单、保留段)。
 *
 * 直接读 JSON 而不是各抄一份:这个脚本跑在裸 Node 上,import 不了 TS 模块,
 * 而键序与白名单**必须**与应用逐字一致 —— 见 pluginFormat.json 里的说明。
 */
const FORMAT = JSON.parse(readFileSync(join(ROOT, 'src/shared/pluginFormat.json'), 'utf8'))
const ALLOWED_EXT = FORMAT.allowedExtensions
const RESERVED_SEGMENT = FORMAT.reservedSegment
const ARRAY_KEYS = new Set(FORMAT.arrayKeys)

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/**
 * 文本文件一律以 **LF** 进包。
 *
 * `core.autocrlf=true` 的检出(Windows 默认)会让工作区里的文件是 CRLF,而包的
 * integrity 是对**字节**求的 —— 同一份源码在 Windows 与 Linux 上构建会得到
 * 两个 integrity,表现是"包没变,但校验值变了",合并时还会把这两个庞大的 JSON
 * 当成冲突文件。归一之后两边逐字节一致。
 */
const TEXT_EXT = new Set(FORMAT.textExtensions)
function normalizeEol(name, buf) {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (!TEXT_EXT.has(ext)) return buf
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/** 按固定键序重建一个嵌套对象(main / render) */
function orderObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of keys) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/**
 * 与 shared/pluginPackage.ts 的 canonicalManifest() 同构 —— 同一个键序、同一套兜底。
 * integrity 是对 `JSON.stringify({manifest, files})` 求的 sha256,JSON.stringify 保留键的
 * 插入顺序,所以这个顺序是格式的一部分:两边对不上,包会被应用自己的校验拒掉。
 */
function canonicalManifest(raw) {
  const out = {}
  for (const key of FORMAT.manifestKeyOrder) {
    if (ARRAY_KEYS.has(key)) {
      out[key] = raw[key] ?? []
    } else if (key === 'main' && raw.main) {
      out.main = orderObject(raw.main, FORMAT.mainKeyOrder)
    } else if (key === 'render' && raw.render) {
      out.render = orderObject(raw.render, FORMAT.renderKeyOrder)
    } else if (raw[key] !== undefined) {
      out[key] = raw[key]
    }
  }
  return out
}

/** 与 shared/pluginPackage.ts 的 integrityInput() 同构(同样按文件名排序) */
function integrityInput(manifest, files) {
  const map = {}
  for (const name of Object.keys(files).sort()) map[name] = files[name].sha256
  return JSON.stringify({ manifest, files: map })
}

function isSafeRelPath(p) {
  if (!p || p.length > 128 || p.startsWith('/') || p.includes('\\')) return false
  const parts = p.split('/')
  if (parts.length > 3) return false
  if (parts.some(s => s === '' || s === '.' || s === '..')) return false
  if (parts.some(s => s.toLowerCase() === RESERVED_SEGMENT)) return false
  const ext = (parts[parts.length - 1].split('.').pop() ?? '').toLowerCase()
  return ALLOWED_EXT.includes(ext)
}

/** 递归收集插件源目录里的静态资源(README / icon / assets 等) */
function collectStatic(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE.has(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      collectStatic(full, base, out)
      continue
    }
    const rel = relative(base, full).split(/[/\\]/).join('/')
    if (EXCLUDE_FILE.test(rel)) continue
    out.push(rel)
  }
  return out
}

/**
 * 递归收集某个编译产物目录里的文件(入口可能 import/require 同目录的其它文件)。
 * 返回的路径相对于 `<root>/<dirName>`,也就是包内路径。
 */
function collectDist(root, dirName, out = [], base = join(root, dirName)) {
  if (!existsSync(base)) return out
  for (const name of readdirSync(base)) {
    const full = join(base, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      collectDist(root, dirName, out, full)
      continue
    }
    if (name === 'manifest.json' || /\.(map|d\.ts)$/.test(name)) continue
    out.push(relative(join(root, dirName), full).split(/[/\\]/).join('/'))
  }
  return out
}

/**
 * render 入口必须是普通脚本:CSP/注入方式不允许 import/export/require/eval。
 * 返回**剥掉 tsc 模块标记之后**的字节。
 */
function plainScript(name, buf) {
  let code = buf.toString('utf8')
  // tsc 会给"只 import type"的模块补一个 `export {};` —— 它不产生任何运行时语义,剥掉
  code = code.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
  if (/\b(?:import|export)\b/.test(code) || /\brequire\s*\(/.test(code) || /\beval\s*\(/.test(code)) {
    throw new Error(
      `${name}: render 入口必须是普通脚本(不能有 import/export/require/eval);` +
        `请作者自行打包成 IIFE`
    )
  }
  return Buffer.from(code, 'utf8')
}

function buildOne(dirName) {
  const dir = join(SRC, dirName)
  const manifestRaw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const manifest = canonicalManifest(manifestRaw)
  const contents = {}

  // ---- main 层 ----
  if (manifest.main) {
    const mode = manifest.main.mode
    const root = DIST[mode]
    if (!root) throw new Error(`${dirName}: 不认识的 main.mode ${String(mode)}`)
    const files = collectDist(root, dirName)
    if (files.length === 0) {
      throw new Error(`${dirName}: 找不到 ${mode} 的编译产物,请先跑 tsc`)
    }
    for (const rel of files) contents[rel] = readFileSync(join(root, dirName, rel))
    if (!contents[manifest.main.entry]) {
      throw new Error(`${dirName}: 清单声明的 main 入口 ${manifest.main.entry} 不在编译产物里`)
    }
  }

  // ---- render 层 ----
  if (manifest.render) {
    const files = collectDist(DIST.render, dirName)
    if (files.length === 0) {
      throw new Error(`${dirName}: 找不到 render 的编译产物,请先跑 tsc`)
    }
    for (const rel of files) contents[rel] = readFileSync(join(DIST.render, dirName, rel))
    const entry = contents[manifest.render.entry]
    if (!entry) {
      throw new Error(`${dirName}: 清单声明的 render 入口 ${manifest.render.entry} 不在编译产物里`)
    }
    contents[manifest.render.entry] = plainScript(`${dirName}/${manifest.render.entry}`, entry)
  }

  // ---- 静态资源(README / icon / assets) ----
  for (const rel of collectStatic(dir)) {
    contents[rel] = readFileSync(join(dir, rel))
  }

  // ---- 入口体积 ----
  for (const [label, entry] of [
    ['main', manifest.main?.entry],
    ['render', manifest.render?.entry]
  ]) {
    if (!entry) continue
    const buf = contents[entry]
    if (!buf) throw new Error(`${dirName}: ${label} 入口 ${entry} 不在包里`)
    if (buf.byteLength > LIMITS.entryBytes) {
      throw new Error(`${dirName}: ${label} 入口 ${entry} 超过 ${LIMITS.entryBytes} 字节上限`)
    }
  }

  const files = {}
  const data = {}
  for (const name of Object.keys(contents).sort()) {
    if (!isSafeRelPath(name)) throw new Error(`${dirName}: 非法文件路径 ${name}`)
    const buf = normalizeEol(name, contents[name])
    if (buf.byteLength > LIMITS.fileBytes) {
      throw new Error(`${dirName}: ${name} 超过 ${LIMITS.fileBytes} 字节上限`)
    }
    files[name] = { encoding: 'base64', size: buf.byteLength, sha256: sha256(buf) }
    data[name] = buf.toString('base64')
  }

  const envelope = {
    format: 'imk-plugin',
    formatVersion: FORMAT.formatVersion,
    manifest,
    files,
    data,
    integrity: sha256(integrityInput(manifest, files))
  }
  const json = JSON.stringify(envelope)
  if (Buffer.byteLength(json) > LIMITS.envelopeBytes) {
    throw new Error(`${dirName}: 包体积超过上限`)
  }
  return { envelope, files: Object.keys(files) }
}

// ---------- 主流程 ----------

const tsc = join(ROOT, 'node_modules/typescript/bin/tsc')
console.log('[plugins] 编译 plugins-src …')
for (const target of ['node', 'restricted', 'render']) {
  const config = join(SRC, `tsconfig.${target}.json`)
  if (!existsSync(config)) {
    throw new Error(`缺少 ${relative(ROOT, config)} —— 需要 node/restricted/render 三份 tsconfig`)
  }
  // 清掉旧产物:tsc 不会删除已被移除的源文件对应的 .js
  rmSync(join(SRC, `dist/${target}`), { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, '-p', config], { stdio: 'inherit' })
}

const plugins = readdirSync(SRC).filter(
  name => !name.startsWith('.') && name !== 'dist' && statSync(join(SRC, name)).isDirectory()
)
if (plugins.length === 0) {
  console.log('[plugins] plugins-src/ 下没有插件')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
for (const name of plugins) {
  const raw = JSON.parse(readFileSync(join(SRC, name, 'manifest.json'), 'utf8'))
  const manifest = canonicalManifest(raw)

  // 把清单拷进对应编译产物目录,让它成为**可以直接跑开发模式的插件目录**。
  // render 层没有独立的源目录概念,但 manifest 仍可放在 render dist 里。
  if (manifest.main) {
    copyFileSync(
      join(SRC, name, 'manifest.json'),
      join(DIST[manifest.main.mode], name, 'manifest.json')
    )
  }
  if (manifest.render) {
    mkdirSync(join(DIST.render, name), { recursive: true })
    copyFileSync(join(SRC, name, 'manifest.json'), join(DIST.render, name, 'manifest.json'))
  }

  const { envelope, files } = buildOne(name)
  const target = join(OUT, `${envelope.manifest.id}.imkpkg.json`)
  writeFileSync(target, JSON.stringify(envelope, null, 2) + '\n', 'utf8')
  console.log(
    `[plugins] ${envelope.manifest.id} ${envelope.manifest.version} → ${posix.join(
      'src/main/market/builtin',
      `${envelope.manifest.id}.imkpkg.json`
    )}` +
      `\n          文件 ${files.join(', ')}` +
      `\n          integrity ${envelope.integrity}`
  )
}
