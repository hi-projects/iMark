/**
 * 主进程里的 git 子进程封装(仓库选择页「从 Git 克隆」用)。
 *
 * 与扩展宿主的 git 调用保持同一套约定:
 * 1. `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` —— 缺凭据时直接失败,
 *    绝不在 GUI 里挂起等输入;
 * 2. 要展示的 git 输出先过 `redactUrl()`,别把带 token 的地址漏进界面或日志。
 */

import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface GitRunOptions {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface GitRunResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

const DEFAULT_TIMEOUT = 300_000
const MAX_BUFFER = 8 * 1024 * 1024

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
      ['-c', 'http.postBuffer=104857600', ...args],
      {
        cwd: opts.cwd,
        env: gitEnv(opts.env),
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        const notFound = Boolean(e) && e?.code === 'ENOENT'
        resolve({
          ok: !e,
          code: notFound ? 127 : typeof e?.code === 'number' ? e.code : e ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: notFound
            ? '未找到 git 可执行文件(请确认已安装 Git 并已加入 PATH)'
            : String(stderr ?? '')
        })
      }
    )
  })
}

export async function isGitAvailable(): Promise<boolean> {
  const result = await runGit(['--version'], { cwd: process.cwd(), timeoutMs: 15_000 })
  return result.ok && /git version/i.test(result.stdout)
}

/** 把 `scheme://user:token@host` 洗成 `scheme://user:***@host` */
export function redactUrl(text: string): string {
  return text.replace(/:\/\/([^/@\s:]+):([^/@\s]+)@/g, '://$1:***@')
}

/** 输出摘要:脱敏 + 压成几行,用于界面上的错误说明 */
export function summarize(text: string, maxLines = 4): string {
  return redactUrl(text)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .slice(0, maxLines)
    .join('\n')
}

/**
 * 临时挂一个一次性的 credential helper,账号/令牌从环境变量读取。
 * 这样令牌不出现在命令行里,git 的报错也只会回显干净地址。
 */
export function credentialArgs(): string[] {
  const helper =
    `!f() { printf 'username=%s\\npassword=%s\\n' "$GIT_IMK_USER" "$GIT_IMK_TOKEN"; }; f`
  return ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`]
}

export function credentialEnv(username: string, token: string): Record<string, string> {
  if (!token) return {}
  return { GIT_IMK_USER: username || 'oauth2', GIT_IMK_TOKEN: token }
}

/**
 * 从仓库地址推导一个默认文件夹名:`https://host/组/笔记.git` → `笔记`。
 * 推不出来时返回空串,由调用方要求用户自己填。
 */
export function folderNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  // scp 风格(git@host:组/仓库.git)没有 `//`,先把冒号当分隔符
  const parts = trimmed.split(/[\\/:]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return last.replace(/\.git$/i, '')
}

export interface CloneOptions {
  url: string
  parentDir: string
  name: string
  branch: string
  username: string
  secret: string
}

export interface CloneOutcome {
  ok: boolean
  path: string
  branch: string
  detail: string
}

/**
 * 克隆一个仓库到 `parentDir/name`。
 *
 * 失败时把本次刚建出来的目录删掉(调用前已确认它原本不存在),避免留下一个
 * 半截仓库让用户以后误打开。成功时返回实际检出的分支名。
 */
export async function cloneRepository(opts: CloneOptions): Promise<CloneOutcome> {
  const url = opts.url.trim()
  if (!url) return { ok: false, path: '', branch: '', detail: '仓库地址不能为空' }
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    return { ok: false, path: '', branch: '', detail: '仓库地址里有控制字符' }
  }
  if (!isAbsolute(opts.parentDir)) {
    return { ok: false, path: '', branch: '', detail: '克隆位置必须是绝对路径' }
  }
  const name = opts.name.trim()
  if (!name) return { ok: false, path: '', branch: '', detail: '文件夹名不能为空' }
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    return { ok: false, path: '', branch: '', detail: '文件夹名不能包含路径分隔符' }
  }

  const target = join(opts.parentDir, name)
  try {
    await mkdir(opts.parentDir, { recursive: true })
    await stat(target)
    return { ok: false, path: '', branch: '', detail: `目标文件夹已存在:${target}` }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        path: '',
        branch: '',
        detail: `无法检查目标位置:${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  if (!(await isGitAvailable())) {
    return {
      ok: false,
      path: '',
      branch: '',
      detail: '未找到 git,请先安装 Git 并确保它在 PATH 中'
    }
  }

  const useCredential = opts.secret.length > 0
  const args = [
    ...(useCredential ? credentialArgs() : []),
    'clone',
    ...(opts.branch.trim() ? ['--branch', opts.branch.trim()] : []),
    '--',
    url,
    target
  ]
  const run = await runGit(args, {
    cwd: opts.parentDir,
    env: credentialEnv(opts.username, opts.secret)
  })
  if (!run.ok) {
    // 只删本次调用刚建出来的路径;调用前已确认它不存在
    await rm(target, { recursive: true, force: true }).catch(() => {})
    const detail = summarize(run.stderr || run.stdout) || `git clone 退出码 ${run.code}`
    return { ok: false, path: '', branch: '', detail: `克隆失败:${detail}` }
  }

  const head = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd: target,
    timeoutMs: 15_000
  })
  return {
    ok: true,
    path: target,
    branch: head.ok ? head.stdout.trim() : '',
    detail: ''
  }
}
