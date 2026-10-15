#!/usr/bin/env node
/**
 * 把 plugins-src/ 下的每个插件目录打包成插件信封,产出
 * `src/main/market/builtin/<id>.imkpkg.json`(应用内置的兜底包)。
 *
 * 这些包不是「另一套格式」——它们与从市场下载的包**逐字节同构**,
 * 应用补装时走的是完全相同的校验与安装代码路径。所以内置包坏了,
 * 在市场上下载同一个插件也一样坏,反之亦然。
 *
 * 零依赖:只用 Node 内置模块 + 仓库里已有的 typescript。
 *
 *   npm run plugins:build
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'plugins-src')
const OUT = join(ROOT, 'src/main/market/builtin')
/** tsc 的输出根(见 plugins-src/tsconfig.json 的 rootDir/outDir:rootDir 是仓库根) */
const DIST = join(SRC, 'dist/plugins-src')

const LIMITS = { envelopeBytes: 8 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, mainBytes: 1024 * 1024 }
const ALLOWED_EXT = ['js', 'mjs', 'cjs', 'json', 'md', 'txt', 'svg', 'png', 'css']
/** 插件源码目录里不参与打包的目录 */
const EXCLUDE = new Set(['node_modules', 'dist', '.git'])
/** 也不参与打包的文件:源码与构建中间产物。清单单独处理(它进 envelope.manifest,不进 files) */
const EXCLUDE_FILE = /(^|\/)(manifest\.json|.*\.(ts|tsx|mts|cts|map))$/

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/**
 * 按 validateManifest() 构造返回值的顺序重排清单键。
 *
 * **这个顺序必须与 src/shared/pluginPackage.ts 里的 validateManifest 完全一致** ——
 * integrity 是对 `JSON.stringify({manifest, files})` 求的 sha256,而 JSON.stringify
 * 保留对象的键插入顺序。顺序对不上,应用下载后算出来的 integrity 就对不上,
 * 内置包会被自己的校验拒掉。
 * (fields 数组本身不重排:validateManifest 原样透传 JSON 里的那个数组。)
 */
function canonicalManifest(raw) {
  const keys = [
    'id',
    'name',
    'description',
    'version',
    'kind',
    'fields',
    'actions',
    'author',
    'homepage',
    'capability',
    'main',
    'permissions',
    'icon',
    'engines',
    'targetActions',
    'targetFieldKey'
  ]
  const out = {}
  for (const key of keys) {
    if (raw[key] === undefined) continue
    if (key === 'actions') out[key] = raw.actions ?? []
    else out[key] = raw[key]
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
  const ext = (parts[parts.length - 1].split('.').pop() ?? '').toLowerCase()
  return ALLOWED_EXT.includes(ext)
}

/** 递归收集插件目录里的静态资源(README.md / icon / assets 等),排除源码与构建产物 */
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

function buildOne(dirName) {
  const dir = join(SRC, dirName)
  const manifestRaw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const manifest = canonicalManifest(manifestRaw)

  if (manifest.kind !== 'script') {
    throw new Error(`${dirName}: 目前只有 script 插件需要编译产物(声明式插件不必进 plugins-src/)`)
  }
  const mainRel = manifest.main ?? 'main.js'
  const mainPath = join(DIST, dirName, mainRel)
  let mainSrc
  try {
    mainSrc = readFileSync(mainPath)
  } catch {
    throw new Error(`${dirName}: 找不到编译产物 ${relative(ROOT, mainPath)},请先跑 tsc`)
  }
  if (mainSrc.byteLength > LIMITS.mainBytes) {
    throw new Error(`${dirName}: ${mainRel} 超过 ${LIMITS.mainBytes} 字节上限`)
  }

  const contents = { [mainRel]: mainSrc }
  // README.md 会被市场抽进详情页,也让离线安装的用户有得可读
  for (const rel of collectStatic(dir)) {
    contents[rel] = readFileSync(join(dir, rel))
  }

  const files = {}
  const data = {}
  for (const name of Object.keys(contents).sort()) {
    if (!isSafeRelPath(name)) throw new Error(`${dirName}: 非法文件路径 ${name}`)
    const buf = contents[name]
    if (buf.byteLength > LIMITS.fileBytes) {
      throw new Error(`${dirName}: ${name} 超过 ${LIMITS.fileBytes} 字节上限`)
    }
    files[name] = { encoding: 'base64', size: buf.byteLength, sha256: sha256(buf) }
    data[name] = buf.toString('base64')
  }

  const envelope = {
    format: 'imk-plugin',
    formatVersion: 1,
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
execFileSync(process.execPath, [tsc, '-p', join(SRC, 'tsconfig.json')], { stdio: 'inherit' })

const plugins = readdirSync(SRC).filter(
  name => !name.startsWith('.') && name !== 'dist' && statSync(join(SRC, name)).isDirectory()
)
if (plugins.length === 0) {
  console.log('[plugins] plugins-src/ 下没有插件')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
for (const name of plugins) {
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
