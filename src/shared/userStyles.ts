/**
 * 用户自定义样式(~/.imark/css)在两进程间的传输形状。
 *
 * 只放类型、零运行时依赖,与 `market.ts` / `plugins.ts` 同一个惯例。
 *
 * **凡是过 contextBridge 的都必须能结构化克隆**:所以读失败用字符串表示,
 * 而不是 Error 对象(Error 克隆过去会变成一个 `{}`,见 pluginService.ts 里
 * `plain()` 的说明)。
 */

export interface UserStyleFile {
  /** 磁盘上的真实文件名 —— 排序键与注入 id 都用它 */
  name: string
  /** 文件大小;**0 表示连大小都没读到**(stat 就失败了) */
  size: number
  /** CSS 文本;读取失败或超过体积上限时为 null */
  css: string | null
  /** 人类可读的失败原因(字符串,不是 Error);成功为 null */
  error: string | null
}

export interface UserStyleState {
  /** 样式目录的绝对路径 —— 路径只在主进程里拼,渲染层只拿它显示 */
  dir: string
  /** 已按文件名升序排好:顺序即层叠顺序,越靠后越赢 */
  files: UserStyleFile[]
}

/** 一次导入动作都干了些什么(单个文件与整个文件夹共用同一套说法) */
export interface UserStyleImportOutcome {
  /** 真正复制进来的文件名(重名时可能带上了 -2 这样的后缀) */
  imported: string[]
  /** 内容与已有文件完全相同、因此没有复制的:同名文件可能有**多个** */
  duplicates: { name: string; sameAs: string[] }[]
  /** 读不了或过大的;error 是可以直接显示的中文 */
  failed: { name: string; error: string }[]
}

/** 导入类通道的返回值:做了什么 + 动作之后的最新清单 */
export interface UserStyleImportResult {
  state: UserStyleState
  outcome: UserStyleImportOutcome
}
