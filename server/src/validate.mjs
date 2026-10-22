/**
 * 服务端校验 —— **校验逻辑独立实现**,不 import 客户端的校验代码。
 *
 * 这是刻意的重复。客户端装扩展时**永远全量重新校验一遍**(见
 * src/main/extensions/installer.ts),所以两边规则漂移的唯一后果是
 * 「服务端更宽松、客户端更严」:坏包收下了,但谁也装不上。反过来(服务端更严)
 * 只会让人早点发现问题。既然客户端才是权威,这里就没必要为一个只跑在服务器上的
 * 独立 JS 去共享 TS 源码、构建步骤和版本同步 —— 那才是真正的脆弱。
 *
 * **但数据例外**:扩展名白名单、体积上限、清单键序从 `src/shared/extensionFormat.json`
 * 读(见下面 FORMAT)。理由是这两样东西的漂移**不是**上面那种「早点发现问题」,
 * 而是两种坏结局:
 *   - 服务端比客户端严 → **作者发不出本来能装的包**,发布直接 400;
 *   - 键序/规范化不一致 → 服务端重算出的 integrity 与客户端算的对不上,包被拒收。
 * 一个纯 JSON 数据文件没有构建步骤、没有版本同步,代价只有「服务端与仓库同处
 * 一份 checkout」—— 它本来就是这么跑的(`npm run market`)。校验**逻辑**仍然各写各的。
 *
 * 只接受 `FORMAT.formatVersion`,清单是 package.json 形状。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FORMAT_PATH = join(HERE, '../../src/shared/extensionFormat.json')

let FORMAT
try {
  FORMAT = JSON.parse(readFileSync(FORMAT_PATH, 'utf8'))
} catch (err) {
  throw new Error(
    `读不到共享的扩展格式数据 ${FORMAT_PATH}(${err.message})。` +
      '市场服务端必须与仓库同一份 checkout:扩展名白名单与体积上限要和客户端、打包器逐字一致,'
      + '各抄一份迟早会漂移成「作者发不出本来能装的包」。'
  )
}

export const LIMITS = FORMAT.limits
const MANIFEST_KEYS = FORMAT.manifestKeyOrder
const CONTRIBUTES_KEYS = FORMAT.contributesKeyOrder
const CAPABILITY_KEYS = FORMAT.capabilityKeys
const FILESYSTEM_VALUES = FORMAT.filesystemValues
const ALLOWED_EXT = FORMAT.allowedExtensions
const RESERVED_SEGMENT = FORMAT.reservedSegment
const ACTIVATION_EVENTS = FORMAT.activationEvents
const SUPPORTED_FORMAT_VERSION = FORMAT.formatVersion
const AGENT_CORE_EXTENSION_ID = FORMAT.agentCoreExtensionId
const AGENT_PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

/** package.json 里允许出现、但不进信封的构建字段(与 shared/extensionPackage.ts 一致) */
const PACKAGING_KEYS = [
  'scripts',
  'devDependencies',
  'dependencies',
  'private',
  'type',
  'files',
  'publishConfig'
]

const ID_PART_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONFIG_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const FIELD_KEY_RE = /^[A-Za-z0-9_]{1,40}$/
const LINE_MENU_ID_RE = /^[a-z0-9-]{1,40}$/
const KEYBINDING_RE = /^(?:(?:ctrl|cmd|alt|shift|super|meta)\+)+[a-z0-9][a-z0-9+-]{0,20}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const ENGINE_RE = /^(>=|>|\^)?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FIELD_KINDS = ['text', 'textarea', 'password', 'number', 'boolean', 'select', 'targets', 'endpoints']
/** 对话框里允许出现的字段 kind —— 密钥与目标列表是一次性对话框装不下的东西 */
const DIALOG_FIELD_KINDS = ['text', 'number', 'boolean', 'select']

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function isSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > LIMITS.pathLength) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  const parts = p.split('/')
  if (parts.length > LIMITS.pathDepth) return false
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return false
    if (seg.toLowerCase() === RESERVED_SEGMENT) return false
  }
  const ext = (parts[parts.length - 1].split('.').pop() ?? '').toLowerCase()
  return ALLOWED_EXT.includes(ext)
}

/** 版本比较(与客户端同一套语义:预发布低于同号正式版) */
export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre] = String(v).split('-')
    const nums = core.split('.').map(n => Number.parseInt(n, 10) || 0)
    return { nums, pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

/** 递归键排序的 JSON 序列化(与 shared/extensionPackage.ts 逐字同构) */
export function stableStringify(value) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'undefined'
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      const done = stableStringify(item)
      return done === 'undefined' ? 'null' : done
    }).join(',')}]`
  }
  const parts = []
  for (const key of Object.keys(value).sort()) {
    const done = stableStringify(value[key])
    if (done === 'undefined') continue
    parts.push(`${JSON.stringify(key)}:${done}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * integrity 的输入形状:manifest + 「路径 → sha256」,**路径排序**。
 * 递归键排序的 stable stringify,于是打包器、服务端、客户端只要对象内容
 * 相同就得到同一个值。
 */
export function integrityInput(manifest, files) {
  const map = {}
  for (const name of Object.keys(files).sort()) map[name] = files[name].sha256
  return stableStringify({ manifest, files: map })
}

// ---------- 清单规范化(与 shared/extensionPackage.ts 的 canonicalManifest 同构) ----------

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function canonicalField(field) {
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

function canonicalLineMenu(list) {
  if (!Array.isArray(list)) return list
  return list.map(item => {
    if (!isObject(item)) return item
    const out = pick(item, ['id', 'label', 'command'])
    if (isObject(item.dialog)) {
      out.dialog = {
        ...pick(item.dialog, ['title', 'confirmLabel']),
        fields: Array.isArray(item.dialog.fields)
          ? item.dialog.fields.map(canonicalField)
          : item.dialog.fields
      }
    }
    return out
  })
}

function canonicalContributes(value) {
  if (!isObject(value)) return value
  const out = {}
  for (const key of CONTRIBUTES_KEYS) {
    const item = value[key]
    if (item === undefined) continue
    switch (key) {
      case 'commands':
        out.commands = Array.isArray(item)
          ? item.map(entry =>
              isObject(entry)
                ? pick(entry, ['command', 'title', 'category', 'detail', 'icon', 'enablement'])
                : entry
            )
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
          ? item.map(entry =>
              isObject(entry) ? pick(entry, ['command', 'label', 'scope', 'targetSetting', 'primary']) : entry
            )
          : item
        break
      case 'imark.agentProviders':
        out['imark.agentProviders'] = Array.isArray(item) ? [...item] : item
        break
    }
  }
  return out
}

export function canonicalManifest(raw) {
  const out = {}
  for (const key of MANIFEST_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    switch (key) {
      case 'engines':
        out.engines = isObject(value) ? { imark: value.imark } : value
        break
      case 'main':
        out.main = `./${String(value).replace(/^\.\//, '')}`
        break
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
  return out
}

// ---------- 清单校验 ----------

function validateActivationEvents(value, warnings, errors) {
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

function validateCapabilities(value, errors) {
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
  if (value.filesystem !== undefined && !FILESYSTEM_VALUES.includes(value.filesystem)) {
    errors.push(`capabilities.filesystem 只能是 ${FILESYSTEM_VALUES.join(' / ')}`)
  }
  for (const key of CAPABILITY_KEYS) {
    if (key === 'filesystem' || value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') errors.push(`capabilities.${key} 必须是布尔值`)
  }
}

function validateDialogFields(fields, at, errors) {
  if (!Array.isArray(fields)) {
    errors.push(`${at} 必须是数组`)
    return
  }
  const seen = new Set()
  for (const [i, raw] of fields.entries()) {
    const where = `${at}[${i}]`
    if (!isObject(raw)) {
      errors.push(`${where} 必须是对象`)
      continue
    }
    if (typeof raw.key !== 'string' || !FIELD_KEY_RE.test(raw.key)) {
      errors.push(`${where}.key 非法(只能是字母/数字/下划线,1-40 字符)`)
    } else if (seen.has(raw.key)) {
      errors.push(`${where}.key 重复:${raw.key}`)
    } else {
      seen.add(raw.key)
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

function validateCommands(value, errors) {
  const declared = new Set()
  if (value === undefined) return declared
  if (!Array.isArray(value)) {
    errors.push('contributes.commands 必须是数组')
    return declared
  }
  if (value.length > LIMITS.commands) errors.push(`contributes.commands 过多(上限 ${LIMITS.commands})`)
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
  }
  return declared
}

function validateKeybindings(value, declared, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('contributes.keybindings 必须是数组')
    return
  }
  if (value.length > LIMITS.keybindings) {
    errors.push(`contributes.keybindings 过多(上限 ${LIMITS.keybindings})`)
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
      // 与客户端一致:运行时注册的命令也合法,只记警告
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

function validateMenus(value, declared, errors) {
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
  if (palette.length > LIMITS.menuItems) {
    errors.push(`contributes.menus.commandPalette 过多(上限 ${LIMITS.menuItems})`)
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
      // 运行时注册的命令也合法,与客户端一致
    }
    if (raw.when !== undefined && typeof raw.when !== 'string') errors.push(`${at}.when 必须是字符串`)
    if (raw.group !== undefined && typeof raw.group !== 'string') errors.push(`${at}.group 必须是字符串`)
  }
}

function validateConfiguration(value, id, errors) {
  if (value === undefined) return
  const sections = Array.isArray(value) ? value : [value]
  if (sections.length === 0) {
    errors.push('contributes.configuration 不能是空数组')
    return
  }
  const seen = new Set()
  let count = 0
  for (const [i, section] of sections.entries()) {
    const where = Array.isArray(value) ? `contributes.configuration[${i}]` : 'contributes.configuration'
    if (!isObject(section)) {
      errors.push(`${where} 必须是对象 { properties }`)
      continue
    }
    if (section.title !== undefined && typeof section.title !== 'string') {
      errors.push(`${where}.title 必须是字符串`)
    }
    if (!isObject(section.properties)) {
      errors.push(`${where}.properties 必须是对象`)
      continue
    }
    for (const [key, raw] of Object.entries(section.properties)) {
      count += 1
      const at = `${where}.properties.${key}`
      if (!CONFIG_KEY_RE.test(key)) errors.push(`${at} 的键名非法`)
      if (!key.startsWith(`${id}.`)) errors.push(`${at} 必须以扩展 ID 开头(${id}.…)`)
      if (seen.has(key)) errors.push(`配置键重复:${key}`)
      seen.add(key)
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
      if (raw.default === undefined) errors.push(`${at} 缺少 default(设置页需要它作为初始值)`)
      if (raw.enum !== undefined && !Array.isArray(raw.enum)) errors.push(`${at}.enum 必须是数组`)
      if (raw.minimum !== undefined && typeof raw.minimum !== 'number') errors.push(`${at}.minimum 必须是数字`)
      if (raw.maximum !== undefined && typeof raw.maximum !== 'number') errors.push(`${at}.maximum 必须是数字`)
      if (raw.title !== undefined && typeof raw.title !== 'string') errors.push(`${at}.title 必须是字符串`)

      const meta = raw.imark
      if (meta !== undefined && !isObject(meta)) {
        errors.push(`${at}.imark 必须是对象`)
        continue
      }
      if (meta === undefined) continue
      if (meta.kind !== undefined && !FIELD_KINDS.includes(meta.kind)) {
        errors.push(`${at}.imark.kind 非法:${String(meta.kind)}`)
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
      if (meta.kind === 'select' && !Array.isArray(raw.enum) && !Array.isArray(meta.options)) {
        errors.push(`${at} 是 select,但既没有 enum 也没有 imark.options`)
      }
    }
  }
  if (count > LIMITS.configurationProperties) {
    errors.push(`配置项过多(上限 ${LIMITS.configurationProperties})`)
  }
}

function validateLineMenu(value, declared, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('contributes["imark.lineMenu"] 必须是数组')
    return
  }
  if (value.length > LIMITS.lineMenuEntries) {
    errors.push(`行首菜单条目过多(上限 ${LIMITS.lineMenuEntries})`)
  }
  const seen = new Set()
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
    } else if (raw.label.length > LIMITS.lineMenuLabelChars) {
      errors.push(`${at}.label 过长(上限 ${LIMITS.lineMenuLabelChars} 字)`)
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
        const bytes = Buffer.byteLength(JSON.stringify(raw.dialog), 'utf8')
        totalBytes += bytes
        if (bytes > LIMITS.lineMenuTemplateBytes) {
          errors.push(`${at}.dialog 过大(上限 ${LIMITS.lineMenuTemplateBytes} 字节)`)
        }
      }
    }
  }
  if (totalBytes > LIMITS.lineMenuTotalBytes) {
    errors.push(`行首菜单的对话框合计过大(上限 ${LIMITS.lineMenuTotalBytes} 字节)`)
  }
}

function collectConfigKeys(value) {
  const out = new Set()
  if (value === undefined) return out
  const sections = Array.isArray(value) ? value : [value]
  for (const section of sections) {
    if (!isObject(section) || !isObject(section.properties)) continue
    for (const key of Object.keys(section.properties)) out.add(key)
  }
  return out
}

function validateActions(value, declared, configKeys, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('contributes["imark.actions"] 必须是数组')
    return
  }
  if (value.length > LIMITS.actions) errors.push(`动作过多(上限 ${LIMITS.actions})`)
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

function validateAgentProviders(value, dependencies, main, errors) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('contributes["imark.agentProviders"] 必须是非空数组')
    return
  }
  if (value.length > LIMITS.agentProviders) {
    errors.push(`Agent provider 过多(上限 ${LIMITS.agentProviders})`)
  }
  const seen = new Set()
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
    errors.push('声明 contributes["imark.agentProviders"] 的扩展必须提供 main 入口')
  }
  if (!Array.isArray(dependencies) || !dependencies.includes(AGENT_CORE_EXTENSION_ID)) {
    errors.push(
      `声明 contributes["imark.agentProviders"] 的扩展必须通过 extensionDependencies 依赖 ${AGENT_CORE_EXTENSION_ID}`
    )
  }
}

export function validateManifest(raw) {
  const errors = []
  const warnings = []
  if (!isObject(raw)) return { ok: false, errors: ['package.json 清单必须是对象'], warnings }

  if (typeof raw.publisher !== 'string' || !ID_PART_RE.test(raw.publisher)) {
    errors.push('publisher 非法(小写字母开头,可含数字/连字符,2-64 字符)')
  }
  if (typeof raw.name !== 'string' || !ID_PART_RE.test(raw.name)) {
    errors.push('name 非法(小写字母开头,可含数字/连字符,2-64 字符)')
  }
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) {
    errors.push('version 非法(需形如 1.2.3 或 1.2.3-beta.1)')
  }
  if (raw.displayName !== undefined && typeof raw.displayName !== 'string') {
    errors.push('displayName 必须是字符串')
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push('description 必须是字符串')
  }
  if (raw.homepage !== undefined && !/^https:\/\//i.test(String(raw.homepage))) {
    errors.push('homepage 必须是 https 地址')
  }
  if (!isObject(raw.engines) || typeof raw.engines.imark !== 'string') {
    errors.push('engines.imark 必填(如 "^1.0.0")')
  } else if (!ENGINE_RE.test(raw.engines.imark.trim())) {
    errors.push('engines.imark 必须是版本范围(如 "^1.0.0" / ">=1.0.0")')
  }
  if (raw.main !== undefined) {
    if (typeof raw.main !== 'string') {
      errors.push('main 必须是字符串')
    } else {
      const file = raw.main.replace(/^\.\//, '')
      if (!isSafeRelPath(file)) errors.push('main 必须是包内的合法相对路径')
      else if (!/\.(c?js)$/.test(file)) errors.push('main 入口必须是 .js / .cjs(CommonJS)')
    }
  }
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string') {
      errors.push('icon 必须是字符串')
    } else {
      const file = raw.icon.replace(/^\.\//, '')
      if (!isSafeRelPath(file)) errors.push('icon 必须是包内的合法相对路径')
    }
  }

  validateActivationEvents(raw.activationEvents, warnings, errors)
  for (const key of ['extensionDependencies', 'extensionAffinity']) {
    const list = raw[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      errors.push(`${key} 必须是数组`)
      continue
    }
    for (const item of list) {
      if (typeof item !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}\.[a-z0-9][a-z0-9-]{1,63}$/.test(item)) {
        errors.push(`${key} 里的「${String(item)}」不是合法扩展 ID(形如 publisher.name)`)
      } else if (item === `${raw.publisher}.${raw.name}`) {
        errors.push(`${key} 不能引用自己`)
      }
    }
  }
  validateCapabilities(raw.capabilities, errors)

  const contributes = raw.contributes
  if (contributes !== undefined) {
    if (!isObject(contributes)) {
      errors.push('contributes 必须是对象')
    } else {
      for (const key of Object.keys(contributes)) {
        if (!CONTRIBUTES_KEYS.includes(key)) {
          errors.push(`contributes 里不认识的键「${key}」(可用:${CONTRIBUTES_KEYS.join(' / ')})`)
        }
      }
      const id = `${String(raw.publisher)}.${String(raw.name)}`
      const declared = validateCommands(contributes.commands, errors)
      validateKeybindings(contributes.keybindings, declared, errors)
      validateMenus(contributes.menus, declared, errors)
      validateConfiguration(contributes.configuration, id, errors)
      validateLineMenu(contributes['imark.lineMenu'], declared, errors)
      validateActions(
        contributes['imark.actions'],
        declared,
        collectConfigKeys(contributes.configuration),
        errors
      )
      validateAgentProviders(
        contributes['imark.agentProviders'],
        raw.extensionDependencies,
        raw.main,
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
  return { ok: true, errors: [], warnings, value: canonicalManifest(raw) }
}

/**
 * 全量校验一份信封。返回 `{ ok, errors, value }`,value 里带上算好的 integrity 与
 * mainSha256(供入库),调用方不需要自己再算一遍。
 */
export function validateEnvelope(raw) {
  const errors = []
  const bad = () => ({ ok: false, errors })

  if (!isObject(raw)) return bad()
  if (raw.format !== FORMAT.format) errors.push(`format 必须是 ${FORMAT.format}`)
  if (raw.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    errors.push(`formatVersion 必须是 ${SUPPORTED_FORMAT_VERSION}`)
  }

  const manifest = raw.manifest
  const checked = validateManifest(manifest)
  if (!checked.ok) errors.push(...checked.errors)
  if (errors.length > 0) return bad()
  const canonical = checked.value

  // 客户端会把清单规范化后再算 integrity;这里拒绝非规范形状,避免
  // 「服务端收下、客户端算出的 integrity 却对不上」的漂移
  if (stableStringify(manifest) !== stableStringify(canonical)) {
    errors.push('manifest 含未知字段或非规范形状,拒绝发布')
    return bad()
  }

  const files = raw.files
  const data = raw.data
  if (!isObject(files)) return bad()
  if (!isObject(data)) return bad()

  const names = Object.keys(files)
  if (names.length === 0) errors.push('包里没有任何文件')
  if (names.length > LIMITS.fileCount) errors.push(`文件数超过上限(${LIMITS.fileCount})`)
  if (names.length !== Object.keys(data).length) errors.push('files 与 data 的条目数不一致')

  const entryFile = canonical.main ? canonical.main.replace(/^\.\//, '') : null
  const iconFile = canonical.icon ? canonical.icon.replace(/^\.\//, '') : null

  for (const name of names) {
    if (!isSafeRelPath(name)) {
      errors.push(`非法文件路径:${name}`)
      continue
    }
    const meta = files[name]
    if (!isObject(meta)) {
      errors.push(`${name} 的元信息缺失`)
      continue
    }
    if (meta.encoding !== 'base64') errors.push(`${name}:encoding 必须是 base64`)
    if (typeof meta.size !== 'number' || meta.size <= 0) {
      errors.push(`${name}:size 非法`)
      continue
    }
    if (!SHA256_RE.test(String(meta.sha256))) errors.push(`${name} 的 sha256 格式非法`)
    const b64 = data[name]
    if (typeof b64 !== 'string' || b64.length === 0) {
      errors.push(`${name} 缺少内容`)
      continue
    }
    // base64 不合法会让 Buffer.from 静默丢字符,所以先验一遍
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      errors.push(`${name} 的内容不是合法 base64`)
      continue
    }
    const buf = Buffer.from(b64, 'base64')
    if (buf.byteLength !== meta.size) errors.push(`${name} 的实际大小与声明不符`)
    const limit =
      name === 'README.md'
        ? LIMITS.readmeBytes
        : name === iconFile
          ? LIMITS.iconBytes
          : LIMITS.fileBytes
    if (buf.byteLength > limit) errors.push(`${name} 超过大小上限`)
    const actual = sha256(buf)
    if (actual !== meta.sha256) errors.push(`${name} 的 sha256 对不上`)
  }
  if (errors.length > 0) return bad()

  if (entryFile) {
    if (!names.includes(entryFile)) errors.push(`main 入口 ${entryFile} 不在包里`)
    else if (files[entryFile].size > LIMITS.entryBytes) errors.push('main 入口超过大小上限')
  }
  if (iconFile && !names.includes(iconFile)) errors.push(`图标 ${iconFile} 不在包里`)

  const computed = sha256(integrityInput(canonical, files))
  if (raw.integrity !== computed) errors.push('integrity 与包内容不符')

  const size = Buffer.byteLength(JSON.stringify(raw), 'utf8')
  if (size > LIMITS.envelopeBytes) errors.push('整包超过大小上限')
  if (errors.length > 0) return bad()

  return {
    ok: true,
    errors: [],
    value: {
      manifest: canonical,
      files,
      data,
      integrity: computed,
      mainSha256: entryFile ? (files[entryFile]?.sha256 ?? null) : null,
      size
    }
  }
}

/**
 * 从包里挑出 README 的纯文本(详情页展示用)。
 * 只接受根目录的 README.md —— 嵌套目录里的同名文件不做猜测。
 */
export function extractReadme(envelope) {
  const b64 = envelope.data?.['README.md']
  if (typeof b64 !== 'string') return null
  const text = Buffer.from(b64, 'base64').toString('utf8')
  // 上限已经在校验里管住了,这里再截一刀:详情页不该载入一整本书
  return text.slice(0, 64 * 1024)
}
