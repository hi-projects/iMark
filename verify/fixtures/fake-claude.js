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
if (dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    let stdin = ''
    if (!versionOnly) {
      try {
        stdin = fs.readFileSync(0, 'utf8')
      } catch {
        stdin = ''
      }
    }
    fs.writeFileSync(
      path.join(dir, `invocation-${Date.now()}-${process.pid}.json`),
      `${JSON.stringify(
        {
          at: Date.now(),
          pid: process.pid,
          argv: args,
          cwd: process.cwd(),
          stdin,
          versionOnly,
          scenario: control.scenario || 'ok',
          hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY)
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  } catch {
    /* 日志失败不影响协议 */
  }
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
    '# 解析结果\n\n这是 fake Claude 写出的解析产物。\n',
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
