/**
 * main 层 ↔ render 层的消息形状。
 *
 * 这里只有类型：编译后不会留下任何运行时代码，也不会被打进插件包。
 * 刻意不写成共享的 .ts 模块 —— 打包器会把 node 与 render 的产物合进同一个
 * 插件目录，同名的运行时代码文件会互相覆盖。
 */

/** main → render：要一份当前文档的正文（生成动作用来判断文档是否为空） */
export interface DocRequestMessage {
  id: string
  /** 文档字符数上限；超过就回 too-large，不发送正文 */
  maxChars: number
}

/** render → main：文档正文 */
export interface DocReply {
  id: string
  ok: boolean
  text?: string
  code?: 'no-document' | 'too-large' | string
  message?: string
}

/** main → render：打开对话面板（可顺带触发一次快捷动作） */
export interface PreviewOpenMessage {
  mode: 'chat' | 'generate'
  /** generate 模式下预填的生成要求（行首「+」菜单带过来的） */
  prompt?: string
  /** 有 prompt 时是否直接开始生成 */
  auto?: boolean
}

/** 对话历史里的一条（只允许用户与助手） */
export interface ChatHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

/** render → main：普通对话提问 */
export interface AiChatMessage {
  id: string
  /** 用户这次的问题 */
  message: string
  /** 当前文档正文（作为回答的上下文） */
  text: string
  /** 之前几轮对话（不含这次的问题） */
  history: ChatHistoryItem[]
}

/** render → main：请求美化一段文档 */
export interface AiBeautifyMessage {
  id: string
  text: string
  /** 用户在对话输入框里提的美化要求；空 = 由 AI 自行整理 */
  instruction?: string
}

/** render → main：请求生成内容 */
export interface AiGenerateMessage {
  id: string
  prompt: string
}

/** render → main：面板被关闭，取消这次请求 */
export interface AiCancelMessage {
  id: string
}

/** main → render：AI 结果（或失败原因） */
export interface AiReplyMessage {
  id: string
  ok: boolean
  /** 美化时是**整篇**新文档（含原 front matter）；生成时是生成的正文本体 */
  text?: string
  message?: string
  detail?: string
  model?: string
  /** 对话回答达到输出上限；内容仍可展示，但会标注「可能不完整」 */
  truncated?: boolean
}
