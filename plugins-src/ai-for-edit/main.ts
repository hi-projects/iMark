/**
 * AI for Edit —— 主进程侧。
 *
 * 它负责配置、密钥、网络与提示词；文档正文由 render 层读取，**预览与确认也在
 * render 层**：AI 结果不会自动写回，只有用户在预览面板里点确认才会改文档。
 *
 * 两层之间是单向消息，这里用关联 id 实现请求/应答：
 *   preview.open（main → render）   打开预览面板
 *   ai.beautify / ai.generate（render → main）  请求 AI
 *   ai.reply（main → render）      返回结果或失败原因
 *   ai.cancel（render → main）     面板关闭时取消在途请求
 *
 * 选 node main 而不是 restricted：restricted 的 net.fetch 有 30 秒硬超时，且默认
 * 禁止访问本机地址（本地 Ollama 会被挡）。
 */

import { randomUUID } from 'node:crypto'
import type { ImkApi, PluginContext, PluginRuntime } from '@shared/pluginApi'
import type { PluginActionPayload, PluginActionResult } from '@shared/plugins'
import {
  AiError,
  callAi,
  readAiConfig,
  requestChat,
  type AiResult,
  type ChatMessage
} from './aiClient'
import {
  joinDocument,
  normalizeAiOutput,
  normalizeChatText,
  splitFrontMatter,
  systemPromptForBeautify,
  systemPromptForChat,
  systemPromptForGenerate,
  userPromptForBeautify,
  userPromptForGenerate
} from './prompts'
import type { AiReplyMessage, ChatHistoryItem, DocReply, PreviewOpenMessage } from './protocol'

/** 发给 AI 的正文上限；渲染层也用这个值拒绝过大的文档 */
const MAX_INPUT_CHARS = 120_000
/** AI 返回内容的字符上限，同时满足宿主 256 KiB 的消息上限 */
const MAX_OUTPUT_CHARS = 180_000
/** 行首菜单对话框里那句话 / 对话输入的长度上限 */
const MAX_PROMPT_CHARS = 4_000
const MAX_CHAT_CHARS = 4_000
/** 对话历史只带最近若干轮；每条也截断，避免把整段美化结果塞回上下文 */
const MAX_HISTORY_ITEMS = 12
const MAX_HISTORY_TEXT = 2_000
/** 与宿主 render.send / handleRenderMessage 的上限对齐，并留出 JSON 转义余量 */
const MAX_MESSAGE_CHARS = 240 * 1024
/** 一次文档读取的等待上限；超时说明编辑器没有响应 */
const DOC_TIMEOUT_MS = 10_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface AiTextResult {
  text: string
  model: string
  /** 只有对话回答会带：达到输出上限时仍展示，但标注可能不完整 */
  truncated?: boolean
}

class AiForEditPlugin implements PluginRuntime {
  private readonly pending = new Map<string, Pending>()
  private readonly aborts = new Set<AbortController>()
  /** 预览面板发起的 AI 请求：request id → 可取消的 controller */
  private readonly aiJobs = new Map<string, AbortController>()
  private busy = false
  private offRender: (() => void) | null = null

  constructor(private readonly imk: ImkApi) {}

  onEnable(): void {
    // 宿主停用/重载时会清空监听，所以每次 onEnable 都重新登记
    this.offRender?.()
    this.offRender =
      this.imk.render?.onMessage((channel, data) => {
        this.onRenderMessage(channel, data)
      }) ?? null
  }

  onDisable(): void {
    this.offRender?.()
    this.offRender = null
    this.cancelInFlight()
  }

  onConfigChange(): void {
    // 配置刚变（多半是地址/密钥）：不要再把文档发往旧地址
    this.cancelInFlight()
  }

  async runAction(
    actionId: string,
    _ctx: PluginContext,
    _targetId?: string,
    payload?: PluginActionPayload
  ): Promise<PluginActionResult> {
    if (this.busy) {
      return { ok: false, message: 'AI 正在处理上一个请求，请稍候' }
    }
    this.busy = true
    try {
      if (actionId === 'generate-content') return await this.generate(payload)
      if (actionId === 'test-connection') return await this.testConnection()
      return { ok: false, message: `未知动作：${actionId}` }
    } catch (err) {
      return this.failure(err)
    } finally {
      this.busy = false
    }
  }

  // ---------- 动作 ----------

  private async generate(payload?: PluginActionPayload): Promise<PluginActionResult> {
    const prompt = typeof payload?.values?.prompt === 'string' ? payload.values.prompt.trim() : ''
    if (!prompt) return { ok: false, message: '请填写想生成的内容' }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return {
        ok: false,
        message: `生成要求太长（${prompt.length} 字符），最多 ${MAX_PROMPT_CHARS} 字符`
      }
    }

    this.imk.setState({ status: 'running', lastMessage: '正在读取当前文档…' })
    let text: string | null = null
    try {
      text = await this.requestDocument()
    } catch (err) {
      // 文档超过消息上限时只能确定它非空；非空文档走宿主插入，不需要正文
      if (err instanceof AiError && err.code === 'too-large') text = null
      else throw err
    }

    const empty = text !== null && text.trim() === ''

    if (empty) {
      // 空文档：打开对话，由用户在结果消息里确认后整篇写入
      const opened = await this.openPreview({ mode: 'generate', prompt, auto: true })
      if (!opened) return { ok: false, message: '无法打开对话：编辑器界面未就绪' }
      return { ok: true, message: '已打开生成对话，确认后才会写入文档' }
    }

    // 非空文档：沿用「+」菜单的插入行为，不经过整篇替换
    const controller = this.newAbort()
    try {
      const result = await this.runGenerate(prompt, controller)
      return {
        ok: true,
        message: `已生成 ${result.text.length} 个字符`,
        editor: { text: result.text, cursorOffset: result.text.length }
      }
    } finally {
      this.aborts.delete(controller)
    }
  }

  private async testConnection(): Promise<PluginActionResult> {
    const cfg = await readAiConfig(this.imk, 20_000)
    this.imk.setState({ status: 'running', lastMessage: '正在测试连接…' })

    const started = Date.now()
    const controller = this.newAbort()
    try {
      const result = await callAi(
        cfg,
        '你是连通性测试助手。',
        '请只回复 OK。',
        controller.signal
      )
      this.logCall(result)
      const elapsed = Date.now() - started
      const message = `连接成功 · ${result.provider} · ${result.model} · ${elapsed}ms`
      this.imk.setState({ status: 'ok', lastRunAt: Date.now(), lastMessage: message })
      return { ok: true, message }
    } finally {
      this.aborts.delete(controller)
    }
  }

  /** 打开 render 层的预览面板；失败时给用户一条通知，而不是静默什么都不发生 */
  private async openPreview(payload: PreviewOpenMessage): Promise<boolean> {
    const render = this.imk.render
    if (!render) return false
    try {
      await render.send('preview.open', payload)
      return true
    } catch (err) {
      this.imk.log('warn', `打开预览失败：${errorText(err)}`)
      this.imk.ui.notify('AI 预览暂时不可用，请稍后重试', 'warn')
      return false
    }
  }

  // ---------- AI 调用（动作与预览共用） ----------

  private async runBeautify(
    text: string,
    instruction: string,
    controller: AbortController
  ): Promise<AiTextResult> {
    const cfg = await readAiConfig(this.imk)
    const parts = splitFrontMatter(text)
    const body = parts.body

    if (body.trim() === '') {
      throw new AiError(
        parts.frontMatter ? '文档只有元信息，没有可美化的正文' : '当前文档是空的'
      )
    }
    if (body.length > MAX_INPUT_CHARS) {
      throw new AiError(`文档太长（${body.length} 字符），目前最多支持 ${MAX_INPUT_CHARS} 字符`)
    }

    this.imk.setState({
      status: 'running',
      lastMessage: `正在请求 AI 美化（${cfg.model || '默认模型'}）…`
    })

    const result = await callAi(
      cfg,
      systemPromptForBeautify(instruction),
      userPromptForBeautify(body),
      controller.signal
    )
    this.logCall(result)

    if (result.truncated) {
      throw new AiError(
        'AI 输出被截断，为避免丢失内容，已放弃本次结果',
        '可以换用输出上限更高的模型，或先把长文档拆成几段再分别美化。'
      )
    }

    const beautified = normalizeAiOutput(result.text, body.endsWith('\n'))
    if (!beautified.trim()) throw new AiError('AI 返回了空内容')
    if (beautified.length > MAX_OUTPUT_CHARS) {
      throw new AiError(`AI 返回的内容太长（${beautified.length} 字符），超过插件上限`)
    }

    return { text: joinDocument(parts, beautified), model: result.model }
  }

  private async runGenerate(prompt: string, controller: AbortController): Promise<AiTextResult> {
    const trimmed = prompt.trim()
    if (!trimmed) throw new AiError('请填写想生成的内容')
    if (trimmed.length > MAX_PROMPT_CHARS) {
      throw new AiError(`生成要求太长（${trimmed.length} 字符），最多 ${MAX_PROMPT_CHARS} 字符`)
    }

    const cfg = await readAiConfig(this.imk)
    this.imk.setState({
      status: 'running',
      lastMessage: `正在生成（${cfg.model || '默认模型'}）…`
    })

    const result = await callAi(
      cfg,
      systemPromptForGenerate(),
      userPromptForGenerate(trimmed),
      controller.signal
    )
    this.logCall(result)

    if (result.truncated) {
      throw new AiError('AI 输出被截断，为避免写入不完整的内容，已放弃本次结果')
    }

    const text = normalizeAiOutput(result.text, false)
    if (!text.trim()) throw new AiError('AI 没有生成内容')
    if (text.length > MAX_OUTPUT_CHARS) {
      throw new AiError(`生成的内容太长（${text.length} 字符），超过插件上限`)
    }
    return { text, model: result.model }
  }

  /** 多轮对话：文档作为 system 上下文，历史只带最近几轮 */
  private async runChat(
    documentText: string,
    message: string,
    history: ChatMessage[],
    controller: AbortController
  ): Promise<AiTextResult> {
    const question = message.trim()
    if (!question) throw new AiError('请输入问题')
    if (question.length > MAX_CHAT_CHARS) {
      throw new AiError(`问题太长（${question.length} 字符），最多 ${MAX_CHAT_CHARS} 字符`)
    }

    const cfg = await readAiConfig(this.imk)
    this.imk.setState({
      status: 'running',
      lastMessage: `正在回答（${cfg.model || '默认模型'}）…`
    })

    const doc =
      documentText.length > MAX_INPUT_CHARS
        ? `${documentText.slice(0, MAX_INPUT_CHARS)}\n\n…（文档过长，已截断）`
        : documentText
    const result = await requestChat(
      cfg,
      systemPromptForChat(doc),
      [...history, { role: 'user', content: question }],
      controller.signal
    )
    this.logCall(result)

    const answer = normalizeChatText(result.text)
    if (!answer.trim()) throw new AiError('AI 没有返回内容')
    if (answer.length > MAX_OUTPUT_CHARS) {
      throw new AiError(`AI 回答太长（${answer.length} 字符），超过插件上限`)
    }
    // 对话回答被截断时仍然展示，由界面标注「可能不完整」；
    // 美化/生成的结果则相反：宁可失败，也不写半篇文档。
    return { text: answer, model: result.model, truncated: result.truncated }
  }

  // ---------- 对话面板的请求/应答 ----------

  /**
   * render 层发来的消息入口。
   *
   * **这里不能 await AI 调用**：宿主给 render.onMessage 的 safeCall 只有 10 秒，
   * 而一次美化可能跑 90 秒。所以处理器只负责启动后台任务并立刻返回，结果稍后
   * 通过 `ai.reply` 送回面板。
   */
  private onRenderMessage(channel: string, data: unknown): void {
    const payload = (data ?? {}) as Record<string, unknown>
    const id = typeof payload.id === 'string' ? payload.id : ''

    if (channel === 'ai.beautify') {
      if (!id) return
      const text = typeof payload.text === 'string' ? payload.text : ''
      const instruction = typeof payload.instruction === 'string' ? payload.instruction : ''
      if (!text) {
        void this.replyAi(id, { ok: false, message: '没有收到文档内容' })
        return
      }
      void this.handlePanelAi(
        id,
        controller => this.runBeautify(text, instruction, controller),
        '美化结果已生成，等待确认'
      )
      return
    }

    if (channel === 'ai.generate') {
      if (!id) return
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
      void this.handlePanelAi(id, controller => this.runGenerate(prompt, controller), '生成结果已生成，等待确认')
      return
    }

    if (channel === 'ai.chat') {
      this.startChat(payload)
      return
    }

    if (channel === 'ai.cancel') {
      if (id) this.cancelAi(id)
      return
    }

    if (channel !== 'doc.reply') return
    const pending = id ? this.pending.get(id) : undefined
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(payload)
  }

  private startChat(payload: Record<string, unknown>): void {
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!id) return
    const message = typeof payload.message === 'string' ? payload.message : ''
    const text = typeof payload.text === 'string' ? payload.text : ''

    const history: ChatMessage[] = []
    const raw = Array.isArray(payload.history) ? payload.history : []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const entry = item as ChatHistoryItem
      const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null
      const content = typeof entry.content === 'string' ? entry.content.trim() : ''
      if (!role || !content) continue
      history.push({ role, content: content.slice(0, MAX_HISTORY_TEXT) })
    }

    void this.handlePanelAi(
      id,
      controller => this.runChat(text, message, history.slice(-MAX_HISTORY_ITEMS), controller),
      '对话回复已生成'
    )
  }

  private async handlePanelAi(
    id: string,
    run: (controller: AbortController) => Promise<AiTextResult>,
    successMessage: string
  ): Promise<void> {
    if (this.busy) {
      await this.replyAi(id, { ok: false, message: 'AI 正在处理上一个请求，请稍候' })
      return
    }
    this.busy = true
    const controller = this.newAbort()
    this.aiJobs.set(id, controller)

    try {
      const result = await run(controller)
      if (!this.imk.isEnabled()) return
      this.imk.setState({ status: 'ok', lastRunAt: Date.now(), lastMessage: successMessage })
      await this.replyAi(id, {
        ok: true,
        text: result.text,
        model: result.model,
        ...(result.truncated ? { truncated: true } : {})
      })
    } catch (err) {
      if (controller.signal.aborted) {
        // 面板主动取消 / 插件停用：不把一次取消记成失败
        if (this.imk.isEnabled()) {
          this.imk.setState({
            status: 'idle',
            lastRunAt: Date.now(),
            lastMessage: 'AI 请求已取消'
          })
        }
        await this.replyAi(id, { ok: false, message: '请求已取消' })
        return
      }
      const failure = this.toFailure(err)
      if (this.imk.isEnabled()) {
        // 面板仍开着，错误会显示在里面；状态卡保持可用（不要因为一次网络错误
        // 让状态栏按钮被宿主的「出错去设置」规则接管）
        this.imk.setState({
          status: 'idle',
          lastRunAt: Date.now(),
          lastMessage: `上次失败：${failure.message}`
        })
      }
      await this.replyAi(id, { ok: false, ...failure })
    } finally {
      this.aiJobs.delete(id)
      this.aborts.delete(controller)
      this.busy = false
    }
  }

  private async replyAi(id: string, payload: Omit<AiReplyMessage, 'id'>): Promise<void> {
    const render = this.imk.render
    if (!render) return
    const data = { id, ...payload }
    if (jsonLength(data) > MAX_MESSAGE_CHARS) {
      try {
        await render.send('ai.reply', {
          id,
          ok: false,
          message: '结果太大，无法在预览窗口中显示'
        })
      } catch {
        /* 面板已经关闭 */
      }
      return
    }
    try {
      await render.send('ai.reply', data)
    } catch {
      /* 面板已经关闭 / 插件已停用 */
    }
  }

  private cancelAi(id: string): void {
    const controller = this.aiJobs.get(id)
    if (!controller) return
    controller.abort()
    this.aiJobs.delete(id)
  }

  // ---------- 文档快照（仅生成前判断是否为空） ----------

  private async requestDocument(): Promise<string> {
    const id = randomUUID()
    const reply = await this.request<DocReply>('doc.request', {
      id,
      maxChars: MAX_INPUT_CHARS
    })
    if (!reply.ok || typeof reply.text !== 'string') {
      throw new AiError(reply.message || '读取当前文档失败', undefined, reply.code)
    }
    return reply.text
  }

  private request<T>(channel: string, payload: { id: string } & Record<string, unknown>): Promise<T> {
    const render = this.imk.render
    if (!render) {
      return Promise.reject(new AiError('插件没有 render 层，无法操作当前文档'))
    }
    const id = payload.id
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AiError('编辑器没有响应，请重试'))
      }, DOC_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer
      })
      void render.send(channel, payload).catch(err => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(new AiError('无法与编辑器通信', errorText(err)))
      })
    })
  }

  // ---------- 内部 ----------

  private logCall(result: AiResult): void {
    this.imk.log(
      'debug',
      `AI 请求完成：${result.provider} · ${result.endpointDisplay} · ${result.elapsedMs}ms`
    )
  }

  private toFailure(err: unknown): { message: string; detail?: string } {
    if (err instanceof AiError) {
      return {
        message: err.message,
        ...(err.detail ? { detail: err.detail } : {})
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { message: message || 'AI 操作失败' }
  }

  private failure(err: unknown): PluginActionResult {
    const failure = this.toFailure(err)
    this.imk.log(
      'warn',
      `AI 操作失败：${failure.message}${failure.detail ? `（${failure.detail}）` : ''}`
    )
    return { ok: false, ...failure }
  }

  private newAbort(): AbortController {
    const controller = new AbortController()
    this.aborts.add(controller)
    return controller
  }

  private cancelInFlight(): void {
    for (const controller of this.aborts) controller.abort()
    this.aborts.clear()
    this.aiJobs.clear()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new AiError('请求已取消'))
      this.pending.delete(id)
    }
  }
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// 返回类型显式写成 PluginRuntime：生命周期签名写错时在插件自己的 typecheck 里就会报错
export = (imk: ImkApi): PluginRuntime => new AiForEditPlugin(imk)
