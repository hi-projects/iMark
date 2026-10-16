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
export const PACKAGE_FORMAT_VERSION = 1

/**
 * 插件形态。
 *
 * - `script`   —— 包内有 main.js,在**主进程**以完整 Node 能力执行(旧形态,权限只是告知)
 * - `declarative` —— 无代码,绑定宿主内置能力
 * - `sandboxed` —— 代码跑在**自己的渲染器**里(无 Node、无 fs),能力全部经宿主审查后转发
 *
 * **沙箱形态必须是一个新的 kind 值,不能是 `runtime: 'sandboxed'` 这样的可选字段。**
 * 原因在本文末尾的说明里:清单是被「白名单重建、未知键静默丢弃」的,旧客户端会把
 * 旁路字段悄悄丢掉,然后把沙箱插件当成普通 script 插件在主进程里以完整 Node 跑起来 ——
 * 整个安全模型无声蒸发。用新 kind 值,旧客户端会明确拒绝安装。
 * 推广成规则:**将来任何"更安全的形态"都换 kind 值,不加旁路字段。**
 */
export type PluginKind = 'script' | 'declarative' | 'sandboxed'

/**
 * 这个形态的插件带代码入口(main)吗。
 *
 * script 的 main 在主进程跑,sandboxed 的 main 在插件自己的页面里跑 ——
 * 对「打包时入口文件必须在包里」「登记 mainSha256」「算加载错误」这些事而言,
 * 两者的判断完全一样,只有「谁来执行它」不同。抽出来是为了不再到处写
 * `kind === 'script'`,那种写法在加入第二种带代码的形态时必然会漏掉几处。
 */
export function hasMainEntry(kind: PluginKind): boolean {
  return kind === 'script' || kind === 'sandboxed'
}

/**
 * 权限词表。
 *
 * 语义**取决于 kind**,这一点在界面上必须说清楚:
 * - 对 `script`(完整 Node):除 git / secrets 外都是**声明性说明** —— fs / net / shell
 *   本来挡不住,列出来是为了让安装者知道自己在同意什么。
 * - 对 `sandboxed`:**每一项都是真门禁**。没声明的能力连 API 对象都不存在,
 *   每一次调用还要在主进程再查一遍。
 *
 * 所以 README 与安装对话框的准确说法是:**装了沙箱插件才是真门禁,装了脚本插件仍是告知。**
 */
export type PluginPermission =
  | 'git'
  | 'secrets'
  | 'vault:read'
  | 'vault:write'
  | 'network'
  | 'shell'
  | 'settings'
  | 'ui'
  | 'editor:read'
  | 'editor:write'

export const PLUGIN_PERMISSIONS: PluginPermission[] = [
  'git',
  'secrets',
  'vault:read',
  'vault:write',
  'network',
  'shell',
  'settings',
  'ui',
  'editor:read',
  'editor:write'
]

/**
 * 只有沙箱插件用得上的权限词。
 *
 * `ui`(开自己的窗口 / 把面板停靠进主界面)需要一整个页面,而只有沙箱形态有页面。
 * 脚本插件想往界面上放东西走的是另一条路(`imk.ui.mount`,见 README 的说明)——
 * 它本来就全权,给它一个"窗口"的说法既多余又难懂。
 * 出现在 script / declarative 清单里直接报错:静默接受会变成"我声明了 ui 却什么也没发生"。
 */
export const SANDBOX_ONLY_PERMISSIONS: PluginPermission[] = ['ui']

/**
 * 只有**带代码**的形态(script / sandboxed)谈得上的权限词。
 *
 * 声明式插件没有代码,谈"读文档"没有意义 —— 那种包只声明字段与动作,
 * 干活的是宿主内置能力。这两个词对它就是纯粹的噪音。
 */
export const CODE_ONLY_PERMISSIONS: PluginPermission[] = ['editor:read', 'editor:write']

/** 权限的中文说明(安装确认框逐条展示,渲染层与主进程共用) */
export const PERMISSION_INFO: Record<PluginPermission, { label: string; description: string }> = {
  git: {
    label: '调用 Git',
    description: '通过宿主提供的接口执行 git 命令(推送、拉取、查看远端等)。'
  },
  secrets: {
    label: '读取已保存的密钥',
    description: '读取本插件自己名下的访问令牌 / 密码(只读,不能改写其他插件的密钥)。'
  },
  'vault:read': { label: '读取仓库文件', description: '读取当前仓库里的笔记与目录结构。' },
  'vault:write': { label: '修改仓库文件', description: '在当前仓库里新建、修改或删除文件。' },
  network: { label: '访问网络', description: '连接互联网,把数据发送到你配置的服务器。' },
  shell: { label: '执行系统命令', description: '在你电脑上启动其他程序或命令。' },
  settings: { label: '读取编辑器设置', description: '读取主题、仓库路径等编辑器设置。' },
  ui: {
    label: '打开自己的窗口',
    description:
      '在自己的窗口或主界面的侧栏里显示任意内容。窗口标题栏与面板顶栏都会标出插件名;它长得像 iMark 的界面,所以请只在这里输入你信任的插件要的东西。'
  },
  'editor:read': {
    label: '读取当前文档',
    description:
      '读取你正在编辑的这篇文档的正文与光标位置,并可以在正文上叠高亮/标记(比如把待办渲染成方框)。它读不到仓库里别的文件 —— 那是「读取仓库文件」。'
  },
  'editor:write': {
    label: '修改当前文档',
    description:
      '改写你正在编辑的这篇文档(替换选区、移动光标、插入内容)。不是改任意文件 —— 那是「修改仓库文件」。'
  }
}

/**
 * 沙箱插件的界面声明。**没有 ui 就是纯后台插件**(宿主给它一个隐藏的执行器页面)。
 *
 * 这个对象存在本身就意味着「要开窗口」,所以清单里写了它却没声明 `ui` 权限
 * 会直接报错 —— 那正是钓鱼窗口风险的告知位置。
 */
export interface PluginUiSpec {
  /** 窗口/面板加载的包内 HTML 入口 */
  entry: string
  /**
   * 初始尺寸(不填用宿主的默认值)。
   * 开窗口时是窗口尺寸;停靠时左/右栏取 `width`、底栏取 `height`。
   */
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  /**
   * **停靠到主界面的哪一侧**。不写就是"开自己的窗口"。
   *
   * 两种形态的差别只有一件事:页面长在哪儿。页面本身、会话、CSP、能力完全一样 ——
   * 所以作者不必为"停靠还是独立窗口"写两套代码。
   *
   * 停靠的是**插件自己的 renderer**(`WebContentsView`),不是把插件的 HTML 塞进
   * iMark 的页面里:它碰不到主界面的任何 DOM,主界面的样式也影响不到它。
   */
  dock?: PluginDockSide
}

/** 面板能停靠的三侧(与主界面布局一一对应) */
export type PluginDockSide = 'left' | 'right' | 'bottom'

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
  kind: PluginKind
  /** 仅 declarative:内置能力 id(见 main/plugins/capabilities.ts) */
  capability?: string
  /** 仅 script / sandboxed:入口文件名,必须是包内存在的 .js */
  main?: string
  /** 仅 sandboxed:开自己的窗口(不写 = 纯后台插件,宿主给一个隐藏的执行器页面) */
  ui?: PluginUiSpec
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
  fileBytes: 2 * 1024 * 1024,
  mainBytes: 1024 * 1024,
  readmeBytes: 256 * 1024,
  iconBytes: 64 * 1024,
  fileCount: 64,
  pathLength: 128,
  pathDepth: 3,
  /**
   * 源码查看器里单个文件最多显示多少字节。
   * main.js 的上限是 1 MiB,一整个塞进 `<pre>` 会让界面卡住;超出的部分截断并明确标注。
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
const FIELD_KINDS = ['text', 'password', 'number', 'boolean', 'select', 'targets']

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
 * 插件窗口尺寸的边界。
 *
 * 校验在这里、夹取在主进程建窗时各做一次:前者让作者在**打包时**就知道自己写错了,
 * 后者保证手改 manifest.json 也越不过去(磁盘上的东西可以是手改的)。
 */
export const UI_SIZE = { min: 240, max: 4000, defaultWidth: 900, defaultHeight: 640 }

/** 面板能停靠的三侧(运行时校验用;类型上是 PluginDockSide) */
export const DOCK_SIDES: PluginDockSide[] = ['left', 'right', 'bottom']

/**
 * 停靠面板的尺寸边界。
 *
 * 比窗口那套更紧:窗口开大了只是挡着别的窗口,而**面板会把主界面挤窄** ——
 * 一个占了 3000px 宽的面板等于把编辑器挤没了,用户还找不到是哪个插件干的。
 */
export const DOCK_SIZE = { min: 180, max: 900, defaultWidth: 320, defaultHeight: 220 }

/** 校验沙箱插件的界面声明(仅 kind:'sandboxed' 会走到这里) */
function validateUiSpec(ui: unknown, errors: string[]): void {
  if (ui === undefined) return
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) {
    errors.push('ui 必须是对象')
    return
  }
  const u = ui as Partial<PluginUiSpec>
  const allowed = ['entry', 'width', 'height', 'minWidth', 'minHeight', 'dock']
  for (const key of Object.keys(u)) {
    if (!allowed.includes(key)) errors.push(`ui 里不认识的键:${key}`)
  }
  if (u.dock !== undefined && !DOCK_SIDES.includes(u.dock)) {
    errors.push(`ui.dock 只能是 ${DOCK_SIDES.join(' / ')} 之一`)
  }
  if (typeof u.entry !== 'string' || !isSafeRelPath(u.entry)) {
    errors.push('ui.entry 必须是包内的合法相对路径')
  } else if (!/\.html?$/i.test(u.entry)) {
    errors.push('ui.entry 必须是 .html 文件')
  }
  // 停靠的面板尺寸另有一套更紧的边界(见 DOCK_SIZE):它挤的是主界面,不是桌面
  const size = u.dock ? DOCK_SIZE : UI_SIZE
  for (const key of ['width', 'height', 'minWidth', 'minHeight'] as const) {
    const v = u[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < size.min || v > size.max) {
      errors.push(`ui.${key} 必须是 ${size.min}-${size.max} 之间的数字`)
    }
  }
  if (u.minWidth !== undefined && u.width !== undefined && u.minWidth > u.width) {
    errors.push('ui.minWidth 不能大于 ui.width(窗口一建出来就是矛盾的)')
  }
  if (u.minHeight !== undefined && u.height !== undefined && u.minHeight > u.height) {
    errors.push('ui.minHeight 不能大于 ui.height')
  }
}

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
  if (m.kind !== 'script' && m.kind !== 'declarative' && m.kind !== 'sandboxed') {
    errors.push("kind 必须是 'script' / 'declarative' / 'sandboxed' 之一")
  }

  const files = Array.isArray(m.fields) ? m.fields : []
  const isTargetsField = files.some(
    (f) => f && typeof f === 'object' && (f as PluginField).kind === 'targets'
  )

  if (m.kind === 'script') {
    if (typeof m.main !== 'string' || !isSafeRelPath(m.main) || !/\.(c?js)$/.test(m.main)) {
      errors.push('script 插件必须给出合法的 main(包内的 .js 文件)')
    }
    if (m.capability !== undefined) errors.push('script 插件不应声明 capability')
  } else if (m.kind === 'declarative') {
    if (m.main !== undefined) errors.push('declarative 插件不应有 main(声明式插件不含代码)')
    if (typeof m.capability !== 'string' || m.capability.trim().length === 0) {
      errors.push('declarative 插件必须声明 capability')
    }
  } else if (m.kind === 'sandboxed') {
    if (typeof m.main !== 'string' || !isSafeRelPath(m.main) || !/\.(c?js)$/.test(m.main)) {
      errors.push('sandboxed 插件必须给出合法的 main(包内的 .js 文件,在插件自己的页面里执行)')
    }
    if (m.capability !== undefined) errors.push('sandboxed 插件不应声明 capability')
    validateUiSpec(m.ui, errors)
  }
  if (m.kind !== 'sandboxed') {
    if (m.ui !== undefined) {
      errors.push("只有 kind:'sandboxed' 的插件才能声明 ui(脚本插件跑在主进程,没有属于它的窗口)")
    }
  }

  if (m.homepage !== undefined && !/^https:\/\//i.test(String(m.homepage))) {
    errors.push('homepage 必须是 https 地址')
  }
  if (m.icon !== undefined && (typeof m.icon !== 'string' || !isSafeRelPath(m.icon))) {
    errors.push('icon 必须是包内的合法相对路径')
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions 必须是数组')
    } else {
      for (const p of m.permissions) {
        if (!PLUGIN_PERMISSIONS.includes(p as PluginPermission)) {
          // 未知权限硬报错而不是静默放行:静默放行的后果是作者以为「我申请了网络」,
          // 而运行时因为词表里没这个词什么也没给 —— 他会去别处找原因,找不到
          errors.push(`未知权限:${String(p)}`)
        } else if (SANDBOX_ONLY_PERMISSIONS.includes(p as PluginPermission) && m.kind !== 'sandboxed') {
          errors.push(`权限「${p}」只对沙箱插件(kind: 'sandboxed')有意义,别的形态不该声明它`)
        } else if (m.kind !== undefined && CODE_ONLY_PERMISSIONS.includes(p as PluginPermission) && !hasMainEntry(m.kind)) {
          errors.push(`声明式插件没有代码,不该声明「${p}」(它不会调用任何东西)`)
        }
      }
    }
  }
  if (m.engines !== undefined && (typeof m.engines !== 'object' || Array.isArray(m.engines))) {
    errors.push('engines 必须是对象')
  }
  // 「要开窗口」和「申请了开窗口的权限」必须同时成立。允许只写 ui 不申请权限的话,
  // 安装确认框就少了一行 —— 而钓鱼窗口正是这一行在告知的东西。
  //
  // 注意 `permissions` 整个没写的情况:那等于"什么都没申请",同样要拦住。
  // 只在 `Array.isArray(...)` 成立时才判的话,一个连 permissions 键都没有的清单
  // 会从这条校验下面溜过去。
  const declaredPerms = Array.isArray(m.permissions) ? m.permissions : []
  if (m.kind === 'sandboxed' && m.ui !== undefined && !declaredPerms.includes('ui')) {
    errors.push("声明了 ui(自己的窗口)却没有申请「ui」权限")
  }

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

  if (m.targetActions !== undefined && m.targetActions.length > 0 && !isTargetsField) {
    errors.push('声明了 targetActions 但没有任何 targets 字段')
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
 * (代价见 PluginKind 处的说明:新增**安全相关**的形态绝不能靠「多一个可选键」。)
 */
export function canonicalManifest(m: Partial<PluginManifest>): PluginManifest {
  const arrayKeys = new Set<string>(formatData.arrayKeys)
  const out: Record<string, unknown> = {}
  for (const key of formatData.manifestKeyOrder) {
    // 空数组兜底:fields / actions 是宿主代码无条件读的,缺了就得到处写 ?? []
    if (arrayKeys.has(key)) out[key] = m[key as keyof PluginManifest] ?? []
    else if (m[key as keyof PluginManifest] !== undefined) out[key] = m[key as keyof PluginManifest]
  }
  return out as unknown as PluginManifest
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
      if (manifest.kind === 'script') {
        const main = manifest.main!
        if (!names.includes(main)) errors.push(`main「${main}」不在包内`)
        const mainMeta = e.files[main]
        if (mainMeta && mainMeta.size > LIMITS.mainBytes) {
          errors.push(`main 超过 ${LIMITS.mainBytes} 字节上限`)
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
