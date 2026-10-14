import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  secretKey,
  targetSecretSlot,
  type PluginActionResult,
  type PluginDescriptor,
  type PluginTarget
} from '@shared/plugins'
import { getSettings } from '../settings'
import { getSecret } from '../secrets'
import { credentialArgs, credentialEnv, isGitAvailable, runGit, summarize, type GitResult } from '../git'
import type { MainPlugin, PluginContext } from './types'

const ID = 'git-sync'

/** 新建仓库时写入的忽略项;已有仓库绝不改动用户的 .gitignore */
const DEFAULT_GITIGNORE = `# iMark 定时上传默认忽略
.obsidian/
.trash/
node_modules/
*.imark-tmp
.DS_Store
Thumbs.db
desktop.ini
`

export interface GitSyncConfig {
  targets: PluginTarget[]
  intervalMinutes: number
  syncOnStart: boolean
  commitMessage: string
  authorName: string
  authorEmail: string
  autoInitRepo: boolean
  /** 初始化仓库时创建的分支名(git init -b);默认 main */
  initBranch: string
  writeGitignore: boolean
  /** 初始化仓库时是否创建一个 README.md（已存在则不覆盖） */
  writeReadme: boolean
}

const descriptor: PluginDescriptor = {
  id: ID,
  name: '定时上传（Git）',
  description: '按固定间隔把当前仓库提交并推送到 GitLab / Gitee 等 Git 远端，支持多个远端。',
  version: '0.1.0',
  fields: [
    {
      key: 'targets',
      kind: 'targets',
      label: '远端仓库',
      default: [],
      description:
        '每次同步把同一个提交推送到所有远端。远程仓库、本地分支必填，远程分支留空则与本地分支同名。认证方式三选一：访问令牌（GitHub / GitLab 的 personal access token）、账号密码、SSH（用本机密钥，无需填写密钥；地址填 git@host:用户名/仓库.git 形式）。密钥经加密保存，不会写进仓库配置，插件也不改动你仓库的 remote 设置。',
      targetSecret: { label: '访问令牌', placeholder: '必填（私有仓库需要访问令牌）' }
    },
    {
      key: 'intervalMinutes',
      section: '同步设置',
      kind: 'number',
      label: '自动同步间隔（分钟）',
      default: 10,
      min: 0,
      max: 1440,
      description: '0 表示关闭自动同步，只保留手动「立即上传」。'
    },
    {
      key: 'syncOnStart',
      section: '同步设置',
      kind: 'boolean',
      label: '启动后同步一次',
      default: true,
      description: '应用关闭期间定时器不会运行，开启它可在下次启动时补上。'
    },
    {
      key: 'commitMessage',
      section: '同步信息设置',
      kind: 'text',
      label: '提交信息模板',
      default: 'sync: {time}',
      placeholder: 'sync: {time}',
      description: '可用占位符:{time}（本地时间）。'
    },
    {
      key: 'authorName',
      section: '同步信息设置',
      kind: 'text',
      label: '提交作者名',
      default: 'iMark',
      description: '仅当仓库未配置 git user.name 时使用。'
    },
    {
      key: 'authorEmail',
      section: '同步信息设置',
      kind: 'text',
      label: '提交作者邮箱',
      default: 'imark@local',
      description: '仅当仓库未配置 git user.email 时使用。'
    },
    {
      key: 'autoInitRepo',
      section: '本地仓库自动初始化',
      kind: 'boolean',
      label: '自动初始化仓库',
      default: true,
      description: '仓库还不是 git 仓库时自动执行 git init。'
    },
    {
      key: 'initBranch',
      section: '本地仓库自动初始化',
      showWhen: { key: 'autoInitRepo', value: true },
      kind: 'text',
      label: '自动创建的分支名',
      default: 'main',
      description: '初始化仓库时创建的分支名（git init -b）。建议与上面各远端的「本地分支」保持一致，否则推送时会找不到分支。'
    },
    {
      key: 'writeGitignore',
      section: '本地仓库自动初始化',
      showWhen: { key: 'autoInitRepo', value: true },
      kind: 'boolean',
      label: '初始化时创建 .gitignore',
      default: true,
      description: '仅新建仓库时写入推荐忽略项；已有仓库、或已存在 .gitignore 时都不会改动。'
    },
    {
      key: 'writeReadme',
      section: '本地仓库自动初始化',
      showWhen: { key: 'autoInitRepo', value: true },
      kind: 'boolean',
      label: '初始化时创建 README.md',
      default: false,
      description: '仅新建仓库时创建一个 README.md（标题取仓库文件夹名）；已存在则不覆盖。'
    }
  ],
  actions: [
    { id: 'sync-now', label: '立即上传' }
  ],
  targetActions: [{ id: 'test-connection', label: '测试连接' }],
  targetFieldKey: 'targets'
}

/** 状态与失败信息里用的短标签:取地址最后一段(如 rl);取不到就用整条地址 */
function repoLabel(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = cleaned.split(/[/\\]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : url.trim()
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 把 git 的报错翻译成有指导意义的中文 */
function classifyPushError(stderr: string): string {
  const text = stderr.toLowerCase()
  if (/non-fast-forward|fetch first|rejected|behind/.test(text)) {
    return '远端已有本地没有的提交，推送被拒。请在仓库目录自行处理（如 git pull --rebase）后重试。'
  }
  if (/authentication failed|could not read username|403|401|invalid credentials/.test(text)) {
    return '认证失败:请检查访问令牌是否有效、是否有该仓库的写权限。'
  }
  if (/could not resolve host|unable to access|connection|timed out/.test(text)) {
    return '无法连接远端:请检查网络与仓库地址。'
  }
  if (/repository not found|does not exist/.test(text)) {
    return '远端仓库不存在或无权访问:请检查地址与令牌权限。'
  }
  return ''
}

class GitSyncPlugin implements MainPlugin {
  readonly id = ID
  readonly descriptor = descriptor

  private timer: ReturnType<typeof setInterval> | null = null
  private configSyncTimer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private running = false
  /** 手动触发撞上正在跑的同步时,记一次「跑完再来一轮」,不累积 */
  private queuedRerun = false
  /** 「启动后同步一次」每次进程只做一次,反复启停插件不再触发 */
  private startSyncScheduled = false

  onEnable(ctx: PluginContext): void {
    this.schedule(ctx)
    if (!this.startSyncScheduled && ctx.getConfig<GitSyncConfig>().syncOnStart) {
      this.startSyncScheduled = true
      // 稍等窗口与文档就绪再跑
      setTimeout(() => {
        if (ctx.isEnabled()) void this.sync(ctx, 'start')
      }, 3000)
    }
  }

  onConfigChange(_config: unknown, ctx: PluginContext): void {
    this.schedule(ctx)
    this.scheduleConfigSync(ctx)
  }

  onDisable(): void {
    this.stopTimer()
    if (this.configSyncTimer) clearTimeout(this.configSyncTimer)
    this.configSyncTimer = null
    this.abort?.abort()
    this.abort = null
    this.running = false
    this.queuedRerun = false
  }

  async runAction(
    actionId: string,
    ctx: PluginContext,
    targetId?: string
  ): Promise<PluginActionResult> {
    if (actionId === 'sync-now') return this.sync(ctx, 'manual')
    if (actionId === 'test-connection') return this.testConnection(ctx, targetId)
    return { ok: false, message: `未知动作:${actionId}` }
  }

  // ---------- 定时 ----------

  private schedule(ctx: PluginContext): void {
    this.stopTimer()
    const { intervalMinutes } = ctx.getConfig<GitSyncConfig>()
    if (!intervalMinutes || intervalMinutes <= 0) return
    this.timer = setInterval(() => {
      if (ctx.isEnabled()) void this.sync(ctx, 'timer')
    }, intervalMinutes * 60_000)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 配置一改就尽快试跑一次。
   * 没有它的话:用户先启用插件(此时还没填远端)、「启动后同步一次」当场失败并被消耗掉,
   * 之后要干等一个完整间隔(默认 10 分钟)才会再试,看起来就像"配好了但不会同步"。
   */
  private scheduleConfigSync(ctx: PluginContext): void {
    if (this.configSyncTimer) clearTimeout(this.configSyncTimer)
    this.configSyncTimer = setTimeout(() => {
      this.configSyncTimer = null
      if (!ctx.isEnabled()) return
      const targets = (ctx.getConfig<GitSyncConfig>().targets ?? []).filter(t => t.url.trim().length > 0)
      if (targets.length === 0) return
      void this.sync(ctx, 'config')
    }, 3000)
  }

  // ---------- 同步 ----------

  private async sync(
    ctx: PluginContext,
    trigger: 'timer' | 'manual' | 'start' | 'config'
  ): Promise<PluginActionResult> {
    if (this.running) {
      // 手动点击不该被静默丢掉:排一次队,当前这轮结束后补跑
      if (trigger === 'manual') {
        this.queuedRerun = true
        return { ok: true, message: '正在同步中，已排队:本轮结束后立即执行' }
      }
      return { ok: false, message: '正在同步中，已跳过本次触发' }
    }
    // 互斥标志必须在任何 await 之前落位:先前放在校验之后,两个并发触发会双双通过检查,
    // 两个 git 进程撞在一起(实测表现为第二个报 git 引用锁冲突)
    this.running = true
    this.abort = new AbortController()
    const signal = this.abort.signal

    const cfg = ctx.getConfig<GitSyncConfig>()
    const targets = (cfg.targets ?? []).filter(t => t.url.trim().length > 0)

    const fail = (message: string, detail?: string): PluginActionResult => {
      ctx.setState({ status: 'error', lastRunAt: Date.now(), lastMessage: message, lastDetail: detail })
      return { ok: false, message, detail }
    }

    try {
      if (targets.length === 0) return fail('尚未配置远端仓库')
      const { vaultPath } = await getSettings()
      if (!vaultPath) return fail('未打开仓库，无法上传')
      if (!existsSync(vaultPath)) return fail('仓库目录不存在')
      if (!(await isGitAvailable())) return fail('未找到 git，请先安装 Git 并确保它在 PATH 中')
      const noLocalBranch = targets.find(t => !t.localBranch.trim())
      if (noLocalBranch) {
        return fail(
          `远端「${repoLabel(noLocalBranch.url)}」没填本地分支`,
          '本地分支是必填项（要推送的那条本地分支，如 main）；远程分支留空则与本地同名。'
        )
      }
      // 认证必填校验:只对 HTTP(S) 地址要求凭据(file:// 等本地路径不需要)
      for (const t of targets) {
        if (t.auth === 'ssh') continue
        if (!/^https?:/i.test(t.url.trim())) continue
        const isPassword = t.auth === 'password'
        if (isPassword && !t.username.trim()) {
          return fail(
            `远端「${repoLabel(t.url)}」选了账号密码认证，但没填账号`,
            '把账号填上后重试。'
          )
        }
        if (!(await getSecret(secretKey(ID, 'targets', targetSecretSlot(t))))) {
          return fail(
            `远端「${repoLabel(t.url)}」选了${isPassword ? '账号密码' : '访问令牌'}认证，但还没填${isPassword ? '密码' : '访问令牌'}`,
            '在对应远端那一行填好密钥后重试；公开仓库不需要凭据的话，可把认证方式改成 SSH。'
          )
        }
      }

      // 开跑时把上一次的详情清掉,否则新任务的消息下面还挂着旧的报错文本
      ctx.setState({
        status: 'running',
        lastMessage: trigger === 'manual' ? '正在上传…' : '正在同步…',
        lastDetail: undefined
      })

      // 先把编辑器里的脏文档落盘,否则刚敲的内容不会进这次提交
      await ctx.flushDocument()

      await this.ensureRepo(vaultPath, cfg, signal)

      const committed = await this.commitLocal(vaultPath, cfg, signal)
      // 无论有没有新提交都推一次:上一次推送失败(离线/被拒)时也能补上
      const { pushed, failed } = await this.pushAll(vaultPath, targets, signal)

      if (failed.length > 0) {
        const message = `推送失败（${failed.length}/${targets.length}）`
        return fail(message, failed.join('\n'))
      }

      const head = await this.headShort(vaultPath, signal)
      const message = committed
        ? `已提交并推送到 ${pushed.length} 个远端${head ? `（提交 ${head}）` : ''}`
        : `无改动:远端已是 ${head || '最新'}`
      ctx.setState({ status: 'ok', lastRunAt: Date.now(), lastMessage: message, lastDetail: undefined })
      return { ok: true, message }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return fail(signal.aborted ? '同步已取消' : '同步失败', detail)
    } finally {
      this.running = false
      this.abort = null
      if (this.queuedRerun) {
        this.queuedRerun = false
        if (ctx.isEnabled()) void this.sync(ctx, 'manual')
      }
    }
  }

  /** 把工作区改动提交到本地;返回是否产生了新提交 */
  private async commitLocal(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    const add = await runGit(['add', '-A'], { cwd: vaultPath, signal })
    if (!add.ok) throw new Error(`git add 失败:${summarize(add.stderr || add.stdout, 3)}`)

    const status = await runGit(['status', '--porcelain'], { cwd: vaultPath, signal })
    if (status.stdout.trim().length === 0) return false

    const identity = await this.identityArgs(vaultPath, cfg, signal)
    const message = (cfg.commitMessage || 'sync: {time}').replace(/\{time\}/g, stamp())
    const commit = await runGit([...identity, 'commit', '-m', message], { cwd: vaultPath, signal })
    if (!commit.ok) throw new Error(`提交失败:${summarize(commit.stderr || commit.stdout, 3)}`)
    return true
  }

  /** 逐个远端推送,收集成功/失败明细(失败也继续推其余远端) */
  private async pushAll(
    vaultPath: string,
    targets: PluginTarget[],
    signal: AbortSignal
  ): Promise<{ pushed: string[]; failed: string[] }> {
    const pushed: string[] = []
    const failed: string[] = []
    for (const target of targets) {
      const result = await this.pushTarget(vaultPath, target, signal)
      if (result.ok) pushed.push(repoLabel(target.url))
      else failed.push(`${repoLabel(target.url)}:${result.detail}`)
    }
    return { pushed, failed }
  }

  /**
   * 不是 git 仓库时按配置初始化。
   * 插件**不改动仓库的 remote 配置** —— 推送一律直接给 URL,凭据由每次现挂的
   * credential helper 提供;想用命令行推送的话自己 `git remote add` 即可。
   */
  private async ensureRepo(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<void> {
    if (!existsSync(join(vaultPath, '.git'))) {
      if (!cfg.autoInitRepo) throw new Error('当前仓库还不是 git 仓库（可在插件设置中开启自动初始化）')
      // 初始化时创建的分支名来自配置(默认 main),与推送用的「本地分支」是两回事
      const wantBranch = cfg.initBranch?.trim() || 'main'
      let init = await runGit(['init', '-b', wantBranch], { cwd: vaultPath, signal })
      if (!init.ok) {
        // 老版本 git 不支持 -b
        init = await runGit(['init'], { cwd: vaultPath, signal })
        if (!init.ok) throw new Error(`初始化仓库失败:${summarize(init.stderr, 3)}`)
        await runGit(['symbolic-ref', 'HEAD', `refs/heads/${wantBranch}`], { cwd: vaultPath, signal })
      }
      if (cfg.writeGitignore) {
        // wx: 已存在则不动(理论上刚初始化不会有)
        await writeFile(join(vaultPath, '.gitignore'), DEFAULT_GITIGNORE, { flag: 'wx' }).catch(() => {})
      }
      if (cfg.writeReadme) {
        // 同样 wx:绝不覆盖已有的 README
        const name = basename(vaultPath) || 'Notes'
        await writeFile(
          join(vaultPath, 'README.md'),
          `# ${name}\n\n> 由 iMark 的「定时上传」插件在初始化仓库时创建。\n`,
          { flag: 'wx' }
        ).catch(() => {})
      }
    }

  }

  /** 当前提交的短 SHA,用于把「到底同步到哪个版本」说清楚 */
  private async headShort(vaultPath: string, signal: AbortSignal): Promise<string> {
    const r = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: vaultPath, signal })
    return r.ok ? r.stdout.trim() : ''
  }

  /** 仓库没配 user.name/user.email 时用插件配置兜底,否则 commit 会直接失败 */
  private async identityArgs(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<string[]> {
    const name = (await runGit(['config', 'user.name'], { cwd: vaultPath, signal })).stdout.trim()
    const email = (await runGit(['config', 'user.email'], { cwd: vaultPath, signal })).stdout.trim()
    const args: string[] = []
    if (!name) args.push('-c', `user.name=${cfg.authorName || 'iMark'}`)
    if (!email) args.push('-c', `user.email=${cfg.authorEmail || 'imark@local'}`)
    return args
  }

  /** 解析该远端要推送的分支:本地分支必填;远端分支留空 = 与本地同名 */
  private branchNames(target: PluginTarget): { local: string; remote: string } {
    const local = target.localBranch.trim()
    const remote = target.remoteBranch.trim() || local
    return { local, remote }
  }

  /**
   * 按认证方式取出要注入给 git 的用户名/密码:
   * - token:用户固定 oauth2(私有令牌的通用写法),密码是访问令牌
   * - password:用户是配置里的账号,密码是存的密钥
   * - ssh:返回 null —— 交给本机 SSH 密钥,不注入任何凭据
   */
  private async credentialFor(target: PluginTarget): Promise<{ user: string; pass: string } | null> {
    if (target.auth === 'ssh') return null
    const secret = (await getSecret(secretKey(ID, 'targets', targetSecretSlot(target)))) ?? ''
    if (!secret) return null
    const user = target.auth === 'password' ? target.username.trim() : 'oauth2'
    return { user, pass: secret }
  }

  private async pushTarget(
    vaultPath: string,
    target: PluginTarget,
    signal: AbortSignal
  ): Promise<{ ok: boolean; detail: string }> {
    const cred = await this.credentialFor(target)
    const { local, remote } = this.branchNames(target)
    // 直接给 URL:插件不改动仓库的 remote 配置;凭据由一次性 helper 注入(ssh 模式则不注入)
    const push = await runGit(
      [...credentialArgs(cred?.pass ?? ''), 'push', target.url.trim(), `refs/heads/${local}:refs/heads/${remote}`],
      { cwd: vaultPath, signal, env: credentialEnv(cred?.user ?? '', cred?.pass ?? '') }
    )
    if (push.ok) return { ok: true, detail: '' }
    const hint = classifyPushError(push.stderr)
    const raw = summarize(push.stderr || push.stdout, 4)
    return { ok: false, detail: hint || raw || `退出码 ${push.code}` }
  }

  /** 测试连接:带 targetId 时只测那一个远端(界面上每个远端后面有自己的「测试连接」) */
  private async testConnection(ctx: PluginContext, targetId?: string): Promise<PluginActionResult> {
    const cfg = ctx.getConfig<GitSyncConfig>()
    const configured = (cfg.targets ?? []).filter(t => t.url.trim().length > 0)
    const targets = targetId ? configured.filter(t => t.id === targetId) : configured
    if (targets.length === 0) {
      return { ok: false, message: targetId ? '该远端已不存在（可能刚被删除）' : '尚未配置远端仓库' }
    }
    if (!(await isGitAvailable())) return { ok: false, message: '未找到 git，请先安装 Git' }
    const { vaultPath } = await getSettings()
    const cwd = vaultPath && existsSync(vaultPath) ? vaultPath : process.cwd()

    // 先清掉上一次的详情,让状态卡只反映本次测试
    ctx.setState({
      status: 'running',
      lastMessage: targets.length === 1 ? `${repoLabel(targets[0].url)}:正在测试连接…` : '正在测试连接…',
      lastDetail: undefined
    })

    const lines: string[] = []
    let allOk = true
    for (const target of targets) {
      const cred = await this.credentialFor(target)
      const branch = target.remoteBranch.trim() || target.localBranch.trim()
      const r: GitResult = await runGit(
        [...credentialArgs(cred?.pass ?? ''), 'ls-remote', '--heads', target.url.trim(), branch],
        { cwd, timeoutMs: 30_000, env: credentialEnv(cred?.user ?? '', cred?.pass ?? '') }
      )
      const name = repoLabel(target.url)
      if (r.ok) {
        const found = r.stdout.trim().length > 0
        lines.push(`${name}:连接成功${found ? '' : `（远端还没有 ${branch} 分支，首次推送时创建）`}`)
      } else {
        allOk = false
        lines.push(`${name}:${classifyPushError(r.stderr) || summarize(r.stderr || r.stdout, 3) || '连接失败'}`)
      }
    }
    const message = allOk ? '连接测试通过' : '连接测试失败'
    ctx.setState({
      status: allOk ? 'ok' : 'error',
      lastRunAt: Date.now(),
      lastMessage: targets.length === 1 ? `${repoLabel(targets[0].url)}:${message}` : message,
      lastDetail: lines.join('\n')
    })
    return { ok: allOk, message, detail: lines.join('\n') }
  }
}

export const gitSyncPlugin = new GitSyncPlugin()
