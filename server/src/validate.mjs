/**
 * 服务端校验 —— **校验逻辑独立实现**,不 import 客户端的校验代码。
 *
 * 这是刻意的重复。客户端装插件时**永远全量重新校验一遍**(见 src/main/market/verify.ts),
 * 所以两边规则漂移的唯一后果是「服务端更宽松、客户端更严」:坏包收下了,
 * 但谁也装不上。反过来(服务端更严)只会让人早点发现问题。
 * 既然客户端才是权威,这里就没必要为一个只跑在服务器上的独立 JS 去共享
 * TS 源码、构建步骤和版本同步 —— 那才是真正的脆弱。
 *
 * **但数据例外**:扩展名白名单与清单键序不在这份重复之列,它们从
 * `src/shared/pluginFormat.json` 读(见下面 FORMAT)。理由是这两样东西的漂移
 * **不是**上面那种「早点发现问题」,而是两种坏结局:
 *   - 服务端比客户端严 → **作者发不出本来能装的包**,发布直接 400;
 *   - 键序不一致 → 服务端重算出的 integrity 与客户端算的对不上,包被拒收。
 * 一个纯 JSON 数据文件没有构建步骤、没有版本同步,代价只有「服务端与仓库同处
 * 一份 checkout」—— 而它本来就是这么跑的(`npm run market`)。校验**逻辑**仍然各写各的。
 *
 * 上下文与体积上限必须与 src/shared/pluginPackage.ts 保持一致。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FORMAT_PATH = join(HERE, '../../src/shared/pluginFormat.json')

let FORMAT
try {
  FORMAT = JSON.parse(readFileSync(FORMAT_PATH, 'utf8'))
} catch (err) {
  throw new Error(
    `读不到共享的插件格式数据 ${FORMAT_PATH}(${err.message})。` +
      '市场服务端必须与仓库同一份 checkout:扩展名白名单与清单键序要和客户端、打包器逐字一致,'
      + '各抄一份迟早会漂移成「作者发不出本来能装的包」。'
  )
}

export const LIMITS = {
  envelopeBytes: 8 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  entryBytes: 1024 * 1024,
  readmeBytes: 256 * 1024,
  iconBytes: 64 * 1024,
  fileCount: 64,
  pathLength: 128,
  pathDepth: 3,
  // 行首菜单(descriptor 每次状态广播都要整体过一遍 IPC,所以文案有体积上限)
  lineMenuEntries: 12,
  lineMenuLabelChars: 40,
  lineMenuTemplateBytes: 4 * 1024,
  lineMenuTotalBytes: 16 * 1024
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FIELD_KEY_RE = /^[A-Za-z0-9_]{1,40}$/
const ACTION_ID_RE = /^[a-z0-9-]{1,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const FIELD_KINDS = ['text', 'password', 'number', 'boolean', 'select', 'targets']
/** 对话框里允许出现的字段 kind —— 密钥与目标列表是一次性的对话框装不下的东西 */
const DIALOG_FIELD_KINDS = ['text', 'number', 'boolean', 'select']
const RESERVED_IDS = ['imk', 'market', 'system', 'core', 'node', 'electron']
/** 权限词表(与 src/shared/pluginPackage.ts 保持一致) */
const PERMISSIONS = ['git', 'secrets', 'vault:read', 'vault:write', 'network', 'shell', 'settings']
/** restricted main 真正有对应能力的权限 */
const RESTRICTED_PERMISSIONS = ['git', 'secrets', 'vault:read', 'vault:write', 'network']
/** 见文件头:这一份来自 src/shared/pluginFormat.json,与客户端、打包器共用 */
const ALLOWED_EXT = FORMAT.allowedExtensions
const RESERVED_SEGMENT = FORMAT.reservedSegment

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

/**
 * integrity 的输入形状:manifest + 「路径 → sha256」,**路径排序**。
 * 客户端用 JSON.stringify 拼同一个形状,所以两边的键插入顺序必须一致 ——
 * 这里显式按排序后的路径重建对象,客户端也是这么做的。
 */
export function integrityInput(manifest, files) {
  const map = {}
  for (const name of Object.keys(files).sort()) map[name] = files[name].sha256
  return JSON.stringify({ manifest, files: map })
}

function validateField(field, errors, index, opts = {}) {
  const at = `${opts.where ?? 'fields'}[${index}]`
  const kinds = opts.kinds ?? FIELD_KINDS
  if (!field || typeof field !== 'object') {
    errors.push(`${at} 不是对象`)
    return
  }
  if (typeof field.key !== 'string' || !FIELD_KEY_RE.test(field.key)) {
    errors.push(`${at}.key 非法`)
  }
  if (!kinds.includes(field.kind)) errors.push(`${at}.kind 非法:${field.kind}`)
  if (typeof field.label !== 'string' || !field.label) errors.push(`${at}.label 缺失`)
  if (!('default' in field)) errors.push(`${at}.default 缺失`)
}

/** 行首菜单:与 src/shared/pluginPackage.ts 的 validateLineMenu 同规则 */
function validateLineMenu(list, errors) {
  if (list === undefined) return
  if (!Array.isArray(list)) {
    errors.push('lineMenu 必须是数组')
    return
  }
  if (list.length > LIMITS.lineMenuEntries) {
    errors.push(`lineMenu 条目过多(上限 ${LIMITS.lineMenuEntries} 条)`)
  }
  const seen = new Set()
  let totalBytes = 0
  for (const [i, item] of list.entries()) {
    const at = `lineMenu[${i}]`
    if (!item || typeof item !== 'object') {
      errors.push(`${at} 不是对象`)
      continue
    }
    if (typeof item.id !== 'string' || !ACTION_ID_RE.test(item.id)) {
      errors.push(`${at}.id 非法`)
    } else if (seen.has(item.id)) {
      errors.push(`${at}.id 重复:${item.id}`)
    } else {
      seen.add(item.id)
    }
    if (typeof item.label !== 'string' || !item.label.trim()) {
      errors.push(`${at}.label 缺失`)
    } else if (item.label.length > LIMITS.lineMenuLabelChars) {
      errors.push(`${at}.label 过长(上限 ${LIMITS.lineMenuLabelChars} 字)`)
    }

    // template 与 action 恰好二选一:前者由宿主直接插入,后者要过一趟插件
    const hasTemplate = typeof item.template === 'string'
    const hasAction = typeof item.action === 'string'
    if (item.template !== undefined && !hasTemplate) errors.push(`${at}.template 必须是字符串`)
    if (item.action !== undefined && !hasAction) errors.push(`${at}.action 必须是字符串`)
    if (hasTemplate === hasAction) errors.push(`${at} 必须且只能声明 template 或 action 之一`)
    if (hasAction && !ACTION_ID_RE.test(item.action)) errors.push(`${at}.action 非法`)
    if (hasTemplate) {
      const bytes = Buffer.byteLength(item.template, 'utf8')
      totalBytes += bytes
      if (bytes > LIMITS.lineMenuTemplateBytes) {
        errors.push(`${at}.template 过长(上限 ${LIMITS.lineMenuTemplateBytes} 字节)`)
      }
    }

    if (item.dialog !== undefined) {
      if (!hasAction) errors.push(`${at}.dialog 必须配合 action 使用`)
      if (!item.dialog || typeof item.dialog !== 'object') {
        errors.push(`${at}.dialog 必须是对象`)
        continue
      }
      if (typeof item.dialog.title !== 'string' || !item.dialog.title.trim()) {
        errors.push(`${at}.dialog.title 缺失`)
      }
      if (!Array.isArray(item.dialog.fields)) {
        errors.push(`${at}.dialog.fields 必须是数组`)
      } else {
        item.dialog.fields.forEach((f, j) =>
          validateField(f, errors, j, { where: `${at}.dialog.fields`, kinds: DIALOG_FIELD_KINDS })
        )
      }
    }
  }
  if (totalBytes > LIMITS.lineMenuTotalBytes) {
    errors.push(`lineMenu 的模板文本合计过长(上限 ${LIMITS.lineMenuTotalBytes} 字节)`)
  }
}

export function validateManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest 不是对象'] }
  }
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) {
    errors.push('id 非法(只能用小写字母、数字与 . _ -,2–64 位)')
  } else if (manifest.id.includes(':') || RESERVED_IDS.includes(manifest.id)) {
    errors.push(`id「${manifest.id}」是保留字`)
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name 缺失')
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    errors.push('version 必须是 x.y.z 形式')
  }
  const hasMain = manifest.main !== undefined
  const hasRender = manifest.render !== undefined
  const hasCapability = manifest.capability !== undefined
  if (!hasMain && !hasRender && !hasCapability) {
    errors.push('清单必须至少声明 main / render / capability 之一')
  }
  if (hasCapability && (hasMain || hasRender)) {
    errors.push('capability 只能单独出现,不能与 main / render 并存')
  }

  let mainMode = null
  if (hasMain) {
    if (!manifest.main || typeof manifest.main !== 'object' || Array.isArray(manifest.main)) {
      errors.push('main 必须是对象 { mode, entry }')
    } else {
      if (manifest.main.mode !== 'restricted' && manifest.main.mode !== 'node') {
        errors.push("main.mode 必须是 'restricted' 或 'node'")
      } else {
        mainMode = manifest.main.mode
      }
      if (typeof manifest.main.entry !== 'string' || !isSafeRelPath(manifest.main.entry)) {
        errors.push('main.entry 必须是包内的合法相对路径')
      } else if (mainMode === 'node' && !/\.(c?js)$/.test(manifest.main.entry)) {
        errors.push('node main 的入口必须是 .js / .cjs(CommonJS)')
      } else if (mainMode === 'restricted' && !/\.(m?js)$/.test(manifest.main.entry)) {
        errors.push('restricted main 的入口必须是 .js / .mjs(ES module)')
      }
    }
  }
  if (hasRender) {
    if (!manifest.render || typeof manifest.render !== 'object' || Array.isArray(manifest.render)) {
      errors.push('render 必须是对象 { entry }')
    } else if (
      typeof manifest.render.entry !== 'string' ||
      !isSafeRelPath(manifest.render.entry) ||
      !/\.js$/.test(manifest.render.entry)
    ) {
      errors.push('render.entry 必须是包内的 .js 普通脚本')
    }
  }
  if (hasCapability && (typeof manifest.capability !== 'string' || !manifest.capability)) {
    errors.push('capability 必须是非空字符串')
  }
  const fields = Array.isArray(manifest.fields) ? manifest.fields : []
  if (!Array.isArray(manifest.fields)) errors.push('fields 必须是数组')
  fields.forEach((f, i) => validateField(f, errors, i))
  const keys = fields.map(f => f.key)
  if (new Set(keys).size !== keys.length) errors.push('fields 里有重复的 key')

  const actions = Array.isArray(manifest.actions) ? manifest.actions : []
  if (!Array.isArray(manifest.actions)) errors.push('actions 必须是数组')
  for (const [i, a] of actions.entries()) {
    if (!a || typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) errors.push(`actions[${i}].id 非法`)
    if (!a || typeof a.label !== 'string' || !a.label) errors.push(`actions[${i}].label 缺失`)
  }
  if (manifest.targetActions !== undefined) {
    if (!Array.isArray(manifest.targetActions)) errors.push('targetActions 必须是数组')
    else {
      for (const [i, a] of manifest.targetActions.entries()) {
        if (!a || typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) {
          errors.push(`targetActions[${i}].id 非法`)
        }
        if (!a || typeof a.label !== 'string' || !a.label) {
          errors.push(`targetActions[${i}].label 缺失`)
        }
      }
      const targetField = fields.find(f => f.key === manifest.targetFieldKey)
      if (!targetField || targetField.kind !== 'targets') {
        errors.push('声明了 targetActions 就必须有 targetFieldKey 指向一个 targets 字段')
      } else if (manifest.targetActions.length > 0 && !targetField.targetSecret) {
        errors.push('targets 字段必须声明 targetSecret,否则目标级动作没有密钥可用')
      }
    }
  }
  validateLineMenu(manifest.lineMenu, errors)
  if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) {
    errors.push('permissions 必须是数组')
  } else {
    const seen = new Set()
    for (const p of manifest.permissions ?? []) {
      if (seen.has(p)) errors.push(`权限「${p}」重复声明`)
      seen.add(p)
      if (!PERMISSIONS.includes(p)) {
        errors.push(`未知权限:${p}`)
        continue
      }
      if (!hasMain && !hasCapability) {
        errors.push(`render-only 插件没有系统能力,不该声明权限「${p}」`)
      } else if (mainMode === 'restricted' && !RESTRICTED_PERMISSIONS.includes(p)) {
        errors.push(`受限 main 没有「${p}」对应的能力`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 全量校验一份信封。返回 `{ ok, errors, value }`,value 里带上算好的 integrity 与
 * mainSha256(供入库),调用方不需要自己再算一遍。
 */
export function validateEnvelope(raw) {
  const errors = []
  const bad = () => ({ ok: false, errors })

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad()
  if (raw.format !== 'imk-plugin') errors.push('format 必须是 imk-plugin')
  if (raw.formatVersion !== FORMAT.formatVersion) {
    errors.push(`formatVersion 必须是 ${FORMAT.formatVersion}`)
  }

  const manifest = raw.manifest
  const m = validateManifest(manifest)
  if (!m.ok) errors.push(...m.errors)
  if (errors.length > 0) return bad()

  const files = raw.files
  const data = raw.data
  if (!files || typeof files !== 'object' || Array.isArray(files)) return bad()
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad()

  const names = Object.keys(files)
  if (names.length === 0) errors.push('包里没有任何文件')
  if (names.length > LIMITS.fileCount) errors.push(`文件数超过上限(${LIMITS.fileCount})`)
  if (names.length !== Object.keys(data).length) errors.push('files 与 data 的条目数不一致')

  for (const name of names) {
    if (!isSafeRelPath(name)) {
      errors.push(`非法文件路径:${name}`)
      continue
    }
    const meta = files[name]
    if (!meta || typeof meta !== 'object') {
      errors.push(`${name} 的元信息缺失`)
      continue
    }
    if (!SHA256_RE.test(String(meta.sha256))) errors.push(`${name} 的 sha256 格式非法`)
    const b64 = data[name]
    if (typeof b64 !== 'string') {
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
    const limit = name === 'README.md' ? LIMITS.readmeBytes : LIMITS.fileBytes
    if (buf.byteLength > limit) errors.push(`${name} 超过大小上限`)
    const actual = sha256(buf)
    if (actual !== meta.sha256) errors.push(`${name} 的 sha256 对不上`)
  }
  if (errors.length > 0) return bad()

  const entries = []
  if (manifest.main) entries.push({ label: 'main', file: manifest.main.entry })
  if (manifest.render) entries.push({ label: 'render', file: manifest.render.entry })
  for (const { label, file } of entries) {
    if (!names.includes(file)) errors.push(`${label} 入口 ${file} 不在包里`)
    else if (files[file].size > LIMITS.entryBytes) errors.push(`${label} 入口超过大小上限`)
  }
  if (manifest.icon && !names.includes(manifest.icon)) errors.push(`图标 ${manifest.icon} 不在包里`)

  const computed = sha256(integrityInput(manifest, files))
  if (raw.integrity !== computed) errors.push('integrity 与包内容不符')

  const size = Buffer.byteLength(JSON.stringify(raw), 'utf8')
  if (size > LIMITS.envelopeBytes) errors.push('整包超过大小上限')
  if (errors.length > 0) return bad()

  return {
    ok: true,
    errors: [],
    value: {
      manifest,
      files,
      data,
      integrity: computed,
      mainSha256: manifest.main ? (files[manifest.main.entry]?.sha256 ?? null) : null,
      renderSha256: manifest.render ? (files[manifest.render.entry]?.sha256 ?? null) : null,
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
  // 256 KiB 上限已经在校验里管住了,这里再截一刀:详情页不该载入一整本书
  return text.slice(0, 64 * 1024)
}
