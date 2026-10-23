/**
 * Claude Code 子进程启动与 Windows 兼容。
 *
 * 优先原生 .exe；.cmd/.bat 通过 cmd.exe /d /s /c 调用，避免 Node 对 .cmd
 * 直接 shell:false 的 EINVAL。取消时杀进程树（Claude Code 可能再起子进程）。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { delimiter, extname, join } from 'node:path'
import { createInterface } from 'node:readline'

export type CommandKind = 'exe' | 'cmd' | 'bat' | 'ps1' | 'other'

export interface ResolvedCommand {
  command: string
  kind: CommandKind
}

export interface SpawnResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export interface SpawnHandle {
  child: ChildProcess
  done: Promise<SpawnResult>
  killTree(): Promise<void>
}

function kindOf(command: string): CommandKind {
  const ext = extname(command).toLowerCase()
  if (ext === '.exe' || ext === '.com') return 'exe'
  if (ext === '.cmd') return 'cmd'
  if (ext === '.bat') return 'bat'
  if (ext === '.ps1') return 'ps1'
  return 'other'
}

function whereNames(): string[] {
  if (process.platform === 'win32') {
    return [...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)].map(ext =>
      ext.toLowerCase()
    )
  }
  return ['']
}

async function findOnPath(name: string): Promise<string | null> {
  const found = await new Promise<string[]>((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'where' : 'which',
      [name],
      { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean))
      }
    )
  }).catch(() => [] as string[])
  const existing: string[] = []
  for (const candidate of found) {
    if (existsSync(candidate)) existing.push(candidate)
  }
  if (existing.length > 0) {
    existing.sort((a, b) => {
      const rank = (path: string): number => {
        const kind = kindOf(path)
        return kind === 'exe' ? 0 : kind === 'cmd' ? 1 : kind === 'bat' ? 2 : 3
      }
      return rank(a) - rank(b)
    })
    return existing[0]
  }

  // where 不可用时手动扫 PATH/PATHEXT
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of whereNames()) {
      const candidate = join(dir, `${name}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 最后兜底：用户已经在 VS Code 里装了 Claude Code 时，扩展目录里自带一份
 * native binary。它不是官方 CLI 安装路径，但对“机器上只有 VS Code 扩展”的
 * 用户可以直接用；放在 PATH / ~/.local/bin 之后，不影响正常安装。
 */
async function newestVscodeBinary(): Promise<string | null> {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) return null
  const root = join(home, '.vscode', 'extensions')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith('anthropic.claude-code-'))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const name of candidates) {
    const candidate = join(root, name, 'resources', 'native-binary', 'claude.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function resolveClaudeCommand(configured: string): Promise<ResolvedCommand> {
  const trimmed = configured.trim()
  if (trimmed) {
    const info = await stat(trimmed).catch(() => null)
    if (!info || !info.isFile()) throw new Error(`Claude Code 可执行文件不存在：${trimmed}`)
    return { command: trimmed, kind: kindOf(trimmed) }
  }

  for (const name of ['claude.exe', 'claude.cmd', 'claude.bat', 'claude']) {
    const found = await findOnPath(name)
    if (found) return { command: found, kind: kindOf(found) }
  }

  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home) {
    const local = join(home, '.local', 'bin', 'claude.exe')
    if (existsSync(local)) return { command: local, kind: 'exe' }
  }

  const vscode = await newestVscodeBinary()
  if (vscode) return { command: vscode, kind: 'exe' }

  throw new Error('未找到 Claude Code。请在设置里填写 claude.exe 的完整路径，或先安装 Claude Code CLI。')
}

/*
 * cmd.exe 参数转义。
 *
 * 直接包一层双引号不够：.cmd 里的 `%*` 会把引号原样带进子进程 argv，
 * `--allowedTools "Read,...,Bash(pdftotext:*)"` 会被 CLI 当成带引号的工具名。
 * 这里沿用 cross-spawn（MIT）的算法：命令与参数按 cmd 元字符做 ^ 转义，整条
 * 命令再用外层引号包住，并设置 windowsVerbatimArguments，让 Node 不再二次转义。
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function escapeCommand(arg: string): string {
  return arg.replace(CMD_META, '^$1')
}

function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let value = String(arg)
  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  value = value.replace(/(?=(\\+?)?)\1$/, '$1$1')
  value = `"${value}"`
  value = value.replace(CMD_META, '^$1')
  if (doubleEscapeMetaChars) value = value.replace(CMD_META, '^$1')
  return value
}

function spawnFor(command: ResolvedCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const options = {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe']
  }
  if (command.kind === 'cmd' || command.kind === 'bat') {
    // node_modules/.bin 下的 shim 会再解析一次 %*，需要双重转义（与 cross-spawn 一致）
    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command.command)
    const shellCommand = [
      escapeCommand(command.command),
      ...args.map(arg => escapeArgument(arg, doubleEscape))
    ].join(' ')
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${shellCommand}"`], {
      ...options,
      windowsVerbatimArguments: true
    })
  }
  if (command.kind === 'ps1') {
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', command.command, ...args],
      options
    )
  }
  return spawn(command.command, args, options)
}

export function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.NO_COLOR = '1'
  env.FORCE_COLOR = '0'
  return env
}

export interface SpawnClaudeOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  onStdoutLine(line: string): void
  onStderr(chunk: string): void
}

export function spawnClaude(
  command: ResolvedCommand,
  args: string[],
  options: SpawnClaudeOptions
): SpawnHandle {
  const child = spawnFor(command, args, options.cwd, options.env)
  const handle: SpawnHandle = {
    child,
    done: Promise.resolve({ code: null, signal: null }),
    killTree: async () => undefined
  }

  let killed = false
  const killTree = async (): Promise<void> => {
    if (killed || child.exitCode !== null) return
    killed = true
    const pid = child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      })
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 2000).unref?.()
    }
  }
  handle.killTree = killTree

  if (child.stdout) {
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    reader.on('line', line => options.onStdoutLine(line))
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => options.onStderr(String(chunk)))
  }

  const onAbort = (): void => {
    void killTree()
  }
  if (options.signal) {
    if (options.signal.aborted) void killTree()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  handle.done = new Promise<SpawnResult>(resolve => {
    let settled = false
    const finish = (result: SpawnResult): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    child.once('error', error => finish({ code: null, signal: null, error }))
    child.once('close', (code, signal) => finish({ code, signal }))
  })

  return handle
}

export async function runVersion(
  command: ResolvedCommand,
  timeoutMs: number
): Promise<{ ok: boolean; version?: string; detail?: string }> {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result: { ok: boolean; version?: string; detail?: string }): void => {
      if (done) return
      done = true
      resolve(result)
    }
    const child = spawnFor(command, ['--version'], process.cwd(), claudeEnv())
    const timer = setTimeout(() => {
      void (async () => {
        if (process.platform === 'win32' && child.pid) {
          await new Promise<void>(r => {
            execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => r())
          })
        } else {
          child.kill('SIGKILL')
        }
      })()
      finish({ ok: false, detail: '版本探测超时' })
    }, timeoutMs)
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', error => {
      clearTimeout(timer)
      finish({ ok: false, detail: error.message })
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ ok: false, detail: stderr.trim() || `退出码 ${code ?? 'null'}` })
        return
      }
      const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(`${stdout}\n${stderr}`)
      finish({ ok: true, version: match?.[1] })
    })
  })
}
