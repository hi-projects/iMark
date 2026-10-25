#!/usr/bin/env node
/**
 * 假的 Claude Code CLI，供 verify/agent-harness.ts 使用。
 *
 * 不是产品代码：只模拟 `-p --output-format stream-json` 的少量事件，
 * 并把每次调用的 argv/cwd/stdin 写到 IMARK_AGENT_FAKE_DIR 下，供 harness 断言。
 *
 * 用 Electron 的 ELECTRON_RUN_AS_NODE 运行（见 harness 生成的 .cmd），
 * 这样 Windows 上不需要额外的 node.exe。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const dir = process.env.IMARK_AGENT_FAKE_DIR || ''
const controlPath = dir ? path.join(dir, 'control.json') : ''
let control = { scenario: 'ok', sessionId: 'fake-session-1' }
try {
  if (controlPath) control = { ...control, ...JSON.parse(fs.readFileSync(controlPath, 'utf8')) }
} catch {
  /* 默认 ok */
}

const versionOnly = args.includes('--version')

// 真实 CLI 在 --input-format stream-json 下会一直读 stdin（权限决定也走这里），
// 所以假 CLI 不能再用 readFileSync(0) 等 EOF：边读边记，并在收到控制响应时唤醒场景。
let stdinText = ''
const controlWaiters = new Map()
const invocationPath =
  dir && !versionOnly
    ? path.join(dir, `invocation-${Date.now()}-${process.pid}.json`)
    : ''

function writeInvocation() {
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const payload = {
      at: Date.now(),
      pid: process.pid,
      argv: args,
      cwd: process.cwd(),
      stdin: stdinText,
      versionOnly,
      scenario: control.scenario || 'ok',
      marker: control.marker || '',
      hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY)
    }
    fs.writeFileSync(
      invocationPath || path.join(dir, `invocation-${Date.now()}-${process.pid}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8'
    )
  } catch {
    /* 日志失败不影响协议 */
  }
}

writeInvocation()

if (!versionOnly) {
  const readline = require('node:readline')
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', line => {
    stdinText += `${stdinText ? '\n' : ''}${line}`
    writeInvocation()
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (parsed && parsed.type === 'control_response') {
      const id = parsed.response && parsed.response.request_id
      const waiter = controlWaiters.get(id)
      if (waiter) {
        controlWaiters.delete(id)
        waiter(parsed.response)
      }
    }
  })
}

function waitControlResponse(id, ms = 20000) {
  return new Promise(resolve => {
    controlWaiters.set(id, resolve)
    setTimeout(() => {
      if (controlWaiters.delete(id)) resolve(null)
    }, ms).unref?.()
  })
}

if (versionOnly) {
  process.stdout.write('2.1.999 (fake Claude Code)\n')
  process.exit(0)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const sessionId = control.sessionId || 'fake-session-1'
const scenario = control.scenario || 'ok'
const marker = control.marker || ''

function init() {
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'fake-model',
    tools: ['Read', 'Bash', 'Write']
  })
}

function text(delta) {
  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: delta }
    }
  })
}

function toolUse(id, command) {
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: `运行 ${command}` },
        { type: 'tool_use', id, name: 'Bash', input: { command } }
      ]
    }
  })
}

function toolResult(id, content, isError = false) {
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: isError,
          content: [{ type: 'text', text: content }]
        }
      ]
    }
  })
}

function result(textValue, isError = false, extra = {}) {
  emit({
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result: textValue,
    session_id: sessionId,
    usage: { input_tokens: 12, output_tokens: 8 },
    total_cost_usd: 0.001,
    ...extra
  })
}

function writeArtifacts() {
  const prepared = path.join(process.cwd(), 'prepared')
  fs.mkdirSync(path.join(prepared, 'figures'), { recursive: true })
  fs.writeFileSync(
    path.join(prepared, 'summary.md'),
    '# 解析结果\n\n这是 fake Claude 写出的解析产物。\n\n![pixel](figures/pixel.png)\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(prepared, 'figures', 'pixel.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=',
      'base64'
    )
  )
}

function hasResume() {
  return args.includes('--resume')
}

async function main() {
  if (scenario === 'auth') {
    process.stderr.write('Error: invalid api key; please run /login\n')
    process.exitCode = 2
    // provider 会一直开着 stdin（权限决定要走这里）；真实 CLI 认证失败会直接退出，
    // 这里也要关掉 stdin，否则 readline 让进程一直挂着，宿主只能等超时。
    process.stdin.destroy()
    return
  }

  if (scenario === 'resume-missing' && hasResume()) {
    init()
    result('No conversation found with session ID', true, { subtype: 'error_during_execution' })
    process.exitCode = 1
    return
  }

  if (scenario === 'permission') {
    init()
    toolUse('tu-perm', 'pdftotext paper.pdf -')
    result('工具被拒绝', true, {
      permission_denials: [{ tool_name: 'Bash' }]
    })
    return
  }

  if (scenario === 'permission-request') {
    // 复刻真实 CLI：先发起工具调用，再通过 control_request 询问宿主，
    // 必须等到 control_response 才继续。
    init()
    toolUse('tu-perm', 'python -c "print(1)"')
    const requestId = `perm-${marker || 'default'}`
    emit({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tu-perm',
        input: { command: 'python -c "print(1)"' }
      }
    })
    const response = await waitControlResponse(requestId)
    const decision = response && response.response
    const allowed = Boolean(decision && decision.behavior === 'allow')
    toolResult(
      'tu-perm',
      allowed ? 'allowed output' : (decision && decision.message) || 'denied',
      !allowed
    )
    result(`${allowed ? '执行完成' : '已拒绝'} ${marker}`)
    return
  }

  if (scenario === 'max-turns') {
    init()
    for (let i = 0; i < 8; i++) {
      toolUse(`tu-${i}`, `python worker.py ${i}`)
      toolResult(`tu-${i}`, `done ${i}`)
      await sleep(20)
    }
    result('不该走到这里')
    await new Promise(() => undefined)
    return
  }

  if (scenario === 'split-turns') {
    // 真实 CLI 在 --include-partial-messages 下会把同一条 assistant 消息按内容块
    // 拆成多条记录（thinking / tool_use 各一条），它们共享 message.id。
    init()
    for (let i = 0; i < 12; i++) {
      const messageId = `msg-split-${i}`
      emit({
        type: 'assistant',
        message: {
          id: messageId,
          role: 'assistant',
          content: [{ type: 'thinking', thinking: `思考 ${i}` }]
        }
      })
      await sleep(20)
      emit({
        type: 'assistant',
        message: {
          id: messageId,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: `tu-split-${i}`,
              name: 'Bash',
              input: { command: `python worker.py ${i}` }
            }
          ]
        }
      })
      await sleep(20)
      toolResult(`tu-split-${i}`, `done ${i}`)
      await sleep(20)
    }
    result('不该走到这里')
    await new Promise(() => undefined)
    return
  }

  if (scenario === 'think-stream') {
    // 思考过程按增量流出，长到足以撑满 220px 的滚动框：
    // webview 需要一边追加一边把块内滚动条贴到底部。
    init()
    for (let i = 1; i <= 60; i++) {
      emit({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: `思考第 ${i} 行：正在检查上下文与约束。\n` }
        }
      })
      await sleep(25)
    }
    result('思考完成。')
    return
  }

  if (scenario === 'large-line') {
    // 单个工具结果（如整份 PDF 的 base64）会落在同一行。17 MiB 的字符串
    // 会被宿主流式截断，回合必须继续，而不是报「单行输出过大」。
    init()
    toolUse('tu-large', 'cat big.txt')
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-large',
            content: [{ type: 'text', text: 'A'.repeat(17 * 1024 * 1024) }]
          }
        ]
      }
    })
    result(`大行通过 ${marker}`)
    return
  }

  if (scenario === 'slow' || scenario === 'timeout') {
    init()
    text('正在读取附件')
    await sleep(30)
    toolUse('tu-slow', 'pdftotext paper.pdf -')
    await sleep(30)
    toolResult('tu-slow', 'slow parser output')
    await sleep(30)
    text('……')
    await new Promise(() => undefined)
    return
  }

  init()
  await sleep(20)
  emit({
    type: 'assistant',
    message: {
      id: 'msg-think-ok',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '先看看附件里有什么，再决定怎么整理。' }]
    }
  })
  await sleep(20)
  text('正在读取附件。')
  await sleep(20)
  toolUse('tu-1', 'pdftotext paper.pdf -')
  await sleep(20)
  toolResult('tu-1', 'extracted text from paper')
  await sleep(20)
  text('已解析附件，开始整理。')
  await sleep(20)
  writeArtifacts()
  result(`# 结果\n\n已完成。${marker ? `\n\n${marker}` : ''}\n`)
}

void main().catch(err => {
  process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
