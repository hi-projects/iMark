#!/usr/bin/env node
/**
 * `npm run dev` 的启动壳。
 *
 * 存在的理由只有一个:Electron 44.7.0 的 Windows 包没有随附 crashpad_handler.exe,
 * Chromium 每次启动都会向 stderr 打印
 * `[....:ERROR:third_party\crashpad\...\registration_protocol_win.cc:108] CreateFile ... (0x2)`
 * (崩溃上报的命名管道不存在)。
 *
 * 这条日志**在崩溃上报初始化阶段**就打出来了,早于 Chromium 的日志级别设置,
 * 所以开关也压不住。它在功能上无害,只是很吵。这里对 electron-vite(以及它继承
 * 同一个 stderr 的 Electron 子进程)的 stderr 做**逐行过滤**,只丢弃包含
 * `registration_protocol_win.cc` 的那一行;其它输出(主进程 console.log、扩展日志、
 * 渲染层 console-message、真正的错误)原样保留。不要用 `--log-level=3` 一刀切,
 * 那会把 GPU/网络等真正有用的错误也一起藏掉。
 *
 * 调试时想看原始输出:`IMARK_SHOW_CRASHPAD=1 npm run dev`。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronVite = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')

if (!process.env.ELECTRON_CLI_ARGS) {
  process.env.ELECTRON_CLI_ARGS = JSON.stringify([
    '--disable-breakpad',
    '--disable-crash-reporter'
  ])
}

const showCrashpad = process.env.IMARK_SHOW_CRASHPAD === '1'
const CRASHPAD_NOISE = /registration_protocol_win\.cc/

const child = spawn(process.execPath, [electronVite, 'dev', ...process.argv.slice(2)], {
  cwd: ROOT,
  // stdin/stdout 直通;stderr 单独接出来做过滤。Electron 子进程继承的是
  // electron-vite 的 stderr —— 也就是这条管道 —— 所以它的日志也会被过滤。
  stdio: ['inherit', 'inherit', 'pipe'],
  env: {
    ...process.env,
    // stderr 不再是 TTY,Vite 默认会关掉颜色;开发时保留颜色更好读。
    FORCE_COLOR: process.env.FORCE_COLOR ?? '1'
  }
})

child.stderr.setEncoding('utf8')
let pending = ''
child.stderr.on('data', chunk => {
  pending += chunk
  const lines = pending.split(/\r?\n/)
  pending = lines.pop() ?? ''
  for (const line of lines) {
    if (!showCrashpad && CRASHPAD_NOISE.test(line)) continue
    process.stderr.write(`${line}\n`)
  }
})

// Ctrl+C 同时结束 wrapper 与 electron-vite(以及它拉起的 Electron)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('error', err => {
  console.error('[dev] 启动 electron-vite 失败:', err)
  process.exit(1)
})

child.on('exit', code => {
  if (pending && (showCrashpad || !CRASHPAD_NOISE.test(pending))) {
    process.stderr.write(pending)
  }
  process.exit(code ?? 1)
})
