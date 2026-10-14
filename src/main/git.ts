import { execFile } from 'node:child_process'

/**
 * 轻量 git 封装:只在主进程使用(渲染层 sandbox 拿不到 child_process)。
 *
 * 两个必须遵守的约定:
 * 1. 子进程一律 `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` —— 否则缺凭据时
 *    git 会弹凭据管理器/等输入,在 GUI 里表现为「同步卡死」;
 * 2. 任何要展示、记录或落盘的 git 输出,先过 `redactUrl()`,避免把带 token 的 URL 漏出去。
 */

export interface GitResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  /** 超时/中止 */
  aborted: boolean
}

export interface GitOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 追加到子进程环境变量(凭据用,见 credentialArgs) */
  env?: Record<string, string>
}

const DEFAULT_TIMEOUT = 120_000
const MAX_BUFFER = 4 * 1024 * 1024

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never'
  }
}

/**
 * 每次调用都带上的 git 配置:
 *  - http.postBuffer:全局里这个值若被设得过大(实测 5242880000,即 5GB,常见配方 524288000 多打一个 0),
 *    任何 HTTP 操作都会在分配缓冲时报 `fatal: Out of memory, malloc failed (tried to allocate 947912704 bytes)`。
 *    笔记仓库体积很小,100MB 缓冲足够;超出时 git 会自动改用分块传输,不会因此失败。
 */
const BASE_CONFIG = ['-c', 'http.postBuffer=104857600']

export function runGit(args: string[], opts: GitOptions): Promise<GitResult> {
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
          stderr: notFound ? '未找到 git 可执行文件(请确认已安装 git 并已加入 PATH)' : String(stderr ?? ''),
          aborted: Boolean(opts.signal?.aborted) || e?.killed === true
        })
      }
    )
  })
}

/** git 是否可用(未安装时给出可读错误,而不是 ENOENT 堆栈) */
export async function isGitAvailable(): Promise<boolean> {
  try {
    const r = await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 15_000 })
    return r.ok && /git version/i.test(r.stdout)
  } catch {
    return false
  }
}

/** 把 `scheme://user:token@host` 洗成 `scheme://user:***@host`(所有对外文本都要过这层) */
export function redactUrl(text: string): string {
  return text.replace(/:\/\/([^/@\s:]+):([^/@\s]+)@/g, '://$1:***@')
}

/**
 * 凭据注入:临时挂一个一次性的 credential helper,用户名/token 从**环境变量**读取。
 *
 * 相比把 token 拼进推送 URL,这样做的两点好处:
 * 1. token 不出现在子进程命令行里(Windows 上其他进程可读命令行,环境变量则不可);
 * 2. git 的报错/日志里回显的是不带凭据的干净 URL,减少泄漏面。
 *
 * `credential.helper=`(空值)先把系统上继承的 helper 清掉,避免 GCM 接管弹窗。
 * 需要配套把 `credentialEnv()` 合并进子进程环境。
 */
export function credentialArgs(token: string): string[] {
  if (!token) return []
  const helper = `!f() { printf 'username=%s\\npassword=%s\\n' "$GIT_IMK_USER" "$GIT_IMK_TOKEN"; }; f`
  return ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`]
}

export function credentialEnv(username: string, token: string): Record<string, string> {
  if (!token) return {}
  return { GIT_IMK_USER: username || 'oauth2', GIT_IMK_TOKEN: token }
}

/** 输出摘要:脱敏 + 压成几行,用于状态详情 */
export function summarize(text: string, maxLines = 6): string {
  return redactUrl(text)
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.length > 0)
    .slice(0, maxLines)
    .join('\n')
}
