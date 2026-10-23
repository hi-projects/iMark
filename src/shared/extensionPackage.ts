/**
 * 扩展包格式(package.json 清单 + 单文件 JSON 信封)与校验。
 *
 * 一个扩展就是一个普通的 VS Code 式扩展:
 *
 *   package.json   清单(唯一真身;信封里保存剥掉构建字段后的那一份)
 *   main.js        可选入口,在扩展宿主进程里 require
 *   webview/**     可选 webview 资源
 *   README.md …
 *
 * 信封仍然是“元信息 + 内容”的单文件 JSON:
 *   files: 路径 → { size, sha256 }      ← 被 integrity 覆盖
 *   data:  路径 → base64                ← 由 files 的逐文件 sha256 传递覆盖
 *
 * integrity = sha256(stableStringify({ manifest, files: { name: sha256 } }))。
 * stableStringify 递归排序键,于是打包器、服务端、客户端只要“对象内容相同”
 * 就得到同一个值。
 *
 * 本文件零 Node 依赖(不 import crypto),渲染层也会 import 它做展示;
 * 真正的 sha256 在主进程、构建脚本与服务端各自计算。
 */

import formatData from './extensionFormat.json'
import type { ExtensionDescriptor } from './extensions'
import type {
  PluginField,
  PluginFieldKind,
  PluginFieldScope,
  PluginLineMenuDialog
} from './plugins'

export const PACKAGE_FORMAT: string = formatData.format
export const PACKAGE_FORMAT_VERSION: number = formatData.formatVersion
export const EXTENSION_LIMITS = formatData.limits

const MANIFEST_KEYS = formatData.manifestKeyOrder
const CONTRIBUTES_KEYS = formatData.contributesKeyOrder
const CAPABILITY_KEYS = formatData.capabilityKeys
const FILESYSTEM_VALUES = formatData.filesystemValues
const ALLOWED_EXT: readonly string[] = formatData.allowedExtensions
const TEXT_EXT: readonly string[] = formatData.textExtensions
/** 构建脚本用它决定哪些文件按 LF 归一;与 isTextFile() 是同一份数据 */
export const EXTENSION_TEXT_EXTENSIONS: readonly string[] = TEXT_EXT
const RESERVED_SEGMENT: string = formatData.reservedSegment
const ACTIVATION_EVENTS = formatData.activationEvents
const AGENT_CORE_EXTENSION_ID: string = formatData.agentCoreExtensionId
const ID_PART_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const AGENT_PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}\.[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONFIG_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const FIELD_KEY_RE = /^[A-Za-z0-9_]{1,40}$/
const LINE_MENU_ID_RE = /^[a-z0-9-]{1,40}$/
/** 小写、`+` 分隔、至少一个修饰键;与 Electron 的 accelerator 对齐 */
const KEYBINDING_RE = /^(?:(?:ctrl|cmd|alt|shift|super|meta)\+)+[a-z0-9][a-z0-9+-]{0,20}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const FIELD_KINDS: readonly string[] = [
  'text',
  'textarea',
  'password',
  'number',
  'boolean',
  'select',
  'targets',
  'endpoints',
  'external'
]
const DIALOG_FIELD_KINDS: readonly string[] = ['text', 'number', 'boolean', 'select']
/**
 * package.json 里允许出现、但不进信封的构建字段。
 * 作者直接在 plugins-src 里跑开发模式时,清单里会有这些;打包器会把它们剥掉。
 */
const PACKAGING_KEYS = [
  'scripts',
  'devDependencies',
  'dependencies',
  'private',
  'type',
  'files',
  'publishConfig'
]

export type ExtensionFilesystemCapability = 'workspace' | 'user'

/** 安装披露用;不做运行时拦截 —— 扩展代码以当前用户权限运行 */
export interface ExtensionCapabilities {
  filesystem?: ExtensionFilesystemCapability
  network?: boolean
  secrets?: boolean
  git?: boolean
  process?: boolean
  shell?: boolean
}

export interface ExtensionCommandContribution {
  command: string
  title: string
  category?: string
  detail?: string
  icon?: string
  enablement?: string
}

export interface ExtensionKeybindingContribution {
  command: string
  key: string
  mac?: string
  when?: string
}

export interface ExtensionMenuContribution {
  command: string
  when?: string
  group?: string
}

export interface ExtensionMenusContribution {
  commandPalette?: ExtensionMenuContribution[]
}

/** `configuration.properties` 里 `imark` 元数据的形状(不含 key/kind 的交叉校验) */
export interface ExtensionFieldMarkdown {
  kind?: PluginFieldKind
  /**
   * 保存范围:`workspace` = 每个仓库各存一份覆盖值,缺省 = 全局一份。
   * 只影响非密配置;密钥始终全局。
   */
  scope?: PluginFieldScope
  label?: string
  description?: string
  section?: string
  showWhen?: { key: string; value: unknown }
  rows?: number
  resettable?: boolean
  required?: boolean
  placeholder?: string
  endpointModel?: { label: string; placeholder?: string }
  targetSecret?: { label: string; placeholder?: string }
  /** select 的显示名;标准 enum 只有值,标签需要单独给 */
  options?: { value: string; label: string }[]
  /** kind: 'external' 的文件与 JSON 指针 */
  file?: string
  dirEnv?: string
  pointer?: string
  secret?: boolean
}

export interface ExtensionConfigurationProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  default?: unknown
  enum?: unknown[]
  enumDescriptions?: string[]
  minimum?: number
  maximum?: number
  title?: string
  description?: string
  markdownDescription?: string
  order?: number
  imark?: ExtensionFieldMarkdown
}

export interface ExtensionConfigurationSection {
  title?: string
  properties: Record<string, ExtensionConfigurationProperty>
}

export type ExtensionConfiguration = ExtensionConfigurationSection | ExtensionConfigurationSection[]

export interface ExtensionLineMenuContribution {
  id: string
  label: string
  /** 必须指向 contributes.commands 里声明过的命令 */
  command: string
  dialog?: PluginLineMenuDialog
}

export interface ExtensionActionContribution {
  command: string
  label: string
  scope?: 'global' | 'target'
  /** scope=target 时必填:哪个配置属性保存着目标列表(完整键名) */
  targetSetting?: string
  primary?: boolean
}

export interface ExtensionContribution {
  commands?: ExtensionCommandContribution[]
  keybindings?: ExtensionKeybindingContribution[]
  menus?: ExtensionMenusContribution
  configuration?: ExtensionConfiguration
  /** iMark 私有:行首「+」菜单 */
  'imark.lineMenu'?: ExtensionLineMenuContribution[]
  /** iMark 私有:设置页里的动作按钮 */
  'imark.actions'?: ExtensionActionContribution[]
  /** iMark 私有:本扩展向 Agent Core 提供哪些 AgentProvider */
  'imark.agentProviders'?: string[]
}

/** package.json 清单(剥掉构建字段后的形状) */
export interface ExtensionManifest {
  publisher: string
  name: string
  version: string
  displayName?: string
  description?: string
  author?: string | { name?: string; email?: string; url?: string }
  license?: string
  homepage?: string
  repository?: string | { type?: string; url?: string }
  bugs?: string | { url?: string; email?: string }
  engines: { imark: string }
  main?: string
  icon?: string
  activationEvents?: string[]
  extensionDependencies?: string[]
  extensionAffinity?: string[]
  capabilities?: ExtensionCapabilities
  contributes?: ExtensionContribution
  categories?: string[]
  keywords?: string[]
  /** 打包时会被剥掉的字段;运行时清单里不会出现 */
  [key: string]: unknown
}

export interface PackageFileEntry {
  encoding: 'base64'
  size: number
  sha256: string
}

export interface ExtensionPackageEnvelope {
  format: typeof PACKAGE_FORMAT
  formatVersion: typeof PACKAGE_FORMAT_VERSION
  manifest: ExtensionManifest
  files: Record<string, PackageFileEntry>
  data: Record<string, string>
  integrity: string
}

export interface ExtensionValidation<T> {
  ok: boolean
  errors: string[]
  warnings: string[]
  value?: T
}

function fail<T>(...errors: string[]): ExtensionValidation<T> {
  return { ok: false, errors, warnings: [] }
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

export function extensionIdOf(manifest: Pick<ExtensionManifest, 'publisher' | 'name'>): string {
  return `${manifest.publisher}.${manifest.name}`
}

/** 清单里的 `./main.js` → 包内路径 `main.js` */
export function entryFileOf(manifest: Pick<ExtensionManifest, 'main'>): string | null {
  if (!manifest.main) return null
  return manifest.main.replace(/^\.\//, '')
}

export function iconFileOf(manifest: Pick<ExtensionManifest, 'icon'>): string | null {
  if (!manifest.icon) return null
  return manifest.icon.replace(/^\.\//, '')
}

export function isTextFile(name: string): boolean {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return TEXT_EXT.includes(ext)
}

export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > EXTENSION_LIMITS.pathLength) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  const parts = p.split('/')
  if (parts.length > EXTENSION_LIMITS.pathDepth) return false
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (seg.toLowerCase() === RESERVED_SEGMENT) return false
  }
  const ext = (parts[parts.length - 1]!.split('.').pop() ?? '').toLowerCase()
  return ALLOWED_EXT.includes(ext)
}

// ---------- 版本比较(覆盖 engines 的常见写法) ----------

export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core = '', pre = null] = v.split('-', 2) as [string, string | null]
    return { nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre > pb.pre ? 1 : -1
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function satisfiesRange(version: string, range: string | undefined): boolean {
  if (!range) return true
  const r = range.trim()
  const m = /^(>=|>|\^)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(r)
  if (!m) return true
  const op = m[1] ?? '^'
  const target = m[2]!
  const cmp = compareVersions(version, target)
  if (op === '>=') return cmp >= 0
  if (op === '>') return cmp > 0
  const major = (v: string): number => Number.parseInt(v.split('.')[0] ?? '0', 10) || 0
  return cmp >= 0 && major(version) === major(target)
}

// ---------- stable stringify / integrity ----------

/**
 * 递归键排序的 JSON 序列化。
 *
 * 与 JSON.stringify 的差异只有对象键序;数组顺序、数字/字符串/布尔/null 的表示
 * 与 JSON.stringify 完全一致。undefined 在对象里被省略、在数组里变成 null。
 * 打包器与服务端必须各有一份**逐字同构**的实现(见 extensionFormat.json 的说明)。
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'number') return Number.isFinite(value as number) ? JSON.stringify(value) : 'null'
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'undefined'
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      const done = stableStringify(item)
      return done === 'undefined' ? 'null' : done
    }).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const done = stableStringify(record[key])
    if (done === 'undefined') continue
    parts.push(`${JSON.stringify(key)}:${done}`)
  }
  return `{${parts.join(',')}}`
}

export function stableIntegrityInput(
  manifest: ExtensionManifest,
  files: Record<string, PackageFileEntry>
): string {
  const map: Record<string, string> = {}
  for (const name of Object.keys(files).sort()) map[name] = files[name]!.sha256
  return stableStringify({ manifest, files: map })
}

// ---------- 清单校验 ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateActivationEvents(value: unknown, warnings: string[], errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('activationEvents 必须是数组')
    return
  }
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0) {
      errors.push('activationEvents 里的每一项都必须是非空字符串')
      continue
    }
    if (ACTIVATION_EVENTS.exact.includes(raw)) continue
    if (ACTIVATION_EVENTS.prefixes.some(prefix => raw.startsWith(prefix) && raw.length > prefix.length)) {
      continue
    }
    warnings.push(`未知激活事件「${raw}」,当前版本会忽略它`)
  }
}

function validateCapabilities(value: unknown, errors: string[]): void {
  if (value === undefined) return
  if (!isObject(value)) {
    errors.push('capabilities 必须是对象')
    return
  }
  for (const key of Object.keys(value)) {
    if (!CAPABILITY_KEYS.includes(key)) {
      errors.push(`capabilities 里不认识的字段「${key}」(可用:${CAPABILITY_KEYS.join(' / ')})`)
    }
  }
  if (value.filesystem !== undefined && !FILESYSTEM_VALUES.includes(value.filesystem as string)) {
    errors.push(`capabilities.filesystem 只能是 ${FILESYSTEM_VALUES.join(' / ')}`)
  }
  for (const key of CAPABILITY_KEYS) {
    if (key === 'filesystem' || value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') errors.push(`capabilities.${key} 必须是布尔值`)
  }
}

function validateConfigProperties(
  section: unknown,
  where: string,
  id: string,
  errors: string[],
  warnings: string[],
  total: { count: number; keys: Set<string> }
): void {
  if (!isObject(section)) {
    errors.push(`${where} 必须是对象 { properties }`)
    return
  }
  if (section.title !== undefined && typeof section.title !== 'string') {
    errors.push(`${where}.title 必须是字符串`)
  }
  if (!isObject(section.properties)) {
    errors.push(`${where}.properties 必须是对象`)
    return
  }
  for (const [key, raw] of Object.entries(section.properties)) {
    total.count += 1
    const at = `${where}.properties.${key}`
    if (!CONFIG_KEY_RE.test(key)) {
      errors.push(`${at} 的键名非法`)
    }
    if (!key.startsWith(`${id}.`)) {
      errors.push(`${at} 必须以扩展 ID 开头(${id}.…)`)
    }
    if (total.keys.has(key)) errors.push(`配置键重复:${key}`)
    total.keys.add(key)
    if (!isObject(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    const type = raw.type
    if (
      type !== undefined &&
      type !== 'string' &&
      type !== 'number' &&
      type !== 'integer' &&
      type !== 'boolean' &&
      type !== 'array' &&
      type !== 'object'
    ) {
      errors.push(`${at}.type 非法:${String(type)}`)
    }
    if (raw.default === undefined) {
      errors.push(`${at} 缺少 default(设置页需要它作为初始值)`)
    }
    if (raw.enum !== undefined && !Array.isArray(raw.enum)) errors.push(`${at}.enum 必须是数组`)
    if (raw.minimum !== undefined && typeof raw.minimum !== 'number') errors.push(`${at}.minimum 必须是数字`)
    if (raw.maximum !== undefined && typeof raw.maximum !== 'number') errors.push(`${at}.maximum 必须是数字`)
    if (raw.title !== undefined && typeof raw.title !== 'string') errors.push(`${at}.title 必须是字符串`)

    const rawMeta = raw.imark
    if (rawMeta !== undefined && !isObject(rawMeta)) {
      errors.push(`${at}.imark 必须是对象`)
      continue
    }
    if (rawMeta === undefined) continue
    const meta: Record<string, unknown> = rawMeta
    if (meta.kind !== undefined && !FIELD_KINDS.includes(meta.kind as string)) {
      errors.push(`${at}.imark.kind 非法:${String(meta.kind)}`)
    }
    if (meta.scope !== undefined && meta.scope !== 'global' && meta.scope !== 'workspace') {
      errors.push(`${at}.imark.scope 只能是 global / workspace`)
    }
    if (meta.showWhen !== undefined) {
      if (!isObject(meta.showWhen) || typeof meta.showWhen.key !== 'string') {
        errors.push(`${at}.imark.showWhen 必须是 { key, value }`)
      }
    }
    if (meta.options !== undefined) {
      if (!Array.isArray(meta.options)) errors.push(`${at}.imark.options 必须是数组`)
      else {
        for (const option of meta.options) {
          if (!isObject(option) || typeof option.value !== 'string' || typeof option.label !== 'string') {
            errors.push(`${at}.imark.options 的每一项必须是 { value, label }`)
          }
        }
      }
    }
    if (
      (meta.kind === 'select') &&
      !Array.isArray(raw.enum) &&
      !Array.isArray(meta.options)
    ) {
      errors.push(`${at} 是 select,但既没有 enum 也没有 imark.options`)
    }
    if (meta.kind === 'external') {
      if (typeof meta.file !== 'string' || !meta.file.trim()) {
        errors.push(`${at}.imark.file 必须是非空字符串`)
      }
      if (typeof meta.pointer !== 'string' || !meta.pointer.startsWith('/') || meta.pointer === '/') {
        errors.push(`${at}.imark.pointer 必须是以 / 开头的 JSON 指针`)
      }
      if (meta.dirEnv !== undefined && typeof meta.dirEnv !== 'string') {
        errors.push(`${at}.imark.dirEnv 必须是字符串`)
      }
      if (meta.secret !== undefined && typeof meta.secret !== 'boolean') {
        errors.push(`${at}.imark.secret 必须是布尔值`)
      }
    }
    if (meta.kind === 'targets' || meta.kind === 'endpoints') {
      warnings.push(`${at} 使用 ${String(meta.kind)} 字段,请确认 targetSecret 与 targetSetting 已配置`)
    }
  }
}

function validateConfiguration(
  value: unknown,
  id: string,
  errors: string[],
  warnings: string[]
): void {
  if (value === undefined) return
  const sections = Array.isArray(value) ? value : [value]
  if (sections.length === 0) {
    errors.push('contributes.configuration 不能是空数组')
    return
  }
  const total = { count: 0, keys: new Set<string>() }
  for (const [i, section] of sections.entries()) {
    validateConfigProperties(
      section,
      Array.isArray(value) ? `contributes.configuration[${i}]` : 'contributes.configuration',
      id,
      errors,
      warnings,
      total
    )
  }
  if (total.count > EXTENSION_LIMITS.configurationProperties) {
    errors.push(`配置项过多(上限 ${EXTENSION_LIMITS.configurationProperties})`)
  }
}

function validateDialogFields(fields: unknown, at: string, errors: string[]): void {
  if (!Array.isArray(fields)) {
    errors.push(`${at} 必须是数组`)
    return
  }
  const seen = new Set<string>()
  for (const [i, raw] of fields.entries()) {
    const where = `${at}[${i}]`
    if (!isObject(raw)) {
      errors.push(`${where} 必须是对象`)
      continue
    }
    const key = raw.key
    if (typeof key !== 'string' || !FIELD_KEY_RE.test(key)) {
      errors.push(`${where}.key 非法(只能是字母/数字/下划线,1-40 字符)`)
    } else if (seen.has(key)) {
      errors.push(`${where}.key 重复:${key}`)
    } else {
      seen.add(key)
    }
    if (typeof raw.kind !== 'string' || !DIALOG_FIELD_KINDS.includes(raw.kind)) {
      errors.push(`${where}.kind 只能是 ${DIALOG_FIELD_KINDS.join(' / ')}`)
    }
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
      errors.push(`${where}.label 不能为空`)
    }
    if (raw.default === undefined) {
      errors.push(`${where} 缺少 default(对话框拿它当初始值)`)
    }
    if (raw.kind === 'select' && (!Array.isArray(raw.options) || raw.options.length === 0)) {
      errors.push(`${where} 是 select 但没有 options`)
    }
  }
}

function validateCommands(value: unknown, errors: string[], warnings: string[]): Set<string> {
  const declared = new Set<string>()
  if (value === undefined) return declared
  if (!Array.isArray(value)) {
    errors.push('contributes.commands 必须是数组')
    return declared
  }
  if (value.length > EXTENSION_LIMITS.commands) {
    errors.push(`contributes.commands 过多(上限 ${EXTENSION_LIMITS.commands})`)
  }
  for (const [i, raw] of value.entries()) {
    const at = `contributes.commands[${i}]`
    if (!isObject(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (typeof raw.command !== 'string' || !COMMAND_RE.test(raw.command)) {
      errors.push(`${at}.command 非法`)
    } else if (declared.has(raw.command)) {
      errors.push(`${at}.command 重复:${raw.command}`)
    } else {
      declared.add(raw.command)
    }
    if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
      errors.push(`${at}.title 不能为空`)
    }
    for (const key of ['category', 'detail', 'icon', 'enablement']) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string') {
        errors.push(`${at}.${key} 必须是字符串`)
      }
    }
    if (raw.command !== undefined && declared.size > EXTENSION_LIMITS.commands) {
      warnings.push(`${at} 超出命令上限后被忽略`)
    }
  }
  return declared
}

function validateKeybindings(
  value: unknown,
  declared: Set<string>,
  errors: string[],
  warnings: string[]
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('contributes.keybindings 必须是数组')
    return
  }
  if (value.length > EXTENSION_LIMITS.keybindings) {
    errors.push(`contributes.keybindings 过多(上限 ${EXTENSION_LIMITS.keybindings})`)
  }
  for (const [i, raw] of value.entries()) {
    const at = `contributes.keybindings[${i}]`
    if (!isObject(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (typeof raw.command !== 'string' || !COMMAND_RE.test(raw.command)) {
      errors.push(`${at}.command 非法`)
    } else if (!declared.has(raw.command)) {
      warnings.push(`${at}.command「${raw.command}」没有在 contributes.commands 里声明,可能由运行时注册`)
    }
    if (typeof raw.key !== 'string' || !KEYBINDING_RE.test(raw.key)) {
      errors.push(`${at}.key 非法(形如 ctrl+alt+s,修饰键用 ctrl/cmd/alt/shift/super)`)
    }
    if (raw.mac !== undefined && (typeof raw.mac !== 'string' || !KEYBINDING_RE.test(raw.mac))) {
      errors.push(`${at}.mac 非法`)
    }
    if (raw.when !== undefined && typeof raw.when !== 'string') {
      errors.push(`${at}.when 必须是字符串`)
    }
  }
}

function validateMenus(
  value: unknown,
  declared: Set<string>,
  errors: string[],
  warnings: string[]
): void {
  if (value === undefined) return
  if (!isObject(value)) {
    errors.push('contributes.menus 必须是对象')
    return
  }
  for (const key of Object.keys(value)) {
    if (key !== 'commandPalette') errors.push(`contributes.menus 里不认识的键「${key}」`)
  }
  const palette = value.commandPalette
  if (palette === undefined) return
  if (!Array.isArray(palette)) {
    errors.push('contributes.menus.commandPalette 必须是数组')
    return
  }
  if (palette.length > EXTENSION_LIMITS.menuItems) {
    errors.push(`contributes.menus.commandPalette 过多(上限 ${EXTENSION_LIMITS.menuItems})`)
  }
  for (const [i, raw] of palette.entries()) {
    const at = `contributes.menus.commandPalette[${i}]`
    if (!isObject(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (typeof raw.command !== 'string' || !COMMAND_RE.test(raw.command)) {
      errors.push(`${at}.command 非法`)
    } else if (!declared.has(raw.command)) {
      warnings.push(`${at}.command「${raw.command}」没有在 contributes.commands 里声明`)
    }
    if (raw.when !== undefined && typeof raw.when !== 'string') errors.push(`${at}.when 必须是字符串`)
    if (raw.group !== undefined && typeof raw.group !== 'string') errors.push(`${at}.group 必须是字符串`)
  }
}

function validateLineMenu(
  value: unknown,
  declared: Set<string>,
  errors: string[]
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('contributes["imark.lineMenu"] 必须是数组')
    return
  }
  if (value.length > EXTENSION_LIMITS.lineMenuEntries) {
    errors.push(`行首菜单条目过多(上限 ${EXTENSION_LIMITS.lineMenuEntries})`)
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const [i, raw] of value.entries()) {
    const at = `contributes["imark.lineMenu"][${i}]`
    if (!isObject(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (typeof raw.id !== 'string' || !LINE_MENU_ID_RE.test(raw.id)) {
      errors.push(`${at}.id 非法(小写字母/数字/连字符,1-40 字符)`)
    } else if (seen.has(raw.id)) {
      errors.push(`${at}.id 重复:${raw.id}`)
    } else {
      seen.add(raw.id)
    }
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
      errors.push(`${at}.label 不能为空`)
    } else if (raw.label.length > EXTENSION_LIMITS.lineMenuLabelChars) {
      errors.push(`${at}.label 过长(上限 ${EXTENSION_LIMITS.lineMenuLabelChars} 字)`)
    }
    if (typeof raw.command !== 'string' || !COMMAND_RE.test(raw.command)) {
      errors.push(`${at}.command 非法`)
    } else if (!declared.has(raw.command)) {
      errors.push(`${at}.command 必须先在 contributes.commands 里声明`)
    }
    if (raw.dialog !== undefined) {
      if (!isObject(raw.dialog)) {
        errors.push(`${at}.dialog 必须是对象`)
      } else {
        if (typeof raw.dialog.title !== 'string' || raw.dialog.title.trim().length === 0) {
          errors.push(`${at}.dialog.title 不能为空`)
        }
        if (raw.dialog.confirmLabel !== undefined && typeof raw.dialog.confirmLabel !== 'string') {
          errors.push(`${at}.dialog.confirmLabel 必须是字符串`)
        }
        validateDialogFields(raw.dialog.fields, `${at}.dialog.fields`, errors)
        const bytes = utf8Bytes(JSON.stringify(raw.dialog))
        totalBytes += bytes
        if (bytes > EXTENSION_LIMITS.lineMenuTemplateBytes) {
          errors.push(`${at}.dialog 过大(上限 ${EXTENSION_LIMITS.lineMenuTemplateBytes} 字节)`)
        }
      }
    }
  }
  if (totalBytes > EXTENSION_LIMITS.lineMenuTotalBytes) {
    errors.push(`行首菜单的对话框合计过大(上限 ${EXTENSION_LIMITS.lineMenuTotalBytes} 字节)`)
  }
}

function validateActions(
  value: unknown,
  declared: Set<string>,
  configKeys: Set<string>,
  errors: string[]
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('contributes["imark.actions"] 必须是数组')
    return
  }
  if (value.length > EXTENSION_LIMITS.actions) {
    errors.push(`动作过多(上限 ${EXTENSION_LIMITS.actions})`)
  }
  for (const [i, raw] of value.entries()) {
    const at = `contributes["imark.actions"][${i}]`
    if (!isObject(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (typeof raw.command !== 'string' || !COMMAND_RE.test(raw.command)) {
      errors.push(`${at}.command 非法`)
    } else if (!declared.has(raw.command)) {
      errors.push(`${at}.command 必须先在 contributes.commands 里声明`)
    }
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
      errors.push(`${at}.label 不能为空`)
    }
    if (raw.scope !== undefined && raw.scope !== 'global' && raw.scope !== 'target') {
      errors.push(`${at}.scope 只能是 global / target`)
    }
    if (raw.scope === 'target') {
      if (typeof raw.targetSetting !== 'string' || !configKeys.has(raw.targetSetting)) {
        errors.push(`${at}.targetSetting 必须指向一个已声明的配置项`)
      }
    } else if (raw.targetSetting !== undefined) {
      errors.push(`${at}.targetSetting 只在 scope=target 时有意义`)
    }
    if (raw.primary !== undefined && typeof raw.primary !== 'boolean') {
      errors.push(`${at}.primary 必须是布尔值`)
    }
  }
}

function validateAgentProviders(
  value: unknown,
  dependencies: unknown,
  main: unknown,
  errors: string[]
): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('contributes["imark.agentProviders"] 必须是非空数组')
    return
  }
  if (value.length > EXTENSION_LIMITS.agentProviders) {
    errors.push(`Agent provider 过多(上限 ${EXTENSION_LIMITS.agentProviders})`)
  }
  const seen = new Set<string>()
  for (const [i, id] of value.entries()) {
    const at = `contributes["imark.agentProviders"][${i}]`
    if (typeof id !== 'string' || !AGENT_PROVIDER_ID_RE.test(id)) {
      errors.push(`${at} 非法(小写字母开头,可含数字/连字符,最多 64 字符)`)
    } else if (seen.has(id)) {
      errors.push(`${at} 重复:${id}`)
    } else {
      seen.add(id)
    }
  }
  if (typeof main !== 'string' || main.length === 0) {
    errors.push(`声明 contributes["imark.agentProviders"] 的扩展必须提供 main 入口`)
  }
  if (!Array.isArray(dependencies) || !dependencies.includes(AGENT_CORE_EXTENSION_ID)) {
    errors.push(
      `声明 contributes["imark.agentProviders"] 的扩展必须通过 extensionDependencies 依赖 ${AGENT_CORE_EXTENSION_ID}`
    )
  }
}

function collectConfigKeys(value: unknown): Set<string> {
  const out = new Set<string>()
  if (value === undefined) return out
  const sections = Array.isArray(value) ? value : [value]
  for (const section of sections) {
    if (!isObject(section) || !isObject(section.properties)) continue
    for (const key of Object.keys(section.properties)) out.add(key)
  }
  return out
}

export function validateManifest(raw: unknown): ExtensionValidation<ExtensionManifest> {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(raw)) return fail('package.json 清单必须是对象')

  const m = raw as Partial<ExtensionManifest>

  if (typeof m.publisher !== 'string' || !ID_PART_RE.test(m.publisher)) {
    errors.push("publisher 非法(小写字母开头,可含数字/连字符,2-64 字符)")
  }
  if (typeof m.name !== 'string' || !ID_PART_RE.test(m.name)) {
    errors.push("name 非法(小写字母开头,可含数字/连字符,2-64 字符)")
  }
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    errors.push('version 非法(需形如 1.2.3 或 1.2.3-beta.1)')
  }
  if (m.displayName !== undefined && typeof m.displayName !== 'string') {
    errors.push('displayName 必须是字符串')
  }
  if (m.description !== undefined && typeof m.description !== 'string') {
    errors.push('description 必须是字符串')
  }
  if (m.homepage !== undefined && !/^https:\/\//i.test(String(m.homepage))) {
    errors.push('homepage 必须是 https 地址')
  }

  if (!isObject(m.engines) || typeof (m.engines as { imark?: unknown }).imark !== 'string') {
    errors.push('engines.imark 必填(如 "^1.0.0")')
  } else if (!/^(>=|>|\^)?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test((m.engines as { imark: string }).imark.trim())) {
    errors.push('engines.imark 必须是版本范围(如 "^1.0.0" / ">=1.0.0")')
  }

  if (m.main !== undefined) {
    if (typeof m.main !== 'string') {
      errors.push('main 必须是字符串')
    } else {
      const file = m.main.replace(/^\.\//, '')
      if (!isSafeRelPath(file)) errors.push('main 必须是包内的合法相对路径')
      else if (!/\.(c?js)$/.test(file)) errors.push('main 入口必须是 .js / .cjs(CommonJS)')
    }
  }
  if (m.icon !== undefined) {
    if (typeof m.icon !== 'string') errors.push('icon 必须是字符串')
    else {
      const file = m.icon.replace(/^\.\//, '')
      if (!isSafeRelPath(file)) errors.push('icon 必须是包内的合法相对路径')
    }
  }

  validateActivationEvents(m.activationEvents, warnings, errors)
  for (const key of ['extensionDependencies', 'extensionAffinity'] as const) {
    const list = m[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      errors.push(`${key} 必须是数组`)
      continue
    }
    for (const item of list) {
      if (typeof item !== 'string' || !EXTENSION_ID_RE.test(item)) {
        errors.push(`${key} 里的「${String(item)}」不是合法扩展 ID(形如 publisher.name)`)
      } else if (item === `${m.publisher}.${m.name}`) {
        errors.push(`${key} 不能引用自己`)
      }
    }
  }
  validateCapabilities(m.capabilities, errors)

  const contributes = m.contributes
  if (contributes !== undefined) {
    if (!isObject(contributes)) {
      errors.push('contributes 必须是对象')
    } else {
      for (const key of Object.keys(contributes)) {
        if (!CONTRIBUTES_KEYS.includes(key)) {
          errors.push(`contributes 里不认识的键「${key}」(可用:${CONTRIBUTES_KEYS.join(' / ')})`)
        }
      }
      const id = `${String(m.publisher)}.${String(m.name)}`
      const declared = validateCommands(contributes.commands, errors, warnings)
      validateKeybindings(contributes.keybindings, declared, errors, warnings)
      validateMenus(contributes.menus, declared, errors, warnings)
      validateConfiguration(contributes.configuration, id, errors, warnings)
      validateLineMenu(contributes['imark.lineMenu'], declared, errors)
      validateActions(
        contributes['imark.actions'],
        declared,
        collectConfigKeys(contributes.configuration),
        errors
      )
      validateAgentProviders(
        contributes['imark.agentProviders'],
        m.extensionDependencies,
        m.main,
        errors
      )
    }
  }

  for (const key of Object.keys(raw)) {
    if (MANIFEST_KEYS.includes(key) || PACKAGING_KEYS.includes(key)) continue
    // 打包字段之外的未知键直接报错:清单是契约,写错了不应静默消失
    errors.push(`不认识的清单字段「${key}」`)
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, errors: [], warnings, value: canonicalManifest(m) }
}

// ---------- 清单重建 ----------

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function canonicalField(field: unknown): unknown {
  if (!isObject(field)) return field
  return pick(field, [
    'key',
    'kind',
    'label',
    'section',
    'showWhen',
    'description',
    'default',
    'placeholder',
    'min',
    'max',
    'rows',
    'resettable',
    'required',
    'endpointModel',
    'targetSecret',
    'options'
  ])
}

function canonicalLineMenu(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return list.map(item => {
    if (!isObject(item)) return item
    const out = pick(item, ['id', 'label', 'command'])
    if (isObject(item.dialog)) {
      out.dialog = {
        ...pick(item.dialog, ['title', 'confirmLabel']),
        fields: Array.isArray(item.dialog.fields) ? item.dialog.fields.map(canonicalField) : item.dialog.fields
      }
    }
    return out
  })
}

function canonicalContributes(value: unknown): unknown {
  if (!isObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of CONTRIBUTES_KEYS) {
    const item = value[key]
    if (item === undefined) continue
    switch (key) {
      case 'commands':
        out.commands = Array.isArray(item)
          ? item.map(entry => (isObject(entry) ? pick(entry, ['command', 'title', 'category', 'detail', 'icon', 'enablement']) : entry))
          : item
        break
      case 'keybindings':
        out.keybindings = Array.isArray(item)
          ? item.map(entry => (isObject(entry) ? pick(entry, ['command', 'key', 'mac', 'when']) : entry))
          : item
        break
      case 'menus':
        out.menus = isObject(item)
          ? {
              ...(Array.isArray(item.commandPalette)
                ? {
                    commandPalette: item.commandPalette.map(entry =>
                      isObject(entry) ? pick(entry, ['command', 'when', 'group']) : entry
                    )
                  }
                : {})
            }
          : item
        break
      case 'configuration':
        out.configuration = item
        break
      case 'imark.lineMenu':
        out['imark.lineMenu'] = canonicalLineMenu(item)
        break
      case 'imark.actions':
        out['imark.actions'] = Array.isArray(item)
          ? item.map(entry => (isObject(entry) ? pick(entry, ['command', 'label', 'scope', 'targetSetting', 'primary']) : entry))
          : item
        break
      case 'imark.agentProviders':
        out['imark.agentProviders'] = Array.isArray(item) ? [...item] : item
        break
    }
  }
  return out
}

/** 按 extensionFormat.json 的键序重建清单;打包器、安装器、服务端必须用同一形状 */
export function canonicalManifest(raw: Partial<ExtensionManifest>): ExtensionManifest {
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of MANIFEST_KEYS) {
    const value = source[key]
    if (value === undefined) continue
    switch (key) {
      case 'engines':
        out.engines = isObject(value) ? { imark: value.imark } : value
        break
      case 'main': {
        const file = String(value).replace(/^\.\//, '')
        out.main = `./${file}`
        break
      }
      case 'icon':
        out.icon = String(value).replace(/^\.\//, '')
        break
      case 'capabilities':
        out.capabilities = isObject(value) ? pick(value, CAPABILITY_KEYS) : value
        break
      case 'contributes':
        out.contributes = canonicalContributes(value)
        break
      default:
        out[key] = value
    }
  }
  return out as unknown as ExtensionManifest
}

// ---------- 信封校验 ----------

export function validateEnvelope(raw: unknown): ExtensionValidation<ExtensionPackageEnvelope> {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(raw)) return fail('扩展包必须是 JSON 对象')

  const e = raw as Partial<ExtensionPackageEnvelope>
  if (e.format !== PACKAGE_FORMAT) errors.push(`format 必须是 "${PACKAGE_FORMAT}"`)
  if (e.formatVersion !== PACKAGE_FORMAT_VERSION) {
    errors.push(`formatVersion 必须是 ${PACKAGE_FORMAT_VERSION}`)
  }

  const manifestResult = validateManifest(e.manifest)
  errors.push(...manifestResult.errors.map(item => `manifest:${item}`))
  warnings.push(...manifestResult.warnings)
  const manifest = manifestResult.value

  if (!e.files || !isObject(e.files)) {
    errors.push('files 必须是对象')
  } else if (!e.data || !isObject(e.data)) {
    errors.push('data 必须是对象')
  } else {
    const names = Object.keys(e.files)
    if (names.length === 0) errors.push('包内没有任何文件')
    if (names.length > EXTENSION_LIMITS.fileCount) {
      errors.push(`文件数超过上限(${EXTENSION_LIMITS.fileCount})`)
    }
    if (Object.keys(e.data).length !== names.length) {
      errors.push('files 与 data 的文件数不一致')
    }
    for (const name of names) {
      if (!isSafeRelPath(name)) {
        errors.push(`非法文件路径:${name}`)
        continue
      }
      const meta = e.files[name] as Partial<PackageFileEntry> | undefined
      if (!meta || meta.encoding !== 'base64') {
        errors.push(`${name}:encoding 必须是 base64`)
        continue
      }
      if (typeof meta.size !== 'number' || meta.size <= 0) {
        errors.push(`${name}:size 非法`)
        continue
      }
      const limit =
        name === 'README.md'
          ? EXTENSION_LIMITS.readmeBytes
          : manifest && iconFileOf(manifest) === name
            ? EXTENSION_LIMITS.iconBytes
            : EXTENSION_LIMITS.fileBytes
      if (meta.size > limit) errors.push(`${name}:文件过大(> ${limit} 字节)`)
      if (typeof meta.sha256 !== 'string' || !SHA256_RE.test(meta.sha256)) {
        errors.push(`${name}:sha256 非法`)
      }
      const content = e.data[name]
      if (typeof content !== 'string' || content.length === 0) {
        errors.push(`${name}:缺少内容`)
      } else {
        const approx = Math.floor((content.replace(/=+$/, '').length * 3) / 4)
        if (Math.abs(approx - meta.size) > 2) {
          errors.push(`${name}:内容长度与声明的 size 不符`)
        }
      }
    }

    if (manifest) {
      const entry = entryFileOf(manifest)
      if (entry) {
        if (!names.includes(entry)) errors.push(`main 入口「${entry}」不在包内`)
        const meta = e.files[entry]
        if (meta && meta.size > EXTENSION_LIMITS.entryBytes) {
          errors.push(`main 入口超过 ${EXTENSION_LIMITS.entryBytes} 字节上限`)
        }
      }
      const icon = iconFileOf(manifest)
      if (icon && !names.includes(icon)) errors.push(`icon「${icon}」不在包内`)
    }
  }

  if (typeof e.integrity !== 'string' || !SHA256_RE.test(e.integrity)) {
    errors.push('integrity 非法')
  }

  if (manifest && e.manifest !== undefined) {
    // 安装到磁盘的清单必须与校验过的完全一致:含未知字段的清单直接拒绝 ——
    // 静默丢弃未知键会让 integrity 校验的对象与实际安装的对象分家。
    if (stableStringify(e.manifest) !== stableStringify(manifest)) {
      errors.push('manifest 含未知字段或非规范形状,拒绝安装')
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return {
    ok: true,
    errors: [],
    warnings,
    value: {
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      manifest: manifest!,
      files: e.files as Record<string, PackageFileEntry>,
      data: e.data as Record<string, string>,
      integrity: e.integrity as string
    }
  }
}

// ---------- 设置字段翻译 ----------

export interface FlatConfiguration {
  key: string
  property: ExtensionConfigurationProperty
}

/** 把对象/数组两种 configuration 形态摊平成「完整键 → 属性」 */
export function flattenConfiguration(
  manifest: Pick<ExtensionManifest, 'contributes'>
): FlatConfiguration[] {
  const config = manifest.contributes?.configuration
  if (!config) return []
  const sections = Array.isArray(config) ? config : [config]
  const out: FlatConfiguration[] = []
  for (const section of sections) {
    for (const [key, property] of Object.entries(section.properties ?? {})) {
      out.push({ key, property })
    }
  }
  return out
}

/** 市场列表/详情页展示的贡献点计数 */
export interface ExtensionContributesSummary {
  commands: number
  keybindings: number
  configuration: number
  lineMenu: number
  actions: number
}

export function contributesSummaryOf(
  manifest: Pick<ExtensionManifest, 'contributes'>
): ExtensionContributesSummary {
  const contributes = manifest.contributes ?? {}
  return {
    commands: contributes.commands?.length ?? 0,
    keybindings: contributes.keybindings?.length ?? 0,
    configuration: flattenConfiguration(manifest).length,
    lineMenu: contributes['imark.lineMenu']?.length ?? 0,
    actions: contributes['imark.actions']?.length ?? 0
  }
}

/** 清单里的作者署名;对象形态取 `name`,没有就是 null */
export function authorNameOf(manifest: Pick<ExtensionManifest, 'author'>): string | null {
  const author = manifest.author
  if (typeof author === 'string') return author.trim() || null
  if (author && typeof author === 'object' && typeof author.name === 'string') {
    return author.name.trim() || null
  }
  return null
}

export function displayNameOf(manifest: Pick<ExtensionManifest, 'displayName' | 'name'>): string {
  return manifest.displayName?.trim() || manifest.name
}

function shortKey(id: string, key: string): string {
  return key.startsWith(`${id}.`) ? key.slice(id.length + 1) : key
}

function defaultForProperty(property: ExtensionConfigurationProperty): PluginField['default'] {
  if (property.default !== undefined) return property.default as PluginField['default']
  if (property.type === 'number' || property.type === 'integer') return 0
  if (property.type === 'boolean') return false
  if (property.type === 'array') return []
  return ''
}

function kindOfProperty(property: ExtensionConfigurationProperty): PluginFieldKind {
  const meta = property.imark
  if (meta?.kind) return meta.kind
  if (property.type === 'number' || property.type === 'integer') return 'number'
  if (property.type === 'boolean') return 'boolean'
  if (Array.isArray(property.enum) && property.enum.length > 0) return 'select'
  if (property.type === 'array') return 'targets'
  return 'text'
}

function optionsOfProperty(property: ExtensionConfigurationProperty): PluginField['options'] | undefined {
  const meta = property.imark
  if (meta?.options) return meta.options
  if (!Array.isArray(property.enum)) return undefined
  return property.enum.map((value, index) => ({
    value: String(value),
    label: property.enumDescriptions?.[index] ?? String(value)
  }))
}

/**
 * configuration → 现有设置表单的 PluginField[]。
 *
 * 设置页不需要认识 JSON Schema:所有“怎么画”的差异都在这里被翻译成既有的
 * 字段类型(text/textarea/password/number/boolean/select/targets/endpoints)。
 */
export function settingsFieldsOf(manifest: ExtensionManifest): PluginField[] {
  const id = extensionIdOf(manifest)
  const out: PluginField[] = []
  for (const { key, property } of flattenConfiguration(manifest)) {
    const meta = property.imark ?? {}
    const field: PluginField = {
      key: shortKey(id, key),
      kind: kindOfProperty(property),
      label: meta.label ?? property.title ?? shortKey(id, key),
      default: defaultForProperty(property)
    }
    if (meta.section !== undefined) field.section = meta.section
    if (meta.description ?? property.description ?? property.markdownDescription) {
      field.description = meta.description ?? property.description ?? property.markdownDescription
    }
    if (meta.showWhen) {
      field.showWhen = {
        key: shortKey(id, meta.showWhen.key),
        value: meta.showWhen.value
      }
    }
    if (meta.scope !== undefined) field.scope = meta.scope
    if (meta.rows !== undefined) field.rows = meta.rows
    if (meta.resettable !== undefined) field.resettable = meta.resettable
    if (meta.required !== undefined) field.required = meta.required
    if (meta.placeholder !== undefined) field.placeholder = meta.placeholder
    if (meta.endpointModel !== undefined) field.endpointModel = meta.endpointModel
    if (meta.targetSecret !== undefined) field.targetSecret = meta.targetSecret
    if (
      meta.kind === 'external' &&
      typeof meta.file === 'string' &&
      typeof meta.pointer === 'string'
    ) {
      field.external = {
        file: meta.file,
        pointer: meta.pointer,
        ...(meta.dirEnv !== undefined ? { dirEnv: meta.dirEnv } : {}),
        ...(meta.secret !== undefined ? { secret: meta.secret } : {})
      }
    }
    const options = optionsOfProperty(property)
    if (options) field.options = options
    if (property.minimum !== undefined) field.min = property.minimum
    if (property.maximum !== undefined) field.max = property.maximum
    out.push(field)
  }
  return out
}

/** 主进程与市场页共用的描述符;扩展代码永远不参与决定自己长什么样 */
export function descriptorFromManifest(manifest: ExtensionManifest): ExtensionDescriptor {
  const id = extensionIdOf(manifest)
  const contributes = manifest.contributes ?? {}
  const configuration = Object.fromEntries(
    flattenConfiguration(manifest).map(item => [item.key, item.property])
  )
  return {
    id,
    publisher: manifest.publisher,
    name: manifest.name,
    displayName: manifest.displayName?.trim() || manifest.name,
    description: manifest.description ?? '',
    version: manifest.version,
    engine: manifest.engines.imark,
    main: entryFileOf(manifest),
    icon: iconFileOf(manifest),
    activationEvents: manifest.activationEvents ?? [],
    extensionDependencies: manifest.extensionDependencies ?? [],
    capabilities: manifest.capabilities ?? {},
    contributes,
    configuration,
    settingsFields: settingsFieldsOf(manifest)
  }
}
