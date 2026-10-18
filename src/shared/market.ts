/**
 * 插件市场的共享类型 —— 跨 IPC 的那些。主进程产出、渲染层展示。
 *
 * 只有**进度**是单向播报,其余都是一问一答。
 */

import type { PluginPermission } from './pluginPackage'
import type { PluginDescriptor, PluginView } from './plugins'

/**
 * 市场视角的插件层信息。
 *
 * 与清单的 `main:{mode}` / `render` / `capability` 一一对应,由服务端从 manifest
 * 派生后下发;界面只认这三个字段,不再按旧的四种 kind 分支。
 */
export interface MarketPluginShape {
  mainMode: 'restricted' | 'node' | null
  hasRender: boolean
  capability: string | null
}

// ---------- 进度 ----------

export type MarketPhase =
  /** 从市场/本地文件读入字节 */
  | 'download'
  /** 校验结构、逐文件 sha256 与整体 integrity */
  | 'verify'
  /** 解包到 .staging/ */
  | 'extract'
  /** 交由宿主加载并注册(会真的跑插件的 main.js) */
  | 'load'
  | 'done'
  | 'error'

export interface MarketProgress {
  /** 插件 id;从本地文件安装且清单还没读出来时为空串 */
  id: string
  phase: MarketPhase
  /** 0-100 */
  percent: number
  message: string
  /** 失败详情(已脱敏) */
  detail?: string
}

// ---------- 安装确认 ----------

export interface PackageFileInfo {
  name: string
  size: number
}

/**
 * 安装确认框要看到的一切。
 *
 * 这是**安全基线**:用户在按下「安装」之前必须能看清自己将要同意什么 ——
 * 谁做的、装的是什么、要哪些权限、多大、以及那个可以拿去和别人核对的 sha256。
 */
export interface PackagePreview {
  id: string
  name: string
  version: string
  /** 清单里的作者署名。**不是**发布者用户名(那是市场账号,本地安装时没有) */
  author: string | null
  description: string
  /** main 层模式;没有 main 层时为 null */
  mainMode: 'restricted' | 'node' | null
  /** 是否有 render 层 */
  hasRender: boolean
  /** 无代码插件绑定的内置能力 id;有代码插件为 null */
  capability: string | null
  /** 声明式插件绑定的内置能力显示名(会替它执行的那只手);有代码插件为 null */
  capabilityName: string | null
  permissions: PluginPermission[]
  descriptor: PluginDescriptor
  /** 整包 sha256,供用户跨渠道核对 */
  integrity: string
  fileCount: number
  totalBytes: number
  files: PackageFileInfo[]
  /** main 入口的 sha256 —— 「跑的是不是这一份代码」的凭据 */
  mainSha256: string | null
  /** render 入口的 sha256(没有 render 层时为 null) */
  renderSha256: string | null
  /** 本地已装的版本(用于把按钮文案变成「更新」并展示版本变化),没装过为 null */
  installed: { version: string; integrity: string } | null
  /** 这次安装是降级(本地版本更新) */
  downgraded: boolean
  /** 包从哪来:市场下载 / 本地文件 / 本地目录(内置兜底包走的是安装路径,不产生预览) */
  origin: 'market' | 'local-file' | 'local-dir'
  /** 来源描述:市场地址、文件路径或目录路径(仅展示用) */
  originLabel: string
  /**
   * 用户已有的授权里没有的新权限。
   * 非空即表示这是**权限扩大**,确认框必须重新逐条确认 —— 升级时最容易
   * 被忽略的风险就是「包还是那个包,但它现在要读你的整个仓库了」。
   */
  newPermissions: PluginPermission[]
  /** 本地已装版本(用于升级时对比展示),与 installed.version 相同,独立列出便于阅读 */
  installedVersion: string | null
}

/** 待确认的安装:确认框拿着令牌,主进程拿着那份已校验的字节 */
export interface PendingInstall {
  token: string
  preview: PackagePreview
}

// ---------- 已安装 ----------

export interface MarketInstalledData {
  plugins: PluginView[]
  /** 应用自带的兜底包有哪些(界面据此区分「自带」与「自己装的」) */
  bundled: string[]
}

// ---------- 更新 ----------

export interface MarketUpdate {
  id: string
  name: string
  currentVersion: string
  latestVersion: string
  /** 新版本要求的权限里,比本地已授权的多出来的那些 */
  newPermissions: PluginPermission[]
  mainMode: 'restricted' | 'node' | null
  hasRender: boolean
}

// ---------- 市场(服务端返回的形状) ----------

/**
 * 列表页看到的一条。
 *
 * 这里**没有**「本地是否已装」「有没有更新」—— 那些是客户端拿本地状态与
 * 这份服务端数据join 出来的,不归服务端回答。服务端并不知道谁装了什么,
 * 也不该知道。
 */
export interface MarketEntry extends MarketPluginShape {
  id: string
  name: string
  description: string
  /** 最新非下架版本 */
  version: string
  /** 清单里作者自己写的署名,可以为空 */
  author: string | null
  /** 发布者账号(市场用户名)—— 与 author 不是一回事,界面上要分开写 */
  publisher: string
  /**
   * 声明式插件绑定的内置能力 id;有代码插件为 null。
   * 名字不在这里 —— 能力注册表在主进程,名字由它翻好再下发(见 capabilityName)。
   */
  capability: string | null
  /**
   * 上面那个能力的**显示名**,由主进程查能力注册表得到。
   *
   * 「不含代码」这句话本身是空的:一个声称是笔记统计的插件完全可以绑 webhook。
   * 用户要判断的恰恰是「它借的是哪只别人的手」,所以名字必须跟着 id 一起下来。
   */
  capabilityName: string | null
  permissions: PluginPermission[]
  homepage: string | null
  hasIcon: boolean
  downloads: number
  updatedAt: number
  publishedAt: number
}

export interface MarketSearchResult {
  total: number
  page: number
  pageSize: number
  items: MarketEntry[]
}

export interface MarketVersionInfo {
  version: string
  integrity: string
  publishedAt: number
  /** 已下架:不在搜索结果与 latest 里,但按精确版本仍可下载 */
  yanked: boolean
  size: number | null
  mainSha256: string | null
  renderSha256: string | null
}

export interface MarketDetail extends MarketEntry {
  createdAt: number
  /** 含已下架版本,按版本号从高到低 */
  versions: MarketVersionInfo[]
  /** 包里的 README.md,纯文本 */
  readme: string | null
}

/** 源码查看器里的一份文件 */
export interface MarketSourceFile {
  name: string
  /** 包里的原始字节数(不是这里 text 的长度) */
  size: number
  text: string
  /** 文件太大,只给了前面一段 */
  truncated: boolean
}

/**
 * 某个版本包里的可读文件。
 *
 * 这份东西存在的唯一理由是**知情**:装脚本插件等于让作者的代码拿到完整权限,
 * 而 README 是作者写的、详情页是市场给的,只有源码是作者真正要跑的东西。
 * 因此这里展示的内容与**真要装进去的那份字节**来自同一个信封,且同样过了
 * `verifyEnvelope` 与 integrity 校验 —— 不是另取的一份「参考源码」。
 */
export interface MarketSource {
  id: string
  version: string
  /** 与详情页、安装确认框显示的是同一个整包 sha256 */
  integrity: string
  files: MarketSourceFile[]
  /** 有文件被截断了 */
  truncated: boolean
}

export type MarketSort = 'updated' | 'name' | 'downloads'

export interface MarketQuery {
  q: string
  page: number
  pageSize: number
  sort: MarketSort
  /** 'none' = 没有 main 层;null = 不筛选 */
  mainMode: 'restricted' | 'node' | 'none' | null
  hasRender: boolean | null
}

export interface MarketAuthStatus {
  /** 当前注册表地址(已规范化);空串表示没配置 */
  registry: string
  loggedIn: boolean
  user: string | null
  /** 系统密钥库是否可用。不可用时令牌是**明文**落盘的,必须让用户知道 */
  secureStorage: boolean
  /** 地址是明文 http 且不是回环 —— 界面提示一次 */
  plainHttp: boolean
}

/** 发布前的预览:打包完成、还没上传时给用户看的东西 */
export interface PublishPreview {
  id: string
  name: string
  version: string
  mainMode: 'restricted' | 'node' | null
  hasRender: boolean
  capability: string | null
  integrity: string
  mainSha256: string | null
  renderSha256: string | null
  fileCount: number
  totalBytes: number
  files: PackageFileInfo[]
  permissions: PluginPermission[]
  /** 服务端上这个 id 目前的最高版本;这个 id 还没被发布过则为 null */
  existingVersion: string | null
  /** 服务端上这个 id 的拥有者;与当前登录用户不同时界面要警告 */
  existingOwner: string | null
  /**
   * (id, version) 在服务端已经存在。
   * 已发布版本不可覆盖(服务端会回 409),所以这件事必须在**上传之前**就说清楚 ——
   * 让用户白传一次 8 MiB 再收到「版本已存在」是很糟的体验。
   */
  versionExists: boolean
  /** 与已发布版本内容完全相同(integrity 一致),发布没有意义 */
  identical: boolean
}

export interface PublishResult {
  id: string
  version: string
  integrity: string
  publisher: string
}
