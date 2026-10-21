/**
 * 插件包格式(单文件 JSON 信封)与清单校验。
 *
 * 为什么不用 zip:打包端与解包端都由我们掌握、包内没有大二进制资产、体积上限 8 MiB,
 * zip 在这里买不到任何东西,却要引入依赖并重新引入 slip/symlink/权限位一整类攻击面。
 *
 * 信封把「元信息」与「内容」分开:
 *   files: 路径 → { size, sha256 }        ← 被 integrity 覆盖
 *   data:  路径 → base64 内容              ← 不被 integrity 直接覆盖
 * 这看着像漏了一层,其实是刻意的:data 的完整性由 files 里逐文件的 sha256 保证,
 * 而 files 又被 integrity 覆盖,所以 data 是被**传递覆盖**的。好处是 integrity 的
 * 输入形状显式且极小,列表页/确认框只读元信息就能算校验值。
 *
 * 注意:integrity 是**包内防篡改**(挡住传输损坏与中间人改包),不是真实性证明 ——
 * 真实性由市场发布的 sha256 与 HTTPS 承担。
 *
 * 本文件零运行时依赖(不引 node:crypto),因为渲染层也要 import 它做展示与校验提示;
 * 真正算 sha256 的地方在主进程(market/verify.ts)。
 *
 * 有几处数据必须在**多个互不相通的环境**里保持一致(清单键序、扩展名白名单…):
 * 应用(本文件)、scripts/build-plugins.mjs(裸 Node)、server/src/validate.mjs(独立进程)。
 * 它们都在 ./pluginFormat.json 里,三处共用同一份 —— 各抄一份就是等着漂移,
 * 而漂移的后果是「打包器算出的 integrity 与校验端对不上」或「作者发不出能装的包」。
 */

import formatData from './pluginFormat.json'
import type {
  PluginCommand,
  PluginDescriptor,
  PluginField,
  PluginLineMenuDialog,
  PluginLineMenuItem,
  PluginMenuItem,
  PluginStatusItem
} from './plugins'

export const PACKAGE_FORMAT = 'imk-plugin'
/** 信封版本;三处(应用/打包器/服务端)都读 pluginFormat.json 的同一份 */
export const PACKAGE_FORMAT_VERSION: number = formatData.formatVersion

/**
 * 插件由两层组成,均可不写,但至少要有一层:
 *
 * - **main 层** —— 代码跑在宿主侧
 *   - `restricted`:隐藏沙箱页(无 Node/fs),能力逐次过 `gate.invokeOp`;
 *   - `node`:主进程 CommonJS,完整 Node。
 * - **render 层** —— 代码跑在主窗口渲染进程,直接拿真实 EditorView / CM6 kit / DOM;
 *   没有系统能力,需要时只能消息给 main 层。
 *
 * `capability`(无代码、绑定宿主内置能力)是可以单独存在的退化形态。
 *
 * 清单会被白名单重建、未知键静默丢弃,所以「层」必须是一等字段,不能靠旁路可选字段
 * 表达。将来新增更安全的形态时,同样换新的字段/版本,而不是加一个旧客户端会忽略的键。
 */
export type PluginMainMode = 'restricted' | 'node'

/** main 层的入口声明 */
export interface PluginMainSpec {
  mode: PluginMainMode
  /** 包内相对路径;node 用 .js/.cjs(CommonJS),restricted 用 .js/.mjs(ES module) */
  entry: string
}

/** render 层的入口声明 */
export interface PluginRenderSpec {
  /** 包内相对路径;普通脚本(IIFE),不能有 import/export/require */
  entry: string
}

/** 插件形态的派生视图(市场/安装确认/设置页共用一套判断) */
export interface PluginShape {
  mainMode: PluginMainMode | null
  hasRender: boolean
  capability: string | null
}

export function hasMainLayer(manifest: Pick<PluginManifest, 'main'>): boolean {
  return Boolean(manifest.main)
}

export function hasRenderLayer(manifest: Pick<PluginManifest, 'render'>): boolean {
  return Boolean(manifest.render)
}

/** 清单里所有需要打进包的代码入口(用于信封校验与 sha256 记录) */
export function entryFilesOf(manifest: PluginManifest): string[] {
  const out: string[] = []
  if (manifest.main) out.push(manifest.main.entry)
  if (manifest.render) out.push(manifest.render.entry)
  return out
}

export function pluginShapeOf(manifest: Pick<PluginManifest, 'main' | 'render' | 'capability'>): PluginShape {
  return {
    mainMode: manifest.main?.mode ?? null,
    hasRender: Boolean(manifest.render),
    capability: manifest.capability ?? null
  }
}

/**
 * 权限词表。
 *
 * 语义**取决于 main.mode**,界面上必须说清楚:
 * - `restricted`:**每一项都是真门禁**。没声明的能力连 API 对象都不存在,
 *   每一次调用还要在主进程再查一遍。
 * - `node`:**告知 + API 塑形**。主进程里本来就有完整 Node,权限列表是为了
 *   让安装者知道作者声称要做什么,不是安全边界。
 * - `capability`(无代码):宿主能力所需的权限,只用于安装披露。
 *
 * render 层没有权限概念:它与主界面同 realm,能改 UI/读当前文档/看键盘输入,
 * 这些不是"申请"出来的,只能靠安装时的知情确认兜底。
 */
export type PluginPermission =
  | 'git'
  | 'secrets'
  | 'vault:read'
  | 'vault:write'
  | 'network'
  | 'shell'
  | 'settings'

export const PLUGIN_PERMISSIONS: PluginPermission[] = [
  'git',
  'secrets',
  'vault:read',
  'vault:write',
  'network',
  'shell',
  'settings'
]

/**
 * 受限 main 层真正有对应能力的权限词。
 *
 * `settings` 与 `shell` 在受限页面里没有实现(没有 Node、没有进程启动),
 * 声明它们只会让安装确认框多一行解释不了的承诺 —— 直接报错。
 */
export const RESTRICTED_PERMISSIONS: PluginPermission[] = [
  'git',
  'secrets',
  'vault:read',
  'vault:write',
  'network'
]

/** 权限的中文说明(安装确认框逐条展示,渲染层与主进程共用) */
export const PERMISSION_INFO: Record<PluginPermission, { label: string; description: string }> = {
  git: {
    label: '调用 Git',
    description: '通过宿主提供的接口执行 git 命令（推送、拉取、查看远端等）。'
  },
  secrets: {
    label: '读取已保存的密钥',
    description: '读取本插件自己名下的访问令牌、密码（只读，不能改写其他插件的密钥）。'
  },
  'vault:read': { label: '读取仓库文件', description: '读取当前仓库里的笔记与目录结构。' },
  'vault:write': { label: '修改仓库文件', description: '在当前仓库里新建、修改或删除文件。' },
  network: { label: '访问网络', description: '连接互联网，把数据发送到你配置的服务器。' },
  shell: { label: '执行系统命令', description: '在你的电脑上启动其他程序或命令（仅 node 主层有意义）。' },
  settings: { label: '读取编辑器设置', description: '读取主题、仓库路径等编辑器设置（仅 node 主层有意义）。' }
}

export interface PluginManifestAction {
  id: string
  label: string
}

export interface PluginManifest {
  id: string
  name: string
  description: string
  version: string
  author?: string
  /** 只能是 https 地址(界面里经 shell.openExternal 打开) */
  homepage?: string
  /**
   * main 层:代码跑在宿主侧,`mode` 决定是受限沙箱页还是主进程完整 Node。
   * 与 `render` 至少写一个;也可以两者都写(受限 main + 界面)。
   */
  main?: PluginMainSpec
  /**
   * render 层:代码跑在主窗口渲染进程,直接拿 EditorView / CM6 kit / DOM。
   * 没有系统能力,需要时消息给 main。
   */
  render?: PluginRenderSpec
  /**
   * 无代码形态:绑定宿主内置能力(见 main/plugins/capabilities.ts)。
   * **只能单独出现**,不能与 main/render 并存。
   */
  capability?: string
  permissions?: PluginPermission[]
  /** 包内图标文件名(建议 svg/png,≤64 KiB) */
  icon?: string
  /** 兼容性声明,如 { imark: ">=0.1.0" } */
  engines?: { imark?: string }
  /**
   * 配置字段表 —— 与内置插件**完全同构**(@shared/plugins 的 PluginField),
   * 所以 normalizeConfig / secretKeysOf / 通用表单渲染全部零改动复用。
   */
  fields: PluginField[]
  actions: PluginManifestAction[]
  targetActions?: PluginManifestAction[]
  targetFieldKey?: string
  /**
   * 编辑器行首「+」菜单的贡献条目(见 @shared/plugins 的 PluginLineMenuItem)。
   * 条目的 action 只在这里声明,不写进 actions —— 它不会出现在设置页里。
   */
  lineMenu?: PluginLineMenuItem[]
  /**
   * 命令面板里的条目。见 @shared/plugins 的 PluginCommand。
   *
   * 与 lineMenu 同一种思路:这里只声明「叫什么、什么时候可用、有没有快捷键」,
   * 点了之后做什么仍然走 actions 那条老路(runAction)。
   */
  commands?: PluginCommand[]
  /**
   * 状态栏条目。见 @shared/plugins 的 PluginStatusItem。
   *
   * 状态栏只有一条,所以它是**抢位制**:一个插件最多能占一条,多了校验直接报错。
   * 理由见 PluginStatusItem 处的说明。
   */
  statusBar?: PluginStatusItem[]
  /** 右键菜单条目。见 @shared/plugins 的 PluginMenuItem。 */
  menus?: PluginMenuItem[]
}

export interface PackageFileEntry {
  encoding: 'base64'
  size: number
  sha256: string
}

/** 单文件插件包(磁盘上的 .imkpkg / 市场接口传的 JSON,都是这一坨) */
export interface PluginPackageEnvelope {
  format: typeof PACKAGE_FORMAT
  formatVersion: typeof PACKAGE_FORMAT_VERSION
  manifest: PluginManifest
  /** 路径 → 元信息(被 integrity 覆盖) */
  files: Record<string, PackageFileEntry>
  /** 路径 → base64 内容(由 files 的 sha256 保证) */
  data: Record<string, string>
  /** sha256(integrityInput(manifest, files)) */
  integrity: string
}

// ---------- 体积与格式上限 ----------

export const LIMITS = {
  /** 整包上限 */
  envelopeBytes: 8 * 1024 * 1024,
  /** 单个文件上限 */
  fileBytes: 4 * 1024 * 1024,
  /** main / render 各自入口的上限（render 入口可能内联 PDF.js 等运行时依赖） */
  entryBytes: 4 * 1024 * 1024,
  readmeBytes: 256 * 1024,
  iconBytes: 64 * 1024,
  fileCount: 64,
  pathLength: 128,
  pathDepth: 3,
  /**
   * 源码查看器里单个文件最多显示多少字节。
   * 入口文件的上限是 4 MiB,一整个塞进 `<pre>` 会让界面卡住;超出的部分截断并明确标注。
   */
  sourceTextBytes: 200 * 1024,
  /**
   * 行首菜单的模板文本预算。
   *
   * 卡的不是磁盘,而是**广播**:descriptor 随 PluginView 走,
   * 插件每次 setState 都会把整份 descriptor 过一遍 IPC 下发给渲染层。
   * 模板要是能塞几十 KB,一次状态变化就要搬几十 KB。
   */
  lineMenuEntries: 12,
  lineMenuLabelChars: 40,
  lineMenuTemplateBytes: 4 * 1024,
  lineMenuTotalBytes: 16 * 1024,
  /**
   * 命令面板的上限。
   *
   * 命令是**要按名字搜**的:一个插件丢 500 条进来,别人的命令就会被自己的搜索结果淹掉。
   * 50 条对任何单个插件都够用,不够就说明该拆成「一个命令 + 参数对话框」。
   */
  commands: 50,
  /** 状态栏条目的上限。**是 1**,理由见 validateStatusBar */
  statusBarItems: 1,
  /** 右键菜单的上限。菜单比面板更难搜,所以更少 */
  menuItems: 20
} as const

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const FIELD_KEY_RE = /^[A-Za-z0-9_]{1,40}$/
const ACTION_ID_RE = /^[a-z0-9-]{1,40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const FIELD_KINDS = ['text', 'textarea', 'password', 'number', 'boolean', 'select', 'targets', 'endpoints']

/** id 里出现 ':' 会让 secretKey() 的拼接跨插件串台,所以是**安全规则**而非格式洁癖 */
const RESERVED_IDS = ['imk', 'market', 'system', 'core', 'node', 'electron']

/** 允许出现在包里的文件扩展名(见 pluginFormat.json 的说明:此处必须是唯一一份) */
const ALLOWED_EXT = formatData.allowedExtensions

/** 其中能当文本直接显示的(其余是二进制,源码查看器不往界面上送) */
const TEXT_EXT = formatData.textExtensions

/**
 * 包内路径里禁止出现的路径段。
 *
 * 宿主将来要往插件目录里放自己的保留资源(主题令牌、执行器页面…),这些资源按
 * 固定的相对路径提供。包内如果能有同名文件,就能把宿主的那个影子掉 ——
 * 插件于是能替换掉宿主注入给它的样式或代码。现在还没有这些资源,规则先立着。
 */
const RESERVED_SEGMENT = formatData.reservedSegment

/**
 * 这个文件能不能当文本看。
 * svg 虽然是文本,但它出现在源码查看器里只会是一坨标记,且图标有专门的显示位置,故不算。
 */
export function isTextFile(name: string): boolean {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return TEXT_EXT.includes(ext)
}

export interface Validation<T> {
  ok: boolean
  errors: string[]
  value?: T
}

function fail<T>(...errors: string[]): Validation<T> {
  return { ok: false, errors }
}

export function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > LIMITS.pathLength) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  const parts = p.split('/')
  if (parts.length > LIMITS.pathDepth) return false
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return false
    // 拦任何一段而不只是首段:插件没有任何正当理由把目录叫 __imark,
    // 而少拦一段就要多论证一次「为什么这段安全」。大小写不敏感 —— macOS/Windows
    // 的文件系统本来就不区分,只在 Linux 上拦会让同一份包在两处表现不同。
    if (seg.toLowerCase() === RESERVED_SEGMENT) return false
  }
  const ext = (parts[parts.length - 1]!.split('.').pop() ?? '').toLowerCase()
  return ALLOWED_EXT.includes(ext)
}

/** 版本比较:纯数字三段 + 可选预发布(预发布**低于**正式版),返回 -1 / 0 / 1 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core = '', pre = null] = v.split('-', 2) as [string, string | null]
    const nums = core.split('.').map(n => Number.parseInt(n, 10) || 0)
    return { nums, pre }
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

/** b 是否比 a 新(更新检查用) */
export function isNewerVersion(b: string, a: string): boolean {
  return compareVersions(b, a) > 0
}

/**
 * 简易范围匹配:只支持 >=x.y.z / >x.y.z / ^x.y.z / x.y.z(够用即可,不引入 semver 依赖)。
 * 无法解析时视为满足 —— 宁可让用户自己判断,也不要因为解析不了就把插件全判为不兼容。
 */
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
  // ^:同一主版本号且不低于目标
  const major = (v: string): number => Number.parseInt(v.split('.')[0] ?? '0', 10) || 0
  return cmp >= 0 && major(version) === major(target)
}

/** integrity 的**唯一**输入形状。打包端与校验端都必须用这个函数,否则键序会不一致 */
export function integrityInput(
  manifest: PluginManifest,
  files: Record<string, PackageFileEntry>
): string {
  const map: Record<string, string> = {}
  for (const name of Object.keys(files).sort()) map[name] = files[name]!.sha256
  return JSON.stringify({ manifest, files: map })
}

/**
 * 字段表校验。清单的 `fields` 与行首菜单对话框的 `dialog.fields` 共用这一份 ——
 * 两边渲染的都是同一套声明式字段,校验口径没有理由分家。
 *
 * @param where 报错前缀(清单里是 `fields`,对话框里是 `lineMenu[0].dialog.fields`)
 */
function validateFields(
  fields: unknown,
  errors: string[],
  where = 'fields',
  opts: { forbidKinds?: string[]; requireDefault?: boolean } = {}
): void {
  if (!Array.isArray(fields)) {
    errors.push(`${where} 必须是数组`)
    return
  }
  const seen = new Set<string>()
  for (const [i, raw] of fields.entries()) {
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where}[${i}] 不是对象`)
      continue
    }
    const f = raw as Partial<PluginField>
    const at = `${where}[${i}]`
    if (typeof f.key !== 'string' || !FIELD_KEY_RE.test(f.key)) {
      errors.push(`${at}.key 非法(只能是字母/数字/下划线,1-40 字符)`)
    } else if (seen.has(f.key)) {
      errors.push(`${at}.key 重复:${f.key}`)
    } else {
      seen.add(f.key)
    }
    if (typeof f.kind !== 'string' || !FIELD_KINDS.includes(f.kind)) {
      errors.push(`${at}.kind 非法:${String(f.kind)}`)
    } else if (opts.forbidKinds?.includes(f.kind)) {
      errors.push(`${at}.kind 不能是 ${f.kind}(对话框里放不下这类字段)`)
    }
    if (typeof f.label !== 'string' || f.label.trim().length === 0) {
      errors.push(`${at}.label 不能为空`)
    }
    if (f.kind === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
      errors.push(`${at} 是 select 但没有 options`)
    }
    if (f.showWhen && typeof f.showWhen.key !== 'string') {
      errors.push(`${at}.showWhen.key 非法`)
    }
    if (opts.requireDefault && f.default === undefined) {
      errors.push(`${at} 缺少 default(对话框拿它当初始值)`)
    }
  }
}

/** UTF-8 字节数。不用 Buffer:本文件渲染层也会 import,那边没有 Buffer */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 对话框里允许出现的字段 kind —— 密钥与目标列表是一次性的对话框装不下的东西 */
const DIALOG_FIELD_KINDS = ['text', 'number', 'boolean', 'select']

export function validateLineMenu(list: unknown, errors: string[]): void {
  if (list === undefined) return
  if (!Array.isArray(list)) {
    errors.push('lineMenu 必须是数组')
    return
  }
  if (list.length > LIMITS.lineMenuEntries) {
    errors.push(`lineMenu 条目过多(上限 ${LIMITS.lineMenuEntries} 条)`)
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const [i, raw] of list.entries()) {
    const at = `lineMenu[${i}]`
    if (!raw || typeof raw !== 'object') {
      errors.push(`${at} 不是对象`)
      continue
    }
    const item = raw as Partial<PluginLineMenuItem>
    if (typeof item.id !== 'string' || !ACTION_ID_RE.test(item.id)) {
      errors.push(`${at}.id 非法(小写字母/数字/连字符,1-40 字符)`)
    } else if (seen.has(item.id)) {
      errors.push(`${at}.id 重复:${item.id}`)
    } else {
      seen.add(item.id)
    }
    if (typeof item.label !== 'string' || item.label.trim().length === 0) {
      errors.push(`${at}.label 不能为空`)
    } else if (item.label.length > LIMITS.lineMenuLabelChars) {
      errors.push(`${at}.label 过长(上限 ${LIMITS.lineMenuLabelChars} 字)`)
    }

    // template 与 action 恰好二选一:前者由宿主直接插入,后者要过一趟插件
    const hasTemplate = typeof item.template === 'string'
    const hasAction = typeof item.action === 'string'
    if (item.template !== undefined && !hasTemplate) errors.push(`${at}.template 必须是字符串`)
    if (item.action !== undefined && !hasAction) errors.push(`${at}.action 必须是字符串`)
    if (hasTemplate === hasAction) {
      errors.push(`${at} 必须且只能声明 template 或 action 之一`)
    }
    if (hasAction && !ACTION_ID_RE.test(item.action as string)) {
      errors.push(`${at}.action 非法(小写字母/数字/连字符,1-40 字符)`)
    }
    if (hasTemplate) {
      const bytes = utf8Bytes(item.template as string)
      totalBytes += bytes
      if (bytes > LIMITS.lineMenuTemplateBytes) {
        errors.push(`${at}.template 过长(上限 ${LIMITS.lineMenuTemplateBytes} 字节)`)
      }
    }

    if (item.dialog !== undefined) {
      const d = item.dialog as Partial<PluginLineMenuDialog>
      if (!hasAction) {
        errors.push(`${at}.dialog 必须配合 action 使用(纯模板条目没有要问的参数)`)
      }
      if (!d || typeof d !== 'object') {
        errors.push(`${at}.dialog 必须是对象`)
      } else {
        if (typeof d.title !== 'string' || d.title.trim().length === 0) {
          errors.push(`${at}.dialog.title 不能为空`)
        }
        if (d.confirmLabel !== undefined && typeof d.confirmLabel !== 'string') {
          errors.push(`${at}.dialog.confirmLabel 必须是字符串`)
        }
        validateFields(d.fields, errors, `${at}.dialog.fields`, {
          forbidKinds: FIELD_KINDS.filter(k => !DIALOG_FIELD_KINDS.includes(k)),
          requireDefault: true
        })
      }
    }
  }
  if (totalBytes > LIMITS.lineMenuTotalBytes) {
    errors.push(`lineMenu 的模板文本合计过长(上限 ${LIMITS.lineMenuTotalBytes} 字节)`)
  }
}

/**
 * 快捷键的合法形状。
 *
 * 只认 `修饰键(+修饰键...)+主键`。刻意**不**做「这套组合有没有被占用」的判断 ——
 * 那样等于把菜单表抄进来一份,而菜单是应用自己的东西、随时会变。
 * 占用检测在真正注册的时候做(见 main/menu.ts),那里才拿得到权威的已用列表。
 */
export const KEYBINDING_RE = /^(?:(?:Cmd|Ctrl|CmdOrCtrl|Alt|Shift|Super)\+)+[A-Za-z0-9][A-Za-z0-9+-]{0,19}$/

const COMMAND_WHENS = ['always', 'editor', 'vault']
/**
 * 插件能挂右键菜单的地方。
 *
 * **暂时只有 `files`(文件列表)**。`editor`(编辑器正文)是刻意留白的:编辑器现在
 * 根本没有宿主右键菜单,插件条目无处可挂 —— 而先放出一个永远不会出现的取值,
 * 只会让作者写完之后对着"为什么没反应"发呆。等编辑器有了自己的菜单
 * (那需要先把剪切/复制/粘贴打通,菜单里缺了这三项才更奇怪)再把它加回来。
 */
const MENU_WHERES = ['files']

/** 命令与右键菜单的 id 跟动作共用一套字符集:它们最终都指向一个 runAction */
const SLOT_ID_RE = ACTION_ID_RE

/**
 * 命令 / 状态栏 / 右键菜单的通用校验。
 *
 * 三者形状几乎一样(一个 id、一个 label、一个指向 action 的指针),所以共用一份实现 ——
 * 各写一遍的话,「action 必须在 actions 里声明过」这条迟早有一处会漏,而漏掉的后果是
 * 界面上多出一个点了没反应的按钮。
 */
function validateSlotList(
  list: unknown,
  where: string,
  errors: string[],
  opts: {
    max: number
    /** 允许出现的字段白名单 —— 未知字段在这里直接报错(清单是重建的,写错了会被静默丢掉) */
    allowed: string[]
    /**
     * 必须声明的字段。
     *
     * `action` 对三者都是必填,这条值得说清楚:清单里声明的东西是**装的时候就能看见**
     * 的承诺,而"点了之后干什么"必须同样在清单里 —— 否则一条只等运行期回调的命令,
     * 在插件崩了被熔断之后就会变成界面上一颗永远点不动的按钮。要按运行期状态决定
     * 命令长什么样的插件,走 `imark.commands.register()`,那条路天然带着回调。
     */
    required: string[]
    /** 这些指针字段必须能在 actions 里找到 */
    actionPointers: string[]
    actionIds: Set<string>
  }
): void {
  if (list === undefined) return
  if (!Array.isArray(list)) {
    errors.push(`${where} 必须是数组`)
    return
  }
  if (list.length > opts.max) {
    errors.push(`${where} 最多 ${opts.max} 条(现在 ${list.length} 条)`)
  }
  const seen = new Set<string>()
  for (const [i, raw] of list.entries()) {
    const at = `${where}[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at} 必须是对象`)
      continue
    }
    const item = raw as Record<string, unknown>

    for (const key of Object.keys(item)) {
      if (!opts.allowed.includes(key)) {
        errors.push(`${at} 不认识的字段「${key}」(可用:${opts.allowed.join(' / ')})`)
      }
    }
    for (const key of opts.required) {
      if (typeof item[key] !== 'string' || (item[key] as string).trim().length === 0) {
        errors.push(`${at}.${key} 不能为空`)
      }
    }

    if (item.id !== undefined) {
      if (typeof item.id !== 'string' || !SLOT_ID_RE.test(item.id)) {
        errors.push(`${at}.id 非法(小写字母/数字/连字符,1-40 字符)`)
      } else if (seen.has(item.id)) {
        errors.push(`${at}.id 重复:${item.id}`)
      } else {
        seen.add(item.id)
      }
    }

    for (const key of opts.actionPointers) {
      const value = item[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !opts.actionIds.has(value)) {
        errors.push(`${at}.${key} 指向了未声明的动作「${String(value)}」,请先在 actions 里声明`)
      }
    }
  }
}

/** 命令面板条目 */
function validateCommands(list: unknown, errors: string[], actionIds: Set<string>): void {
  validateSlotList(list, 'commands', errors, {
    max: LIMITS.commands,
    allowed: ['id', 'label', 'detail', 'keybinding', 'when', 'action'],
    required: ['id', 'label', 'action'],
    actionPointers: ['action'],
    actionIds
  })
  if (!Array.isArray(list)) return
  for (const [i, raw] of list.entries()) {
    const item = raw as { keybinding?: unknown; when?: unknown }
    if (!item || typeof item !== 'object') continue
    if (item.keybinding !== undefined && (typeof item.keybinding !== 'string' || !KEYBINDING_RE.test(item.keybinding))) {
      errors.push(
        `commands[${i}].keybinding 非法(形如 Ctrl+Shift+P,修饰键用 Cmd/Ctrl/CmdOrCtrl/Alt/Shift/Super)`
      )
    }
    if (item.when !== undefined && !COMMAND_WHENS.includes(item.when as string)) {
      errors.push(`commands[${i}].when 只能是 ${COMMAND_WHENS.join(' / ')}`)
    }
  }
}

/** 状态栏条目:一个插件最多占一条 */
function validateStatusBar(list: unknown, errors: string[], actionIds: Set<string>): void {
  validateSlotList(list, 'statusBar', errors, {
    max: LIMITS.statusBarItems,
    allowed: ['id', 'label', 'icon', 'tooltip', 'action'],
    required: ['id', 'label', 'action'],
    actionPointers: ['action'],
    actionIds
  })
  if (Array.isArray(list) && list.length > 1) {
    errors.push(
      'statusBar 最多 1 条 —— 状态栏是全应用最挤的一条,一个插件占多个位置会把别人挤没'
    )
  }
}

/** 右键菜单条目 */
function validateMenus(list: unknown, errors: string[], actionIds: Set<string>): void {
  validateSlotList(list, 'menus', errors, {
    max: LIMITS.menuItems,
    allowed: ['id', 'label', 'where', 'action', 'danger'],
    required: ['id', 'label', 'action'],
    actionPointers: ['action'],
    actionIds
  })
  if (!Array.isArray(list)) return
  for (const [i, raw] of list.entries()) {
    const item = raw as { where?: unknown; danger?: unknown }
    if (!item || typeof item !== 'object') continue
    if (!MENU_WHERES.includes(item.where as string)) {
      errors.push(`menus[${i}].where 只能是 ${MENU_WHERES.join(' / ')}`)
    }
    if (item.danger !== undefined && typeof item.danger !== 'boolean') {
      errors.push(`menus[${i}].danger 必须是布尔值`)
    }
  }
}

export function validateActions(list: unknown, where: string, errors: string[]): void {
  if (list === undefined) return
  if (!Array.isArray(list)) {
    errors.push(`${where} 必须是数组`)
    return
  }
  const seen = new Set<string>()
  for (const [i, raw] of list.entries()) {
    const a = raw as { id?: unknown; label?: unknown }
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) {
      errors.push(`${where}[${i}].id 非法(小写字母/数字/连字符,1-40 字符)`)
    } else if (seen.has(a.id)) {
      errors.push(`${where}[${i}].id 重复:${a.id}`)
    } else {
      seen.add(a.id)
    }
    if (typeof a.label !== 'string' || a.label.trim().length === 0) {
      errors.push(`${where}[${i}].label 不能为空`)
    }
  }
}

/** 校验清单(不含文件). 返回归一化后的清单 */
export function validateManifest(raw: unknown): Validation<PluginManifest> {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('manifest 必须是对象')
  const m = raw as Partial<PluginManifest>

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    errors.push("id 非法(小写字母开头,可含数字/./_/-,2-64 字符;**不能含 ':'**)")
  } else if (RESERVED_IDS.includes(m.id)) {
    errors.push(`id「${m.id}」是保留字`)
  }
  if (typeof m.name !== 'string' || m.name.trim().length === 0) errors.push('name 不能为空')
  if (typeof m.description !== 'string') errors.push('description 必须是字符串')
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    errors.push('version 非法(需形如 1.2.3 或 1.2.3-beta.1)')
  }

  // ---- 层:main / render / capability 至少一个 ----
  const hasMain = m.main !== undefined
  const hasRender = m.render !== undefined
  const hasCapability = m.capability !== undefined

  if (!hasMain && !hasRender && !hasCapability) {
    errors.push('清单必须至少声明 main / render / capability 之一')
  }
  if (hasCapability && (hasMain || hasRender)) {
    errors.push('capability 只能单独出现,不能与 main / render 并存')
  }

  let mainMode: PluginMainMode | null = null
  if (hasMain) {
    const main = m.main as Partial<PluginMainSpec> | null
    if (!main || typeof main !== 'object' || Array.isArray(main)) {
      errors.push('main 必须是对象 { mode, entry }')
    } else {
      if (main.mode !== 'restricted' && main.mode !== 'node') {
        errors.push("main.mode 必须是 'restricted' 或 'node'")
      } else {
        mainMode = main.mode
      }
      if (typeof main.entry !== 'string' || !isSafeRelPath(main.entry)) {
        errors.push('main.entry 必须是包内的合法相对路径')
      } else if (main.mode === 'node' && !/\.(c?js)$/.test(main.entry)) {
        errors.push('node main 的入口必须是 .js / .cjs(CommonJS)')
      } else if (main.mode === 'restricted' && !/\.(m?js)$/.test(main.entry)) {
        errors.push('restricted main 的入口必须是 .js / .mjs(ES module)')
      }
    }
  }

  if (hasRender) {
    const render = m.render as Partial<PluginRenderSpec> | null
    if (!render || typeof render !== 'object' || Array.isArray(render)) {
      errors.push('render 必须是对象 { entry }')
    } else {
      if (typeof render.entry !== 'string' || !isSafeRelPath(render.entry)) {
        errors.push('render.entry 必须是包内的合法相对路径')
      } else if (!/\.js$/.test(render.entry)) {
        errors.push('render 入口必须是 .js(普通脚本,不能有 import/export/require)')
      }
    }
  }

  if (hasCapability && (typeof m.capability !== 'string' || m.capability.trim().length === 0)) {
    errors.push('capability 必须是非空字符串')
  }

  if (m.homepage !== undefined && !/^https:\/\//i.test(String(m.homepage))) {
    errors.push('homepage 必须是 https 地址')
  }
  if (m.icon !== undefined && (typeof m.icon !== 'string' || !isSafeRelPath(m.icon))) {
    errors.push('icon 必须是包内的合法相对路径')
  }

  // ---- 权限:只在 main / capability 里有意义 ----
  if (m.permissions !== undefined && !Array.isArray(m.permissions)) {
    errors.push('permissions 必须是数组')
  } else {
    const seen = new Set<unknown>()
    for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
      if (seen.has(p)) errors.push(`权限「${String(p)}」重复声明`)
      seen.add(p)
      if (!PLUGIN_PERMISSIONS.includes(p as PluginPermission)) {
        // 未知权限硬报错而不是静默放行:静默放行的后果是作者以为「我申请了网络」,
        // 而运行时因为词表里没这个词什么也没给 —— 他会去别处找原因,找不到
        errors.push(`未知权限:${String(p)}`)
        continue
      }
      if (!hasMain && !hasCapability) {
        errors.push(`render-only 插件没有系统能力,不该声明权限「${p}」`)
      } else if (mainMode === 'restricted' && !RESTRICTED_PERMISSIONS.includes(p as PluginPermission)) {
        errors.push(`受限 main 没有「${p}」对应的能力,不该声明它`)
      }
    }
  }

  if (m.engines !== undefined && (typeof m.engines !== 'object' || Array.isArray(m.engines))) {
    errors.push('engines 必须是对象')
  }

  const fields = Array.isArray(m.fields) ? m.fields : []
  const hasTargetListField = fields.some(
    (f) =>
      f &&
      typeof f === 'object' &&
      ((f as PluginField).kind === 'targets' || (f as PluginField).kind === 'endpoints')
  )

  validateFields(m.fields, errors)
  validateActions(m.actions, 'actions', errors)
  validateActions(m.targetActions, 'targetActions', errors)
  validateLineMenu(m.lineMenu, errors)

  // 贡献点里的 action 指针必须指向 actions 里真有的东西。用「已校验通过的 id 集合」
  // 而不是原始的 m.actions —— 后者可能根本不是数组,或者里面混着没有 id 的垃圾。
  const actionIds = new Set(
    (Array.isArray(m.actions) ? m.actions : [])
      .map(a => (a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string')
  )
  validateCommands(m.commands, errors, actionIds)
  validateStatusBar(m.statusBar, errors, actionIds)
  validateMenus(m.menus, errors, actionIds)

  if (m.targetActions !== undefined && m.targetActions.length > 0 && !hasTargetListField) {
    errors.push('声明了 targetActions 但没有任何 targets / endpoints 字段')
  }
  if (m.targetFieldKey !== undefined && typeof m.targetFieldKey !== 'string') {
    errors.push('targetFieldKey 必须是字符串')
  }

  if (errors.length > 0) return fail(...errors)
  return { ok: true, errors: [], value: canonicalManifest(m) }
}

/**
 * 按 pluginFormat.json 的键序重建清单 —— 校验通过后的**唯一**产出形状。
 *
 * 为什么值得单独抽出来:integrity 是对 `JSON.stringify({manifest, files})` 求的 sha256,
 * 而 JSON.stringify 保留键的插入顺序。于是「清单按什么顺序重建」是格式的一部分,
 * 不是代码风格问题。打包器怎么排、这里怎么排,两边必须逐字一致。
 *
 * 顺带的效果是未知键被**静默丢弃**:清单是从磁盘上读来的,磁盘上的东西可以被手改,
 * 谁也不知道里面多塞了什么。丢掉它们意味着下游拿到的清单形状完全由这里说了算。
 * (代价见 PluginMainMode 处的说明:新增**安全相关**的形态绝不能靠「多一个可选键」。)
 */
export function canonicalManifest(m: Partial<PluginManifest>): PluginManifest {
  const arrayKeys = new Set<string>(formatData.arrayKeys)
  const out: Record<string, unknown> = {}
  for (const key of formatData.manifestKeyOrder) {
    // 空数组兜底:fields / actions 是宿主代码无条件读的,缺了就得到处写 ?? []
    if (arrayKeys.has(key)) {
      out[key] = m[key as keyof PluginManifest] ?? []
    } else if (key === 'main') {
      if (m.main) out.main = orderObject(m.main, formatData.mainKeyOrder)
    } else if (key === 'render') {
      if (m.render) out.render = orderObject(m.render, formatData.renderKeyOrder)
    } else if (m[key as keyof PluginManifest] !== undefined) {
      out[key] = m[key as keyof PluginManifest]
    }
  }
  return out as unknown as PluginManifest
}

/** 嵌套对象的键序也是 integrity 的一部分:三处必须按同一份顺序重建 */
function orderObject(value: object, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/**
 * 校验信封**结构**(不校验内容哈希 —— 那需要 crypto,在主进程做)。
 * 返回归一化后的信封。
 */
export function validateEnvelope(raw: unknown): Validation<PluginPackageEnvelope> {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('插件包必须是 JSON 对象')
  const e = raw as Partial<PluginPackageEnvelope>

  if (e.format !== PACKAGE_FORMAT) errors.push(`format 必须是 "${PACKAGE_FORMAT}"`)
  if (e.formatVersion !== PACKAGE_FORMAT_VERSION) {
    errors.push(`formatVersion 必须是 ${PACKAGE_FORMAT_VERSION}`)
  }

  const manifestResult = validateManifest(e.manifest)
  if (!manifestResult.ok || !manifestResult.value) {
    errors.push(...manifestResult.errors.map((x) => `manifest:${x}`))
  }

  if (!e.files || typeof e.files !== 'object' || Array.isArray(e.files)) {
    errors.push('files 必须是对象')
  } else if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) {
    errors.push('data 必须是对象')
  } else {
    const names = Object.keys(e.files)
    if (names.length === 0) errors.push('包内没有任何文件')
    if (names.length > LIMITS.fileCount) errors.push(`文件数超过上限(${LIMITS.fileCount})`)
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
      const limit = name === 'README.md' ? LIMITS.readmeBytes : LIMITS.fileBytes
      if (meta.size > limit) errors.push(`${name}:文件过大(> ${limit} 字节)`)
      if (typeof meta.sha256 !== 'string' || !SHA256_RE.test(meta.sha256)) {
        errors.push(`${name}:sha256 非法`)
      }
      const content = e.data[name]
      if (typeof content !== 'string' || content.length === 0) {
        errors.push(`${name}:缺少内容`)
      } else {
        // base64 长度与 size 的换算:按 4 字符 3 字节,含 padding
        const approx = Math.floor((content.replace(/=+$/, '').length * 3) / 4)
        if (Math.abs(approx - meta.size) > 2) {
          errors.push(`${name}:内容长度与声明的 size 不符`)
        }
      }
    }

    const manifest = manifestResult.value
    if (manifest) {
      // 每个声明的层都必须把入口打进包里,且各自受入口体积上限约束。
      const entries: { label: string; file: string }[] = []
      if (manifest.main) entries.push({ label: 'main', file: manifest.main.entry })
      if (manifest.render) entries.push({ label: 'render', file: manifest.render.entry })
      for (const { label, file } of entries) {
        if (!names.includes(file)) errors.push(`${label} 入口「${file}」不在包内`)
        const meta = e.files[file]
        if (meta && meta.size > LIMITS.entryBytes) {
          errors.push(`${label} 入口超过 ${LIMITS.entryBytes} 字节上限`)
        }
      }
      if (manifest.icon && !names.includes(manifest.icon)) {
        errors.push(`icon「${manifest.icon}」不在包内`)
      }
      for (const field of manifest.fields) {
        // 字段表里的默认值必须是 JSON 可表达的,否则过 IPC 会炸
        if (field.default === undefined) errors.push(`字段 ${field.key} 缺少 default`)
      }
    }
  }

  if (typeof e.integrity !== 'string' || !SHA256_RE.test(e.integrity)) {
    errors.push('integrity 非法')
  }

  if (errors.length > 0) return fail(...errors)
  return { ok: true, errors: [], value: raw as PluginPackageEnvelope }
}

/** 从清单装配宿主/渲染层用的 descriptor —— 插件代码**永远不参与**决定自己长什么样 */
export function descriptorFromManifest(manifest: PluginManifest): PluginDescriptor {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    fields: manifest.fields,
    actions: manifest.actions,
    ...(manifest.targetActions ? { targetActions: manifest.targetActions } : {}),
    ...(manifest.targetFieldKey ? { targetFieldKey: manifest.targetFieldKey } : {}),
    ...(manifest.lineMenu ? { lineMenu: manifest.lineMenu } : {})
  }
}
