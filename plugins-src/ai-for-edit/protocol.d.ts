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

/** 附件里的一张扫描页图片；正文数据由 `attach.image` 单独上传，不进这条消息 */
export interface AttachmentImageMeta {
  /** PDF 页码，从 1 开始 */
  page: number
}

/**
 * 用户添加的本地参考文件。
 *
 * 只包含文件名与文本内容 —— 插件不需要绝对路径，也不把路径发给模型。
 * render 层已经按上限截断，main 层仍会再校验一次。
 *
 * 扫描件 PDF 还能带一组页面图片：图片本身通过 `attach.image` 分条上传（宿主
 * 对单条 render → main 消息有 256 KiB 上限），这里只留页码元数据，供提示词
 * 说明「哪些页以图片形式附在消息里」。
 */
export interface AttachmentItem {
  name: string
  text: string
  images?: AttachmentImageMeta[]
  /** 指向已经通过 `attach.image` 上传的图片；没有图片时为空 */
  imageUpload?: AttachmentImageUploadRef
}

/** render → main：一组扫描页图片的上传引用 */
export interface AttachmentImageUploadRef {
  id: string
  /** 这组图片的张数；main 层会等齐再开始请求 */
  count: number
}

/**
 * render → main：一条扫描页图片。
 *
 * 每张图片单独一条消息，base64 数据控制在 200,000 字符以内，避免触发宿主
 * 256 KiB 的消息上限。`id` 由 render 层生成，main 层按 `index` 归组。
 */
export interface AttachmentImageMessage {
  id: string
  index: number
  total: number
  name: string
  page: number
  mediaType: string
  /** 不带 `data:` 前缀的 base64 */
  data: string
  width: number
  height: number
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
  /** 与当前文档关联的参考文件 */
  attachments?: AttachmentItem[]
}

/** render → main：请求美化一段文档 */
export interface AiBeautifyMessage {
  id: string
  text: string
  /** 用户在对话输入框里提的美化要求；空 = 由 AI 自行整理 */
  instruction?: string
  /** 与当前文档关联的参考文件 */
  attachments?: AttachmentItem[]
}

/** render → main：请求生成内容 */
export interface AiGenerateMessage {
  id: string
  prompt: string
  /** 与当前文档关联的参考文件 */
  attachments?: AttachmentItem[]
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
