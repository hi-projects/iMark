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
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { getSettings, loadSettings, saveSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { getRecord, setRecord } from '../src/main/plugins/installed'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { isRenderLayerLoaded } from '../src/main/plugins/renderLayer'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

const PLUGIN_ID = 'ai-for-edit'
const PLUGIN_VERSION = '1.4.1'
const API_KEY = 'test-key-123'
const AI_BUTTON = '.status-toggles button[title="AI 对话 / 生成 / 美化"]'

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
              stop_reason: reply.stop ?? 'end_turn'
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
            ]
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

  async function loadDoc(content: string): Promise<boolean> {
    await writeFile(note, content, 'utf8')
    await saveSettings({ lastFile: note, openFiles: [note] })
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(900)
    const loaded = await waitFor(`document.querySelector('.cm-content')`)
    await waitUntil(() => !isRenderLayerLoaded(PLUGIN_ID), 2000)
    await waitUntil(() => isRenderLayerLoaded(PLUGIN_ID), 10_000)
    await sleep(300)
    await waitForAiButton(4000)
    await focusEditor()
    return loaded
  }

  async function saveAndRead(): Promise<string> {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(700)
    return readFile(note, 'utf8')
  }

  async function pluginView(): Promise<Awaited<ReturnType<typeof host.list>>[number] | undefined> {
    return (await host.list()).find(view => view.descriptor.id === PLUGIN_ID)
  }

  async function configureAndEnable(endpoint: string, model: string): Promise<void> {
    await host.setSecretValue(PLUGIN_ID, 'apiKey', null, API_KEY)
    await host.save(PLUGIN_ID, {
      enabled: true,
      config: { endpoint, model, timeoutMs: 5000 }
    })
    const injected = await waitUntil(() => isRenderLayerLoaded(PLUGIN_ID), 10_000)
    check('启用后 render 层已注入', injected)
    check('状态栏注入了 AI 按钮', await waitForAiButton(5000))
  }

  async function reconfigure(endpoint: string, model: string, timeoutMs = 5000): Promise<void> {
    await host.save(PLUGIN_ID, {
      config: { endpoint, model, timeoutMs }
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
    evalJs<boolean>(
      `!!document.querySelector('.ai-chat-${kind}')?.disabled`
    )

  async function setChatInput(text: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const el = document.querySelector('.ai-chat-input')
      if (!el) return false
      el.value = ${JSON.stringify(text)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  }

  const sendChat = (): Promise<boolean> => clickChatButton('.ai-chat-send')

  async function waitChatIdle(ms = 15_000): Promise<boolean> {
    return waitFor(`!document.querySelector('.ai-chat-loading')`, ms)
  }

  async function waitActionEnd(ms = 15_000): Promise<boolean> {
    return waitFor(
      `document.querySelector('.ai-chat-generated') ||
       document.querySelector('.ai-chat-preview') ||
       document.querySelector('.ai-chat-diff') ||
       document.querySelector('.ai-chat-action .ai-chat-error')`,
      ms
    )
  }

  const previewText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.ai-chat-preview')?.innerText ?? ''`)

  async function waitPreviewText(text: string, ms = 10_000): Promise<boolean> {
    return waitFor(
      `document.querySelector('.ai-chat-preview')?.innerText.includes(${JSON.stringify(text)})`,
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

  async function waitActionError(ms = 15_000): Promise<string> {
    const found = await waitFor(`document.querySelector('.ai-chat-action .ai-chat-error')`, ms)
    return found
      ? evalJs<string>(`document.querySelector('.ai-chat-action .ai-chat-error')?.innerText ?? ''`)
      : ''
  }

  const diffCount = (kind: 'add' | 'del'): Promise<number> =>
    evalJs<number>(
      `document.querySelectorAll('.ai-chat-preview .ai-diff-segment.is-${kind}').length`
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
  check(
    '行首菜单声明了「AI 生成内容」',
    provisioned?.descriptor.lineMenu?.some(
      item => item.id === 'ai-generate' && item.action === 'generate-content'
    ) === true,
    JSON.stringify(provisioned?.descriptor.lineMenu)
  )

  // ---------- 1b. 默认值迁移 ----------

  console.log('\n【1b】旧默认配置迁移:OpenAI → DeepSeek')
  const freshRecord = await getRecord(PLUGIN_ID)
  check('有安装登记', freshRecord !== null)
  if (freshRecord) {
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
    check(
      '旧默认服务地址迁移到 DeepSeek',
      migrated?.config.endpoint === 'https://api.deepseek.com/chat/completions',
      String(migrated?.config.endpoint)
    )
    check(
      '旧默认模型迁移到 deepseek-flash',
      migrated?.config.model === 'deepseek-flash',
      String(migrated?.config.model)
    )
    check(
      '插件版本已升级',
      (await getRecord(PLUGIN_ID))?.version === PLUGIN_VERSION,
      String((await getRecord(PLUGIN_ID))?.version)
    )

    const upgraded = await getRecord(PLUGIN_ID)
    if (upgraded) {
      await setRecord({ ...upgraded, version: '1.0.0' })
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
      check(
        '用户改过的配置不会被迁移覆盖',
        kept?.config.endpoint === 'https://example.com/custom' &&
          kept?.config.model === 'custom-model',
        JSON.stringify({
          endpoint: kept?.config.endpoint,
          model: kept?.config.model
        })
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

  mockReply = { content: '补充一句：登录模块本周收尾。' }
  check('再问一句', await setChatInput('还有呢？'))
  check('发送第二问', await sendChat())
  check('等到了第二段回答', await waitChatIdle())
  check(
    '第二问的历史里带上了第一轮问答',
    captured[1]?.body.includes('这份文档讲了什么') &&
      captured[1]?.body.includes('这份文档讲的是项目计划'),
    captured[1]?.body.slice(-400)
  )
  check('点「新对话」', await clickNewChat())
  check(
    '新对话清空聊天记录',
    await waitFor(
      `document.querySelector('.ai-chat-welcome') && document.querySelectorAll('.ai-chat-bubble-user').length === 0`
    )
  )

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
  check('点「美化」', await clickChatButton('.ai-chat-beautify'))
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
    await evalJs<boolean>(`document.querySelector('.ai-chat-preview h1')?.textContent === '标题'`),
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
    (await evalJs<string>(`document.querySelector('.ai-chat-generated')?.innerText ?? ''`)).includes('title: 测试')
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
  check('点「生成」', await clickChatButton('.ai-chat-generate'))
  check('对话里先出现展示消息', (await chatText()).includes('帮我生成：写一份产品周报大纲'), await chatText())
  check('等到了生成结果', await waitActionEnd())
  check('生成结果有预览窗口', await waitPreviewText('生成标题'))
  check(
    '预览渲染成 HTML 标题',
    await evalJs<boolean>(`document.querySelector('.ai-chat-preview h1')?.textContent === '生成标题'`),
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
    (await evalJs<string>(`document.querySelector('.ai-chat-generated')?.innerText ?? ''`)).includes('# 第二版')
  )
  check('切回预览', await clickPreviewTab())
  check('重新生成请求也带上了要求', captured[1]?.body.includes('写一份产品周报大纲'), captured[1]?.body.slice(0, 160))
  check('点「写入文档」', await clickLast('.ai-chat-confirm'))
  check('结果标记为已写入', await waitFor(`document.querySelector('.ai-chat-applied')`))
  const generated = await saveAndRead()
  check(
    '空文档被整篇写入,第一行就是生成内容(没有前导空行)',
    generated === '# 第二版\n\n重新生成的内容。\n',
    JSON.stringify(generated)
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
  check('点「美化」', await clickChatButton('.ai-chat-beautify'))
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
  check('打开对话并点美化', (await openChatByStatus()) && (await clickChatButton('.ai-chat-beautify')))
  const truncError = await waitActionError()
  check('对话里显示截断错误', truncError.includes('截断'), truncError)
  check('截断时文档一个字符都没动', (await saveAndRead()) === TRUNC_INPUT)
  await closeChat()

  // ---------- 13. 401 ----------

  console.log('\n【13】401:错误可读,密钥不落日志')
  const AUTH_INPUT = '# 认证测试\n\n正文\n'
  check('载入 401 测试文档', await loadDoc(AUTH_INPUT))
  resetMock({ status: 401, content: 'invalid api key' })
  check('打开对话并点美化', (await openChatByStatus()) && (await clickChatButton('.ai-chat-beautify')))
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
  check('打开对话并点美化', (await openChatByStatus()) && (await clickChatButton('.ai-chat-beautify')))
  const tooBigError = await waitActionError(5000)
  check('对话里显示文档太长', /太长|上限/.test(tooBigError), tooBigError)
  check('没有向 AI 发请求', captured.length === 0, `${captured.length} 次`)
  await closeChat()

  // ---------- 15. 超时 ----------

  console.log('\n【15】请求超时:对话里报错,文档不动')
  const TIMEOUT_INPUT = '# 超时\n\n正文\n'
  check('载入超时测试文档', await loadDoc(TIMEOUT_INPUT))
  resetMock({ hang: true })
  check('打开对话并点美化', (await openChatByStatus()) && (await clickChatButton('.ai-chat-beautify')))
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
  check('打开对话并点美化', (await openChatByStatus()) && (await clickChatButton('.ai-chat-beautify')))
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
  check('body 带 system 与 max_tokens', typeof anthBody.system === 'string' && anthBody.max_tokens === 8192)
  check(
    'body 的 messages 是 user 角色',
    Array.isArray(anthBody.messages) &&
      (anthBody.messages as { role?: string }[])[0]?.role === 'user'
  )
  check('点确认', await clickLast('.ai-chat-confirm'))
  check('Anthropic 的返回写回了文档', (await saveAndRead()) === '# 新标题\n\n新内容\n')
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

  // ---------- 收尾 ----------

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
