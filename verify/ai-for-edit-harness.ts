/**
 * AI for Edit 扩展端到端验收。
 *
 * 这条链路比 quick-edit 多两个边界：对话界面跑在跨源 sandbox iframe 里，AI 请求
 * 跑在扩展宿主进程里。所以这里既不看「render 层有没有注入」这种实现细节，也不
 * 直接调用插件内部函数，而是：
 *
 *   - 用真实的状态栏按钮 / 浮动小人 / 行首「+」菜单打开对话；
 *   - 在 chat webview 的文档里填问题、点发送、点确认（WebFrameMain.executeJavaScript）；
 *   - 用本地 node:http 起 mock OpenAI 兼容服务，断言真实发出去的请求；
 *   - 最后读磁盘上的 .md，确认只有用户点「确认」后才写回。
 *
 * 覆盖：
 *   1 内置包安装、清单贡献点、onStartupFinished 激活、默认小人
 *   2 状态栏入口打开 chat webview；欢迎语、文档关联、密钥不进页面
 *   3 对话：带当前文档上下文、多轮历史
 *   4 多地址轮换、测试连接（全局 / 单地址）、targetResults
 *   5 美化：差异预览 → 确认写回；请求带美化要求
 *   6 空文档生成：预览 → 确认整篇写入；自定义生成提示词
 *   7 非空文档行首「+」生成：直接插入到光标行下方，不打开对话
 *   8 空文档行首「+」生成：打开对话、自动预览、确认写入
 *   9 本地参考文件：文本、PDF 文字、扫描页图片进入请求
 *  10 取消：关闭面板中止在途请求，重开后可继续用
 *  11 超时：错误显示在对话里，文档不动
 *  12 浮动小人开关与形象切换（配置热更新）
 *  13 停用扩展：面板、状态栏、宿主一起释放
 *
 * 跑法（仓库根目录）：
 *   xvfb-run -a node verify/run.mjs ai-for-edit
 */

import { app, BrowserWindow, dialog, protocol, type WebFrameMain } from 'electron'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { EXTENSION_WEBVIEW_SCHEME } from '../src/shared/extensionProtocol'
import type { ExtensionView } from '../src/shared/extensions'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerExtensionWebviewProtocol } from '../src/main/extensions/webviewProtocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings, saveSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { installExtensionPackage } from '../src/main/extensions/installer'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import { setSecret } from '../src/main/secrets'

const REPO = join(__dirname, '..', '..')
const EXT_ID = 'imark.ai-for-edit'
import { APP_VERSION } from './appVersion'
const API_KEY = 'test-key-123'
const CMD_OPEN_CHAT = 'imark.ai-for-edit.openChat'
const CMD_TEST_CONNECTION = 'imark.ai-for-edit.testConnection'
const CMD_TEST_TARGET = 'imark.ai-for-edit.testTarget'
const AI_STATUS = '.status-plugin-group button.status-plug'

/** 一页的最小可用 PDF，正文是两行可提取的英文（base64） */
const PDF_FIXTURE =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxNDAgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKFBERiByZWZlcmVuY2U6IHByb2plY3QgY29kZSBWZXJtaWxpb24uKSBUaiBFVApCVCAvRjEgMTIgVGYgNzIgNjkwIFRkIChTZWNvbmQgbGluZSBhYm91dCBhdHRlbnRpb24gbWVjaGFuaXNtcy4pIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwNDM4IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNTA4CiUlRU9GCg=='
/** 一页没有文字层的 PDF（模拟扫描件，base64） */
const PDF_BLANK_FIXTURE =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDAgPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDIyNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjI3NAolJUVPRgo='

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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ---------- mock AI 服务 ----------

interface MockReply {
  status?: number
  content?: string
  finish?: string
  delayMs?: number
  hang?: boolean
  usage?: Record<string, unknown>
}

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

let mockReply: MockReply = { content: 'OK' }
let captured: CapturedRequest[] = []
let abortedRequests = 0

function resetMock(reply: MockReply): void {
  mockReply = reply
  captured = []
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs ai-for-edit` 跑会自动带上）')
    app.exit(2)
    return
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      captured.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      // 请求挂起时记录客户端是否主动断开（取消/关闭面板的验收点）
      res.on('close', () => {
        if (!res.writableEnded) abortedRequests += 1
      })
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
  const deadUrl = 'http://127.0.0.1:1/v1/chat/completions'
  console.log(`[harness] mock AI: ${openaiUrl}`)

  protocol.registerSchemesAsPrivileged([
    { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    {
      scheme: EXTENSION_WEBVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])

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
  const noteB = join(vault, '另一篇.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await rm(join(ud, 'extensions-data'), { recursive: true, force: true })

  const CHAT_DOC = '# 项目计划\n\n本周完成登录模块。\n'
  await writeFile(note, CHAT_DOC, 'utf8')
  await writeFile(noteB, '# 另一篇\n\n内容\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        openFiles: [note],
        marketUrl: '',
        autoSaveMode: 'off',
        extensions: {
          [EXT_ID]: {
            enabled: true,
            config: {
              [`${EXT_ID}.endpoints`]: [{ id: 'e1', url: openaiUrl, model: 'mock-model' }],
              [`${EXT_ID}.timeoutSec`]: 5
            }
          }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  // 装内置包：与市场安装走同一条校验/落盘路径
  const envelope = JSON.parse(
    await readFile(join(REPO, 'src/main/market/builtin/imark.ai-for-edit.imkpkg.json'), 'utf8')
  ) as unknown
  const installed = await installExtensionPackage(envelope, {
    source: 'bundled',
    appVersion: APP_VERSION
  })
  check('内置包通过校验并安装', installed.manifest.publisher === 'imark')

  registerIpc()
  registerImarkProtocol()
  registerExtensionWebviewProtocol()
  const settings = await loadSettings()
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  await service.setExtensionSecret(EXT_ID, 'endpoints:e1', API_KEY)
  await service.setExtensionSecret(EXT_ID, 'endpoints:e2', API_KEY)
  await service.setExtensionSecret(EXT_ID, 'endpoints:e3', API_KEY)

  // ---------- 通用等待 ----------

  const evalHost = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitHost(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalHost<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  async function waitUntilAsync(fn: () => Promise<boolean> | boolean, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await fn()) return true
      await sleep(80)
    }
    return fn()
  }

  const aiView = async (): Promise<ExtensionView> => {
    const view = await service.getExtensionView(EXT_ID)
    if (!view) throw new Error('扩展视图不存在')
    return view
  }

  async function waitView(
    predicate: (view: ExtensionView) => boolean,
    ms = 8000
  ): Promise<ExtensionView | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const view = await aiView()
      if (predicate(view)) return view
      await sleep(80)
    }
    return null
  }

  // ---------- webview iframe 访问 ----------
  //
  // chat/character 是跨源 sandbox iframe，主渲染进程的 document 看不到里面。
  // Electron 的 WebFrameMain.executeJavaScript 可以在帧自己的上下文里执行，
  // 因此按「页面里有哪个选择器」区分两个面板。

  function frames(): WebFrameMain[] {
    try {
      return wc.mainFrame.framesInSubtree
    } catch {
      return []
    }
  }

  async function findFrame(selector: string): Promise<WebFrameMain | null> {
    for (const frame of frames()) {
      try {
        const found = await frame.executeJavaScript(
          `!!document.querySelector(${JSON.stringify(selector)})`,
          true
        )
        if (found) return frame
      } catch {
        /* 帧可能正在导航，下一次轮询再看 */
      }
    }
    return null
  }

  async function waitFrame(selector: string, ms = 10_000): Promise<WebFrameMain | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const frame = await findFrame(selector)
      if (frame) return frame
      await sleep(80)
    }
    return null
  }

  async function inFrame<T>(selector: string, code: string): Promise<T> {
    const frame = await waitFrame(selector)
    if (!frame) throw new Error(`找不到包含 ${selector} 的 webview 帧`)
    return frame.executeJavaScript(code, true) as Promise<T>
  }

  async function waitInFrame(selector: string, code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const frame = await findFrame(selector)
      if (frame) {
        try {
          if (await frame.executeJavaScript(code, true)) return true
        } catch {
          /* 帧正在销毁 */
        }
      }
      await sleep(80)
    }
    return false
  }

  function frameDebug(): string {
    return JSON.stringify(
      frames().map(frame => frame.url),
      null,
      0
    )
  }

  // ---------- chat UI ----------

  const chatEval = <T>(code: string): Promise<T> => inFrame('.ai-chat-panel', code)

  const chatOpen = (): Promise<boolean> =>
    evalHost<boolean>(`!!document.querySelector('.webview-panel-sidebar')`)

  const chatText = (): Promise<string> =>
    chatEval<string>(`document.querySelector('.ai-chat-messages')?.innerText ?? ''`)

  const lastAssistantText = (): Promise<string> =>
    chatEval<string>(`(() => {
      const list = [...document.querySelectorAll('.ai-chat-bubble-assistant:not(.ai-chat-action)')]
      return list[list.length - 1]?.innerText ?? ''
    })()`)

  async function openChatByStatus(): Promise<boolean> {
    const clicked = await evalHost<boolean>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(AI_STATUS)})]
        .find(button => (button.getAttribute('title') || '').includes('打开 AI 对话'))
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!clicked) return false
    if (!(await waitHost(`document.querySelector('.webview-panel-sidebar')`, 5000))) return false
    return !!(await waitFrame('.ai-chat-panel', 10_000))
  }

  async function clickChat(selector: string): Promise<boolean> {
    return chatEval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`)
  }

  async function clickLastChat(selector: string): Promise<boolean> {
    return chatEval<boolean>(`(() => {
      const list = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = list[list.length - 1]
      if (!el || el.disabled) return false
      el.click()
      return true
    })()`)
  }

  async function setChatInput(text: string): Promise<boolean> {
    return chatEval<boolean>(`(() => {
      const el = document.querySelector('.ai-chat-input')
      if (!el) return false
      el.value = ${JSON.stringify(text)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  }

  async function sendChat(): Promise<boolean> {
    if (!(await clickChat('.ai-chat-mode-chat'))) return false
    return clickChat('.ai-chat-send')
  }

  async function clickAction(kind: 'generate' | 'beautify'): Promise<boolean> {
    if (!(await clickChat(`.ai-chat-mode-${kind}`))) return false
    return clickChat('.ai-chat-send')
  }

  const shortcutDisabled = (kind: 'generate' | 'beautify'): Promise<boolean> =>
    chatEval<boolean>(`!!document.querySelector('.ai-chat-mode-${kind}')?.disabled`)

  async function waitChatIdle(ms = 15_000): Promise<boolean> {
    return waitInFrame('.ai-chat-panel', `!document.querySelector('.ai-chat-loading')`, ms)
  }

  async function waitAssistantContains(text: string, ms = 15_000): Promise<boolean> {
    return waitInFrame(
      '.ai-chat-panel',
      `(() => {
         const list = [...document.querySelectorAll('.ai-chat-bubble-assistant:not(.ai-chat-action)')]
         return (list[list.length - 1]?.innerText ?? '').includes(${JSON.stringify(text)})
       })()`,
      ms
    )
  }

  async function waitActionEnd(ms = 20_000): Promise<boolean> {
    return waitInFrame(
      '.ai-chat-panel',
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

  async function waitLastApplied(ms = 5000): Promise<boolean> {
    return waitInFrame(
      '.ai-chat-panel',
      `(() => {
         const rows = [...document.querySelectorAll('.ai-chat-messages > *')]
         const last = rows[rows.length - 1]
         return !!last?.querySelector('.ai-chat-applied')
       })()`,
      ms
    )
  }

  async function waitActionError(ms = 20_000): Promise<string> {
    const found = await waitInFrame(
      '.ai-chat-panel',
      `(() => {
         const rows = [...document.querySelectorAll('.ai-chat-messages > *')]
         const last = rows[rows.length - 1]
         return !!(last && last.querySelector('.ai-chat-error'))
       })()`,
      ms
    )
    if (!found) return ''
    return chatEval<string>(`(() => {
      const rows = [...document.querySelectorAll('.ai-chat-messages > *')]
      const last = rows[rows.length - 1]
      const error = last?.querySelector('.ai-chat-error')
      const detail = last?.querySelector('.ai-chat-error-detail')
      return (error?.innerText ?? '') + (detail ? '\\n' + detail.innerText : '')
    })()`)
  }

  const previewText = (): Promise<string> =>
    chatEval<string>(`([...document.querySelectorAll('.ai-chat-preview')].pop())?.innerText ?? ''`)

  /** 预览先挂 DOM、后异步渲染 markdown，断言文字要等渲染完成 */
  async function waitPreviewContains(text: string, ms = 6000): Promise<boolean> {
    return waitInFrame(
      '.ai-chat-panel',
      `(() => {
         const el = [...document.querySelectorAll('.ai-chat-preview')].pop()
         return (el?.innerText ?? '').includes(${JSON.stringify(text)})
       })()`,
      ms
    )
  }

  const diffCount = (kind: 'add' | 'del'): Promise<number> =>
    chatEval<number>(`([...document.querySelectorAll('.ai-chat-preview')].pop())
      ?.querySelectorAll('.ai-diff-segment.is-${kind}').length ?? 0`)

  const docChipText = (): Promise<string> =>
    chatEval<string>(`document.querySelector('.ai-chat-doc-chip')?.textContent ?? ''`)

  const attachNames = (): Promise<string[]> =>
    chatEval<string[]>(
      `[...document.querySelectorAll('.ai-chat-attach-name')].map(el => el.textContent ?? '')`
    )

  const attachNoticeText = (): Promise<string> =>
    chatEval<string>(`document.querySelector('.ai-chat-attach-note')?.textContent ?? ''`)

  /** 往对话里塞一个本地文件；file input 的 click 拦掉，避免弹原生文件选择框 */
  async function attachLocalFile(
    name: string,
    content: string,
    type = 'text/markdown',
    binary = false
  ): Promise<boolean> {
    const dataExpr = binary
      ? `(() => {
           const raw = atob(${JSON.stringify(content)})
           const bytes = new Uint8Array(raw.length)
           for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
           return bytes
         })()`
      : JSON.stringify(content)
    return chatEval<boolean>(`(() => {
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
        [${dataExpr}],
        ${JSON.stringify(name)},
        { type: ${JSON.stringify(type)} }
      ))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  async function closeChat(): Promise<boolean> {
    if (!(await chatOpen())) return true
    const frame = await findFrame('.ai-chat-panel')
    if (!frame) return false
    try {
      await frame.executeJavaScript(`document.querySelector('.ai-chat-close')?.click()`, true)
    } catch {
      return false
    }
    return waitHost(`!document.querySelector('.webview-panel-sidebar')`, 6000)
  }

  // ---------- 文档 ----------

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalHost(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  /** 写盘 + 重载窗口，拿到一个光标在文首的干净编辑器。对话先关掉，避免 iframe 抢时序。 */
  async function loadDocAt(path: string, content: string): Promise<boolean> {
    await closeChat()
    const expected = content === '' ? 1 : content.split('\n').length
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(path, content, 'utf8')
      await saveSettings({ lastFile: path, openFiles: [path] })
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      await sleep(900)
      if (
        await waitHost(
          `document.querySelectorAll('.cm-content .cm-line').length === ${expected}`,
          6000
        )
      ) {
        await focusEditor()
        await waitHost(`document.querySelector('.status-plugin-group button.status-plug')`, 6000)
        return true
      }
    }
    return false
  }

  const loadDoc = (content: string): Promise<boolean> => loadDocAt(note, content)

  async function saveNow(): Promise<void> {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(350)
  }

  async function readSource(): Promise<string> {
    await saveNow()
    await sleep(350)
    return readFile(note, 'utf8')
  }

  /**
   * 扩展写文档走的是 host → main → renderer 的异步链，确认按钮的 UI 标记会先出现，
   * 保存命令可能抢在编辑落地之前。这里反复「保存 + 读盘」直到内容稳定为期望值，
   * 避免把时序问题当成功能失败；内容始终不对时在超时后返回最后一次读到的结果。
   */
  async function waitSource(expected: string, ms = 6000): Promise<string> {
    const until = Date.now() + ms
    let last = ''
    while (Date.now() < until) {
      wc.send(IPC.MenuCommand, 'file:save')
      await sleep(250)
      last = await readFile(note, 'utf8')
      if (last === expected) return last
    }
    return last
  }

  // ---------- 配置 ----------

  /** 配置存的是**完整键**:`<扩展id>.<属性>` */
  const configKey = (key: string): string => `${EXT_ID}.${key}`
  let baseConfig: Record<string, unknown> = {
    [configKey('endpoints')]: [{ id: 'e1', url: openaiUrl, model: 'mock-model' }],
    [configKey('timeoutSec')]: 5
  }

  async function setConfig(patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) baseConfig[configKey(key)] = value
    await service.setExtensionConfig(EXT_ID, baseConfig)
    await sleep(350)
  }

  async function setEndpoints(rows: { id: string; url: string }[]): Promise<void> {
    await setConfig({
      endpoints: rows.map(row => ({ ...row, model: 'mock-model' }))
    })
    await waitView(view => {
      const endpoints = view.config[`${EXT_ID}.endpoints`]
      return Array.isArray(endpoints) && endpoints.length === rows.length
    })
  }

  // ---------- 行首「+」 ----------

  async function openLineMenu(label: string): Promise<boolean> {
    await focusEditor()
    if (!(await waitHost(`document.querySelector('.line-plus')`, 6000))) return false
    if (!(await evalHost<boolean>(`(() => {
      const el = document.querySelector('.line-plus')
      if (!el) return false
      el.click()
      return true
    })()`))) {
      return false
    }
    await sleep(250)
    return evalHost<boolean>(`(() => {
      const item = [...document.querySelectorAll('.line-menu-item')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(label)}))
      if (!item) return false
      item.click()
      return true
    })()`)
  }

  async function openGenerateDialog(): Promise<boolean> {
    if (!(await openLineMenu('AI 生成内容'))) return false
    await sleep(250)
    return evalHost<boolean>(`!!document.querySelector('.line-dialog')`)
  }

  async function fillPrompt(text: string): Promise<boolean> {
    return evalHost<boolean>(`(() => {
      const input = document.querySelector('.line-dialog input.plugin-input')
      if (!input) return false
      input.value = ${JSON.stringify(text)}
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  async function confirmLineDialog(): Promise<boolean> {
    return evalHost<boolean>(`(() => {
      const button = document.querySelector('.line-dialog-primary')
      if (!button) return false
      button.click()
      return true
    })()`)
  }

  // ---------- 1. 安装、清单、启动激活 ----------

  console.log('\n【1】内置包安装：清单贡献点来自 package.json，启动后激活')
  const view = await aiView()
  check('扩展列表里有 imark.ai-for-edit', view.descriptor.id === EXT_ID, view.descriptor.id)
  check('版本是 1.0.0', view.descriptor.version === '1.0.0', view.descriptor.version)
  check('默认启用', view.enabled === true)
  check('来源标成内置（bundled）', view.source === 'bundled', String(view.source))
  check(
    '声明了启动激活与按需激活',
    view.descriptor.activationEvents.includes('onStartupFinished') &&
      view.descriptor.activationEvents.includes(`onCommand:${CMD_OPEN_CHAT}`) &&
      view.descriptor.activationEvents.includes('onWebviewPanel:imark.ai-for-edit.chat'),
    JSON.stringify(view.descriptor.activationEvents)
  )
  const commandIds = (view.descriptor.contributes.commands ?? []).map(command => command.command)
  check(
    '清单声明了打开对话 / 生成 / 测试连接命令',
    commandIds.includes(CMD_OPEN_CHAT) &&
      commandIds.includes('imark.ai-for-edit.generate') &&
      commandIds.includes(CMD_TEST_CONNECTION) &&
      commandIds.includes(CMD_TEST_TARGET),
    JSON.stringify(commandIds)
  )
  const fieldKeys = view.descriptor.settingsFields.map(field => field.key)
  check(
    '配置字段包含地址、超时、小人开关与形象',
    fieldKeys.includes('endpoints') &&
      fieldKeys.includes('timeoutSec') &&
      fieldKeys.includes('characterEnabled') &&
      fieldKeys.includes('characterStyle'),
    JSON.stringify(fieldKeys)
  )
  const endpointsField = view.descriptor.settingsFields.find(field => field.key === 'endpoints')
  check('地址字段是 endpoints 类型', endpointsField?.kind === 'endpoints', String(endpointsField?.kind))
  const prompts = view.descriptor.settingsFields.filter(
    field => field.key === 'generatePrompt' || field.key === 'beautifyPrompt'
  )
  check(
    '两条提示词都是 textarea 且有非空默认值',
    prompts.length === 2 &&
      prompts.every(field => field.kind === 'textarea' && String(field.default ?? '').trim() !== ''),
    JSON.stringify(prompts.map(field => ({ key: field.key, kind: field.kind })))
  )
  const lineMenu = view.descriptor.contributes['imark.lineMenu'] ?? []
  check(
    '行首菜单声明了「AI 生成内容」',
    lineMenu.some(
      item => item.command === 'imark.ai-for-edit.generate' && item.label === 'AI 生成内容'
    ),
    JSON.stringify(lineMenu)
  )
  const actions = view.descriptor.contributes['imark.actions'] ?? []
  check(
    '设置页动作有全局测试连接与每地址测试连接',
    actions.some(action => action.command === CMD_TEST_CONNECTION && action.scope === 'global') &&
      actions.some(action => action.command === CMD_TEST_TARGET && action.scope === 'target'),
    JSON.stringify(actions)
  )

  check('启动前扩展未激活', !service.isActivated(EXT_ID))
  check(
    '启动前不占用宿主进程',
    service.hostGroupsView().every(group => group.pid === null),
    JSON.stringify(service.hostGroupsView())
  )

  await service.startup()
  check('onStartupFinished 触发了激活', service.isActivated(EXT_ID))
  const runtime = (await aiView()).runtime
  check('宿主进程已 fork', typeof runtime.pid === 'number' && runtime.pid > 0, JSON.stringify(runtime))
  check(
    '状态栏出现 AI 按钮',
    await waitHost(`[...document.querySelectorAll(${JSON.stringify(AI_STATUS)})]
      .some(button => (button.getAttribute('title') || '').includes('打开 AI 对话'))`, 8000)
  )

  // 默认小人：floating + transparent 面板，页面里只有形象
  check('浮动小人默认出现', await waitHost(`!!document.querySelector('.webview-panel-transparent')`, 8000))
  check('小人是猫咪', await waitInFrame('.ai-char', `document.querySelector('.ai-char-emoji')?.textContent === '🐱'`, 8000), frameDebug())

  // ---------- 2. 状态栏入口与对话页面 ----------

  console.log('\n【2】状态栏入口打开 chat webview；文档关联与密钥隔离')
  check('点状态栏 AI 按钮打开对话', await openChatByStatus(), frameDebug())
  check('宿主里是 sidebar 面板', await evalHost<boolean>(`!!document.querySelector('.webview-panel-sidebar')`))
  check('面板标题是「AI 对话」', await evalHost<boolean>(`document.querySelector('.webview-panel-sidebar .webview-title')?.textContent === 'AI 对话'`))
  check('对话里有欢迎语', (await chatText()).includes('AI for Edit'), await chatText())
  check('对话关联当前文档', (await docChipText()).includes('笔记.md'), await docChipText())
  check('有「新对话」按钮', await chatEval<boolean>(`document.querySelector('.ai-chat-head')?.innerText.includes('新对话') === true`))
  check(
    '非空文档时「生成」不可用、「美化」可用',
    (await shortcutDisabled('generate')) && !(await shortcutDisabled('beautify'))
  )

  const chatHtml = await chatEval<string>(`document.documentElement.outerHTML`)
  const chatStorage = await chatEval<string>(`JSON.stringify(localStorage)`)
  check('HTML 里没有 API 密钥', !chatHtml.includes(API_KEY))
  check('webview localStorage 里没有 API 密钥', !chatStorage.includes(API_KEY))
  const withSecrets = await service.getExtensionViewWithSecrets(EXT_ID)
  check(
    '主进程只把密钥显示成掩码',
    !!withSecrets &&
      Object.values(withSecrets.secrets).every(value => !value.includes(API_KEY)) &&
      Object.values(withSecrets.secrets).some(value => value.length > 0),
    JSON.stringify(withSecrets?.secrets)
  )
  const settingsText = await readFile(join(ud, 'settings.json'), 'utf8')
  check('settings.json 里没有 API 密钥', !settingsText.includes(API_KEY))

  // ---------- 3. 对话与多轮历史 ----------

  console.log('\n【3】对话：带上当前文档，多轮历史继续传')
  resetMock({ content: '这份文档讲的是项目计划：本周完成登录模块。' })
  check('填写问题', await setChatInput('这份文档讲了什么？'))
  check('发送问题', await sendChat())
  check('等到了回答', await waitAssistantContains('项目计划', 15_000), await chatText())
  check('等到了空闲状态', await waitChatIdle())
  check('请求带上了当前文档内容', captured[0]?.body.includes('本周完成登录模块') === true, captured[0]?.body.slice(0, 240))
  check('请求带上了用户的问题', captured[0]?.body.includes('这份文档讲了什么') === true, captured[0]?.body.slice(-240))
  check(
    'Authorization 头里带了密钥（密钥只到扩展宿主）',
    captured[0]?.headers.authorization === `Bearer ${API_KEY}`,
    String(captured[0]?.headers.authorization)
  )
  check('请求体里是配置的模型', captured[0]?.body.includes('"model":"mock-model"') === true, captured[0]?.body.slice(0, 160))

  resetMock({ content: '补充一句：登录模块本周收尾。' })
  check('再问一句', await setChatInput('还有呢？'))
  check('发送第二问', await sendChat())
  check('等到了第二段回答', await waitAssistantContains('登录模块本周收尾', 15_000))
  check(
    '第二问的历史里带上了第一轮问答',
    captured[0]?.body.includes('这份文档讲了什么') === true &&
      captured[0].body.includes('这份文档讲的是项目计划') === true,
    captured[0]?.body.slice(-500)
  )
  const okView = await waitView(view => view.status.status === 'ok')
  check('对话成功后状态卡是 ok', okView?.status.status === 'ok', JSON.stringify(okView?.status))
  check('状态卡记录了模型输出', (okView?.status.lastMessage ?? '').length > 0 || okView?.status.lastRunAt !== null, JSON.stringify(okView?.status))

  // ---------- 4. 多地址与测试连接 ----------

  console.log('\n【4】多地址轮换；测试连接（全局 / 单地址）')
  await setEndpoints([
    { id: 'e1', url: deadUrl },
    { id: 'e2', url: openaiUrl }
  ])
  resetMock({ content: '回退到第二个地址' })
  check('填写问题（回退）', await setChatInput('测试回退'))
  check('发送（回退）', await sendChat())
  check('回答来自第二个地址', await waitAssistantContains('回退到第二个地址', 15_000), await chatText())
  check('只有可用地址收到了请求', captured.length === 1, `${captured.length} 次`)

  resetMock({ content: 'OK' })
  await service.executeCommand(CMD_TEST_CONNECTION, [])
  const mixedView = await waitView(
    view => view.status.targetResults?.e1 === 'error' && view.status.targetResults?.e2 === 'ok',
    10_000
  )
  check('测试全部地址：部分失败', mixedView?.status.status === 'partial', JSON.stringify(mixedView?.status))
  check(
    '失败与成功分别列在两行',
    (mixedView?.status.lastMessage ?? '').includes('第 1 个地址：连接失败') &&
      (mixedView?.status.lastMessage ?? '').includes('第 2 个地址：连接成功'),
    String(mixedView?.status.lastMessage)
  )
  check(
    '每个地址的结果分别记录',
    mixedView?.status.targetResults?.e1 === 'error' && mixedView?.status.targetResults?.e2 === 'ok',
    JSON.stringify(mixedView?.status.targetResults)
  )
  check('只有可用地址收到了测试请求', captured.length === 1, `${captured.length} 次`)

  resetMock({ content: 'OK' })
  await service.executeCommand(CMD_TEST_TARGET, [{ targetId: 'e2', source: 'action' }])
  const oneView = await waitView(view => view.status.status === 'ok', 10_000)
  check('地址卡片上的「测试连接」只测这一行且成功', oneView?.status.status === 'ok', JSON.stringify(oneView?.status))
  check('只发出了一次请求', captured.length === 1, `${captured.length} 次`)

  await setEndpoints([{ id: 'e1', url: openaiUrl }])
  check('恢复单地址配置', (await aiView()).config[`${EXT_ID}.endpoints`] !== undefined)

  // ---------- 5. 美化 ----------

  console.log('\n【5】美化：差异预览 → 确认写回')
  const START =
    '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 标题\n正文第一段。\n\n\n- 项目一\n- 项目二\n'
  const EXPECTED =
    '---\ntitle: 测试\ntags: [a, b]\n---\n\n# 标题\n\n正文第一段（已润色）。\n\n- 项目一\n- 项目二\n'
  check('载入带 front matter 的文档', await loadDoc(START))
  resetMock({
    content: '````markdown\n# 标题\n\n正文第一段（已润色）。\n\n- 项目一\n- 项目二\n````'
  })
  check('打开对话', await openChatByStatus())
  check('美化可用', !(await shortcutDisabled('beautify')))
  check('填写美化要求', await setChatInput('把标题层级整理清楚，语气更正式'))
  check('选择「美化」并发送', await clickAction('beautify'))
  check('对话里出现带要求的展示消息', (await chatText()).includes('把标题层级整理清楚，语气更正式'), await chatText())
  check('等到了美化结果', await waitActionEnd())
  check('结果有预览窗口', await waitPreviewContains('标题'), await previewText())
  check(
    '预览渲染成 HTML 标题',
    await chatEval<boolean>(
      `([...document.querySelectorAll('.ai-chat-preview')].pop())?.querySelector('h1')?.textContent === '标题'`
    ),
    await previewText()
  )
  check('删除内容用红色区分', (await diffCount('del')) > 0)
  check('新增/修改内容用绿色区分', (await diffCount('add')) > 0)
  check(
    '发给模型的内容不含 front matter',
    captured[0]?.body.includes('title: 测试') !== true && captured[0]?.body.includes('正文第一段。') === true,
    captured[0]?.body.slice(0, 240)
  )
  check(
    '美化要求进了请求',
    captured[0]?.body.includes('把标题层级整理清楚，语气更正式') === true,
    captured[0]?.body.slice(0, 320)
  )
  check('确认前文档没有改动', (await readSource()) === START)
  check('点「确认替换」', await clickLastChat('.ai-chat-confirm'))
  check('结果标记为已替换', await waitLastApplied(6000))
  const beautified = await waitSource(EXPECTED)
  check('确认后写回磁盘', beautified === EXPECTED, JSON.stringify(beautified))
  check('关闭对话', await closeChat())

  // ---------- 6. 空文档生成 ----------

  console.log('\n【6】空文档生成：预览 → 确认整篇写入；自定义生成提示词')
  await setConfig({ generatePrompt: 'CUSTOM-GENERATE-PROMPT' })
  check('载入空文档', await loadDoc(''))
  resetMock({ content: '# 生成标题\n\n这是生成的内容。\n' })
  check('打开对话', await openChatByStatus())
  check('空文档时「生成」可用、「美化」不可用', !(await shortcutDisabled('generate')) && (await shortcutDisabled('beautify')))
  check('填写生成要求', await setChatInput('写一份产品周报大纲'))
  check('选择「生成」并发送', await clickAction('generate'))
  check('等到了生成结果', await waitActionEnd())
  check('生成结果有预览窗口', await waitPreviewContains('生成标题'), await previewText())
  const generateBody = captured[0] ? (JSON.parse(captured[0].body) as { messages?: { role?: string; content?: string }[] }) : null
  check(
    '生成请求的 system 是自定义提示词',
    generateBody?.messages?.[0]?.role === 'system' &&
      generateBody?.messages?.[0]?.content === 'CUSTOM-GENERATE-PROMPT',
    JSON.stringify(generateBody?.messages?.[0]).slice(0, 200)
  )
  check('生成请求里带了要求', captured[0]?.body.includes('写一份产品周报大纲') === true)
  check('确认前空文档仍是空的', (await readSource()) === '')
  check('点「写入文档」', await clickLastChat('.ai-chat-confirm'))
  check('结果标记为已写入', await waitLastApplied(6000))
  const generated = await waitSource('# 生成标题\n\n这是生成的内容。\n')
  check(
    '空文档被整篇写入，第一行就是生成内容',
    generated === '# 生成标题\n\n这是生成的内容。\n',
    JSON.stringify(generated)
  )
  check('关闭对话', await closeChat())

  // ---------- 7. 非空文档「+」直接插入 ----------

  console.log('\n【7】非空文档行首「+」：直接插入到光标行下方，不打开对话')
  const NON_EMPTY = '# 已有\n\n正文\n'
  check('载入非空文档', await loadDoc(NON_EMPTY))
  resetMock({ content: '## 新段落\n\n内容\n' })
  check('打开「+」菜单并选「AI 生成内容」', await openGenerateDialog())
  check('填写生成要求', await fillPrompt('写一个新段落'))
  check('点行首对话框的「生成」', await confirmLineDialog())
  check(
    '扩展生成后直接插入',
    await waitUntilAsync(
      async () => (await aiView()).status.lastMessage.startsWith('已生成 '),
      15_000
    ),
    (await aiView()).status.lastMessage
  )
  check('对话没有被打开', !(await chatOpen()))
  const inserted = await waitSource('# 已有\n## 新段落\n\n内容\n\n正文\n')
  check(
    '插入位置在光标行下方',
    inserted === '# 已有\n## 新段落\n\n内容\n\n正文\n',
    JSON.stringify(inserted)
  )
  check('插入请求里带了要求', captured[0]?.body.includes('写一个新段落') === true)

  // ---------- 8. 空文档「+」打开对话 ----------

  console.log('\n【8】空文档行首「+」：打开对话、自动预览、确认写入')
  check('载入空文档', await loadDoc(''))
  resetMock({ content: '# 菜单生成\n\n内容\n' })
  check('打开「+」菜单并选「AI 生成内容」', await openGenerateDialog())
  check('填写生成要求', await fillPrompt('写一段简介'))
  check('点行首对话框的「生成」', await confirmLineDialog())
  check('对话自动打开', await waitHost(`document.querySelector('.webview-panel-sidebar')`, 8000) && !!(await waitFrame('.ai-chat-panel', 10_000)))
  check('对话里有展示消息', (await chatText()).includes('帮我生成：写一段简介'), await chatText())
  check('等到了生成结果', await waitActionEnd())
  check('结果有预览窗口', await waitPreviewContains('菜单生成'), await previewText())
  check('要求带到了请求里', captured.some(item => item.body.includes('写一段简介')))
  check('确认前空文档仍是空的', (await readSource()) === '')
  check('点「写入文档」', await clickLastChat('.ai-chat-confirm'))
  check('结果标记为已写入', await waitLastApplied(6000))
  const menuGenerated = await waitSource('# 菜单生成\n\n内容\n')
  check('对话确认后写入文档', menuGenerated === '# 菜单生成\n\n内容\n', JSON.stringify(menuGenerated))
  check('关闭对话', await closeChat())

  // ---------- 9. 本地参考文件与 PDF ----------

  console.log('\n【9】本地参考文件：文本、PDF 文字、扫描页图片都进请求')
  check('载入对话测试文档', await loadDoc(CHAT_DOC))
  check('打开对话', await openChatByStatus())
  check('添加本地文本文件', await attachLocalFile('参考.md', '本地参考资料：项目代号朱雀。'))
  check(
    '文件条显示文件名',
    await waitInFrame('.ai-chat-panel', `[...document.querySelectorAll('.ai-chat-attach-name')]
      .some(el => el.textContent === '参考.md')`, 5000)
  )
  check('添加 PDF 参考文件', await attachLocalFile('论文.pdf', PDF_FIXTURE, 'application/pdf', true))
  check(
    'PDF 文字被提取并显示在文件条',
    await waitInFrame('.ai-chat-panel', `[...document.querySelectorAll('.ai-chat-attach-name')]
      .some(el => el.textContent === '论文.pdf')`, 15_000),
    await attachNoticeText()
  )
  check(
    '没有文字层的 PDF 会转成扫描页图片',
    (await attachLocalFile('扫描件.pdf', PDF_BLANK_FIXTURE, 'application/pdf', true)) &&
      (await waitInFrame('.ai-chat-panel', `(() => {
         const chip = [...document.querySelectorAll('.ai-chat-attach-chip')]
           .find(el => el.querySelector('.ai-chat-attach-name')?.textContent === '扫描件.pdf')
         const badge = chip?.querySelector('.ai-chat-attach-badge')
         return !!chip && badge?.textContent === '1 图' &&
           (chip.title || '').includes('1 张扫描页图片')
       })()`, 15_000)),
    `${await attachNoticeText()} — ${JSON.stringify(await attachNames())}`
  )

  resetMock({ content: '代号是朱雀。' })
  check('填写引用参考文件的问题', await setChatInput('参考文件里的项目代号是什么？'))
  check('发送问题', await sendChat())
  check('等到了回答', await waitChatIdle(15_000))
  check('回答显示在对话里', await waitAssistantContains('朱雀', 10_000))
  const attachRequest = captured[captured.length - 1]
  check('请求里带上了参考文件名', attachRequest?.body.includes('参考.md') === true)
  check('请求里带上了参考文件内容', attachRequest?.body.includes('项目代号朱雀') === true)
  check('请求里带上了 PDF 文件名', attachRequest?.body.includes('论文.pdf') === true)
  check(
    '请求里带上了 PDF 提取出的文字',
    attachRequest?.body.includes('project code Vermilion') === true &&
      attachRequest?.body.includes('attention mechanisms') === true,
    attachRequest?.body.slice(-400)
  )
  check(
    '扫描页作为 JPEG 图片发送',
    attachRequest?.body.includes('"image_url"') === true &&
      attachRequest?.body.includes('data:image/jpeg;base64,') === true,
    attachRequest?.body.slice(-300)
  )
  check(
    '图片前有文件名与页码说明',
    attachRequest?.body.includes('扫描件.pdf') === true &&
      attachRequest?.body.includes('第 1 页') === true &&
      attachRequest?.body.includes('扫描图片') === true
  )
  check('关闭对话', await closeChat())

  // ---------- 10. 取消 ----------

  console.log('\n【10】取消：关闭面板中止在途请求，重开后可继续用')
  check('重新载入文档', await loadDoc(CHAT_DOC))
  check('打开对话', await openChatByStatus())
  resetMock({ hang: true })
  const abortsBefore = abortedRequests
  check('填写问题（挂起）', await setChatInput('这一问不会返回'))
  check('发送（挂起）', await sendChat())
  check('请求已经在途', await waitUntilAsync(() => captured.length > 0, 5000))
  check('关闭对话面板', await closeChat())
  check(
    '客户端中止了在途请求',
    await waitUntilAsync(() => abortedRequests > abortsBefore, 6000),
    `aborted=${abortedRequests}`
  )
  const cancelView = await waitView(view => view.status.lastMessage.includes('取消'), 6000)
  check('状态卡记录「请求已取消」', cancelView?.status.lastMessage.includes('取消') === true, String(cancelView?.status.lastMessage))
  resetMock({ content: '取消之后仍可继续。' })
  check('重新打开对话', await openChatByStatus())
  check('填写问题（重新打开）', await setChatInput('取消之后还能用吗？'))
  check('发送（重新打开）', await sendChat())
  check('等到了新回答', await waitAssistantContains('取消之后仍可继续', 15_000), await chatText())
  check('关闭对话', await closeChat())

  // ---------- 11. 超时 ----------

  console.log('\n【11】超时：错误显示在对话里，文档不动')
  const TIMEOUT_INPUT = '# 超时\n\n正文\n'
  check('载入超时测试文档', await loadDoc(TIMEOUT_INPUT))
  resetMock({ hang: true })
  check('打开对话', await openChatByStatus())
  const startedAt = Date.now()
  check('选择「美化」并发送', await clickAction('beautify'))
  const timeoutError = await waitActionError(20_000)
  const elapsed = Date.now() - startedAt
  check('对话里显示没有响应/超时', /没有响应|超时/.test(timeoutError), timeoutError)
  check('大约在 5 秒后放弃', elapsed >= 4500 && elapsed < 18_000, `${elapsed}ms`)
  check('超时时文档没有改动', (await readSource()) === TIMEOUT_INPUT)
  resetMock({ content: 'OK' })
  check('关闭对话', await closeChat())

  // ---------- 12. 浮动小人 ----------

  console.log('\n【12】浮动小人：开关与形象（配置热更新）')
  await setConfig({ characterEnabled: false })
  check('关闭后小人面板消失', await waitHost(`!document.querySelector('.webview-panel-transparent')`, 6000))
  check('状态栏按钮仍然在', await waitHost(`[...document.querySelectorAll(${JSON.stringify(AI_STATUS)})]
    .some(button => (button.getAttribute('title') || '').includes('打开 AI 对话'))`, 4000))

  await setConfig({ characterEnabled: true, characterStyle: 'penguin' })
  check('重新打开后小人出现', await waitHost(`!!document.querySelector('.webview-panel-transparent')`, 6000))
  check(
    '企鹅是矢量动画形象',
    await waitInFrame('.ai-char', `!!document.querySelector('.ai-char-emoji svg .ai-penguin-flipper')`, 8000),
    frameDebug()
  )

  await setConfig({ characterStyle: 'cat' })
  check(
    '切换形象后页面热更新为猫咪',
    await waitInFrame('.ai-char', `document.querySelector('.ai-char-emoji')?.textContent === '🐱'`, 8000),
    frameDebug()
  )
  check('小人页面已就绪', !!(await waitFrame('.ai-char')))

  const charRect = (): Promise<{ x: number; y: number }> =>
    evalHost<{ x: number; y: number }>(`(() => {
      const el = document.querySelector('.webview-panel-transparent')
      if (!el) return { x: -1, y: -1 }
      const rect = el.getBoundingClientRect()
      return { x: rect.left, y: rect.top }
    })()`)

  // Electron 的 sendInputEvent 不会把合成鼠标事件路由进跨进程 iframe，所以这里
  // 按浏览器实际会投递的事件序列驱动：iframe 内 pointerdown → 宿主 window 上
  // 的 pointermove/pointerup（拖动接管后指针本来就在宿主文档里）。
  const pointerInChar = (type: string, clientX: number, clientY: number): Promise<boolean> =>
    inFrame(
      '.ai-char',
      `(() => {
         const el = document.querySelector('.ai-char')
         if (!el) return false
         el.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
           bubbles: true,
           cancelable: true,
           button: 0,
           buttons: ${type === 'pointerup' ? 0 : 1},
           clientX: ${clientX},
           clientY: ${clientY},
           pointerId: 1,
           pointerType: 'mouse',
           isPrimary: true
         }))
         return true
       })()`
    )

  const pointerOnWindow = (type: string, clientX: number, clientY: number): Promise<boolean> =>
    evalHost<boolean>(`(() => {
      window.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: ${type === 'pointerup' ? 0 : 1},
        clientX: ${clientX},
        clientY: ${clientY},
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }))
      return true
    })()`)

  const before = await charRect()
  const downX = before.x + 54
  const downY = before.y + 64
  check('按下小人（iframe 内）', await pointerInChar('pointerdown', 54, 64))
  await sleep(150)
  for (let step = 1; step <= 4; step += 1) {
    await pointerOnWindow('pointermove', downX - step * 15, downY - step * 10)
    await sleep(35)
  }
  await pointerOnWindow('pointerup', downX - 60, downY - 40)
  await sleep(500)
  const after = await charRect()
  const movedX = before.x - after.x
  const movedY = before.y - after.y
  check(
    '按住小人可以拖到新位置',
    Math.abs(movedX - 60) <= 6 && Math.abs(movedY - 40) <= 6,
    JSON.stringify({ before, after })
  )
  check('拖动不会误开对话', !(await chatOpen()))

  check(
    '点浮动小人打开对话',
    (await inFrame('.ai-char', `document.querySelector('.ai-char').click(); true`)) &&
      (await waitHost(`document.querySelector('.webview-panel-sidebar')`, 6000)) &&
      !!(await waitFrame('.ai-chat-panel', 10_000))
  )
  check('关闭对话', await closeChat())

  // ---------- 13. 停用扩展 ----------

  console.log('\n【13】停用扩展：面板、状态栏、宿主一起释放')
  await service.setEnabled(EXT_ID, false)
  check('扩展标记为停用', (await aiView()).enabled === false)
  check('聊天面板消失', await waitHost(`!document.querySelector('.webview-panel-sidebar')`, 6000))
  check('小人面板消失', await waitHost(`!document.querySelector('.webview-panel-transparent')`, 6000))
  check(
    '状态栏按钮消失',
    await waitHost(`![...document.querySelectorAll(${JSON.stringify(AI_STATUS)})]
      .some(button => (button.getAttribute('title') || '').includes('打开 AI 对话'))`, 6000)
  )
  check('宿主进程释放', !service.isActivated(EXT_ID))
  check(
    '宿主 PID 归零',
    (await aiView()).runtime.pid === null,
    JSON.stringify((await aiView()).runtime)
  )

  // ---------- 收尾 ----------

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await service.setEnabled(EXT_ID, true).catch(() => undefined)
  await shutdownExtensions()
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
