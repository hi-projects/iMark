/**
 * 扩展侧的 git 子进程封装。
 *
 * v1 里这是宿主注入的 `imk.git.*`；v2 的扩展按 VS Code 信任模型以当前用户权限运行，
 * 直接用 Node 的 `child_process` 即可，不再需要宿主代理。两条必须保留的约定：
 *
 * 1. 子进程一律 `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` —— 否则缺凭据时
 *    git 会弹凭据管理器/等输入，在 GUI 里表现为「同步卡死」；
 * 2. 任何要展示、记录或落盘的 git 输出，先过 `redactUrl()`，避免把带 token 的 URL
 *    漏进状态卡或日志。
 */

import { execFile } from 'node:child_process'

export interface GitRunOptions {
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GitRunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  aborted: boolean
}

const DEFAULT_TIMEOUT = 120_000
const MAX_BUFFER = 4 * 1024 * 1024

/**
 * 每次调用都带上的 git 配置。
 *
 * `http.postBuffer` 若被全局设得过大（常见配方多打一个 0，变成 5GB），任何 HTTP 操作
 * 都会在分配缓冲时报 `fatal: Out of memory, malloc failed`。笔记仓库很小，100MB
 * 足够；超出时 git 会自动改用分块传输。
 */
const BASE_CONFIG = ['-c', 'http.postBuffer=104857600']

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never'
  }
}

export function runGit(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      [...BASE_CONFIG, ...args],
      {
        cwd: opts.cwd,
        env: gitEnv(opts.env),
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
        signal: opts.signal
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        const notFound = Boolean(e) && e?.code === 'ENOENT'
        resolve({
          ok: !e,
          code: notFound ? 127 : typeof e?.code === 'number' ? e.code : e ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: notFound
            ? '未找到 git 可执行文件（请确认已安装 git 并已加入 PATH）'
            : String(stderr ?? ''),
          aborted: Boolean(opts.signal?.aborted) || e?.killed === true
        })
      }
    )
  })
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 15_000 })
    return result.ok && /git version/i.test(result.stdout)
  } catch {
    return false
  }
}

/** 把 `scheme://user:token@host` 洗成 `scheme://user:***@host` */
export function redactUrl(text: string): string {
  return text.replace(/:\/\/([^/@\s:]+):([^/@\s]+)@/g, '://$1:***@')
}

/**
 * 临时挂一个一次性的 credential helper，用户名/token 从环境变量读取。
 * 这样 token 不出现在子进程命令行里，git 的报错也只会回显干净 URL。
 * 空值先清掉系统上继承的 helper，避免 GCM 接管弹窗。
 */
export function credentialArgs(token: string): string[] {
  if (!token) return []
  const helper =
    `!f() { printf 'username=%s\\npassword=%s\\n' "$GIT_IMK_USER" "$GIT_IMK_TOKEN"; }; f`
  return ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`]
}

export function credentialEnv(username: string, token: string): Record<string, string> {
  if (!token) return {}
  return { GIT_IMK_USER: username || 'oauth2', GIT_IMK_TOKEN: token }
}

/** 输出摘要：脱敏 + 压成几行，用于状态详情 */
export function summarize(text: string, maxLines = 6): string {
  return redactUrl(text)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .slice(0, maxLines)
    .join('\n')
}
