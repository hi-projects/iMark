/**
 * 用户自定义样式(~/.imark/css)在两进程间的传输形状。
 *
 * 只放类型、零运行时依赖,与 `market.ts` / `plugins.ts` 同一个惯例。
 *
 * **凡是过 contextBridge 的都必须能结构化克隆**:所以读失败用字符串表示,
 * 而不是 Error 对象(Error 克隆过去会变成一个 `{}`,见 pluginService.ts 里
 * `plain()` 的说明)。
 */

export interface UserStyleItem {
  /**
   * 磁盘上的真实名字 —— 排序键、注入 id 与设置里存的那个值都用它。
   *
   * 文件全名,或目录名。同一个父目录下文件与目录不可能同名,所以不必再带一个
   * 「是哪种」的路径信息:名字本身就是唯一标识。
   */
  name: string
  /** 单项 = 一个 .css;目录项 = 目录里(递归)所有 .css 一起生效 */
  kind: 'file' | 'dir'
  /** 生效用的 CSS 文本;目录项是递归收齐后拼成的一份;没得可用时为 null */
  css: string | null
  /** 目录项递归数到的 .css 个数(含读不动的);文件为 0 */
  fileCount: number
  /** 致命问题(这一项用不了):css 为 null 的原因;正常为 null */
  error: string | null
  /**
   * 目录项里读不动、被跳过的 .css(相对路径)——
   * 非致命:其余文件照常生效,但界面要说出来,不能悄悄少几条规则
   */
  skipped: string[]
}

export interface UserStyleState {
  /** 样式目录的绝对路径 —— 路径只在主进程里拼,渲染层只拿它显示 */
  dir: string
  /** 已按名字升序排好(文件与目录混排):排序只管显示,生效的只有选中那一项 */
  items: UserStyleItem[]
}

/** 一次导入动作都干了些什么(单个文件与整个文件夹共用同一套说法) */
export interface UserStyleImportOutcome {
  /** 真正复制进来的名字(重名时可能带上了 -2 这样的后缀) */
  imported: string[]
  /** 内容与已有一项完全相同、因此没有复制的:同名项可能有**多个** */
  duplicates: { name: string; sameAs: string[] }[]
  /** 读不了或过大的;error 是可以直接显示的中文 */
  failed: { name: string; error: string }[]
}

/** 导入类通道的返回值:做了什么 + 动作之后的最新清单 */
export interface UserStyleImportResult {
  state: UserStyleState
  outcome: UserStyleImportOutcome
}
