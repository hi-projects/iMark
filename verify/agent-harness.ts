/**
 * Agent Core（imark.agent）+ Claude Code（imark.claude-code）端到端验收。
 *
 * 覆盖：
 *   1 依赖安装顺序、内置包安装、无 provider 时的空状态
 *   2 启用 provider 后的宿主重启、惰性激活、provider 探测（fake claude --version）
 *   3 附件分块上传、落盘、会话 meta
 *   4 turn：流式文本、工具时间线、prepared/ 产物、prompt 只含路径
 *   5 产物预览与结果写回
 *  5b Markdown 预览：KaTeX 公式、会话目录内的图片
 *   6 轮数按 assistant 消息计
 *   7 auth / provider-unavailable 错误分类
 *   8 取消：流式停止、子进程结束
 *   9 依赖保护：Core 被 Claude Code 依赖时不能卸载
 *  10 删除会话：面板内确认框（sandbox 下 window.confirm 会被忽略）
 *
 * 跑法：
 *   npm run build
 *   node verify/run.mjs agent
 */

import { app, BrowserWindow, dialog, protocol, type WebFrameMain } from 'electron'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { EXTENSION_WEBVIEW_SCHEME } from '../src/shared/extensionProtocol'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerExtensionWebviewProtocol } from '../src/main/extensions/webviewProtocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings, saveSettings } from '../src/main/settings'
import { startInstanceBroker, stopInstanceBroker } from '../src/main/vaultHandoff'
import { createMainWindow } from '../src/main/window'
import { installExtensionPackage } from '../src/main/extensions/installer'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import { SYSTEM_PROMPT } from '../plugins-src/agent/core/prompt'
import { workspaceKey } from '../plugins-src/agent/core/sessions'
import { StreamingLineReader } from '../plugins-src/claude-code/streamLines'

const REPO = join(__dirname, '..', '..')
const CORE_ID = 'imark.agent'
const CLAUDE_ID = 'imark.claude-code'
import { APP_VERSION } from './appVersion'
const CMD_OPEN = 'imark.agent.openChat'

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

interface Invocation {
  at: number
  pid: number
  argv: string[]
  cwd: string
  stdin: string
  versionOnly: boolean
  scenario: string
  marker: string
  hasApiKey: boolean
}

function checkLineReader(): void {
  console.log('\n【0】stream-json 行读取器')
  interface Seen {
    line: string
    truncated: boolean
  }
  const read = (chunks: string[]): Seen[] => {
    const seen: Seen[] = []
    const reader = new StreamingLineReader({
      perString: 64,
      perLine: 512,
      onLine: (line, info) => seen.push({ line, ...info })
    })
    for (const chunk of chunks) reader.push(chunk)
    reader.end()
    return seen
  }

  const smallLine = '{"type":"system","session_id":"s1"}'
  const small = read([`${smallLine}\n`])
  check(
    '小行原样通过',
    small.length === 1 && !small[0].truncated && small[0].line === smallLine,
    JSON.stringify(small)
  )

  const bigLine = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(1000) }] }
  })
  const big = read([bigLine.slice(0, 17), bigLine.slice(17, 99), bigLine.slice(99), '\n'])
  let bigParsed: { message?: { content?: Array<{ content?: string }> } } | null = null
  try {
    bigParsed = JSON.parse(big[0]?.line ?? '')
  } catch {
    bigParsed = null
  }
  check(
    '超长字符串截断后仍是合法 JSON',
    Boolean(bigParsed) && big[0]?.truncated === true,
    JSON.stringify(big[0]).slice(0, 200)
  )
  const kept = bigParsed?.message?.content?.[0]?.content ?? ''
  check('保留前缀并写明省略字符数', kept.startsWith('x'.repeat(64)) && /已省略 \d+ 字符/.test(kept))
  check('截断后的内容明显小于原文', kept.length < 200, String(kept.length))

  // 转义序列跨分块、且截断点落在字符串中间：结果仍必须是合法 JSON
  const escapedLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `${'"\\'.repeat(100)}tail` }] }
  })
  const escaped = read([
    escapedLine.slice(0, 60),
    escapedLine.slice(60, 61),
    escapedLine.slice(61)
  ])
  let escapedParsed: unknown = null
  try {
    escapedParsed = JSON.parse(escaped[0]?.line ?? '')
  } catch {
    escapedParsed = null
  }
  check('跨分块的转义序列仍能解析', Boolean(escapedParsed))

  const noNewline = read(['{"type":"result"}'])
  check(
    '最后一行没有换行也能交付',
    noNewline.length === 1 && noNewline[0].line === '{"type":"result"}'
  )
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs agent` 跑会自动带上）')
    app.exit(2)
    return
  }
  checkLineReader()

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
  // 渲染层打开仓库前会走「多实例认领」；harness 不走 index.ts，要自己把 broker 起起来
  await startInstanceBroker()

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
  await rm(join(ud, 'extensions-data'), { recursive: true, force: true })

  const noteText = '# 项目计划\n\n本周完成登录模块。\n'
  await writeFile(note, noteText, 'utf8')

  // ---------- fake Claude CLI ----------
  const fakeDir = join(ud, 'fake-claude')
  const fakeJs = join(REPO, 'verify', 'fixtures', 'fake-claude.js')
  // Windows 上 .cmd 由扩展用 cmd.exe 启动；POSIX 上必须是无扩展名的可执行脚本，
  // 否则 kindOf() 会把它当成 .cmd 去调 cmd.exe（Linux 上不存在）。
  const fakeCmd = join(fakeDir, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude')
  await mkdir(fakeDir, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(
      fakeCmd,
      [
        '@echo off',
        'set ELECTRON_RUN_AS_NODE=1',
        `"${process.execPath}" "${fakeJs}" %*`,
        'exit /b %ERRORLEVEL%',
        ''
      ].join('\r\n'),
      'utf8'
    )
  } else {
    await writeFile(
      fakeCmd,
      [
        '#!/bin/sh',
        `ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${fakeJs}" "$@"`,
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fakeCmd, 0o755)
  }
  const controlPath = join(fakeDir, 'control.json')
  const setScenario = async (
    scenario: string,
    sessionId = 'fake-session-1',
    marker = ''
  ): Promise<void> => {
    await writeFile(controlPath, JSON.stringify({ scenario, sessionId, marker }), 'utf8')
    await sleep(30)
  }
  await setScenario('ok')
  // 扩展宿主在启动时继承这个变量；fake CLI 再用它找 control/log 目录
  process.env.IMARK_AGENT_FAKE_DIR = fakeDir
  // 对话面板显示的默认模型来自后端配置文件；用沙箱目录，别读真实的 ~/.claude/settings.json
  const claudeConfigDir = join(ud, 'claude-config')
  await mkdir(claudeConfigDir, { recursive: true })
  await writeFile(
    join(claudeConfigDir, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_MODEL: 'fake-default-model' } }),
    'utf8'
  )
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

  const settingsSeed = {
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: note,
    openFiles: [note],
    marketUrl: '',
    autoSaveMode: 'off',
    extensions: {
      [CORE_ID]: {
        enabled: true,
        config: {
          [`${CORE_ID}.attachmentMaxMB`]: 32
        }
      },
      // 先禁用 provider：首屏断言“没有可用后端”时不进入宿主；随后动态启用。
      [CLAUDE_ID]: {
        enabled: false,
        config: {
          [`${CLAUDE_ID}.commandMode`]: 'manual',
          [`${CLAUDE_ID}.command`]: fakeCmd,
          [`${CLAUDE_ID}.timeoutSec`]: 30,
          [`${CLAUDE_ID}.maxTurns`]: 10
        }
      }
    }
  }
  await writeFile(join(ud, 'settings.json'), JSON.stringify(settingsSeed, null, 2), 'utf8')

  const coreEnvelope = JSON.parse(
    await readFile(join(REPO, 'src/main/market/builtin/imark.agent.imkpkg.json'), 'utf8')
  ) as unknown
  const claudeEnvelope = JSON.parse(
    await readFile(join(REPO, 'src/main/market/builtin/imark.claude-code.imkpkg.json'), 'utf8')
  ) as unknown

  let withoutCore = ''
  try {
    await installExtensionPackage(claudeEnvelope, {
      source: 'bundled',
      appVersion: APP_VERSION
    })
  } catch (err) {
    withoutCore = err instanceof Error ? err.message : String(err)
  }
  check(
    '未安装 Agent Core 时安装 Claude Code 被拒绝',
    withoutCore.includes(CLAUDE_ID) && withoutCore.includes(CORE_ID) && withoutCore.includes('未安装'),
    withoutCore
  )

  const installed = await installExtensionPackage(coreEnvelope, {
    source: 'bundled',
    appVersion: APP_VERSION
  })
  check('内置 imark.agent 包通过校验并安装', installed.manifest.publisher === 'imark')
  check('Agent Core 显示名正确', installed.manifest.displayName === 'Agent Core')
  const claudeInstalled = await installExtensionPackage(claudeEnvelope, {
    source: 'bundled',
    appVersion: APP_VERSION
  })
  check(
    '内置 imark.claude-code 包依赖 imark.agent',
    claudeInstalled.manifest.extensionDependencies?.includes(CORE_ID) === true
  )

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
  await service.startup()
  await sleep(800)

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
        /* 帧可能正在导航 */
      }
    }
    return null
  }

  async function waitFrame(selector: string, ms = 15_000): Promise<WebFrameMain | null> {
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

  const agentEval = <T>(code: string): Promise<T> => inFrame('.agent', code)
  const agentText = (selector: string): Promise<string> =>
    agentEval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
  const agentTextAll = (selector: string): Promise<string> =>
    agentEval<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)

  async function waitText(selector: string, part: string, ms = 10_000): Promise<boolean> {
    return waitInFrame(
      '.agent',
      `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').includes(${JSON.stringify(part)})`,
      ms
    )
  }

  async function waitAnyText(selector: string, part: string, ms = 10_000): Promise<boolean> {
    return waitInFrame(
      '.agent',
      `[...document.querySelectorAll(${JSON.stringify(selector)})].some(el => (el.textContent || '').includes(${JSON.stringify(part)}))`,
      ms
    )
  }

  async function clickByText(selector: string, text: string): Promise<boolean> {
    return agentEval<boolean>(
      `(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
        const node = nodes.find(item => (item.textContent || '').trim() === ${JSON.stringify(text)})
        if (!node) return false
        node.click()
        return true
      })()`
    )
  }

  /** fake CLI 的 stdin 现在是 stream-json，一行一条消息；取出本轮用户文本 */
  function promptText(invocation: Invocation | null): string {
    for (const line of (invocation?.stdin ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as {
          type?: string
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        if (value.type !== 'user') continue
        return (value.message?.content ?? [])
          .filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join('\n')
      } catch {
        /* 权限响应等其它行 */
      }
    }
    return ''
  }

  async function sendTurn(text: string): Promise<void> {
    await agentEval(
      `(() => {
        const input = document.querySelector('#input')
        input.value = ${JSON.stringify(text)}
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('#send').click()
        return true
      })()`
    )
  }

  async function readInvocations(): Promise<Invocation[]> {
    const entries = await readdir(fakeDir).catch(() => [])
    const out: Invocation[] = []
    for (const entry of entries) {
      if (!entry.startsWith('invocation-') || !entry.endsWith('.json')) continue
      try {
        const value = JSON.parse(await readFile(join(fakeDir, entry), 'utf8')) as Invocation
        out.push(value)
      } catch {
        /* 正在写 */
      }
    }
    return out.sort((a, b) => a.at - b.at)
  }

  async function waitInvocation(
    predicate: (item: Invocation) => boolean,
    ms = 10_000,
    includeVersion = false
  ): Promise<Invocation | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const list = (await readInvocations()).filter(item => includeVersion || !item.versionOnly)
      const found = list.find(predicate)
      if (found) return found
      await sleep(80)
    }
    return null
  }

  async function sessionDirs(): Promise<string[]> {
    const root = join(ud, 'extensions-data', CORE_ID, 'sessions')
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => join(root, entry.name))
  }

  async function readMeta(): Promise<Record<string, unknown> | null> {
    const dirs = await sessionDirs()
    if (dirs.length === 0) return null
    try {
      return JSON.parse(await readFile(join(dirs[0], 'meta.json'), 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async function waitMeta(predicate: (meta: Record<string, unknown>) => boolean, ms = 8000): Promise<Record<string, unknown> | null> {
    let last: Record<string, unknown> | null = null
    const until = Date.now() + ms
    while (Date.now() < until) {
      last = await readMeta()
      if (last && predicate(last)) return last
      await sleep(100)
    }
    return last
  }

  async function saveNow(): Promise<void> {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(300)
  }

  async function waitSource(expected: string, ms = 6000): Promise<string> {
    const until = Date.now() + ms
    let last = ''
    while (Date.now() < until) {
      wc.send(IPC.MenuCommand, 'file:save')
      await sleep(220)
      last = await readFile(note, 'utf8')
      if (last.trimEnd() === expected.trimEnd()) return last
    }
    return last
  }

  // ---------- 1. 打开面板 ----------

  console.log('\n【1】依赖、激活、无 provider 空状态')
  check('Markdown 编辑器已加载', await waitHost(`document.querySelector('.cm-editor')`, 10_000))
  const opened = await waitUntilAsync(async () => {
    try {
      await service.executeCommand(CMD_OPEN)
      return true
    } catch {
      return false
    }
  }, 10_000)
  check('imark.agent.openChat 命令已注册并执行', opened)
  check('侧边栏面板出现', await waitHost(`document.querySelector('.webview-panel-sidebar')`, 10_000))
  check('Agent webview 帧加载', Boolean(await waitFrame('.agent', 15_000)))
  check(
    '滚动条主题变量已注入',
    await agentEval<boolean>(
      `getComputedStyle(document.documentElement).getPropertyValue('--scrollbar-thumb-bg').trim() !== ''`
    )
  )
  check(
    '消息区使用全局滚动条样式（不是 thin）',
    await agentEval<boolean>(
      `getComputedStyle(document.querySelector('.agent-messages')).scrollbarWidth === 'auto'`
    )
  )
  check(
    '宿主标题栏显示 Agent Core',
    await waitHost(
      `document.querySelector('.webview-titlebar .webview-title')?.textContent?.trim() === 'Agent Core'`
    )
  )
  check('标题栏有状态点', await waitHost(`!!document.querySelector('.webview-titlebar .webview-status-dot')`))
  check('webview 内不再重复品牌行', !(await agentEval<boolean>(`!!document.querySelector('.agent-brand')`)))
  check('空状态提示出现', (await agentText('.agent-empty')).includes('Agent Core'))
  check('未启用 provider 时选择器给出占位', (await agentText('#provider')).includes('无可用后端'))
  check(
    '未启用 provider 时发送按钮禁用',
    await agentEval<boolean>(`document.querySelector('#send').disabled === true`)
  )
  check('未启用 provider 时有明确提示', await waitText('#banner', '未安装或未启用'))
  check('设置项与文件输入存在', await agentEval<boolean>(`!!document.querySelector('#file-input')`))

  console.log('\n【1b】启用 Claude Code：宿主重启、惰性激活')
  await service.setEnabled(CLAUDE_ID, true)
  const restarted = await waitUntilAsync(async () => {
    const frame = await findFrame('.agent')
    return !frame && service.isActivated(CORE_ID)
  }, 20_000)
  check('启用 Claude Code 后 Agent Core 随宿主重启重新激活', restarted)
  const reopened = await waitUntilAsync(async () => {
    try {
      await service.executeCommand(CMD_OPEN)
      return true
    } catch {
      return false
    }
  }, 20_000)
  check('重启后 openChat 命令可用', reopened)
  check('重启后 webview 帧加载', Boolean(await waitFrame('.agent', 15_000)))
  check('provider 选择器有 Claude Code', await waitText('#provider', 'Claude Code', 10_000))
  check(
    '模型只读显示配置文件里的默认模型',
    (await agentEval<string>(`document.querySelector('#model')?.tagName ?? ''`)) === 'SPAN' &&
      (await waitText('#model', '模型：fake-default-model', 10_000)),
    await agentText('#model')
  )
  // 改配置文件后重新打开面板：只读的默认模型要跟着变，而不是一直显示首次探测的结果
  await writeFile(
    join(claudeConfigDir, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_MODEL: 'fake-default-model-2' } }),
    'utf8'
  )
  await service.executeCommand(CMD_OPEN)
  check(
    '重新打开面板后默认模型跟随配置文件更新',
    await waitText('#model', '模型：fake-default-model-2', 10_000),
    await agentText('#model')
  )
  check(
    'provider 由 Core 惰性激活',
    await waitUntilAsync(() => service.isActivated(CLAUDE_ID), 15_000)
  )

  const versionInvocation = await waitInvocation(item => item.versionOnly, 10_000, true)
  check('fake Claude --version 被调用', Boolean(versionInvocation))
  check(
    'provider 探测未标记不可用',
    await waitInFrame(
      '.agent',
      `!document.querySelector('#provider').classList.contains('is-unavailable')`,
      10_000
    )
  )

  const claudeActions =
    (await service.getExtensionView(CLAUDE_ID))?.descriptor.contributes['imark.actions'] ?? []
  check(
    'Claude Code 声明了自己的检查动作',
    claudeActions.some(action => action.command === 'imark.claude-code.check'),
    JSON.stringify(claudeActions)
  )
  const coreActions =
    (await service.getExtensionView(CORE_ID))?.descriptor.contributes['imark.actions'] ?? []
  check('Agent Core 不再声明检测动作', coreActions.length === 0, JSON.stringify(coreActions))

  await service.executeCommand('imark.claude-code.check')
  const checkedView = await waitUntilAsync(async () => {
    const checked = await service.getExtensionView(CLAUDE_ID)
    return checked?.status.status === 'ok' && (checked.status.lastMessage ?? '').includes('可用：Claude Code')
  }, 10_000)
  check('Claude Code 自检结果写进自己的状态卡', checkedView)
  await sleep(400)
  const checkToasts = await evalHost<string[]>(
    `[...document.querySelectorAll('.toast')].map(el => el.textContent || '')`
  )
  check(
    '自检结果不弹右下角通知',
    !checkToasts.some(text => text.includes('可用：Claude Code')),
    JSON.stringify(checkToasts)
  )

  let oldCheck = ''
  try {
    await service.executeCommand('imark.agent.checkProvider')
  } catch (err) {
    oldCheck = err instanceof Error ? err.message : String(err)
  }
  check('Agent Core 的检测命令已移除', oldCheck.includes('未知命令'), oldCheck)

  // ---------- 2. 附件上传 ----------

  console.log('\n【2】附件分块上传与落盘')
  const uploaded = await agentEval<boolean>(
    `(() => {
      const bytes = new Uint8Array(300 * 1024)
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
      const file = new File([bytes], 'paper.pdf', { type: 'application/pdf' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const input = document.querySelector('#file-input')
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  check('触发文件选择', uploaded)
  const chipShown = await waitText('#attachments', 'paper.pdf', 30_000)
  if (!chipShown) {
    console.log('  [debug] banner:', await agentText('#banner'))
    console.log('  [debug] attachments:', await agentText('#attachments'))
  }
  check('附件 chip 出现', chipShown)
  check(
    '上传完成（不再显示进度）',
    await waitInFrame('.agent', `!document.querySelector('.agent-attach-chip.is-uploading')`, 30_000)
  )
  const metaAfterUpload = await waitMeta(
    meta => Array.isArray(meta.attachments) && (meta.attachments as unknown[]).length === 1,
    15_000
  )
  if (!metaAfterUpload) console.log('  [debug] meta:', JSON.stringify(await readMeta()))
  check('会话 meta 记录附件', Boolean(metaAfterUpload))
  const attachments = (metaAfterUpload?.attachments as Array<Record<string, unknown>>) ?? []
  const attachmentPath = typeof attachments[0]?.path === 'string' ? attachments[0].path : ''
  check('附件路径落在会话目录', attachmentPath.includes(join('extensions-data', CORE_ID, 'sessions')))
  const attachmentStat = attachmentPath ? await stat(attachmentPath).catch(() => null) : null
  check('附件字节数正确', attachmentStat?.size === 300 * 1024, String(attachmentStat?.size))
  const attachmentSha = attachmentPath
    ? createHash('sha256').update(await readFile(attachmentPath)).digest('hex')
    : ''
  check('附件 sha256 与 meta 一致', Boolean(attachmentSha) && attachmentSha === attachments[0]?.sha256)

  // 「添加本文档」：当前文档作为普通附件，和手动上传的文件一样处理
  check(
    '文档按钮显示当前文档名且可用',
    (await waitText('#attach-doc', '笔记.md', 5000)) &&
      (await agentEval<boolean>(`document.querySelector('#attach-doc')?.disabled === false`))
  )
  check(
    '「＋ 本文档」在「＋ 附件」左边',
    await agentEval<boolean>(`(() => {
      const doc = document.querySelector('#attach-doc')
      const attach = document.querySelector('#attach')
      return (
        !!doc && !!attach &&
        Boolean(doc.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
    })()`)
  )
  check(
    '点文档按钮加入当前文档',
    (await agentEval<boolean>(`(() => {
      const b = document.querySelector('#attach-doc')
      if (!b) return false
      b.click()
      return true
    })()`)) &&
      (await waitInFrame(
        '.agent',
        `document.querySelector('#attach-doc')?.classList.contains('is-added')`,
        10_000
      ))
  )
  check(
    '当前文档不在附件条里重复显示',
    await waitInFrame(
      '.agent',
      `![...document.querySelectorAll('#attachments .agent-attach-chip')]
        .some(el => (el.textContent || '').includes('笔记.md'))`,
      5000
    )
  )
  const metaAfterDoc = await waitMeta(
    meta => Array.isArray(meta.attachments) && (meta.attachments as unknown[]).length === 2,
    10_000
  )
  check('文档作为附件进入待发区', Boolean(metaAfterDoc))
  const docAttachment = ((metaAfterDoc?.attachments as Array<Record<string, unknown>>) ?? []).find(
    item => item.name === '笔记.md'
  )
  const docAttachmentPath = typeof docAttachment?.path === 'string' ? docAttachment.path : ''
  check('文档附件落在会话目录', docAttachmentPath.includes(join('extensions-data', CORE_ID, 'sessions')))
  const docSnapText = docAttachmentPath ? await readFile(docAttachmentPath, 'utf8').catch(() => '') : ''
  check('文档附件是打开时的快照', docSnapText === noteText, JSON.stringify(docSnapText.slice(0, 40)))

  // ---------- 3. 第一轮：流式 + 工具 + 产物 ----------

  console.log('\n【3】第一轮：流式、工具时间线、产物、prompt 路径')
  check(
    'ⓘ 图标在发送按钮左边',
    await agentEval<boolean>(`(() => {
      const btn = document.querySelector('#prompt-peek')
      const send = document.querySelector('#send')
      if (!btn || !send) return false
      return Boolean(btn.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
    })()`)
  )
  await agentEval(`(() => {
    const input = document.querySelector('#input')
    input.value = '请解析附件并总结'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#prompt-peek').dispatchEvent(new MouseEvent('mouseenter'))
    return true
  })()`)
  check(
    '悬停 ⓘ 显示系统规则 + 本轮 prompt',
    await waitInFrame(
      '.agent',
      `(() => {
        const panel = document.querySelector('#prompt-peek-panel')
        const text = document.querySelector('#prompt-peek-text')?.textContent ?? ''
        return (
          panel && !panel.classList.contains('hidden') &&
          text.includes('你在 iMark 的 Agent 面板中工作') &&
          text.includes('## 附件') &&
          text.includes('请解析附件并总结')
        )
      })()`,
      8000
    )
  )
  check(
    '提示词里是本轮附件的绝对路径',
    await agentEval<string>(
      `document.querySelector('#prompt-peek-text')?.textContent ?? ''`
    ).then(text => Boolean(attachmentPath) && text.includes(attachmentPath) && text.includes(docAttachmentPath))
  )
  check(
    '默认系统提示词来自 SYSTEM_PROMPT',
    await agentEval<string>(
      `document.querySelector('#prompt-peek-text')?.textContent ?? ''`
    ).then(text => text.startsWith(SYSTEM_PROMPT))
  )
  await agentEval(
    `document.querySelector('#prompt-peek').dispatchEvent(new MouseEvent('mouseleave'))`
  )
  await sleep(400)
  check(
    '移开后提示词面板隐藏',
    await agentEval<boolean>(
      `document.querySelector('#prompt-peek-panel').classList.contains('hidden')`
    )
  )

  // ---------- 3b. 设置页：系统提示词 ----------

  console.log('\n【3b】设置页：系统提示词（默认展示 / 自定义 / 恢复）')
  const PROMPT_GROUP = `[...document.querySelectorAll('.plugin-group')]
    .find(g => g.querySelector('.plugin-group-title')?.textContent.trim() === '系统提示词')`

  async function openAgentSettings(): Promise<boolean> {
    await evalHost(`(() => { document.querySelector('button[title^="设置"]')?.click(); return true })()`)
    if (!(await waitHost(`document.querySelector('.settings-dialog')`))) return false
    const clicked = await evalHost<boolean>(`(() => {
      const b = [...document.querySelectorAll('.settings-nav-item')]
        .find(x => x.textContent.includes('Agent Core'))
      if (!b) return false
      b.click()
      return true
    })()`)
    if (!clicked) return false
    return waitHost(`[...document.querySelectorAll('.plugin-group-title')]
      .some(h => h.textContent.trim() === '系统提示词')`)
  }

  async function closeSettings(): Promise<void> {
    await evalHost(`document.querySelector('.settings-close')?.click()`)
    await waitHost(`!document.querySelector('.settings-dialog')`)
  }

  async function hoverPeek(): Promise<void> {
    await agentEval(`(() => {
      const btn = document.querySelector('#prompt-peek')
      btn.dispatchEvent(new MouseEvent('mouseleave'))
      btn.dispatchEvent(new MouseEvent('mouseenter'))
      return true
    })()`)
  }

  check('扩展设置页出现「系统提示词」分组', await openAgentSettings())
  check(
    '文本域默认展示内置提示词',
    await waitHost(`(() => {
      const group = ${PROMPT_GROUP}
      const area = group?.querySelector('textarea.plugin-textarea')
      return !!area && area.value.trim() === ${JSON.stringify(SYSTEM_PROMPT.trim())}
    })()`)
  )
  check(
    '默认状态下「恢复默认」图标置灰',
    await waitHost(`(() => {
      const btn = ${PROMPT_GROUP}?.querySelector('.plugin-icon-btn-accent')
      return !!btn && btn.disabled && btn.title.includes('已是默认')
    })()`)
  )

  const customPrompt = '你是验收用的系统提示词：只回答「收到」。'
  await evalHost(`(() => {
    const area = ${PROMPT_GROUP}.querySelector('textarea.plugin-textarea')
    area.value = ${JSON.stringify(customPrompt)}
    area.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  check(
    '自定义后「恢复默认」图标可用',
    await waitHost(`(() => {
      const btn = ${PROMPT_GROUP}?.querySelector('.plugin-icon-btn-accent')
      return !!btn && !btn.disabled
    })()`)
  )
  await closeSettings()
  await hoverPeek()
  check(
    'ⓘ 预览用的是自定义提示词',
    await waitInFrame(
      '.agent',
      `(document.querySelector('#prompt-peek-text')?.textContent ?? '').startsWith(${JSON.stringify(customPrompt)})`,
      8000
    )
  )

  check('重新打开设置页', await openAgentSettings())
  await evalHost(`${PROMPT_GROUP}.querySelector('.plugin-icon-btn-accent').click()`)
  check(
    '点图标后文本域恢复内置提示词',
    await waitHost(`(() => {
      const area = ${PROMPT_GROUP}?.querySelector('textarea.plugin-textarea')
      return !!area && area.value.trim() === ${JSON.stringify(SYSTEM_PROMPT.trim())}
    })()`)
  )
  // number 输入框的原生加减按钮：深色主题下必须跟随主题着色，否则是一块白底
  const numberScheme = await evalHost<string>(`(() => {
    const root = document.documentElement
    const previous = root.dataset.theme
    root.dataset.theme = 'dark'
    const input = document.querySelector('.settings-dialog input[type="number"]')
    const scheme = input ? getComputedStyle(input).colorScheme : 'missing'
    root.dataset.theme = previous || 'light'
    return scheme
  })()`)
  check('深色主题下数字输入框的加减按钮跟随主题（无白底）', numberScheme === 'dark', numberScheme)

  await closeSettings()
  await hoverPeek()
  check(
    '恢复默认后 ⓘ 预览回到 SYSTEM_PROMPT',
    await waitInFrame(
      '.agent',
      `(document.querySelector('#prompt-peek-text')?.textContent ?? '').startsWith(${JSON.stringify(SYSTEM_PROMPT)})`,
      8000
    )
  )
  await agentEval(
    `document.querySelector('#prompt-peek').dispatchEvent(new MouseEvent('mouseleave'))`
  )
  await sleep(400)

  await setScenario('ok', 'fake-session-1', 'T1')
  await sendTurn('请解析附件并总结')
  check('用户消息出现', await waitAnyText('.agent-msg.user', '请解析附件并总结', 8000))
  check('助手最终消息出现', await waitAnyText('.agent-msg.assistant', 'T1', 20_000))
  check(
    '没有任务模式选择器',
    await agentEval<boolean>(`!document.querySelector('#task-mode')`)
  )
  check(
    '普通回复的操作只剩「复制 / 替换整篇」',
    await agentEval<boolean>(`(() => {
      const labels = [...document.querySelectorAll('.agent-msg.assistant .agent-actions .agent-small')]
        .map(b => b.textContent.trim())
      return labels.length === 2 && labels[0] === '复制' && labels[1] === '替换整篇'
    })()`)
  )
  check(
    '输出完成后仍保留思考过程',
    await waitInFrame(
      '.agent',
      `(() => {
        const body = document.querySelector('.agent-msg.assistant .agent-body')
        if (!body) return false
        const kids = [...body.children]
        const tools = kids.findIndex(k => k.classList.contains('agent-tools-wrap'))
        const think = kids.findIndex(k => k.classList.contains('agent-thinking'))
        const text = kids.findIndex(k => k.classList.contains('agent-text'))
        const content = body.querySelector('.agent-thinking-text')?.textContent || ''
        return think >= 0 && tools > think && text > tools && content.includes('先看看附件')
      })()`,
      8000
    )
  )
  check(
    '助手回复有底框',
    await agentEval<boolean>(`(() => {
      const el = document.querySelector('.agent-msg.assistant .agent-text')
      if (!el) return false
      const style = getComputedStyle(el)
      return style.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(style.borderTopWidth) > 0
    })()`)
  )
  // 走应用自己的复制兜底（webview 里 navigator.clipboard 可能被拒）。
  // 合成 click 没有用户手势，系统剪贴板内容无法在这里断言；只验证反馈。
  const copyClicked = await agentEval<boolean>(`(() => {
    const b = [...document.querySelectorAll('.agent-msg.assistant .agent-actions .agent-small')]
      .find(x => x.textContent.trim() === '复制')
    if (!b) return false
    b.click()
    return true
  })()`)
  check(
    '点复制后提示已复制',
    copyClicked &&
      (await waitInFrame('.agent', `document.querySelector('#banner-text')?.textContent === '已复制'`, 5000))
  )
  await agentEval(`document.querySelector('#banner-close')?.click()`)
  check('工具时间线出现', (await agentTextAll('.agent-tools')).includes('Bash'))
  check('工具结果出现', (await agentTextAll('.agent-tools')).includes('pdftotext'))
  check(
    '工具活动排在回答框上方',
    await agentEval<boolean>(`(() => {
      const body = document.querySelector('.agent-msg.assistant:not(.is-streaming) .agent-body')
      const wrap = body?.querySelector('.agent-tools-wrap')
      const text = body?.querySelector('.agent-text')
      if (!wrap || !text) return false
      return Boolean(wrap.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)
    })()`)
  )
  check('产物列表出现', (await agentTextAll('.agent-artifacts')).includes('summary.md'))

  const firstInvocation = await waitInvocation(item => item.argv.includes('--session-id'))
  check('fake CLI 收到 turn', Boolean(firstInvocation))
  const argv = firstInvocation?.argv ?? []
  check('使用 -p / stream-json', argv.includes('-p') && argv.includes('stream-json'))
  check(
    '输入与输出都走 stream-json',
    argv.includes('--input-format') && argv.filter(item => item === 'stream-json').length >= 2,
    argv.join(' ')
  )
  check('授权询问走 stdio', argv.includes('--permission-prompt-tool=stdio'), argv.join(' '))
  check('首轮使用 --session-id', argv.includes('--session-id') && !argv.includes('--resume'))
  check(
    '不传权限模式或工具白名单参数',
    !argv.some(arg =>
      [
        '--restricted',
        '--safe-mode',
        '--tools',
        '--allowedTools',
        '--disallowedTools',
        '--permission-mode',
        '--permission-prompts',
        '--add-dir'
      ].includes(arg)
    ),
    argv.join(' ')
  )
  check('prompt 走 stdin（不是 --append-system-prompt）', !argv.includes('--append-system-prompt'))
  const firstPrompt = promptText(firstInvocation)
  check('prompt 含附件绝对路径', firstPrompt.includes(attachmentPath), firstPrompt.slice(0, 300))
  check(
    'prompt 含手动添加的文档附件',
    Boolean(docAttachmentPath) && firstPrompt.includes(docAttachmentPath)
  )
  check(
    'prompt 不含自动文档快照',
    !firstPrompt.includes('document.md') && !firstPrompt.includes('当前文档快照')
  )
  check(
    'prompt 不含 300KB 附件内容/base64',
    (firstInvocation?.stdin.length ?? 0) < 20_000 && !(firstInvocation?.stdin.includes(Buffer.alloc(300 * 1024, 0).toString('base64').slice(0, 200)) ?? false)
  )

  const metaAfterTurn = await waitMeta(meta => meta.providerSessionId === 'fake-session-1')
  check('会话保存 providerSessionId', Boolean(metaAfterTurn))
  check(
    '会话名取自第一条用户消息',
    await waitInFrame(
      '.agent',
      `[...document.querySelectorAll('#session-menu .agent-session-item')]
        .some(row => row.dataset.id && (row.querySelector('.agent-session-name')?.textContent || '').trim() === '请解析附件并总结')`,
      8000
    ),
    await agentEval<string>(
      `[...document.querySelectorAll('#session-menu .agent-session-name')].map(o => o.textContent.trim()).join(' / ')`
    )
  )
  check('会话 messageCount = 2', metaAfterTurn?.messageCount === 2, String(metaAfterTurn?.messageCount))
  check('发送后待发附件清空', metaAfterTurn?.attachmentCount === 0, String(metaAfterTurn?.attachmentCount))
  check(
    '发送后附件从输入框下方消失',
    await waitInFrame(
      '.agent',
      `document.querySelectorAll('#attachments .agent-attach-chip').length === 0`,
      8000
    )
  )
  check(
    '附件显示在用户消息下方',
    await waitInFrame(
      '.agent',
      `(() => {
        const names = [...document.querySelectorAll('.agent-msg.user .agent-msg-attachment')]
          .map(el => (el.textContent || '').trim())
        return names.some(name => name.includes('paper.pdf')) && names.some(name => name.includes('笔记.md'))
      })()`,
      8000
    )
  )
  const messagesPath = join(await sessionDirs().then(dirs => dirs[0]), 'messages.jsonl')
  const messages = (await readFile(messagesPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>)
  check('messages.jsonl 有 user/assistant', messages.length === 2 && messages[0].role === 'user' && messages[1].role === 'assistant')
  check(
    '用户消息记录本条附件',
    Array.isArray(messages[0]?.attachments) &&
      (messages[0].attachments as Array<{ name?: string }>).map(item => item.name).sort().join(',') ===
        'paper.pdf,笔记.md'
  )
  check(
    'assistant 记录思考过程',
    typeof messages[1]?.thinking === 'string' && (messages[1].thinking as string).includes('先看看附件'),
    JSON.stringify(messages[1]?.thinking ?? '')
  )
  check('assistant 记录工具调用', Array.isArray(messages[1]?.toolCalls) && (messages[1].toolCalls as unknown[]).length === 1)
  check('assistant 记录产物', Array.isArray(messages[1]?.artifacts) && (messages[1].artifacts as unknown[]).length >= 1)

  // ---------- 3b. 会话是全局的：切换文档不改变面板 ----------

  console.log('\n【3b】切换文档不影响会话')
  const secondNote = join(vault, '第二篇.md')
  await writeFile(secondNote, '# 第二篇\n\n另一篇文档。\n', 'utf8')
  const sessionLabels = (): Promise<string[]> =>
    agentEval<string[]>(
      `[...document.querySelectorAll('#session-menu .agent-session-name')].map(o => o.textContent.trim())`
    )
  const selectedSession = (): Promise<string> =>
    agentEval<string>(`document.querySelector('#session-label')?.textContent?.trim() ?? ''`)
  const hasSummaryArtifact = (): Promise<boolean> =>
    agentEval<boolean>(
      `[...document.querySelectorAll('.agent-artifact')]
        .some(item => (item.textContent || '').includes('summary.md'))`
    )

  wc.send(IPC.OpenFileFromSystem, secondNote)
  const switchedDoc = await waitText('#attach-doc', '第二篇.md', 10_000)
  await sleep(500)
  const labelsAfterSwitch = await sessionLabels()
  check(
    '切到另一篇文档：会话列表与当前会话都不变',
    switchedDoc &&
      (await selectedSession()) === '请解析附件并总结' &&
      !labelsAfterSwitch.includes('新会话') &&
      (await hasSummaryArtifact()),
    `${await selectedSession()} | ${labelsAfterSwitch.join(' / ')}`
  )

  await setScenario('ok', 'fake-session-1', 'T9')
  await sendTurn('跨文档继续')
  check(
    '切换文档后旧会话仍可发送（不再提示文档不一致）',
    (await waitAnyText('.agent-msg.assistant', 'T9', 20_000)) &&
      !(await agentText('#banner')).includes('不一致'),
    await agentText('#banner')
  )

  check(
    '点 + 新建会话',
    await agentEval<boolean>(`(() => {
      const b = document.querySelector('#new-session')
      if (!b) return false
      b.click()
      return true
    })()`)
  )
  check(
    '新会话不绑定文档（显示为「新会话」），旧会话仍在列表',
    await waitInFrame(
      '.agent',
      `(() => {
        const labels = [...document.querySelectorAll('#session-menu .agent-session-name')].map(o => o.textContent.trim())
        return (
          labels.includes('请解析附件并总结') &&
          labels.includes('新会话') &&
          document.querySelector('#session-label')?.textContent.trim() === '新会话'
        )
      })()`,
      10_000
    ),
    await agentText('#session-label')
  )

  // 同一附件在另一个会话里只占一份磁盘：blob + 各会话硬链接
  await agentEval(`(() => {
    const bytes = new Uint8Array(300 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const file = new File([bytes], 'paper.pdf', { type: 'application/pdf' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector('#file-input')
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  check('新会话里再次上传同一附件', await waitText('#attachments', 'paper.pdf', 30_000))
  await waitInFrame('.agent', `!document.querySelector('.agent-attach-chip.is-uploading')`, 30_000)
  await sleep(300)
  const pdfPaths: string[] = []
  for (const dir of await sessionDirs()) {
    const names = await readdir(join(dir, 'attachments')).catch(() => [] as string[])
    for (const name of names) {
      if (name.endsWith('paper.pdf')) pdfPaths.push(join(dir, 'attachments', name))
    }
  }
  const inodes = await Promise.all(
    pdfPaths.map(async path => (await stat(path).catch(() => null))?.ino ?? 0)
  )
  check(
    '同一附件跨会话共享磁盘块（硬链接）',
    pdfPaths.length >= 2 && new Set(inodes).size === 1,
    JSON.stringify({ pdfPaths, inodes })
  )
  const blobs = await readdir(join(ud, 'extensions-data', CORE_ID, 'blobs')).catch(
    () => [] as string[]
  )
  check('附件内容只存一份 blob', blobs.includes(attachmentSha), JSON.stringify(blobs))

  wc.send(IPC.OpenFileFromSystem, note)
  const backToNote = await waitText('#attach-doc', '笔记.md', 10_000)
  await sleep(500)
  check(
    '切回文档也不切换当前会话',
    backToNote && (await selectedSession()) === '新会话',
    `${await selectedSession()} | ${(await sessionLabels()).join(' / ')}`
  )

  check(
    '手动选回原来的会话，内容仍在',
    (await agentEval<boolean>(`(() => {
      document.querySelector('#session').click()
      const item = [...document.querySelectorAll('#session-menu .agent-session-item')]
        .find(row => (row.querySelector('.agent-session-name')?.textContent || '').trim() === '请解析附件并总结')
      if (!item) return false
      item.querySelector('.agent-session-name').click()
      return true
    })()`)) && (await waitInFrame('.agent', `[...document.querySelectorAll('.agent-artifact')]
      .some(item => (item.textContent || '').includes('summary.md'))`, 10_000))
  )
  check(
    '重新打开会话仍显示思考过程',
    await waitInFrame(
      '.agent',
      `!!document.querySelector('.agent-msg.assistant .agent-thinking')`,
      8000
    )
  )

  // ---------- 4. 产物预览 + 写回 ----------

  console.log('\n【4】产物预览与写回')
  check(
    '点开 summary.md 预览',
    await agentEval<boolean>(
      `(() => {
        const row = [...document.querySelectorAll('.agent-artifact')].find(item => (item.textContent || '').includes('summary.md'))
        const button = row ? [...row.querySelectorAll('button')].find(item => (item.textContent || '').trim() === '预览') : null
        if (!button) return false
        button.click()
        return true
      })()`
    )
  )
  check('预览弹层出现', await waitInFrame('.agent', `!document.querySelector('#preview').classList.contains('hidden')`, 8000))
  check('预览内容正确', await waitText('#preview-body', '解析结果', 8000))
  check(
    '产物预览里的图片内联为 data URI',
    await waitInFrame(
      '.agent',
      `(() => {
        const img = document.querySelector('#preview-body img')
        return !!img && (img.getAttribute('src') || '').startsWith('data:image/png;base64,')
      })()`,
      8000
    )
  )
  check('关闭预览', await clickByText('#preview-close', '×'))
  check('点「替换整篇」', await clickByText('.agent-actions .agent-small', '替换整篇'))
  const expectedAfterApply = '# 结果\n\n已完成。\n\nT1'
  const afterApply = await waitSource(expectedAfterApply)
  check('结果写回文档', afterApply.trimEnd() === expectedAfterApply, JSON.stringify(afterApply))

  // ---------- 5. 第二轮：--resume ----------

  console.log('\n【5】第二轮 --resume')
  await setScenario('ok', 'fake-session-1', 'T2')
  await sendTurn('继续')
  check('第二轮助手消息出现', await waitAnyText('.agent-msg.assistant', 'T2', 20_000))
  const secondInvocation = await waitInvocation(item => item.argv.includes('--resume'))
  const secondArgv = secondInvocation?.argv ?? []
  check('第二轮使用 --resume fake-session-1', secondArgv.includes('--resume') && secondArgv.includes('fake-session-1'))
  check('第二轮不再传 --session-id', !secondArgv.includes('--session-id'))

  // ---------- 5b. Markdown 预览：公式与图片 ----------

  console.log('\n【5b】Markdown 预览：公式与图片')
  await setScenario(
    'ok',
    'fake-session-1',
    [
      '# 预览标题',
      '',
      'T3',
      '',
      '行内公式 $x^2$',
      '',
      '| 项目 | 取值 |',
      '| --- | --- |',
      '| 优化器 | Adam |',
      '',
      '![pixel](prepared/figures/pixel.png)'
    ].join('\n')
  )
  await sendTurn('预览测试')
  check('预览消息出现', await waitAnyText('.agent-msg.assistant', 'T3', 20_000))
  check(
    '公式渲染成 KaTeX（样式/字体已加载）',
    await waitInFrame(
      '.agent',
      `(() => {
        const el = [...document.querySelectorAll('.agent-msg.assistant .agent-text .katex')].pop()
        return !!el && getComputedStyle(el).fontFamily.includes('KaTeX_Main')
      })()`,
      10_000
    )
  )
  check(
    '回复里的图片内联为 data URI',
    await waitInFrame(
      '.agent',
      `(() => {
        const img = [...document.querySelectorAll('.agent-msg.assistant .agent-text img')].pop()
        return !!img && (img.getAttribute('src') || '').startsWith('data:image/png;base64,')
      })()`,
      10_000
    )
  )
  check(
    '标题与文档同字号（而非浏览器默认 h1）',
    await waitInFrame(
      '.agent',
      `(() => {
        const h = [...document.querySelectorAll('.agent-msg.assistant .agent-text h1')].pop()
        if (!h) return false
        const style = getComputedStyle(h)
        return parseFloat(style.fontSize) < 18 && Number(style.fontWeight) === 600
      })()`,
      10_000
    )
  )
  check(
    '表格带边框与表头底色',
    await waitInFrame(
      '.agent',
      `(() => {
        const cell = [...document.querySelectorAll('.agent-msg.assistant .agent-text td')].pop()
        const head = [...document.querySelectorAll('.agent-msg.assistant .agent-text th')].pop()
        if (!cell || !head) return false
        const border = getComputedStyle(cell).borderTopWidth
        const bg = getComputedStyle(head).backgroundColor
        return border !== '0px' && bg !== 'rgba(0, 0, 0, 0)'
      })()`,
      10_000
    )
  )

  // ---------- 6. 轮数按 assistant 消息计 ----------

  console.log('\n【6】同一条 assistant 消息拆成多条记录时不重复计轮')
  await setScenario('split-turns', 'fake-session-1', 'T4')
  // 工具事件很密（10 个工具、每个都有 start/result）。在页面里装一个观察器：
  // 工具块第一次出现就点开，然后盯住它是否被后续事件整块重建（节点身份变了）
  // 或重新关上。
  await agentEval(`(() => {
    const rec = { node: null, replaced: false, closed: false, max: 0 }
    const tick = () => {
      const live = document.querySelector('.agent-msg.is-streaming .agent-tools-wrap details.agent-tools')
      if (!live) return
      if (!rec.node) {
        rec.node = live
        live.open = true
      } else if (live !== rec.node) {
        rec.replaced = true
      } else if (!live.open) {
        rec.closed = true
      }
      const count = Number((live.querySelector('summary')?.textContent || '').match(/(\\d+)/)?.[1] || 0)
      rec.max = Math.max(rec.max, count)
    }
    new MutationObserver(tick).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open']
    })
    window.__toolPersist = rec
    return true
  })()`)
  await sendTurn('轮数统计回归')
  check(
    '思考过程先出现，工具活动不会插到它上面',
    await waitInFrame(
      '.agent',
      `(() => {
        const body = document.querySelector('.agent-msg.is-streaming .agent-body')
        if (!body) return false
        const kids = [...body.children]
        const tools = kids.findIndex(k => k.classList.contains('agent-tools-wrap'))
        const think = kids.findIndex(k => k.classList.contains('agent-thinking'))
        const text = kids.findIndex(k => k.classList.contains('agent-text'))
        return think >= 0 && tools > think && text > tools
      })()`,
      5000
    )
  )
  check('split-turns 触发 turn-limit', await waitAnyText('.agent-error', 'turn-limit', 20_000))
  await sleep(300)
  check(
    '工具活动展开后不被后续工具事件收起',
    await agentEval<boolean>(`(() => {
      const rec = window.__toolPersist
      return Boolean(rec && rec.node && !rec.replaced && !rec.closed && rec.max >= 2)
    })()`)
  )
  check(
    '轮末保留工具活动的展开状态',
    await agentEval<boolean>(`(() => {
      const msg = [...document.querySelectorAll('.agent-msg.assistant:not(.is-streaming)')].pop()
      const d = msg?.querySelector('.agent-tools-wrap details.agent-tools')
      return d?.open === true
    })()`)
  )
  const splitMessages = (await readFile(messagesPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const splitLast = splitMessages[splitMessages.length - 1] as
    | { toolCalls?: unknown[] }
    | undefined
  check(
    'maxTurns=10 时第 11 条消息才终止',
    Array.isArray(splitLast?.toolCalls) && splitLast.toolCalls.length === 10,
    String(splitLast?.toolCalls?.length)
  )

  // ---------- 6b. 思考过程流式滚动跟随 ----------

  console.log('\n【6b】思考过程流式输出时贴住底部')
  await setScenario('think-stream', 'fake-session-1', 'T5')
  await sendTurn('长思考滚动回归')
  check(
    '流式思考块展开后自动贴住最新一行',
    await waitInFrame(
      '.agent',
      `(() => {
        const d = document.querySelector('.agent-msg.is-streaming .agent-thinking')
        const box = d?.querySelector('.agent-thinking-text')
        if (!d || !box) return false
        if (!d.open) {
          d.open = true
          return false
        }
        const lines = ((box.textContent || '').match(/思考第 \\d+ 行/g) || []).length
        // 至少追加了 5 行、但还没写完：确认的是「边流边贴」，
        // 而不是流结束后的静态位置（结束后会重渲染成折叠块）
        if (lines < 5 || lines >= 60) return false
        return box.scrollHeight - box.scrollTop - box.clientHeight < 80
      })()`,
      15_000
    )
  )
  // 上面是「流到一半」的断言，必须等这一轮真正结束再进下一节 ——
  // 运行中 send 是禁用的，否则下一节的 auth 用例会被静默吞掉。
  check('长思考流结束后回到空闲', await waitAnyText('.agent-msg.assistant', '思考完成。', 20_000))

  // ---------- 6c. 大工具结果 ----------

  console.log('\n【6c】超过 16 MiB 的单行输出')
  await setScenario('large-line', 'fake-session-1', 'LARGE')
  await sendTurn('读取一个很大的结果')
  check('大行不再中断回合', await waitAnyText('.agent-msg.assistant', '大行通过 LARGE', 30_000))
  check(
    '大行里的工具结果被正常归一化',
    await waitInFrame(
      '.agent',
      `[...document.querySelectorAll('.agent-tool-result')]
        .some(el => !(el.textContent || '').includes('运行中'))`,
      10_000
    )
  )
  check(
    '面板没有「单行输出过大」错误',
    !(await agentText('.agent')).includes('单行输出过大')
  )

  // ---------- 7. 错误分类 ----------

  console.log('\n【7】auth / provider-unavailable 错误')
  await setScenario('auth')
  await sendTurn('认证测试')
  check('auth 错误显示在消息里', await waitAnyText('.agent-error', 'auth-required', 15_000))

  await rename(fakeCmd, `${fakeCmd}.bak`)
  await setScenario('ok')
  await sendTurn('缺失测试')
  check('provider-unavailable 错误显示在消息里', await waitAnyText('.agent-error', 'provider-unavailable', 15_000))
  await rename(`${fakeCmd}.bak`, fakeCmd)

  // ---------- 8. 取消 ----------

  console.log('\n【8】取消与子进程清理')
  await setScenario('slow')
  await sendTurn('取消测试')
  check('流式内容出现', await waitAnyText('.agent-msg.is-streaming', '正在读取附件', 15_000))
  check(
    '运行中显示加载指示',
    await waitInFrame(
      '.agent',
      `!!document.querySelector('.agent-msg.is-streaming .agent-loading .agent-spinner')`,
      5000
    )
  )
  check(
    '运行中标题栏状态点忙碌',
    await waitHost(`document.querySelector('.webview-status-dot')?.classList.contains('is-busy')`)
  )
  const slowInvocation = await waitInvocation(item => item.scenario === 'slow')
  const slowPid = slowInvocation?.pid ?? 0
  check('点停止', await agentEval<boolean>(`(() => { document.querySelector('#stop').click(); return true })()`))
  check('cancelled 消息出现', await waitAnyText('.agent-error', 'cancelled', 15_000))
  check(
    '结束后加载指示消失',
    await waitInFrame('.agent', `!document.querySelector('.agent-loading')`, 5000)
  )
  await sleep(2000)
  let alive = false
  if (slowPid) {
    try {
      process.kill(slowPid, 0)
      alive = true
    } catch {
      alive = false
    }
  }
  check('fake CLI 进程已结束', !alive, String(slowPid))
  check(
    '取消后状态点回到空闲',
    await waitHost(`!document.querySelector('.webview-status-dot')?.classList.contains('is-busy')`)
  )

  // ---------- 8b. 工具授权 ----------

  console.log('\n【8b】需要授权时由面板确认')
  await setScenario('permission-request', 'fake-session-1', 'P-ALLOW')
  await sendTurn('需要授权的操作')
  check(
    '授权确认框出现',
    await waitInFrame(
      '.agent',
      `!document.querySelector('#confirm').classList.contains('hidden')`,
      15_000
    )
  )
  const permissionText = await agentText('#confirm-message')
  check(
    '确认框点名工具与命令',
    permissionText.includes('Bash') && permissionText.includes('python -c'),
    permissionText
  )
  check('点允许', await clickByText('#confirm-ok', '允许'))
  check('允许后这一轮继续完成', await waitAnyText('.agent-msg.assistant', 'P-ALLOW', 20_000))
  const allowInvocation = await waitInvocation(
    item => item.marker === 'P-ALLOW' && item.stdin.includes('"behavior":"allow"'),
    10_000
  )
  check('允许决定写回 CLI', Boolean(allowInvocation), allowInvocation?.stdin.slice(-300) ?? '')

  await setScenario('permission-request', 'fake-session-1', 'P-DENY')
  await sendTurn('拒绝这个操作')
  check(
    '第二次授权确认框出现',
    await waitInFrame(
      '.agent',
      `!document.querySelector('#confirm').classList.contains('hidden')`,
      15_000
    )
  )
  check('点拒绝', await clickByText('#confirm-cancel', '拒绝'))
  check('拒绝后回合正常收尾', await waitAnyText('.agent-msg.assistant', 'P-DENY', 20_000))
  const denyInvocation = await waitInvocation(
    item => item.marker === 'P-DENY' && item.stdin.includes('"behavior":"deny"'),
    10_000
  )
  check('拒绝决定写回 CLI', Boolean(denyInvocation), denyInvocation?.stdin.slice(-300) ?? '')

  // ---------- 9. 依赖保护 ----------

  console.log('\n【9】依赖保护')
  let uninstallError = ''
  try {
    await service.uninstallExtension(CORE_ID)
  } catch (err) {
    uninstallError = err instanceof Error ? err.message : String(err)
  }
  check(
    'Core 被 Claude Code 依赖时拒绝卸载',
    uninstallError.includes(CLAUDE_ID) && uninstallError.includes('无法卸载'),
    uninstallError
  )
  check('拒绝卸载后 Core 仍在', Boolean(await service.getExtensionView(CORE_ID)))

  let disableError = ''
  try {
    await service.setEnabled(CORE_ID, false)
  } catch (err) {
    disableError = err instanceof Error ? err.message : String(err)
  }
  check(
    'Core 被已启用的 Claude Code 依赖时拒绝禁用',
    disableError.includes(CLAUDE_ID) && disableError.includes('无法禁用'),
    disableError
  )

  // ---------- 9b. 会话按仓库隔离 ----------

  console.log('\n【9b】会话按仓库隔离')
  const otherVault = join(ud, 'vault-b')
  await mkdir(otherVault, { recursive: true })
  await writeFile(join(otherVault, '另一仓库.md'), '# 另一仓库\n', 'utf8')

  const menuIds = (): Promise<string[]> =>
    agentEval<string[]>(
      `[...document.querySelectorAll('#session-menu .agent-session-item')]
        .map(row => row.dataset.id || '')`
    )
  const beforeIds = await menuIds()
  check('切换仓库前有会话', beforeIds.length > 0, JSON.stringify(beforeIds))

  await saveSettings({ vaultPath: otherVault })
  check(
    '切到另一个仓库：列表里只剩它自己的会话（这里为空）',
    await waitInFrame(
      '.agent',
      `document.querySelectorAll('#session-menu .agent-session-item').length === 0`,
      10_000
    ),
    JSON.stringify(await menuIds())
  )
  check(
    '空仓库显示「无会话」',
    await waitInFrame(
      '.agent',
      `document.querySelector('#session-label')?.textContent.includes('无会话') === true`,
      5000
    )
  )

  check(
    '在新仓库里新建会话',
    await agentEval<boolean>(`(() => {
      const button = document.querySelector('#new-session')
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)
  )
  check(
    '新仓库的列表里只有新建的这个会话',
    await waitInFrame(
      '.agent',
      `(() => {
        const rows = [...document.querySelectorAll('#session-menu .agent-session-item')]
        return rows.length === 1 &&
          (rows[0].querySelector('.agent-session-name')?.textContent || '').trim() === '新会话'
      })()`,
      10_000
    ),
    JSON.stringify(await menuIds())
  )
  const otherSessionId = (await menuIds())[0] ?? ''
  const otherMeta = otherSessionId
    ? JSON.parse(
        await readFile(
          join(ud, 'extensions-data', CORE_ID, 'sessions', otherSessionId, 'meta.json'),
          'utf8'
        )
      )
    : null
  check(
    '新会话记住了所属仓库',
    otherMeta?.workspace === workspaceKey(otherVault),
    JSON.stringify(otherMeta?.workspace)
  )

  await saveSettings({ vaultPath: vault })
  check(
    '切回原仓库：原来的会话都回来了',
    await waitInFrame(
      '.agent',
      `${JSON.stringify(beforeIds)}.every(id =>
        [...document.querySelectorAll('#session-menu .agent-session-item')]
          .some(row => row.dataset.id === id))`,
      10_000
    ),
    JSON.stringify(await menuIds())
  )
  check(
    '另一个仓库的新会话不会串过来',
    !(await menuIds()).includes(otherSessionId),
    JSON.stringify(await menuIds())
  )

  // ---------- 10. 删除会话 ----------

  console.log('\n【10】删除会话')

  interface SessionOption {
    value: string
    text: string
  }
  const sessionOptions = (): Promise<SessionOption[]> =>
    agentEval<SessionOption[]>(
      `[...document.querySelectorAll('#session-menu .agent-session-item')]
        .map(row => ({
          value: row.dataset.id || '',
          text: (row.querySelector('.agent-session-name')?.textContent || '').trim()
        }))`
    )
  const sessionDirExists = (id: string): Promise<boolean> =>
    stat(join(ud, 'extensions-data', CORE_ID, 'sessions', id))
      .then(() => true)
      .catch(() => false)
  /** 点某一行的垃圾桶；菜单收起时先展开，模拟真实操作 */
  const clickRowDelete = (id: string): Promise<boolean> =>
    agentEval<boolean>(
      `(() => {
        const menu = document.querySelector('#session-menu')
        if (menu.classList.contains('hidden')) document.querySelector('#session').click()
        const row = [...document.querySelectorAll('#session-menu .agent-session-item')]
          .find(item => item.dataset.id === ${JSON.stringify(id)})
        const button = row?.querySelector('.agent-session-delete')
        if (!button) return false
        button.click()
        return true
      })()`
    )

  const layout = await agentEval<{
    groupRight: number
    controlsRight: number
    groupLeft: number
    providerRight: number
  }>(
    `(() => {
      const group = document.querySelector('#session-group').getBoundingClientRect()
      const controls = document.querySelector('.agent-controls').getBoundingClientRect()
      const provider = document.querySelector('#provider').getBoundingClientRect()
      return {
        groupRight: group.right,
        controlsRight: controls.right,
        groupLeft: group.left,
        providerRight: provider.right
      }
    })()`
  )
  check(
    '会话下拉与新建按钮贴着头行右端',
    Math.abs(layout.controlsRight - layout.groupRight) < 1.5 && layout.groupLeft > layout.providerRight,
    JSON.stringify(layout)
  )
  check(
    '头行不再有单独的删除按钮',
    await agentEval<boolean>(`!document.querySelector('#delete-session')`)
  )
  check(
    '会话下拉里每个会话行都有垃圾桶图标',
    await agentEval<boolean>(`(() => {
      const rows = [...document.querySelectorAll('#session-menu .agent-session-item')]
      return rows.length > 0 && rows.every(row => row.querySelector('.agent-session-delete svg'))
    })()`)
  )

  const optionsBefore = await sessionOptions()
  const currentId = await agentEval<string>(
    `document.querySelector('#session-menu .agent-session-item.is-current')?.dataset.id ?? ''`
  )
  const target = optionsBefore.find(item => item.value === currentId) ?? optionsBefore[0]
  if (!target) throw new Error('删除会话测试前没有会话')
  check('删除前当前会话在列表里', Boolean(target.value) && optionsBefore.length > 0, target.text)
  check('删除前会话目录存在', await sessionDirExists(target.value), target.value)

  // webview 是 sandbox iframe（没有 allow-modals），原生 confirm 会被浏览器忽略，
  // 所以删除必须弹出面板自己的确认框 —— 这条用例防的就是「点了没反应」。
  check('点会话行的垃圾桶', await clickRowDelete(target.value))
  check(
    '点垃圾桶弹出自绘确认框',
    await waitInFrame('.agent', `!document.querySelector('#confirm').classList.contains('hidden')`)
  )
  const confirmMessage = await agentText('#confirm-message')
  check('确认框点名要删除的会话', confirmMessage.includes(target.text), confirmMessage)

  await clickByText('.agent-confirm-btn', '取消')
  check('取消后确认框关闭', await waitInFrame('.agent', `document.querySelector('#confirm').classList.contains('hidden')`))
  check(
    '取消后会话仍在列表里',
    (await sessionOptions()).some(item => item.value === target.value)
  )
  check('取消后会话目录仍在', await sessionDirExists(target.value))

  await clickRowDelete(target.value)
  await agentEval(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  )
  check('Esc 关闭确认框', await waitInFrame('.agent', `document.querySelector('#confirm').classList.contains('hidden')`))
  check(
    'Esc 后会话仍在列表里',
    (await sessionOptions()).some(item => item.value === target.value)
  )

  await clickRowDelete(target.value)
  await clickByText('.agent-confirm-btn', '删除')
  check(
    '确认后会话从列表移除',
    await waitInFrame(
      '.agent',
      `![...document.querySelectorAll('#session-menu .agent-session-item')].some(row => row.dataset.id === ${JSON.stringify(target.value)})`
    )
  )
  check(
    '确认后会话目录被删除',
    await waitUntilAsync(async () => !(await sessionDirExists(target.value)))
  )
  if (optionsBefore.length > 1) {
    check(
      '删除当前会话后自动打开另一个会话',
      await waitInFrame(
        '.agent',
        `(() => {
          const id = document.querySelector('#session-menu .agent-session-item.is-current')?.dataset.id ?? ''
          return id !== '' && id !== ${JSON.stringify(target.value)}
        })()`
      )
    )

    const remaining = (await sessionOptions())[0]
    if (remaining) {
      check('删除剩余的会话', await clickRowDelete(remaining.value))
      check(
        '第二次删除也弹确认框',
        await waitInFrame('.agent', `!document.querySelector('#confirm').classList.contains('hidden')`)
      )
      await clickByText('.agent-confirm-btn', '删除')
      check(
        '删除最后一个会话后提示无会话',
        await waitInFrame(
          '.agent',
          `(() => {
            const label = document.querySelector('#session-label')?.textContent.trim() ?? ''
            return label.includes('无会话') && document.querySelector('#session').disabled
          })()`
        )
      )
      check(
        '最后一个会话目录也被删除',
        await waitUntilAsync(async () => !(await sessionDirExists(remaining.value)))
      )
    }
  } else {
    check(
      '删除最后一个会话后提示无会话',
      await waitInFrame(
        '.agent',
        `document.querySelector('#session-label')?.textContent.includes('无会话') === true`
      )
    )
  }

  // ---------- 收尾 ----------

  stopInstanceBroker()
  await shutdownExtensions()
  if (!win.isDestroyed()) win.destroy()
  console.log(`\n[agent] ${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(async err => {
  console.error(err)
  try {
    stopInstanceBroker()
    await shutdownExtensions()
  } catch {
    /* ignore */
  }
  app.exit(1)
})
