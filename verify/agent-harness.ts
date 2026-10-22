/**
 * Agent Core（imark.agent）+ Claude Code（imark.claude-code）端到端验收。
 *
 * 覆盖：
 *   1 依赖安装顺序、内置包安装、无 provider 时的空状态
 *   2 启用 provider 后的宿主重启、惰性激活、provider 探测（fake claude --version）
 *   3 附件分块上传、落盘、会话 meta
 *   4 turn：流式文本、工具时间线、prepared/ 产物、prompt 只含路径
 *   5 产物预览、结果写回、stale-doc 保护
 *   6 第二轮 --resume
 *   7 read-only 参数矩阵
 *   8 auth / provider-unavailable 错误分类
 *   9 取消：流式停止、子进程结束
 *  10 依赖保护：Core 被 Claude Code 依赖时不能卸载
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
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { installExtensionPackage } from '../src/main/extensions/installer'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'

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
  hasApiKey: boolean
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs agent` 跑会自动带上）')
    app.exit(2)
    return
  }

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
          [`${CORE_ID}.mode`]: 'read+parse',
          [`${CORE_ID}.attachmentMaxMB`]: 32
        }
      },
      // 先禁用 provider：首屏断言“没有可用后端”时不进入宿主；随后动态启用。
      [CLAUDE_ID]: {
        enabled: false,
        config: {
          [`${CLAUDE_ID}.command`]: fakeCmd,
          [`${CLAUDE_ID}.model`]: '',
          [`${CLAUDE_ID}.isolation`]: 'safe',
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
  check('标题显示 Agent Core', (await agentText('.agent-brand')).includes('Agent Core'))
  check('空状态提示出现', (await agentText('.agent-empty')).includes('Agent Core'))
  check('未启用 provider 时选择器给出占位', (await agentText('#provider')).includes('无可用后端'))
  check(
    '未启用 provider 时发送按钮禁用',
    await agentEval<boolean>(`document.querySelector('#send').disabled === true`)
  )
  check('未启用 provider 时有明确提示', (await agentText('#banner')).includes('未安装或未启用'))
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

  // ---------- 3. 第一轮：流式 + 工具 + 产物 ----------

  console.log('\n【3】第一轮：流式、工具时间线、产物、prompt 路径')
  await setScenario('ok', 'fake-session-1', 'T1')
  await sendTurn('请解析附件并总结')
  check('用户消息出现', await waitAnyText('.agent-msg.user', '请解析附件并总结', 8000))
  check('助手最终消息出现', await waitAnyText('.agent-msg.assistant', 'T1', 20_000))
  check('工具时间线出现', (await agentTextAll('.agent-tools')).includes('Bash'))
  check('工具结果出现', (await agentTextAll('.agent-tools')).includes('pdftotext'))
  check('产物列表出现', (await agentTextAll('.agent-artifacts')).includes('summary.md'))

  const firstInvocation = await waitInvocation(item => item.argv.includes('--session-id'))
  check('fake CLI 收到 turn', Boolean(firstInvocation))
  const argv = firstInvocation?.argv ?? []
  check('使用 -p / stream-json', argv.includes('-p') && argv.includes('stream-json'))
  check('首轮使用 --session-id', argv.includes('--session-id') && !argv.includes('--resume'))
  check('read+parse 允许 Bash/Write', argv.includes('Bash') || argv.join(' ').includes('Bash'))
  const allowedIndex = argv.indexOf('--allowedTools')
  const allowedValue = allowedIndex >= 0 ? argv[allowedIndex + 1] ?? '' : ''
  check(
    'allowedTools 值未被 .cmd 引号污染',
    allowedValue.includes('Read,Glob,Grep,Write') && !allowedValue.includes('"'),
    allowedValue.slice(0, 160)
  )
  check('prompt 走 stdin（不是 --append-system-prompt）', !argv.includes('--append-system-prompt'))
  check('prompt 含附件绝对路径', firstInvocation?.stdin.includes(attachmentPath) === true)
  check('prompt 含 document.md', firstInvocation?.stdin.includes('document.md') === true)
  check(
    'prompt 不含 300KB 附件内容/base64',
    (firstInvocation?.stdin.length ?? 0) < 20_000 && !(firstInvocation?.stdin.includes(Buffer.alloc(300 * 1024, 0).toString('base64').slice(0, 200)) ?? false)
  )

  const metaAfterTurn = await waitMeta(meta => meta.providerSessionId === 'fake-session-1')
  check('会话保存 providerSessionId', Boolean(metaAfterTurn))
  check('会话 messageCount = 2', metaAfterTurn?.messageCount === 2, String(metaAfterTurn?.messageCount))
  check('会话保留附件', metaAfterTurn?.attachmentCount === 1, String(metaAfterTurn?.attachmentCount))
  const messagesPath = join(await sessionDirs().then(dirs => dirs[0]), 'messages.jsonl')
  const messages = (await readFile(messagesPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line) as Record<string, unknown>)
  check('messages.jsonl 有 user/assistant', messages.length === 2 && messages[0].role === 'user' && messages[1].role === 'assistant')
  check('assistant 记录工具调用', Array.isArray(messages[1]?.toolCalls) && (messages[1].toolCalls as unknown[]).length === 1)
  check('assistant 记录产物', Array.isArray(messages[1]?.artifacts) && (messages[1].artifacts as unknown[]).length >= 1)

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

  // ---------- 6. read-only 参数 ----------

  console.log('\n【6】read-only 参数矩阵')
  await agentEval(
    `(() => {
      const select = document.querySelector('#permission')
      select.value = 'read-only'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  const readOnlyMeta = await waitMeta(meta => meta.mode === 'read-only', 5000)
  check('会话切换到 read-only', readOnlyMeta?.mode === 'read-only', String(readOnlyMeta?.mode))
  await setScenario('ok', 'fake-session-1', 'T3')
  await sendTurn('只读测试')
  check('read-only 助手消息出现', await waitAnyText('.agent-msg.assistant', 'T3', 20_000))
  const readOnlyInvocation = await waitInvocation(item => item.argv.includes('--restricted'))
  const readOnlyArgv = readOnlyInvocation?.argv ?? []
  const toolsIndex = readOnlyArgv.indexOf('--tools')
  const readOnlyTools = toolsIndex >= 0 ? readOnlyArgv[toolsIndex + 1] ?? '' : ''
  check('read-only 传 --restricted', readOnlyArgv.includes('--restricted'))
  check('read-only 工具只读', readOnlyTools === 'Read,Glob,Grep', readOnlyTools)
  check('read-only 不含 Bash 白名单', !readOnlyArgv.join(' ').includes('Bash('))

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
  const slowInvocation = await waitInvocation(item => item.scenario === 'slow')
  const slowPid = slowInvocation?.pid ?? 0
  check('点停止', await agentEval<boolean>(`(() => { document.querySelector('#stop').click(); return true })()`))
  check('cancelled 消息出现', await waitAnyText('.agent-error', 'cancelled', 15_000))
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

  // ---------- 9. 行首菜单 generate 意图 ----------

  console.log('\n【9】行首菜单 generate 意图')
  await setScenario('ok', 'fake-session-1', 'T4')
  await service.executeCommand('imark.agent.generate', [
    {
      values: { prompt: '请生成一段测试内容' },
      line: 2,
      source: 'lineMenu'
    }
  ])
  check('行首菜单触发的生成消息出现', await waitAnyText('.agent-msg.assistant', 'T4', 20_000))
  const menuInvocation = await waitInvocation(item => item.stdin.includes('请生成一段测试内容'))
  check('generate 要求进入 stdin', Boolean(menuInvocation))
  check('prompt 标记本次任务为生成', menuInvocation?.stdin.includes('本次任务：生成') === true)
  check(
    'composer 任务模式切到 generate',
    (await agentEval<string>(`document.querySelector('#task-mode').value`)) === 'generate'
  )
  check('结果按钮带行首菜单目标', await waitAnyText('.agent-actions', '插入第 2 行后', 8000))

  // ---------- 10. beautify 命令 ----------

  console.log('\n【10】beautify 命令')
  await setScenario('ok', 'fake-session-1', 'T5')
  await service.executeCommand('imark.agent.beautify')
  check('beautify 消息出现', await waitAnyText('.agent-msg.assistant', 'T5', 20_000))
  const beautyInvocation = await waitInvocation(item => item.stdin.includes('本次任务：美化'))
  check('beautify prompt 标记美化', Boolean(beautyInvocation))

  // ---------- 11. 依赖保护 ----------

  console.log('\n【11】依赖保护')
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

  // ---------- 收尾 ----------

  await shutdownExtensions()
  if (!win.isDestroyed()) win.destroy()
  console.log(`\n[agent] ${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(async err => {
  console.error(err)
  try {
    await shutdownExtensions()
  } catch {
    /* ignore */
  }
  app.exit(1)
})
