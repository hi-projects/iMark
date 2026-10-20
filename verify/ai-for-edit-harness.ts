/**
 * AI for Edit 端到端验收。
 *
 * 用本地 node:http 起一个 mock AI 服务，插件按真实配置发请求；交互走真实的
 * 状态栏 AI 按钮、编辑器浮动小人、对话窗口、快捷按钮与行首「+」菜单。
 *
 * 覆盖：
 *   1 内置包补装、默认关闭、node main + render 两层、旧默认配置迁移；
 *   2 状态栏按钮与浮动小人两个入口；
 *   3 对话模式：提问带上当前文档上下文，多轮历史能传下去；
 *   4 美化快捷按钮：对话里先说一句展示话，结果带逐行差异，确认后才写回；
 *   5 生成快捷按钮（空文档）：填要求 → 对话展示结果 → 写入 / 重新生成；
 *   6 命令面板与行首「+」也打开同一个对话；
 *   7 非空文档用「+」生成仍直接插入；
 *   8 确认时文档已被修改 → 拒绝写回；
 *   9 截断 / 401 / 超长输入 / 超时：对话消息里报错，文档不动；
 *  10 Anthropic 分支：/v1/messages + x-api-key + system/max_tokens；
 *  11 浮动小人的开关与形象切换。
 *
 * 跑法（仓库根目录）：
 *   node verify/run.mjs ai-for-edit
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { secretKey } from '../src/shared/plugins'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { getSettings, loadSettings, saveSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { getRecord, setRecord } from '../src/main/plugins/installed'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { getSecret, setSecret } from '../src/main/secrets'
import { isRenderLayerLoaded } from '../src/main/plugins/renderLayer'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

const PLUGIN_ID = 'ai-for-edit'
const PLUGIN_VERSION = '1.9.0'
const API_KEY = 'test-key-123'
const AI_BUTTON = '.status-plugin-slot button[title="AI 对话 / 生成 / 美化"]'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type MockMode = 'openai' | 'anthropic'

interface MockReply {
  status?: number
  content?: string
  finish?: string
  stop?: string
  delayMs?: number
  hang?: boolean
  /** 原样放进响应的 usage 字段，用来模拟各家的上下文缓存计数 */
  usage?: Record<string, unknown>
}

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

let mockMode: MockMode = 'openai'
let mockReply: MockReply = { content: 'OK' }
let captured: CapturedRequest[] = []

function resetMock(reply: MockReply, mode: MockMode = 'openai'): void {
  mockMode = mode
  mockReply = reply
  captured = []
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs ai-for-edit` 跑会自动带上)')
    app.exit(2)
    return
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (mockReply.hang) return

      const reply = { ...mockReply }
      const send = (): void => {
        const status = reply.status ?? 200
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        if (status !== 200) {
          res.end(JSON.stringify({ error: { message: reply.content ?? 'mock error' } }))
          return
        }
        if (mockMode === 'anthropic') {
          res.end(
            JSON.stringify({
              content: [{ type: 'text', text: reply.content ?? '' }],
              stop_reason: reply.stop ?? 'end_turn',
              ...(reply.usage ? { usage: reply.usage } : {})
            })
          )
          return
        }
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: reply.content ?? '' },
                finish_reason: reply.finish ?? 'stop'
              }
            ],
            ...(reply.usage ? { usage: reply.usage } : {})
          })
        )
      }
      if (reply.delayMs) setTimeout(send, reply.delayMs)
      else send()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    console.error('mock 服务没有拿到端口')
    app.exit(2)
    return
  }
  const openaiUrl = `http://127.0.0.1:${port}/v1/chat/completions`
  const anthropicUrl = `http://127.0.0.1:${port}/v1/messages`
  console.log(`[harness] mock AI: ${openaiUrl}`)

  await app.whenReady()

  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await writeFile(note, '', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: null,
        openFiles: [],
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const host = await initPluginHost(ensureBundledProvisioned)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const ok = await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)
      if (ok) return true
      await sleep(80)
    }
    return false
  }

  const waitForAiButton = (ms = 5000): Promise<boolean> =>
    waitFor(`document.querySelector(${JSON.stringify(AI_BUTTON)})`, ms)

  async function waitUntil(fn: () => boolean, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (fn()) return true
      await sleep(80)
    }
    return fn()
  }

  async function waitUntilAsync(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return true
      await sleep(80)
    }
    return fn()
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function typeFocused(text: string): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(20)
    }
    await sleep(300)
  }

  async function loadDocAt(path: string, content: string): Promise<boolean> {
    await writeFile(path, content, 'utf8')
    await saveSettings({ lastFile: path, openFiles: [path] })
    // 偶发竞态:reload 会落到 ERR_FILE_NOT_FOUND 的错误页(里面没有 .cm-content)。
    // 这不是应用的问题,重新加载一次即可 —— 否则后面一整段都会连锁失败。
    let loaded = false
    for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      wc.reload()
      await done
      loaded = await waitFor(`document.querySelector('.cm-content')`, attempt === 0 ? 5000 : 10_000)
    }
    await sleep(900)
    await waitUntil(() => !isRenderLayerLoaded(PLUGIN_ID), 2000)
    await waitUntil(() => isRenderLayerLoaded(PLUGIN_ID), 10_000)
    await sleep(300)
    await waitForAiButton(4000)
    await focusEditor()
    return loaded
  }

  const loadDoc = (content: string): Promise<boolean> => loadDocAt(note, content)

  async function saveAndRead(): Promise<string> {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(700)
    return readFile(note, 'utf8')
  }

  async function pluginView(): Promise<Awaited<ReturnType<typeof host.list>>[number] | undefined> {
    return (await host.list()).find(view => view.descriptor.id === PLUGIN_ID)
  }

  /** 插件日志全文（含 debug），用来断言缓存用量确实落到了日志里 */
  async function pluginLogs(): Promise<string> {
    const view = await pluginView()
    return (view?.logs ?? []).map(line => line.message).join('\n')
  }

  async function configureAndEnable(endpoint: string | string[], model: string): Promise<void> {
    const urls = Array.isArray(endpoint) ? endpoint : [endpoint]
    const endpoints = urls.map((url, i) => ({ id: `e${i + 1}`, url, model }))
    // 密钥是每个地址一份的：和设置页一样，逐行写入各自的槽位
    for (const row of endpoints) {
      await host.setSecretValue(PLUGIN_ID, 'endpoints', row.id, API_KEY)
    }
    await host.save(PLUGIN_ID, {
      enabled: true,
      config: { endpoints, timeoutSec: 5 }
    })
    const injected = await waitUntil(() => isRenderLayerLoaded(PLUGIN_ID), 10_000)
    check('启用后 render 层已注入', injected)
    check('状态栏注入了 AI 按钮', await waitForAiButton(5000))
  }

  async function reconfigure(
    endpoint: string | string[],
    model: string,
    timeoutSec = 5
  ): Promise<void> {
    const urls = Array.isArray(endpoint) ? endpoint : [endpoint]
    const endpoints = urls.map((url, i) => ({ id: `e${i + 1}`, url, model }))
    for (const row of endpoints) {
      await host.setSecretValue(PLUGIN_ID, 'endpoints', row.id, API_KEY)
    }
    await host.save(PLUGIN_ID, {
      config: { endpoints, timeoutSec }
    })
    await sleep(250)
  }

  // ---- 对话窗口 ----

  const chatOpen = (): Promise<boolean> => evalJs<boolean>(`!!document.querySelector('.ai-chat-panel')`)
  const chatText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.ai-chat-messages')?.innerText ?? ''`)

  async function openChatByStatus(): Promise<boolean> {
    const clicked = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(AI_BUTTON)})
      if (!el) return false
      el.click()
      return true
    })()`)
    return clicked && (await waitFor(`document.querySelector('.ai-chat-panel')`))
  }

  async function openChatByCharacter(): Promise<boolean> {
    const clicked = await evalJs<boolean>(`(() => {
      const el = document.querySelector('.ai-char')
      if (!el) return false
      el.click()
      return true
    })()`)
    return clicked && (await waitFor(`document.querySelector('.ai-chat-panel')`))
  }

  async function closeChat(): Promise<boolean> {
    await evalJs<boolean>(`(() => {
      const el = document.querySelector('.ai-chat-close')
      if (!el) return false
      el.click()
      return true
    })()`)
    return waitFor(`!document.querySelector('.ai-chat-panel')`, 4000)
  }

  async function clickChatButton(selector: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`)
  }

  async function clickLast(selector: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = list[list.length - 1]
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`)
  }

  const shortcutDisabled = (kind: 'generate' | 'beautify'): Promise<boolean> =>
    evalJs<boolean>(`!!document.querySelector('.ai-chat-mode-${kind}')?.disabled`)

  async function setChatInput(text: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const el = document.querySelector('.ai-chat-input')
      if (!el) return false
      el.value = ${JSON.stringify(text)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  }

  const contextText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.ai-chat-context')?.innerText ?? ''`)

  const modeActive = (mode: 'chat' | 'generate' | 'beautify'): Promise<boolean> =>
    evalJs<boolean>(
      `document.querySelector('.ai-chat-mode-${mode}')?.classList.contains('is-active') ?? false`
    )

  /** 对话用例：先显式切回「对话」，再点发送 */
  async function sendChat(): Promise<boolean> {
    if (!(await clickChatButton('.ai-chat-mode-chat'))) return false
    return clickChatButton('.ai-chat-send')
  }

  /** 生成 / 美化：先选模式，再点「发送」触发（输入框内容由调用方先填好） */
  async function clickAction(kind: 'generate' | 'beautify'): Promise<boolean> {
    if (!(await clickChatButton(`.ai-chat-mode-${kind}`))) return false
    return clickChatButton('.ai-chat-send')
  }

  async function waitChatIdle(ms = 15_000): Promise<boolean> {
    return waitFor(`!document.querySelector('.ai-chat-loading')`, ms)
  }

  /**
   * 等**最新**一条动作消息出结果。
   *
   * 会话历史会恢复旧的动作气泡（已替换的也带预览），所以不能问「页面上有没有
   * 预览」——那会被上一条历史结果立刻满足。只看消息列表的最后一行。
   */
  async function waitActionEnd(ms = 15_000): Promise<boolean> {
    return waitFor(
      `(() => {
         const rows = [...document.querySelectorAll('.ai-chat-messages > *')]
         const last = rows[rows.length - 1]
         return !!(last && last.querySelector(
           '.ai-chat-generated, .ai-chat-preview, .ai-chat-diff, .ai-chat-error'
         ))
       })()`,
      ms
    )
  }

  const previewText = (): Promise<string> =>
    evalJs<string>(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())?.innerText ?? ''`
    )

  async function waitPreviewText(text: string, ms = 10_000): Promise<boolean> {
    return waitFor(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())?.innerText.includes(${JSON.stringify(text)})`,
      ms
    )
  }

  const clickSourceTab = (): Promise<boolean> => clickLast('.ai-chat-tab-source')
  const clickPreviewTab = (): Promise<boolean> => clickLast('.ai-chat-tab-preview')

  const clickNewChat = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = [...document.querySelectorAll('.ai-chat-head-btn')]
        .find(button => (button.textContent || '').includes('新对话'))
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`)

  // ---- 会话历史与参考文件 ----

  const fileChipName = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.ai-chat-file-name')?.textContent ?? ''`)

  const historyOpen = (): Promise<boolean> =>
    evalJs<boolean>(`!document.querySelector('.ai-chat-history')?.hidden`)

  const historyCount = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.ai-chat-history-item').length`)

  const historyItems = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('.ai-chat-history-item')].map(el => el.innerText)`
    )

  async function openHistoryList(): Promise<boolean> {
    if (!(await historyOpen())) {
      if (!(await clickChatButton('.ai-chat-history-btn'))) return false
      await sleep(120)
    }
    return historyOpen()
  }

  async function closeHistoryList(): Promise<boolean> {
    if (!(await historyOpen())) return true
    if (!(await clickChatButton('.ai-chat-history-btn'))) return false
    await sleep(120)
    return !(await historyOpen())
  }

  async function clickHistoryItem(index = 0): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const items = [...document.querySelectorAll('.ai-chat-history-open')]
      const el = items[${index}]
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`)
  }

  const attachNames = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('.ai-chat-attach-name')].map(el => el.textContent ?? '')`
    )

  /**
   * 往当前文档添加一个本地参考文件。
   *
   * 「＋ 文件」会调起系统文件选择框；这里把 file input 的 click 拦成空操作，
   * 既走真实的按钮 → 隐藏 input 创建路径，又不会弹出原生对话框。随后用
   * DataTransfer 给 input 塞一个 File 并派发 change。
   */
  async function attachLocalFile(name: string, content: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const proto = HTMLInputElement.prototype
      const original = proto.click
      proto.click = function () { if (this.type === 'file') return; return original.call(this) }
      try {
        const button = document.querySelector('.ai-chat-add-file')
        if (!button) return false
        button.click()
      } finally {
        proto.click = original
      }
      const input = document.querySelector('.ai-chat-file-input')
      if (!input) return false
      const transfer = new DataTransfer()
      transfer.items.add(new File(
        [${JSON.stringify(content)}],
        ${JSON.stringify(name)},
        { type: 'text/markdown' }
      ))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  const chatStore = (): Promise<unknown> =>
    evalJs<unknown>(
      `(() => { try { return JSON.parse(localStorage.getItem('ai-for-edit:chat-store:v1') ?? 'null') } catch { return null } })()`
    )

  async function waitActionError(ms = 15_000): Promise<string> {
    const lastError = `(() => {
      const rows = [...document.querySelectorAll('.ai-chat-messages > *')]
      const last = rows[rows.length - 1]
      const error = last?.querySelector('.ai-chat-error')
      if (!error) return ''
      const detail = last.querySelector('.ai-chat-error-detail')
      return error.innerText + (detail ? '\\n' + detail.innerText : '')
    })()`
    const found = await waitFor(
      `(() => {
         const rows = [...document.querySelectorAll('.ai-chat-messages > *')]
         const last = rows[rows.length - 1]
         return !!(last && last.querySelector('.ai-chat-error'))
       })()`,
      ms
    )
    return found ? evalJs<string>(lastError) : ''
  }

  /**
   * 普通对话提问的错误气泡。
   *
   * 它与「美化/生成」的动作气泡不是同一种 DOM:动作气泡带 .ai-chat-action,
   * 提问的失败则画在普通的 assistant 气泡里。用 waitActionError 等它永远等不到。
   */
  async function waitChatError(ms = 15_000): Promise<string> {
    const found = await waitFor(
      `document.querySelector('.ai-chat-bubble-assistant:not(.ai-chat-action) .ai-chat-error')`,
      ms
    )
    if (!found) return ''
    return evalJs<string>(`(() => {
      const bubbles = [...document.querySelectorAll('.ai-chat-bubble-assistant:not(.ai-chat-action)')]
      const bubble = bubbles[bubbles.length - 1]
      const error = bubble?.querySelector('.ai-chat-error')
      if (!error) return ''
      const detail = bubble?.querySelector('.ai-chat-error-detail')
      return error.innerText + (detail ? '\\n' + detail.innerText : '')
    })()`)
  }

  const diffCount = (kind: 'add' | 'del'): Promise<number> =>
    evalJs<number>(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())
         ?.querySelectorAll('.ai-diff-segment.is-${kind}').length ?? 0`
    )

  const lastAssistantText = (): Promise<string> =>
    evalJs<string>(`(() => {
      const list = [...document.querySelectorAll('.ai-chat-bubble-assistant:not(.ai-chat-action)')]
      return list[list.length - 1]?.innerText ?? ''
    })()`)

  const characterEmoji = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.ai-char-emoji')?.textContent ?? ''`)

  async function openGenerateDialog(): Promise<boolean> {
    await focusEditor()
    const opened = await evalJs<boolean>(`(() => {
      const plus = document.querySelector('.line-plus')
      if (!plus) return false
      plus.click()
      return true
    })()`)
    if (!opened) return false
    await sleep(250)
    const picked = await evalJs<boolean>(`(() => {
      const item = [...document.querySelectorAll('.line-menu-item')]
        .find(el => (el.textContent || '').includes('AI 生成内容'))
      if (!item) return false
      item.click()
      return true
    })()`)
    if (!picked) return false
    await sleep(250)
    return evalJs<boolean>(`!!document.querySelector('.line-dialog')`)
  }

  async function fillPrompt(text: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const input = document.querySelector('.line-dialog input.plugin-input')
      if (!input) return false
      input.value = ${JSON.stringify(text)}
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  // ---------- 1. 补装与形态 ----------

  console.log('\n【1】内置包补装与形态')
  const provisioned = await pluginView()
  check('AI for Edit 已补装', provisioned !== undefined)
  check('默认关闭', provisioned?.state.enabled === false, JSON.stringify(provisioned?.state))
  check('没有加载错误', provisioned?.loadError === undefined, String(provisioned?.loadError))
  check('来源标成 bundled', provisioned?.source === 'bundled', String(provisioned?.source))
  check(
    '是 node main + render 两层',
    provisioned?.mainMode === 'node' && provisioned?.hasRender === true,
    `main=${provisioned?.mainMode} render=${provisioned?.hasRender}`
  )
  check(
    '权限是 secrets + network',
    JSON.stringify(provisioned?.permissions) === JSON.stringify(['secrets', 'network']),
    JSON.stringify(provisioned?.permissions)
  )
  const fieldKeys = (provisioned?.descriptor.fields ?? []).map(field => field.key)
  check(
    '配置里有浮动小人开关与形象',
    fieldKeys.includes('characterEnabled') && fieldKeys.includes('characterStyle'),
    JSON.stringify(fieldKeys)
  )
  const promptFields = (provisioned?.descriptor.fields ?? []).filter(
    field => field.key === 'generatePrompt' || field.key === 'beautifyPrompt'
  )
  check(
    '配置里有生成与美化两条提示词',
    promptFields.length === 2 && promptFields.every(field => field.kind === 'textarea'),
    JSON.stringify(promptFields.map(field => ({ key: field.key, kind: field.kind })))
  )
  check(
    '提示词默认值非空且保留了关键约束',
    promptFields.every(field => typeof field.default === 'string' && field.default.trim().length > 0) &&
      String(promptFields.find(field => field.key === 'beautifyPrompt')?.default ?? '').includes(
        '不要输出 YAML front matter'
      ),
    JSON.stringify(promptFields.map(field => String(field.default).slice(0, 40)))
  )
  check(
    '行首菜单声明了「AI 生成内容」',
    provisioned?.descriptor.lineMenu?.some(
      item => item.id === 'ai-generate' && item.action === 'generate-content'
    ) === true,
    JSON.stringify(provisioned?.descriptor.lineMenu)
  )

  // ---------- 1b. 旧配置迁移 ----------

  console.log('\n【1b】旧配置迁移:单地址 → 地址列表、全局模型/密钥 → 每个地址一份')
  const freshRecord = await getRecord(PLUGIN_ID)
  check('有安装登记', freshRecord !== null)
  if (freshRecord) {
    const legacySecretKey = secretKey(PLUGIN_ID, 'apiKey')
    const legacySlot = secretKey(PLUGIN_ID, 'endpoints', 'legacy')
    await setSecret(legacySecretKey, 'legacy-key')

    await setRecord({ ...freshRecord, version: '1.0.0' })
    const now = await getSettings()
    await saveSettings({
      plugins: {
        ...now.plugins,
        [PLUGIN_ID]: {
          enabled: false,
          config: {
            endpoint: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-4o-mini',
            apiKey: '',
            timeoutMs: 60000
          }
        }
      }
    })
    await ensureBundledProvisioned(host)

    const migrated = await pluginView()
    const migratedEndpoints = Array.isArray(migrated?.config.endpoints)
      ? (migrated.config.endpoints as { url?: string; model?: string }[])
      : []
    check(
      '旧默认服务地址迁移到 DeepSeek',
      migratedEndpoints[0]?.url === 'https://api.deepseek.com/chat/completions',
      JSON.stringify(migrated?.config.endpoints)
    )
    check(
      '旧默认模型迁移进地址卡片',
      migratedEndpoints[0]?.model === 'deepseek-flash',
      JSON.stringify(migrated?.config.endpoints)
    )
    check(
      '全局 model / apiKey 字段已删除',
      migrated?.config.model === undefined && migrated?.config.apiKey === undefined,
      JSON.stringify(migrated?.config)
    )
    check(
      '全局密钥已复制到地址槽位',
      (await getSecret(legacySlot)) === 'legacy-key',
      String(await getSecret(legacySlot))
    )
    check(
      '旧全局密钥已删除',
      (await getSecret(legacySecretKey)) === null,
      String(await getSecret(legacySecretKey))
    )
    check(
      '旧超时 60000ms 迁移成 60 秒',
      migrated?.config.timeoutSec === 60,
      String(migrated?.config.timeoutSec)
    )
    check(
      '插件版本已升级',
      (await getRecord(PLUGIN_ID))?.version === PLUGIN_VERSION,
      String((await getRecord(PLUGIN_ID))?.version)
    )

    const upgraded = await getRecord(PLUGIN_ID)
    if (upgraded) {
      await setRecord({ ...upgraded, version: '1.0.0' })
      // 第二轮：用户改过的地址/模型，以及另一把密钥
      await setSecret(legacySlot, null)
      await setSecret(legacySecretKey, 'custom-key')
      const current = await getSettings()
      await saveSettings({
        plugins: {
          ...current.plugins,
          [PLUGIN_ID]: {
            enabled: false,
            config: {
              endpoint: 'https://example.com/custom',
              model: 'custom-model',
              apiKey: '',
              timeoutMs: 30000
            }
          }
        }
      })
      await ensureBundledProvisioned(host)
      const kept = await pluginView()
      const keptEndpoints = Array.isArray(kept?.config.endpoints)
        ? (kept.config.endpoints as { url?: string; model?: string }[])
        : []
      check(
        '用户改过的地址与模型原样保留',
        keptEndpoints[0]?.url === 'https://example.com/custom' &&
          keptEndpoints[0]?.model === 'custom-model' &&
          kept?.config.model === undefined,
        JSON.stringify({
          endpoints: kept?.config.endpoints,
          model: kept?.config.model
        })
      )
      check(
        '第二轮密钥也复制进地址槽位',
        (await getSecret(legacySlot)) === 'custom-key',
        String(await getSecret(legacySlot))
      )
      check(
        '旧超时 30000ms 迁移成 30 秒',
        kept?.config.timeoutSec === 30,
        String(kept?.config.timeoutSec)
      )
    }
  }

  // ---------- 2. 配置与启用 ----------

  console.log('\n【2】配置密钥并启用')
  await configureAndEnable(openaiUrl, 'mock-model')
  const actionIds = (provisioned?.descriptor.actions ?? []).map(action => action.id)
  check('设置页不再有「美化当前文档」按钮', !actionIds.includes('beautify'), JSON.stringify(actionIds))
  check(
    '设置页只剩「测试连接」',
    JSON.stringify(actionIds) === JSON.stringify(['test-connection']),
    JSON.stringify(actionIds)
  )
  const aiContrib = (await host.contributions()).find(item => item.pluginId === PLUGIN_ID)
  check(
    '没有「AI 美化当前文档」命令',
    !(aiContrib?.commands ?? []).some(cmd => cmd.id === 'beautify-command'),
    JSON.stringify(aiContrib?.commands)
  )
  check('浮动小人默认出现', await waitFor(`document.querySelector('.ai-char')`))
  check('默认形象是猫咪', (await characterEmoji()) === '🐱', await characterEmoji())

  // ---------- 3. 两个入口 ----------

  console.log('\n【3】两个打开入口:浮动小人与状态栏按钮')
  check('点浮动小人打开对话', await openChatByCharacter())
  check('对话里有欢迎语', (await chatText()).includes('AI for Edit'), await chatText())
  check(
    '有「新对话」按钮',
    await evalJs<boolean>(`!!document.querySelector('.ai-chat-head')?.innerText.includes('新对话')`)
  )
  check('没有文档时两个快捷按钮都不可用', (await shortcutDisabled('generate')) && (await shortcutDisabled('beautify')))
  check('关闭对话', await closeChat())
  check('点状态栏按钮打开对话', await openChatByStatus())
  await closeChat()

  // ---------- 4. 测试连接 ----------

  console.log('\n【4】测试连接')
  resetMock({ content: 'OK' })
  const tested = await host.runAction(PLUGIN_ID, 'test-connection')
  check('测试连接成功', tested.ok, JSON.stringify(tested))
  check('发出了恰好一次请求', captured.length === 1, `${captured.length} 次`)
  check(
    'Authorization 头带了密钥',
    captured[0]?.headers.authorization === `Bearer ${API_KEY}`,
    String(captured[0]?.headers.authorization)
  )
  check('请求体里是配置的模型', captured[0]?.body.includes('"model":"mock-model"'), captured[0]?.body.slice(0, 120))

  // ---------- 4b. 多地址回退 ----------

  console.log('\n【4b】多地址:第一个不可用,自动尝试第二个')
  const deadUrl = 'http://127.0.0.1:1/v1/chat/completions'
  const deadUrl2 = 'http://127.0.0.1:2/v1/chat/completions'
  const FALLBACK_DOC = '# 回退\n\n正文\n'
  check('载入回退测试文档', await loadDoc(FALLBACK_DOC))
  await reconfigure([deadUrl, openaiUrl], 'mock-model')
  resetMock({ content: '回退成功' })
  check('打开对话', await openChatByStatus())
  check('填写问题', await setChatInput('测试回退'))
  check('发送问题', await sendChat())
  check('等到了回答', await waitChatIdle())
  check(
    '回答来自第二个地址',
    (await lastAssistantText()).includes('回退成功'),
    await lastAssistantText()
  )
  check('只有可用地址收到了请求', captured.length === 1, `${captured.length} 次`)
  await closeChat()

  // 顶部「测试连接」逐个测所有地址:一坏一好 = 部分失败
  resetMock({ content: 'OK' })
  const mixed = await host.runAction(PLUGIN_ID, 'test-connection')
  const mixedView = await pluginView()
  check('测试全部地址时报告部分失败', mixed.ok === false, JSON.stringify(mixed))
  check(
    '失败与成功分别列在两行',
    (mixedView?.state.lastMessage ?? '').includes('第 1 个地址：连接失败') &&
      (mixedView?.state.lastMessage ?? '').includes('第 2 个地址：连接成功'),
    String(mixedView?.state.lastMessage)
  )
  check(
    '每一行自己的结果分别记录',
    mixedView?.state.targetResults?.e1 === 'error' && mixedView?.state.targetResults?.e2 === 'ok',
    JSON.stringify(mixedView?.state.targetResults)
  )
  check('只有可用地址收到了测试请求', captured.length === 1, `${captured.length} 次`)

  const oneTarget = await host.runAction(PLUGIN_ID, 'test-target', 'e2')
  check('地址卡片上的「测试连接」只测这一行', oneTarget.ok === true, JSON.stringify(oneTarget))

  // 两个地址都不可用:报「所有地址都不可用」,而不是只报最后一个
  await reconfigure([deadUrl, deadUrl2], 'mock-model')
  resetMock({ content: '不应到达' })
  check('重新打开对话', await openChatByStatus())
  check('填写问题', await setChatInput('再试一次'))
  check('发送问题', await sendChat())
  const allDeadError = await waitChatError(15_000)
  check(
    '报所有地址都不可用',
    allDeadError.includes('所有 AI 服务地址都不可用'),
    allDeadError
  )
  check('没有请求到达 mock 服务', captured.length === 0, `${captured.length} 次`)
  await closeChat()

  await reconfigure(openaiUrl, 'mock-model')

  // ---------- 5. 对话模式 ----------

  console.log('\n【5】对话模式:结合文档回答 + 多轮历史')
  const CHAT_DOC = '# 项目计划\n\n本周完成登录模块。\n'
  check('载入对话测试文档', await loadDoc(CHAT_DOC))
  resetMock({ content: '这份文档讲的是项目计划：本周完成登录模块。' })
  check('打开对话', await openChatByStatus())
  check('填写问题', await setChatInput('这份文档讲了什么？'))
  check('发送问题', await sendChat())
  check('等到了回答', await waitChatIdle())
  check(
    '回答显示在对话里',
    (await lastAssistantText()).includes('项目计划'),
    await lastAssistantText()
  )
  check(
    '提问请求带上了当前文档内容',
    captured[0]?.body.includes('本周完成登录模块'),
    captured[0]?.body.slice(0, 200)
  )
  check(
    '提问请求带上了用户的问题',
    captured[0]?.body.includes('这份文档讲了什么'),
    captured[0]?.body.slice(-200)
  )

  // DeepSeek 式自动缓存：命中数由服务端在 usage 里返回，插件只负责读出来记进日志
  mockReply = {
    content: '补充一句：登录模块本周收尾。',
    usage: { prompt_cache_hit_tokens: 777, prompt_cache_miss_tokens: 123 }
  }
  check('再问一句', await setChatInput('还有呢？'))
  check('发送第二问', await sendChat())
  // 等回答渲染出来，后面读插件日志时不会抢在 logCall 之前
  check(
    '等到了第二段回答',
    await waitFor(
      `document.querySelector('.ai-chat-messages')?.innerText.includes('登录模块本周收尾')`,
      15_000
    )
  )
  check(
    '第二问的历史里带上了第一轮问答',
    captured[1]?.body.includes('这份文档讲了什么') &&
      captured[1]?.body.includes('这份文档讲的是项目计划'),
    captured[1]?.body.slice(-400)
  )
  check(
    'OpenAI 兼容请求不发 cache_control（靠服务端按前缀自动缓存）',
    !!captured[1]?.body && !captured[1].body.includes('cache_control'),
    captured[1]?.body.slice(0, 200)
  )
  const deepseekLogs = await pluginLogs()
  check(
    'DeepSeek 的缓存命中也写进插件日志',
    deepseekLogs.includes('缓存命中 777 tokens'),
    deepseekLogs.split('\n').filter(line => line.includes('AI 请求完成')).slice(-2).join(' / ')
  )
  check(
    '没有缓存写入时不编造写入数',
    !deepseekLogs.includes('缓存写入'),
    deepseekLogs.split('\n').filter(line => line.includes('AI 请求完成')).slice(-2).join(' / ')
  )
  // ---------- 5b. 文件关联、历史会话恢复、新对话 ----------

  console.log('\n【5b】文件关联、历史会话恢复与新对话')
  check('标题栏显示关联文件', (await fileChipName()) === '笔记.md', await fileChipName())
  check('打开会话列表', await openHistoryList())
  check(
    '会话列表标出所属文档',
    (await evalJs<string>(`document.querySelector('.ai-chat-history-scope')?.textContent ?? ''`)) ===
      '笔记.md',
    await evalJs<string>(`document.querySelector('.ai-chat-history-scope')?.textContent ?? ''`)
  )
  check('当前会话已登记', (await historyCount()) >= 1, `count=${await historyCount()}`)
  check(
    '会话标题取第一条提问',
    (await historyItems()).some(text => text.includes('测试回退')),
    JSON.stringify(await historyItems())
  )
  check('再点「会话」收起列表', await closeHistoryList())

  // 新对话：消息清空，但文档关联保持不变
  check('点「新对话」', await clickNewChat())
  check(
    '新对话清空聊天记录',
    await waitFor(
      `document.querySelector('.ai-chat-welcome') && document.querySelectorAll('.ai-chat-bubble-user').length === 0`
    )
  )
  check('新对话保持关联文档', (await fileChipName()) === '笔记.md', await fileChipName())

  // 恢复刚才的会话
  check('打开会话列表', await openHistoryList())
  check('历史里能找回刚才的会话', (await historyCount()) >= 1, `count=${await historyCount()}`)
  check('点会话恢复', await clickHistoryItem(0))
  check(
    '恢复后聊天记录回来了',
    (await chatText()).includes('这份文档讲了什么') && (await chatText()).includes('项目计划'),
    await chatText()
  )
  check('恢复后列表自动收起', !(await historyOpen()))

  // 浮层开着时 Escape 只收浮层，不关面板
  check('重新打开会话列表', await openHistoryList())
  check(
    'Escape 先收会话列表',
    await evalJs<boolean>(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`) && (await waitFor(`document.querySelector('.ai-chat-history')?.hidden === true`))
  )
  check('面板仍然开着', await chatOpen())
  check(
    '会话写进了本地存储',
    JSON.stringify(await chatStore()).includes('这份文档讲了什么')
  )

  // ---------- 5c. 本地参考文件 ----------

  console.log('\n【5c】本地参考文件:显示文件名并随请求发送')
  check('添加本地文件', await attachLocalFile('参考.md', '本地参考资料：项目代号朱雀。'))
  check(
    '文件条显示文件名',
    await waitFor(`document.querySelector('.ai-chat-attach-name')?.textContent === '参考.md'`)
  )
  check(
    '文件条显示数量',
    (await evalJs<string>(`document.querySelector('.ai-chat-attach-title')?.textContent ?? ''`)) ===
      '参考文件 1',
    await evalJs<string>(`document.querySelector('.ai-chat-attach-title')?.textContent ?? ''`)
  )
  resetMock({ content: '项目代号是朱雀。' })
  check('填写引用参考文件的问题', await setChatInput('参考文件里的项目代号是什么？'))
  check('发送问题', await sendChat())
  check('等到了回答', await waitChatIdle())
  const attachmentRequest = captured[captured.length - 1]
  check(
    '请求里带上了参考文件名',
    attachmentRequest?.body.includes('参考.md') === true,
    attachmentRequest?.body.slice(-300)
  )
  check(
    '请求里带上了参考文件内容',
    attachmentRequest?.body.includes('项目代号朱雀') === true,
    attachmentRequest?.body.slice(-300)
  )
  check('新对话保留参考文件', (await clickNewChat()) && (await attachNames()).includes('参考.md'))
  // 关面板会立刻落盘，避免 reload 抢在 500ms 的防抖写之前
  await closeChat()

  // 重新载入同一文档：文件关联、参考文件与历史会话都还在
  check('重新载入同一文档', await loadDoc(CHAT_DOC))
  check('重新打开对话', await openChatByStatus())
  check('重载后文件关联还在', (await fileChipName()) === '笔记.md', await fileChipName())
  check(
    '重载后参考文件还在',
    (await attachNames()).includes('参考.md'),
    JSON.stringify(await attachNames())
  )
  check('打开会话列表', await openHistoryList())
  check('重载后历史会话还在', (await historyCount()) >= 1, `count=${await historyCount()}`)
  check('收起会话列表', await closeHistoryList())
  await closeChat()

  // 换了文档：会话与参考文件互不串用
  const noteB = join(vault, '另一篇.md')
  check('载入另一篇文档', await loadDocAt(noteB, '# 另一篇\n\n内容\n'))
  check('打开对话', await openChatByStatus())
  check('另一篇有自己的文件关联', (await fileChipName()) === '另一篇.md', await fileChipName())
  check(
    '另一篇没有参考文件',
    (await attachNames()).length === 0,
    JSON.stringify(await attachNames())
  )
  check('打开会话列表', await openHistoryList())
  check('另一篇没有历史会话', (await historyCount()) === 0, `count=${await historyCount()}`)
  check(
    '列表里提示还没有历史',
    (
      await evalJs<string>(`document.querySelector('.ai-chat-history-empty')?.innerText ?? ''`)
    ).includes('还没有历史会话')
  )
  await closeHistoryList()
  await closeChat()

  check('切回笔记', await loadDoc(CHAT_DOC))
  check('打开对话', await openChatByStatus())
  check(
    '笔记的参考文件还在',
    (await attachNames()).includes('参考.md'),
    JSON.stringify(await attachNames())
  )
  check('打开会话列表', await openHistoryList())
  check('笔记的历史会话还在', (await historyCount()) >= 1, `count=${await historyCount()}`)
  check('收起会话列表', await closeHistoryList())

  // ---------- 5d. 输入区模式与上下文条 ----------

  console.log('\n【5d】输入区:模式在输入框上方，上方展示文档与附件')
  check(
    '模式行位于输入框上方',
    await evalJs<boolean>(`(() => {
      const modes = document.querySelector('.ai-chat-modes')
      const input = document.querySelector('.ai-chat-input')
      if (!modes || !input) return false
      return modes.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 1
    })()`)
  )
  check(
    '模式依次是「对话」「生成」「美化」',
    (await evalJs<string>(
      `[...document.querySelectorAll('.ai-chat-mode')].map(el => el.textContent).join('/')`
    )) === '对话/生成/美化'
  )
  check('默认选中「对话」', await modeActive('chat'))
  check('非空文档时「生成」不可选', await shortcutDisabled('generate'))
  check('非空文档时「美化」可选', !(await shortcutDisabled('beautify')))
  check(
    '上下文条展示当前文档与篇幅',
    (await contextText()).includes('笔记.md') && (await contextText()).includes('18 字符'),
    await contextText()
  )
  check(
    '上下文条展示附件与「＋ 文件」',
    await evalJs<boolean>(`(() => {
      const bar = document.querySelector('.ai-chat-context')
      return (
        !!bar?.querySelector('.ai-chat-attach-name') &&
        !!bar?.querySelector('.ai-chat-add-file')
      )
    })()`),
    await contextText()
  )
  check(
    '旧的顶部动作行已移除',
    !(await evalJs<boolean>(`!!document.querySelector('.ai-chat-actions')`))
  )
  check(
    '对话模式空输入时发送不可用',
    await evalJs<boolean>(`document.querySelector('.ai-chat-send')?.disabled === true`)
  )
  check(
    '填写内容后发送可用',
    (await setChatInput('测试一下')) &&
      !(await evalJs<boolean>(`document.querySelector('.ai-chat-send')?.disabled === true`))
  )
  check('清空输入', await setChatInput(''))
  check('选「美化」', await clickChatButton('.ai-chat-mode-beautify'))
  check(
    '美化模式下可以留空发送',
    !(await evalJs<boolean>(`document.querySelector('.ai-chat-send')?.disabled === true`))
  )
  const beforeEnter = captured.length
  await evalJs(`document.querySelector('.ai-chat-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  )`)
  await sleep(300)
  check(
    '美化空输入按 Enter 不会误触整篇请求',
    captured.length === beforeEnter && !(await evalJs<boolean>(`!!document.querySelector('.ai-chat-loading')`)),
    `requests=${captured.length - beforeEnter}`
  )
  check('切回「对话」', await clickChatButton('.ai-chat-mode-chat'))

  // 空文档：上下文条说明为空，且生成 / 美化的可用性反过来
  check('载入空文档', await loadDoc(''))
  check('重新打开对话', await openChatByStatus())
  check(
    '空文档时上下文条写明为空',
    (await contextText()).includes('当前文档为空'),
    await contextText()
  )
  check('空文档时「生成」可选', !(await shortcutDisabled('generate')))
  check('空文档时「美化」不可选', await shortcutDisabled('beautify'))
  await closeChat()

  // ---------- 6. 美化快捷按钮 ----------

  console.log('\n【6】美化快捷按钮:展示差异 → 确认替换')
  const START =
    '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 标题\n正文第一段。\n\n\n- 项目一\n- 项目二\n'
  const EXPECTED =
    '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 标题\n\n正文第一段（已润色）。\n\n- 项目一\n- 项目二\n'
  check('载入带 front matter 的文档', await loadDoc(START))
  resetMock({
    content: '````markdown\n# 标题\n\n正文第一段（已润色）。\n\n- 项目一\n- 项目二\n````'
  })
  check('打开对话', await openChatByStatus())
  check('美化快捷按钮可用', !(await shortcutDisabled('beautify')))
  check('非空文档时生成快捷按钮不可用', await shortcutDisabled('generate'))
  check('填写美化要求', await setChatInput('把标题层级整理清楚，语气更正式'))
  check('选择「美化」并发送', await clickAction('beautify'))
  check(
    '对话里出现带要求的展示消息',
    (await chatText()).includes('帮我美化一下这份文档：把标题层级整理清楚，语气更正式'),
    await chatText()
  )
  check(
    '点完美化后输入框清空',
    await evalJs<boolean>(`document.querySelector('.ai-chat-input')?.value === ''`)
  )
  check('等到了美化结果', await waitActionEnd())
  check('美化结果有预览窗口', await waitPreviewText('标题'))
  check(
    '预览渲染成 HTML 标题',
    await evalJs<boolean>(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())?.querySelector('h1')?.textContent === '标题'`
    ),
    await previewText()
  )
  check(
    '预览里删除内容用红色区分',
    (await diffCount('del')) > 0,
    `del=${await diffCount('del')}`
  )
  check(
    '预览里新增/修改内容用绿色区分',
    (await diffCount('add')) > 0,
    `add=${await diffCount('add')}`
  )
  check(
    '不再单独显示「逐行差异」块',
    !(await evalJs<boolean>(`!!document.querySelector('.ai-chat-details')`))
  )
  check('点「源码」页签', await clickSourceTab())
  check(
    '源码里保留 front matter',
    (
      await evalJs<string>(
        `([...document.querySelectorAll('.ai-chat-generated')].pop())?.innerText ?? ''`
      )
    ).includes('title: 测试')
  )
  check('切回预览', await clickPreviewTab())
  check('发出了 AI 请求', captured.length === 1, `${captured.length} 次`)
  check(
    '发给模型的内容不含 front matter',
    !captured[0]!.body.includes('title: 测试') && captured[0]!.body.includes('正文第一段。'),
    captured[0]?.body.slice(0, 200)
  )
  check(
    '美化要求进了模型请求',
    captured[0]?.body.includes('把标题层级整理清楚，语气更正式'),
    captured[0]?.body.slice(0, 240)
  )
  check(
    '美化请求也带上了参考文件',
    captured[0]?.body.includes('参考.md') && captured[0]?.body.includes('项目代号朱雀'),
    captured[0]?.body.slice(-300)
  )
  check('确认前文档没有改动', (await saveAndRead()) === START)
  check('点「确认替换」', await clickLast('.ai-chat-confirm'))
  check('结果标记为已替换', await waitFor(`document.querySelector('.ai-chat-applied')`))
  check('确认后写回磁盘', (await saveAndRead()) === EXPECTED)
  await closeChat()

  // ---------- 7. 生成快捷按钮 ----------

  console.log('\n【7】生成快捷按钮(空文档):展示 → 重新生成 → 写入')
  check('载入空文档', await loadDoc(''))
  resetMock({ content: '# 生成标题\n\n这是生成的内容。\n' })
  check('打开对话', await openChatByStatus())
  check('空文档时美化按钮不可用', await shortcutDisabled('beautify'))
  check('空文档时生成按钮可用', !(await shortcutDisabled('generate')))
  check('填写生成要求', await setChatInput('写一份产品周报大纲'))
  check('选择「生成」并发送', await clickAction('generate'))
  check('对话里先出现展示消息', (await chatText()).includes('帮我生成：写一份产品周报大纲'), await chatText())
  check('等到了生成结果', await waitActionEnd())
  check('生成结果有预览窗口', await waitPreviewText('生成标题'))
  check(
    '预览渲染成 HTML 标题',
    await evalJs<boolean>(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())?.querySelector('h1')?.textContent === '生成标题'`
    ),
    await previewText()
  )
  check('生成请求里带了要求', captured[0]?.body.includes('写一份产品周报大纲'), captured[0]?.body.slice(0, 200))
  check('确认前空文档仍是空的', (await saveAndRead()) === '')

  mockReply = { content: '# 第二版\n\n重新生成的内容。\n' }
  check('点「重新生成」', await clickLast('.ai-chat-retry'))
  check('等到了第二次生成', await waitActionEnd())
  check('结果换成了第二次内容', await waitPreviewText('第二版'))
  check('点「源码」页签', await clickSourceTab())
  check(
    '源码里是生成的 Markdown',
    (
      await evalJs<string>(
        `([...document.querySelectorAll('.ai-chat-generated')].pop())?.innerText ?? ''`
      )
    ).includes('# 第二版')
  )
  check('切回预览', await clickPreviewTab())
  check('重新生成请求也带上了要求', captured[1]?.body.includes('写一份产品周报大纲'), captured[1]?.body.slice(0, 160))
  check(
    '生成请求也带上了参考文件',
    captured[0]?.body.includes('项目代号朱雀') && captured[1]?.body.includes('项目代号朱雀'),
    captured[1]?.body.slice(-240)
  )
  check('点「写入文档」', await clickLast('.ai-chat-confirm'))
  check('结果标记为已写入', await waitFor(`document.querySelector('.ai-chat-applied')`))
  const generated = await saveAndRead()
  check(
    '空文档被整篇写入,第一行就是生成内容(没有前导空行)',
    generated === '# 第二版\n\n重新生成的内容。\n',
    JSON.stringify(generated)
  )
  check(
    '移除参考文件',
    await evalJs<boolean>(`(() => {
      const button = document.querySelector('.ai-chat-attach-remove')
      if (!button) return false
      button.click()
      return true
    })()`)
  )
  check('文件条里不再显示它', await waitFor(`!document.querySelector('.ai-chat-attach-name')`))
  await closeChat()

  // ---------- 8. 预览里的 \[...\] 公式 ----------

  console.log('\n【8】AI 用 \\[...\\] 写公式:预览渲染成 KaTeX,不出现列表圆点')
  check('载入空文档', await loadDoc(''))
  resetMock({
    content: [
      '# 扩散模型',
      '',
      '\\[',
      'q_\\sigma(x_{t-1}\\mid x_t, x_0)',
      '= \\mathcal{N}\\!\\left(',
      '\\sqrt{\\bar\\alpha_{t-1}}\\,x_0',
      '+ \\sqrt{1-\\bar\\alpha_{t-1}-\\sigma_t^2}\\cdot',
      '\\frac{x_t-\\sqrt{\\bar\\alpha_t}\\,x_0}{\\sqrt{1-\\bar\\alpha_t}},\\ ',
      '\\sigma_t^2 I',
      '\\right)',
      '\\]',
      '',
      '行内 \\(E = mc^2\\) 也支持。'
    ].join('\n')
  })
  check('打开对话', await openChatByStatus())
  check('填写生成要求', await setChatInput('写一段带公式的笔记'))
  check('选择「生成」并发送', await clickAction('generate'))
  check('等到了生成结果', await waitActionEnd())
  check(
    '预览里出现块级公式',
    await waitFor(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())?.querySelector('.katex-block .katex')`
    )
  )
  const mathPreview = await evalJs<{ blocks: number; katex: number; lists: number; items: number }>(`
    (() => {
      const preview = [...document.querySelectorAll('.ai-chat-preview')].pop()
      return {
        blocks: preview ? preview.querySelectorAll('.katex-block').length : 0,
        katex: preview ? preview.querySelectorAll('.katex').length : 0,
        lists: preview ? preview.querySelectorAll('ul, ol').length : 0,
        items: preview ? preview.querySelectorAll('li').length : 0
      }
    })()`)
  check(
    '多行 \\[...\\] 渲染成一个块级公式',
    mathPreview.blocks === 1,
    JSON.stringify(mathPreview)
  )
  check('行内 \\(...\\) 也渲染了', mathPreview.katex === 2, JSON.stringify(mathPreview))
  check(
    '公式体里以 + 开头的那行没有被读成列表',
    mathPreview.lists === 0 && mathPreview.items === 0,
    JSON.stringify(mathPreview)
  )
  check('点「源码」页签', await clickSourceTab())
  check(
    '源码保留模型输出的 \\[...\\] 写法',
    await evalJs<boolean>(
      `([...document.querySelectorAll('.ai-chat-generated')].pop())?.innerText.includes('\\\\[') ?? false`
    )
  )
  await closeChat()

  // ---------- 9. 行首「+」空文档生成 ----------

  console.log('\n【9】行首「+」空文档生成:打开对话并直接触发生成')
  check('载入空文档', await loadDoc(''))
  resetMock({ content: '# 菜单生成\n\n内容\n' })
  check('打开「+」菜单并选「AI 生成内容」', await openGenerateDialog())
  check('填写生成要求', await fillPrompt('写一段简介'))
  check(
    '点行首对话框的「生成」',
    await evalJs<boolean>(`(() => { const b = document.querySelector('.line-dialog-primary'); if (!b) return false; b.click(); return true })()`)
  )
  check('对话自动打开', await waitFor(`document.querySelector('.ai-chat-panel')`))
  check('对话里有展示消息', (await chatText()).includes('帮我生成：写一段简介'), await chatText())
  check('等到了生成结果', await waitActionEnd())
  check('「+」菜单结果有预览窗口', await waitPreviewText('菜单生成'))
  check('「+」菜单的要求带到了请求里', captured.some(item => item.body.includes('写一段简介')))
  check('确认前空文档仍是空的', (await saveAndRead()) === '')
  check('点「写入文档」', await clickLast('.ai-chat-confirm'))
  check('「+」菜单对话确认后写入文档', (await saveAndRead()) === '# 菜单生成\n\n内容\n')
  await closeChat()

  // ---------- 10. 非空文档「+」生成:仍直接插入 ----------

  console.log('\n【10】非空文档生成:只返回 editor.text,文档不动')
  const NON_EMPTY = '# 已有\n\n正文\n'
  check('载入非空文档', await loadDoc(NON_EMPTY))
  resetMock({ content: '## 新段落\n\n内容\n' })
  const inserted = await host.runAction(PLUGIN_ID, 'generate-content', undefined, {
    values: { prompt: '写一个新段落' },
    editor: { line: 1, lineText: '# 已有', filePath: note }
  })
  check('生成动作成功', inserted.ok, JSON.stringify(inserted))
  check(
    '返回给宿主的插入文本去掉了末尾空行',
    inserted.editor?.text === '## 新段落\n\n内容',
    JSON.stringify(inserted.editor)
  )
  check('文档本身没有被改动', (await saveAndRead()) === NON_EMPTY)

  // ---------- 11. 预览期间文档被修改 ----------

  console.log('\n【11】确认时文档已被修改:拒绝写回')
  check('载入竞态测试文档', await loadDoc('# 原文\n\n正文\n'))
  resetMock({ content: '# AI 改过\n\n内容\n', delayMs: 1500 })
  check('打开对话', await openChatByStatus())
  check('选择「美化」并发送', await clickAction('beautify'))
  const requestSeen = await waitUntilAsync(async () => captured.length > 0, 4000)
  check('AI 请求已经在途', requestSeen)
  await typeFocused('X')
  await sleep(120)
  const typedDoc = await saveAndRead()
  check('用户在请求期间改了文档', typedDoc.includes('X'), JSON.stringify(typedDoc))
  check('等到了差异结果', await waitActionEnd())
  check('点确认', await clickLast('.ai-chat-confirm'))
  const staleError = await waitActionError(4000)
  check('确认被拒绝', staleError.includes('文档在此期间被修改'), staleError)
  const raced = await saveAndRead()
  check('AI 结果没有覆盖用户刚敲的字', raced.includes('X') && !raced.includes('AI 改过'), JSON.stringify(raced))
  await closeChat()

  // ---------- 12. 截断 ----------

  console.log('\n【12】输出截断:对话里报错,文档不动')
  const TRUNC_INPUT = '# 原文\n\n正文\n'
  check('载入截断测试文档', await loadDoc(TRUNC_INPUT))
  resetMock({ content: '# 截断', finish: 'length' })
  check(
    '打开对话并选择「美化」发送',
    (await openChatByStatus()) && (await clickAction('beautify'))
  )
  const truncError = await waitActionError()
  check('对话里显示截断错误', truncError.includes('截断'), truncError)
  check('截断时文档一个字符都没动', (await saveAndRead()) === TRUNC_INPUT)
  await closeChat()

  // ---------- 13. 401 ----------

  console.log('\n【13】401:错误可读,密钥不落日志')
  const AUTH_INPUT = '# 认证测试\n\n正文\n'
  check('载入 401 测试文档', await loadDoc(AUTH_INPUT))
  resetMock({ status: 401, content: 'invalid api key' })
  check(
    '打开对话并选择「美化」发送',
    (await openChatByStatus()) && (await clickAction('beautify'))
  )
  const authError = await waitActionError()
  check('对话里显示认证失败', /认证失败|密钥/.test(authError), authError)
  const serialized = JSON.stringify(await host.list())
  check('密钥没有出现在插件状态/日志里', !serialized.includes(API_KEY))
  const pageText = await evalJs<string>(`document.body.innerText`)
  check('密钥没有出现在界面里', !pageText.includes(API_KEY))
  check('401 时文档没有改动', (await saveAndRead()) === AUTH_INPUT)
  await closeChat()

  // ---------- 14. 超长输入 ----------

  console.log('\n【14】超长输入:对话直接报错,不发请求')
  const big = Array.from({ length: 121 }, (_, i) => `第${i}段 `.padEnd(1000, 'a')).join('\n')
  check('载入超长文档', await loadDoc(big))
  resetMock({ content: '# 不应被请求' })
  check(
    '打开对话并选择「美化」发送',
    (await openChatByStatus()) && (await clickAction('beautify'))
  )
  const tooBigError = await waitActionError(5000)
  check('对话里显示文档太长', /太长|上限/.test(tooBigError), tooBigError)
  check('没有向 AI 发请求', captured.length === 0, `${captured.length} 次`)
  await closeChat()

  // ---------- 15. 超时 ----------

  console.log('\n【15】请求超时:对话里报错,文档不动')
  const TIMEOUT_INPUT = '# 超时\n\n正文\n'
  check('载入超时测试文档', await loadDoc(TIMEOUT_INPUT))
  resetMock({ hang: true })
  check(
    '打开对话并选择「美化」发送',
    (await openChatByStatus()) && (await clickAction('beautify'))
  )
  const startedAt = Date.now()
  const timeoutError = await waitActionError(15_000)
  const elapsed = Date.now() - startedAt
  check('对话里显示没有响应', /没有响应|超时/.test(timeoutError), timeoutError)
  check('大约在 5 秒后放弃', elapsed >= 4500 && elapsed < 15_000, `${elapsed}ms`)
  check('超时时文档没有改动', (await saveAndRead()) === TIMEOUT_INPUT)
  await closeChat()

  // ---------- 16. Anthropic 分支 ----------

  console.log('\n【16】Anthropic: /v1/messages + x-api-key')
  await reconfigure(anthropicUrl, 'claude-mock')
  const ANTHROPIC_INPUT = '# 原文\n\n内容\n'
  check('载入 Anthropic 测试文档', await loadDoc(ANTHROPIC_INPUT))
  resetMock({ content: '# 新标题\n\n新内容\n', stop: 'end_turn' }, 'anthropic')
  check(
    '打开对话并选择「美化」发送',
    (await openChatByStatus()) && (await clickAction('beautify'))
  )
  check('等到了差异结果', await waitActionEnd())
  check('Anthropic 结果有预览窗口', await waitPreviewText('新标题'))
  const anthReq = captured[0]
  check('请求路径是 /v1/messages', anthReq?.url === '/v1/messages', String(anthReq?.url))
  check('使用 x-api-key 头', anthReq?.headers['x-api-key'] === API_KEY, String(anthReq?.headers['x-api-key']))
  check(
    '带 anthropic-version 头',
    anthReq?.headers['anthropic-version'] === '2023-06-01',
    String(anthReq?.headers['anthropic-version'])
  )
  let anthBody: Record<string, unknown> = {}
  try {
    anthBody = JSON.parse(anthReq?.body ?? '{}') as Record<string, unknown>
  } catch {
    anthBody = {}
  }
  check(
    '美化是一次性请求：system 仍是普通字符串，不加缓存断点',
    typeof anthBody.system === 'string' && anthBody.max_tokens === 8192,
    JSON.stringify(anthBody.system).slice(0, 120)
  )
  check(
    'body 的 messages 是 user 角色',
    Array.isArray(anthBody.messages) &&
      (anthBody.messages as { role?: string }[])[0]?.role === 'user'
  )
  check('点确认', await clickLast('.ai-chat-confirm'))
  check('Anthropic 的返回写回了文档', (await saveAndRead()) === '# 新标题\n\n新内容\n')

  // 对话的 system 是跨轮次稳定的文档上下文：Anthropic 要显式标缓存断点
  resetMock(
    {
      content: '这份文档刚刚被美化过。',
      usage: { cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 }
    },
    'anthropic'
  )
  check(
    'Anthropic 对话发送',
    (await setChatInput('这篇文档讲了什么？')) && (await sendChat())
  )
  // 等回答真的渲染出来：logCall 在返回结果之前执行，日志断言因此不会抢跑
  check(
    '等到了 Anthropic 对话回答',
    await waitFor(
      `document.querySelector('.ai-chat-messages')?.innerText.includes('美化过')`,
      10_000
    )
  )
  let anthChatBody: Record<string, unknown> = {}
  try {
    anthChatBody = JSON.parse(captured[0]?.body ?? '{}') as Record<string, unknown>
  } catch {
    anthChatBody = {}
  }
  const anthSystem = Array.isArray(anthChatBody.system)
    ? (anthChatBody.system as Record<string, unknown>[])
    : []
  const anthControl = anthSystem[0]?.cache_control as Record<string, unknown> | undefined
  check(
    '对话的 system 是带 cache_control: ephemeral 的文本块',
    anthSystem.length === 1 &&
      anthSystem[0]?.type === 'text' &&
      anthControl?.type === 'ephemeral',
    JSON.stringify(anthChatBody.system).slice(0, 200)
  )
  check(
    '缓存断点包住的是当前文档',
    typeof anthSystem[0]?.text === 'string' && (anthSystem[0].text as string).includes('新标题'),
    typeof anthSystem[0]?.text === 'string'
      ? (anthSystem[0].text as string).slice(0, 120)
      : ''
  )
  const anthropicLogs = await pluginLogs()
  check(
    'Anthropic 的缓存命中与写入都写进日志',
    anthropicLogs.includes('缓存命中 1200 tokens') &&
      anthropicLogs.includes('缓存写入 300 tokens'),
    anthropicLogs.split('\n').filter(line => line.includes('AI 请求完成')).slice(-1).join('')
  )
  await closeChat()

  // ---------- 17. 浮动小人开关与形象 ----------

  console.log('\n【17】浮动小人:开关、企鹅动画、拖动与位置恢复')
  await host.save(PLUGIN_ID, { config: { characterEnabled: false } })
  check('关闭后小人消失', await waitFor(`!document.querySelector('.ai-char')`, 4000))
  check('状态栏按钮仍然可用', await waitForAiButton(3000))
  await host.save(PLUGIN_ID, { config: { characterEnabled: true, characterStyle: 'penguin' } })
  check('重新打开后小人出现', await waitFor(`document.querySelector('.ai-char')`, 4000))
  check(
    '企鹅是矢量动画形象',
    await waitFor(`document.querySelector('.ai-char-emoji svg .ai-penguin-flipper')`)
  )
  check('企鹅带眨眼动画', await waitFor(`document.querySelector('.ai-char-emoji svg .ai-penguin-eye')`))
  check(
    '企鹅不套圆形气泡',
    await evalJs<boolean>(`!!document.querySelector('.ai-char.ai-char-plain')`)
  )

  // 悬停只保留自定义提示,文案跟随当前形象;不能再挂原生 title(否则一秒后冒出第二个框)
  const charTip = await evalJs<{ text: string; title: string | null }>(`(() => {
    const el = document.querySelector('.ai-char')
    return {
      text: el?.querySelector('.ai-char-label')?.textContent?.trim() ?? '',
      title: el?.getAttribute('title') ?? null
    }
  })()`)
  check('小人悬停提示跟随形象(和企鹅聊聊)', charTip.text === '和企鹅聊聊', JSON.stringify(charTip))
  check('小人没有第二个原生 title 提示', !charTip.title, JSON.stringify(charTip))
  await host.save(PLUGIN_ID, { config: { characterStyle: 'cat' } })
  check(
    '换形象后提示文字跟着变(和猫咪聊聊)',
    await waitFor(
      `document.querySelector('.ai-char-label')?.textContent.trim() === '和猫咪聊聊'`,
      4000
    )
  )
  await host.save(PLUGIN_ID, { config: { characterStyle: 'penguin' } })
  check(
    '切回企鹅',
    await waitFor(`document.querySelector('.ai-char-emoji svg .ai-penguin-flipper')`, 4000)
  )

  const drag = await evalJs<{ left: string; top: string; saved: string | null; open: boolean }>(`(() => {
    const el = document.querySelector('.ai-char')
    if (!el) return { left: '', top: '', saved: null, open: true }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const opts = { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: y }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x - 90, clientY: y - 70 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x - 90, clientY: y - 70 }))
    return {
      left: el.style.left,
      top: el.style.top,
      saved: localStorage.getItem('ai-for-edit:character-position'),
      open: !!document.querySelector('.ai-chat-panel')
    }
  })()`)
  check('拖动后写入了新位置', drag.left !== '' && drag.top !== '', JSON.stringify(drag))
  check('拖动后的位置已持久化', drag.saved !== null, String(drag.saved))
  check('拖动不会顺手打开对话', !drag.open)
  await sleep(500)
  check('拖动后仍可点击打开对话', await openChatByCharacter())
  check('对话头像也是企鹅', await waitFor(`document.querySelector('.ai-chat-avatar svg')`))
  await closeChat()

  await host.save(PLUGIN_ID, { config: { characterEnabled: false } })
  check('再次关闭后小人消失', await waitFor(`!document.querySelector('.ai-char')`, 4000))
  await host.save(PLUGIN_ID, { config: { characterEnabled: true, characterStyle: 'penguin' } })
  check('再次打开后小人出现', await waitFor(`document.querySelector('.ai-char')`, 4000))
  const restored = await evalJs<string>(`document.querySelector('.ai-char')?.style.left ?? ''`)
  check('拖动位置在重新打开后恢复', restored !== '', restored)

  // ---------- 18. 设置页 ----------

  console.log('\n【18】设置页:多地址卡片、「必填」占位符与问号说明')
  await reconfigure([openaiUrl, anthropicUrl], 'mock-model')
  await evalJs(`document.querySelector('button[title^="设置"]').click()`)
  check('设置面板打开', await waitFor(`document.querySelector('.settings-nav')`))
  const clickedAi = await evalJs<boolean>(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('AI for Edit'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('左栏能找到 AI for Edit', clickedAi)
  check(
    '地址列表出现两张卡片',
    await waitFor(`document.querySelectorAll('.plugin-endpoints .plugin-target').length === 2`)
  )

  // 密钥已保存时输入框是收起的;点第一张卡片的「更换」展开后再读 placeholder
  await evalJs(`(() => {
    const card = document.querySelector('.plugin-endpoints .plugin-target')
    const b = card ? [...card.querySelectorAll('button')].find(x => x.textContent.trim() === '更换') : null
    if (b) b.click()
  })()`)
  await sleep(150)

  const ui = await evalJs<{
    cardCount: number
    urls: string[]
    urlPlaceholders: string[]
    models: string[]
    modelPlaceholders: string[]
    rowLabels: string[][]
    helpTitle: string
    helpNativeTitle: string | null
    helpInsideFirstRow: boolean
    helpOnLabel: boolean
    inputsAligned: boolean
    maskTextAligned: boolean
    helpCount: number
    hasHeader: boolean
    hasAddressRow: boolean
    masks: string[]
    keyPlaceholder: string
    addLabel: string
    cardButtons: string[]
    cardTitles: (string | null)[]
    resultTexts: string[]
    timeoutLabel: string
    timeoutMin: string
    timeoutMax: string
  }>(`(() => {
    const cards = [...document.querySelectorAll('.plugin-endpoints .plugin-target')]
    const urlInputs = cards.map(c => c.querySelector('input.plugin-endpoint-url'))
    const modelInputs = cards.map(c => c.querySelector('input[aria-label="服务模型"]'))
    const help = cards[0]?.querySelector('.plugin-endpoint-help')
    const firstRow = cards[0]?.querySelector('.plugin-target-row')
    const rows = [...document.querySelectorAll('.plugin-field-row')]
    const row = label => rows.find(r => (r.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith(label))
    const timeoutInput = row('请求超时')?.querySelector('input[type="number"]')
    const keyInput = cards[0]?.querySelector('input.plugin-target-secret')
    const addBtn = [...document.querySelectorAll('.plugin-endpoints button')]
      .find(b => b.textContent.includes('添加地址'))
    return {
      cardCount: cards.length,
      urls: urlInputs.map(i => i?.value ?? ''),
      urlPlaceholders: urlInputs.map(i => i?.placeholder ?? ''),
      models: modelInputs.map(i => i?.value ?? ''),
      modelPlaceholders: modelInputs.map(i => i?.placeholder ?? ''),
      rowLabels: cards.map(c => [...c.querySelectorAll('.plugin-endpoint-cell > span:not(.plugin-endpoint-help)')].map(s => s.textContent.trim())),
      // 问号改用自定义浮层,说明文字挂在 aria-label 上(不再用原生 title)
      helpTitle: help ? (help.getAttribute('aria-label') ?? '') : '',
      // 空 title 用来截断卡片上的原生 title,否则它会在悬停约一秒后盖住浮层
      helpNativeTitle: help ? help.getAttribute('title') : null,
      helpInsideFirstRow: !!(help && firstRow && firstRow.contains(help)),
      helpOnLabel: !!(help && help.closest('.plugin-endpoint-label')),
      // 需求是「左右两端都对齐」:直接量输入框的盒子,不靠标签宽度间接推断
      inputsAligned: (() => {
        const a = cards[0]?.querySelector('input.plugin-endpoint-url')?.getBoundingClientRect()
        const b = cards[0]?.querySelector('input[aria-label="服务模型"]')?.getBoundingClientRect()
        return !!a && !!b && Math.abs(a.left - b.left) <= 1 && Math.abs(a.right - b.right) <= 1
      })(),
      // 掩码不是输入框,文字左边缘要手动补上和「边框 + 内边距」等宽的内缩,
      // 否则它会贴着输入框的左边框,和上下两行的文字错开
      maskTextAligned: (() => {
        const card = cards.find(c => c.querySelector('.plugin-secret-mask'))
        const mask = card?.querySelector('.plugin-secret-mask')
        const input = card?.querySelector('input.plugin-endpoint-url')
        if (!mask || !input) return false
        const m = mask.getBoundingClientRect()
        const i = input.getBoundingClientRect()
        const ms = getComputedStyle(mask)
        const is = getComputedStyle(input)
        const maskText =
          m.left + parseFloat(ms.paddingLeft) + parseFloat(ms.borderLeftWidth)
        const inputText = i.left + parseFloat(is.borderLeftWidth) + parseFloat(is.paddingLeft)
        return Math.abs(maskText - inputText) <= 1
      })(),
      helpCount: document.querySelectorAll('.plugin-endpoints .plugin-endpoint-help').length,
      hasHeader: !!document.querySelector('.plugin-endpoints-head'),
      hasAddressRow: rows.some(r => (r.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('服务地址')),
      masks: cards.map(c => c.querySelector('.plugin-secret-mask')?.textContent.trim() ?? ''),
      keyPlaceholder: keyInput?.placeholder ?? '',
      addLabel: addBtn ? addBtn.textContent.trim() : '',
      // 动作按钮只剩图标,名字在 aria-label / title 上
      cardButtons: cards[0]
        ? [...cards[0].querySelectorAll('.plugin-target-actions button')].map(
            b => (b.getAttribute('aria-label') ?? b.textContent).trim()
          )
        : [],
      // 连接结果要常驻显示,不能挂在整张卡片的原生 title 上
      cardTitles: cards.map(c => c.getAttribute('title')),
      resultTexts: cards.map(
        c => c.querySelector('.plugin-target-result')?.textContent?.trim() ?? ''
      ),
      timeoutLabel: row('请求超时')?.querySelector('.plugin-field-label')?.innerText.trim() ?? '',
      timeoutMin: timeoutInput?.min ?? '',
      timeoutMax: timeoutInput?.max ?? ''
    }
  })()`)
  check('两个地址各是一张卡片', ui.cardCount === 2, JSON.stringify(ui))
  check(
    '地址按配置顺序显示',
    JSON.stringify(ui.urls) === JSON.stringify([openaiUrl, anthropicUrl]),
    JSON.stringify(ui.urls)
  )
  check(
    '卡片里地址、模型、密钥逐行带说明',
    ui.rowLabels.every(labels =>
      JSON.stringify(labels) === JSON.stringify(['服务地址', '服务模型', 'API 密钥'])
    ),
    JSON.stringify(ui.rowLabels)
  )
  check(
    '服务地址占位符写明必填与示例',
    ui.urlPlaceholders.every(p => p.startsWith('必填') && p.includes('如')),
    JSON.stringify(ui.urlPlaceholders)
  )
  check(
    '模型按地址显示各自的配置',
    JSON.stringify(ui.models) === JSON.stringify(['mock-model', 'mock-model']),
    JSON.stringify(ui.models)
  )
  check(
    '模型占位符写明必填与示例',
    ui.modelPlaceholders.every(p => p.startsWith('必填') && p.includes('如')),
    JSON.stringify(ui.modelPlaceholders)
  )
  check(
    'API 密钥占位符写明必填与说明',
    ui.keyPlaceholder.startsWith('必填') && ui.keyPlaceholder.includes('可留空'),
    ui.keyPlaceholder
  )
  check(
    '密钥是每个地址各自保存的',
    ui.masks[0] === '' && ui.masks[1] !== '',
    JSON.stringify(ui.masks)
  )
  check(
    '问号说明写明 OpenAI 兼容与 Anthropic 兼容',
    ui.helpTitle.includes('OpenAI 兼容') && ui.helpTitle.includes('Anthropic 兼容'),
    ui.helpTitle
  )
  check(
    '问号在「服务地址」字样的右上角,且只有一处',
    ui.helpInsideFirstRow && ui.helpOnLabel && ui.helpCount === 1,
    JSON.stringify(ui)
  )
  check('服务地址与模型输入框左右两端都对齐', ui.inputsAligned, JSON.stringify(ui))
  check(
    '密钥掩码文字与上下两行的输入文字左对齐',
    ui.maskTextAligned,
    JSON.stringify(ui.masks)
  )
  check(
    '问号用空 title 截断卡片的原生提示(否则会盖住浮层)',
    ui.helpNativeTitle === '',
    JSON.stringify(ui.helpNativeTitle)
  )
  check('没有独立的「服务地址」标题行', !ui.hasHeader && !ui.hasAddressRow, JSON.stringify(ui))
  check(
    '每张卡片都有「测试连接」与「删除地址」',
    ui.cardButtons.some(t => t.includes('测试连接')) &&
      ui.cardButtons.some(t => t.includes('删除地址')),
    JSON.stringify(ui.cardButtons)
  )
  check(
    '卡片不再用原生 title 说明连接结果',
    ui.cardTitles.every(t => !t),
    JSON.stringify(ui.cardTitles)
  )
  check(
    '连接结果不再弹出任何文字提示',
    ui.resultTexts.every(t => !t),
    JSON.stringify(ui.resultTexts)
  )
  check('列表下方有「添加地址」', ui.addLabel.includes('添加地址'), ui.addLabel)
  check('超时字段的单位是秒', ui.timeoutLabel.includes('秒') && !ui.timeoutLabel.includes('毫秒'), ui.timeoutLabel)
  check('超时输入范围是 5–90 秒', ui.timeoutMin === '5' && ui.timeoutMax === '90', `${ui.timeoutMin}–${ui.timeoutMax}`)

  // 密钥缺失提示:本地/内网地址允许留空,公网地址必须填。
  // 既有两条地址都配了密钥,所以临时插一条没有密钥的地址来验证,用完再删掉。
  const endpointBase = ((await pluginView())?.config.endpoints ?? []) as {
    id: string
    url: string
    model: string
  }[]
  const withProbe = (url: string) => [
    ...endpointBase,
    { id: 'probe-nokey', url, model: 'probe-model' }
  ]
  const problemsText = () =>
    evalJs<string>(
      `(document.querySelector('.plugin-endpoints .plugin-target-problems')?.innerText ?? '').trim()`
    )

  await host.save(PLUGIN_ID, {
    config: { endpoints: withProbe('http://192.168.1.9:11434/v1/chat/completions') }
  })
  await waitFor(`document.querySelectorAll('.plugin-endpoints .plugin-target').length === 3`, 4000)
  const localHint = await problemsText()
  check('内网地址不填密钥不算未完成', !localHint.includes('API 密钥'), localHint)

  await host.save(PLUGIN_ID, {
    config: { endpoints: withProbe('https://api.deepseek.com/chat/completions') }
  })
  const remoteShown = await waitFor(
    `(document.querySelector('.plugin-endpoints .plugin-target-problems')?.innerText ?? '').includes('API 密钥')`,
    4000
  )
  const remoteHint = await problemsText()
  check(
    '公网地址未填密钥会列进未完成提示',
    remoteShown && remoteHint.includes('第 3 个地址'),
    remoteHint
  )

  await host.save(PLUGIN_ID, { config: { endpoints: endpointBase } })
  await waitFor(`document.querySelectorAll('.plugin-endpoints .plugin-target').length === 2`, 4000)
  const restoredHint = await problemsText()
  check('移除临时地址后提示消失', !restoredHint.includes('第 3 个地址'), restoredHint)

  // 截图留给人工看排版(不参与断言)
  await Promise.race([
    evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'),
    sleep(500)
  ])
  await sleep(120)
  const shots = join(__dirname, '..', '..', '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  await writeFile(join(shots, 'ai-for-edit-settings.png'), (await wc.capturePage()).toPNG())

  // 问号说明是自定义浮层,不是原生 title:字号必须明显小于正文,内容仍完整
  const tip = await evalJs<{ fontSize: string; text: string } | null>(`(async () => {
    const help = document.querySelector('.plugin-endpoints .plugin-endpoint-help')
    if (!help) return null
    help.dispatchEvent(new MouseEvent('mouseenter'))
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const el = document.querySelector('.plugin-help-tip')
    if (!el) return null
    return { fontSize: getComputedStyle(el).fontSize, text: el.textContent.trim() }
  })()`)
  check(
    '问号说明的浮层字号小于正文(<=12px)',
    !!tip && parseFloat(tip.fontSize) <= 12 && tip.text.includes('OpenAI 兼容'),
    JSON.stringify(tip)
  )
  // 等超过原生 title 的弹出延迟:如果没被空 title 截断,这时浮层会被盖住
  await sleep(1600)
  await writeFile(join(shots, 'ai-for-edit-help-tip.png'), (await wc.capturePage()).toPNG())
  await evalJs(
    `document.querySelector('.plugin-endpoints .plugin-endpoint-help')?.dispatchEvent(new MouseEvent('mouseleave'))`
  )

  // ---------- 19. 提示词：默认展示、整段替换与恢复 ----------

  console.log('\n【19】提示词:默认值展示、整段替换与恢复默认')
  const promptView = await pluginView()
  const generateField = promptView?.descriptor.fields.find(field => field.key === 'generatePrompt')
  const beautifyField = promptView?.descriptor.fields.find(field => field.key === 'beautifyPrompt')
  const defaultGenerate = String(generateField?.default ?? '')
  const defaultBeautify = String(beautifyField?.default ?? '')

  // 设置页在【18】结束时仍开着,直接读两个 textarea
  const promptUi = await evalJs<{
    count: number
    generateValue: string
    beautifyValue: string
    generateRows: string
    beautifyRows: string
    resetCount: number
    resetDisabled: boolean[]
    textActions: string[]
  }>(`(() => {
    const areas = [...document.querySelectorAll('textarea.plugin-textarea')]
    const byLabel = label => {
      const field = [...document.querySelectorAll('.plugin-field')]
        .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith(label))
      return field?.querySelector('textarea.plugin-textarea')
    }
    const gen = byLabel('生成提示词')
    const bea = byLabel('美化提示词')
    const resets = [...document.querySelectorAll('.plugin-field-actions .plugin-icon-btn')]
    return {
      count: areas.length,
      generateValue: gen?.value ?? '',
      beautifyValue: bea?.value ?? '',
      generateRows: gen?.getAttribute('rows') ?? '',
      beautifyRows: bea?.getAttribute('rows') ?? '',
      resetCount: resets.length,
      resetDisabled: resets.map(b => b.disabled),
      textActions: [...document.querySelectorAll('.plugin-field-actions button:not(.plugin-icon-btn)')]
        .map(b => b.textContent.trim())
    }
  })()`)
  check('设置页有两个多行提示词输入框', promptUi.count === 2, JSON.stringify(promptUi))
  check(
    '输入框预填内置默认提示词',
    promptUi.generateValue === defaultGenerate && promptUi.beautifyValue === defaultBeautify,
    JSON.stringify({
      generate: promptUi.generateValue.slice(0, 30),
      beautify: promptUi.beautifyValue.slice(0, 30)
    })
  )
  check(
    '行数按 manifest 渲染(8 / 14)',
    promptUi.generateRows === '8' && promptUi.beautifyRows === '14',
    `${promptUi.generateRows}/${promptUi.beautifyRows}`
  )
  check(
    '默认值状态显示恢复图标但不可点,也没有对照文字',
    promptUi.resetCount === 2 &&
      promptUi.resetDisabled.every(Boolean) &&
      promptUi.textActions.length === 0,
    JSON.stringify(promptUi)
  )

  // 先只触发 input(不触发 change):配置还没有保存,图标应当在 Vue 下一次渲染后就亮起,
  // 而不是等 IPC 回写。这是「编辑后恢复图标要隔一会儿才变」的回归测试。
  const wroteCustom = await evalJs<boolean>(`(() => {
    const field = [...document.querySelectorAll('.plugin-field')]
      .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('生成提示词'))
    const area = field?.querySelector('textarea.plugin-textarea')
    if (!area) return false
    area.value = 'CUSTOM-GENERATE-PROMPT'
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('修改生成提示词(仅 input,尚未保存)', wroteCustom)
  check(
    '未保存时恢复图标立即变为可点',
    await waitFor(`(() => {
      const field = [...document.querySelectorAll('.plugin-field')]
        .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('生成提示词'))
      const reset = field?.querySelector('.plugin-field-actions .plugin-icon-btn')
      return !!reset && !reset.disabled
    })()`, 600)
  )
  check(
    '此时配置里仍是默认值(图标不依赖 IPC 回写)',
    (await pluginView())?.config.generatePrompt === defaultGenerate,
    String((await pluginView())?.config.generatePrompt)
  )
  await evalJs(`(() => {
    const field = [...document.querySelectorAll('.plugin-field')]
      .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('生成提示词'))
    field?.querySelector('textarea.plugin-textarea')
      ?.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(400)
  check(
    '自定义提示词写进配置',
    (await pluginView())?.config.generatePrompt === 'CUSTOM-GENERATE-PROMPT',
    String((await pluginView())?.config.generatePrompt)
  )

  await evalJs(`(() => {
    const field = [...document.querySelectorAll('.plugin-field')]
      .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('生成提示词'))
    field?.querySelector('.plugin-field-actions .plugin-icon-btn')?.click()
  })()`)
  await sleep(400)
  check(
    '恢复默认写回配置',
    (await pluginView())?.config.generatePrompt === defaultGenerate,
    String((await pluginView())?.config.generatePrompt)
  )
  const restoredValue = await evalJs<string>(`(() => {
    const field = [...document.querySelectorAll('.plugin-field')]
      .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('生成提示词'))
    return field?.querySelector('textarea.plugin-textarea')?.value ?? ''
  })()`)
  check('恢复后输入框回到默认文本', restoredValue === defaultGenerate)

  // required 字段:清空失焦自动还原,不会把空提示词存进配置
  await evalJs(`(() => {
    const field = [...document.querySelectorAll('.plugin-field')]
      .find(el => (el.querySelector('.plugin-field-label')?.innerText ?? '').trim().startsWith('生成提示词'))
    const area = field?.querySelector('textarea.plugin-textarea')
    if (!area) return
    area.value = ''
    area.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(400)
  check(
    '清空后自动恢复默认值',
    (await pluginView())?.config.generatePrompt === defaultGenerate,
    String((await pluginView())?.config.generatePrompt)
  )

  // 关掉设置页,验证请求里真正带上了自定义提示词
  await evalJs(`document.querySelector('.settings-close')?.click()`)
  await waitFor(`!document.querySelector('.settings-mask')`)

  await host.save(PLUGIN_ID, {
    config: { generatePrompt: 'CUSTOM-GENERATE-PROMPT', beautifyPrompt: 'CUSTOM-BEAUTIFY-PROMPT' }
  })
  await sleep(250)

  check('载入空文档(自定义生成提示词)', await loadDoc(''))
  resetMock({ content: '# 自定义生成\n\n正文。\n' })
  check('打开对话', await openChatByStatus())
  check('填写生成要求', await setChatInput('自定义生成测试'))
  check('选择「生成」并发送', await clickAction('generate'))
  check('等到了生成结果', await waitActionEnd())
  const generateBody = captured[0] ? JSON.parse(captured[0].body) : null
  check(
    '生成请求的 system 是自定义提示词',
    generateBody?.messages?.[0]?.role === 'system' &&
      generateBody?.messages?.[0]?.content === 'CUSTOM-GENERATE-PROMPT',
    JSON.stringify(generateBody?.messages?.[0]).slice(0, 200)
  )
  await closeChat()

  check('载入有内容的文档(自定义美化提示词)', await loadDoc('正文第一段。\n'))
  resetMock({ content: '# 美化标题\n\n正文第一段。\n' })
  check('重新打开对话', await openChatByStatus())
  check('填写本轮美化要求', await setChatInput('更正式'))
  check('选择「美化」并发送', await clickAction('beautify'))
  check('等到了美化结果', await waitActionEnd())
  const beautifyBody = captured[0] ? JSON.parse(captured[0].body) : null
  const beautifySystem = String(beautifyBody?.messages?.[0]?.content ?? '')
  check(
    '美化请求以自定义提示词开头',
    beautifyBody?.messages?.[0]?.role === 'system' && beautifySystem.startsWith('CUSTOM-BEAUTIFY-PROMPT'),
    beautifySystem.slice(0, 200)
  )
  check(
    '本轮美化要求追加在自定义提示词之后',
    beautifySystem.includes('用户这次的美化要求：\n更正式'),
    beautifySystem.slice(-120)
  )
  await closeChat()

  // 空提示词:设置页挡住了,但手改 settings.json 仍可能为空,调用前必须拒绝
  await host.save(PLUGIN_ID, { config: { generatePrompt: '' } })
  await sleep(250)
  check('空提示词已写入配置', (await pluginView())?.config.generatePrompt === '')
  check('载入空文档(空提示词)', await loadDoc(''))
  resetMock({ content: '# 不应该出现\n' })
  check('打开对话(空提示词)', await openChatByStatus())
  check('填写生成要求(空提示词)', await setChatInput('空提示词测试'))
  check('选择「生成」并发送(空提示词)', await clickAction('generate'))
  const emptyError = await waitActionError()
  check('空提示词被拒绝并给出提示', emptyError.includes('生成提示词为空'), emptyError)
  check('空提示词没有发出请求', captured.length === 0, `${captured.length} 次`)
  await closeChat()

  // 还原两条提示词,避免影响以后的用例或重复运行
  await host.save(PLUGIN_ID, {
    config: { generatePrompt: defaultGenerate, beautifyPrompt: defaultBeautify }
  })
  await sleep(250)
  check(
    '提示词已还原默认',
    (await pluginView())?.config.generatePrompt === defaultGenerate &&
      (await pluginView())?.config.beautifyPrompt === defaultBeautify
  )

  // ---------- 收尾 ----------

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
