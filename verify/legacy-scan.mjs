#!/usr/bin/env node
/**
 * 已删除形态残留扫描。
 *
 * 不是替代类型检查或 harness,而是防"代码改了、文档/夹具又长出旧字段"。
 * 只扫应用源码、插件源码、服务端与构建脚本;verify/ 里允许保留历史夹具说明。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const ROOTS = ['src', 'plugins-src', 'server', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '.verify-ud'])

const PATTERNS = [
  { re: /\bkind\s*:\s*['"](?:script|sandboxed|renderer|declarative)['"]/, why: '已删除的 kind 字面量' },
  { re: /\bPluginKind\b/, why: 'PluginKind 类型已删除' },
  { re: /\bhasMainEntry\b/, why: 'hasMainEntry 已删除' },
  { re: /\bSANDBOX_ONLY_PERMISSIONS\b|\bCODE_ONLY_PERMISSIONS\b/, why: '旧权限分类已删除' },
  { re: /\bui\.mount\b/, why: 'ui.mount 已删除' },
  { re: /\bhalves\.(?:send|onMessage)\b|\bhalvesMessage\b/, why: 'halves 已改名为 render/main' },
  { re: /\bsendToRenderHalf\b|\bhasRenderHalf\b|\bisSandbox\b/, why: '旧层语义名' },
  { re: /\bpluginWindowOf\b|\bPluginDock\b|\bopenPluginWindow\b/, why: '插件自有窗口/停靠已删除' },
  { re: /\bPluginUiClick\b|\bPluginDockRect\b|\bplugin:ui-click\b|\bplugin:dock-rect\b/, why: '旧 IPC 通道已删除' },
  { re: /\bonPluginEditorInsert\b|\bplugin:editor-insert\b/, why: 'editor.insert 通道已删除' }
]

const hits = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(ts|tsx|vue|mjs|js|json)$/.test(name)) continue
    if (name.endsWith('.imkpkg.json')) continue
    const text = readFileSync(full, 'utf8')
    for (const p of PATTERNS) {
      if (!p.re.test(text)) continue
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (p.re.test(line)) {
          hits.push(`${relative(ROOT, full)}:${i + 1}  ${p.why}  →  ${line.trim().slice(0, 120)}`)
        }
      })
    }
  }
}

for (const root of ROOTS) walk(join(ROOT, root))

// 内置包:manifest 里不能有已删除字段,formatVersion 必须与共享格式一致
const builtinDir = join(ROOT, 'src/main/market/builtin')
for (const name of readdirSync(builtinDir)) {
  if (!name.endsWith('.imkpkg.json')) continue
  const env = JSON.parse(readFileSync(join(builtinDir, name), 'utf8'))
  if (env.formatVersion !== 1) hits.push(`${name}: formatVersion 不是 1`)
  for (const key of ['kind', 'ui', 'backend']) {
    if (env.manifest?.[key] !== undefined) hits.push(`${name}: manifest 仍有 ${key}`)
  }
  if (!env.manifest?.main && !env.manifest?.render && !env.manifest?.capability) {
    hits.push(`${name}: manifest 没有任何层`)
  }
}

if (hits.length > 0) {
  console.error(`[legacy-scan] 发现 ${hits.length} 处已删除形态残留:\n`)
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
console.log('[legacy-scan] 没有已删除形态残留')
