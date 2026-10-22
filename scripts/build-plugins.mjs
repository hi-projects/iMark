#!/usr/bin/env node
/**
 * 把 plugins-src/ 下的每个扩展打包成扩展信封,产出
 * `src/main/market/builtin/<publisher>.<name>.imkpkg.json`。
 *
 * 构建只有一种入口形态:
 *
 *   package.json  清单(唯一真身)
 *   main.ts       → esbuild → main.js(CommonJS,`imark` 外置)
 *   webview/*.ts  → esbuild → webview/*.js(IIFE,依赖全部内联)
 *   其余文件      → 原样复制
 *
 * 内置包与市场下载的包**逐字节同构**:应用补装时走完全相同的校验与安装代码。
 *
 * 关键点:清单校验、规范化与 integrity 的 stable stringify **不在本脚本里重写**。
 * 脚本用 esbuild 把 `src/shared/extensionPackage.ts` 打成一段无依赖的 ESM,再通过
 * data: URL import 进来。这样作者、构建、服务端、应用四处对“什么算合法清单”只有
 * 一份实现,不会出现“本地能打包、应用拒收”的漂移。
 *
 *   npm run plugins:build
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'plugins-src')
const OUT = join(ROOT, 'src/main/market/builtin')
const DIST = join(SRC, 'dist')

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.cache'])
/** provider 契约等共享模块走 tsconfig 的 @shared/* 别名；esbuild 不读 tsconfig paths */
const SHARED_ALIAS = { '@shared': join(ROOT, 'src/shared') }
/** 源码与构建中间产物不进包;清单单独进 envelope.manifest */
const EXCLUDE_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|.*\.(ts|tsx|mts|cts|map))$/
/** webview 下不作为入口打包的共享模块 */
const WEBVIEW_NON_ENTRIES = new Set(['shim.ts', 'shared.ts'])

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/**
 * 文本文件一律以 LF 进包。
 *
 * `core.autocrlf=true` 的检出会让工作区文件变成 CRLF,而 integrity 是对字节求的;
 * 归一之后 Windows 与 Linux 构建出的包逐字节一致。
 */
function normalizeEol(name, buf) {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (!TEXT_EXT.has(ext)) return buf
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/**
 * 把共享校验模块打成无依赖 ESM 并 import 进来。
 *
 * 不用临时文件:data: URL 里的模块没有任何相对 import(已 bundle),不会从
 * 工作目录解析到别的东西。构建脚本只读本仓库源码,不碰下载来的内容。
 */
async function loadSharedValidator() {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/shared/extensionPackage.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    charset: 'utf8',
    loader: { '.json': 'json' }
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)
}

function collectStatic(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name) || name.startsWith('.')) continue
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

function collectTopLevel(dir, suffix) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith(suffix) && !name.startsWith('_'))
}

async function bundleMain(dir, manifest, entryName) {
  const source = join(dir, entryName.replace(/\.js$/, '.ts'))
  if (!existsSync(source)) {
    throw new Error(`${relative(ROOT, dir)}:清单声明了 main=${entryName},但找不到 ${relative(ROOT, source)}`)
  }
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
    // 宿主注入的虚拟模块;必须由扩展宿主在运行时解析
    external: ['imark'],
    alias: SHARED_ALIAS,
    // Node 内置模块自动外置;允许扩展带自己的 CJS/ESM 依赖
    packages: 'external',
    legalComments: 'eof',
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  const text = result.outputFiles[0].text
  if (text.length > LIMITS.entryBytes) {
    throw new Error(`${relative(ROOT, source)}:入口超过 ${LIMITS.entryBytes} 字节`)
  }
  return Buffer.from(text, 'utf8')
}

async function bundleWebviewEntry(source) {
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
    minify: true,
    alias: SHARED_ALIAS,
    // 保留带 @license 的版权声明;完整许可证另随包分发
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  const buf = Buffer.from(result.outputFiles[0].text, 'utf8')
  if (buf.byteLength > LIMITS.entryBytes) {
    throw new Error(`${relative(ROOT, source)}:webview 入口超过 ${LIMITS.entryBytes} 字节`)
  }
  return buf
}

async function buildOne(dirName, shared) {
  const dir = join(SRC, dirName)
  const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const checked = shared.validateManifest(raw)
  for (const warning of checked.warnings) {
    console.warn(`[plugins] ${dirName}: 警告:${warning}`)
  }
  if (!checked.ok) {
    throw new Error(`${dirName}: package.json 校验失败:\n  - ${checked.errors.join('\n  - ')}`)
  }
  const manifest = checked.value
  const id = shared.extensionIdOf(manifest)
  const entry = shared.entryFileOf(manifest)

  /** 包内路径 → 字节 */
  const contents = {}

  if (entry) {
    contents[entry] = await bundleMain(dir, manifest, entry)
  }

  // webview/**/*.ts → webview/**/*.js;html/css 等由静态资源收集处理
  const webviewDir = join(dir, 'webview')
  for (const name of collectTopLevel(webviewDir, '.ts')) {
    if (WEBVIEW_NON_ENTRIES.has(name)) continue
    const outName = `webview/${name.replace(/\.ts$/, '.js')}`
    contents[outName] = await bundleWebviewEntry(join(webviewDir, name))
  }

  for (const rel of collectStatic(dir)) {
    contents[rel] = readFileSync(join(dir, rel))
  }

  // 包内路径与体积
  const files = {}
  const data = {}
  for (const name of Object.keys(contents).sort()) {
    if (!shared.isSafeRelPath(name)) throw new Error(`${dirName}: 非法文件路径 ${name}`)
    const buf = normalizeEol(name, contents[name])
    const limit =
      name === 'README.md'
        ? shared.EXTENSION_LIMITS.readmeBytes
        : name === shared.iconFileOf(manifest)
          ? shared.EXTENSION_LIMITS.iconBytes
          : shared.EXTENSION_LIMITS.fileBytes
    if (buf.byteLength > limit) {
      throw new Error(`${dirName}: ${name} 超过 ${limit} 字节上限`)
    }
    files[name] = { encoding: 'base64', size: buf.byteLength, sha256: sha256(buf) }
    data[name] = buf.toString('base64')
  }

  const integrityInput = shared.stableIntegrityInput(manifest, files)
  const envelope = {
    format: shared.PACKAGE_FORMAT,
    formatVersion: shared.PACKAGE_FORMAT_VERSION,
    manifest,
    files,
    data,
    integrity: sha256(integrityInput)
  }

  // 自检:生成的包必须能通过应用与市场共用的同一套校验
  const verifies = shared.validateEnvelope(envelope)
  if (!verifies.ok) {
    throw new Error(`${dirName}: 生成的扩展包未通过校验:\n  - ${verifies.errors.join('\n  - ')}`)
  }

  const json = JSON.stringify(envelope)
  if (Buffer.byteLength(json) > shared.EXTENSION_LIMITS.envelopeBytes) {
    throw new Error(`${dirName}: 包体积超过上限`)
  }

  // 同时铺一份可直接用于开发模式的目录
  const devDir = join(DIST, id)
  rmSync(devDir, { recursive: true, force: true })
  mkdirSync(devDir, { recursive: true })
  for (const [name, buf] of Object.entries(contents)) {
    const target = join(devDir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, normalizeEol(name, buf))
  }
  writeFileSync(join(devDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  return { envelope, files: Object.keys(files) }
}

// ---------- 主流程 ----------

const shared = await loadSharedValidator()
const TEXT_EXT = new Set(shared.EXTENSION_TEXT_EXTENSIONS)
const LIMITS = shared.EXTENSION_LIMITS

rmSync(DIST, { recursive: true, force: true })

const plugins = readdirSync(SRC).filter(
  name => !name.startsWith('.') && name !== 'dist' && statSync(join(SRC, name)).isDirectory()
)
if (plugins.length === 0) {
  console.log('[plugins] plugins-src/ 下没有扩展')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
for (const name of plugins) {
  if (!existsSync(join(SRC, name, 'package.json'))) {
    console.warn(`[plugins] 跳过 ${name}:没有 package.json`)
    continue
  }
  const { envelope, files } = await buildOne(name, shared)
  const id = shared.extensionIdOf(envelope.manifest)
  const target = join(OUT, `${id}.imkpkg.json`)
  writeFileSync(target, JSON.stringify(envelope, null, 2) + '\n', 'utf8')
  console.log(
    `[plugins] ${id} ${envelope.manifest.version} → src/main/market/builtin/${id}.imkpkg.json\n` +
      `          文件 ${files.join(', ')}\n` +
      `          integrity ${envelope.integrity}`
  )
}
