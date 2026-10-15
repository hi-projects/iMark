/**
 * 「定时上传（Git）」—— 市场官方插件,也是「外部插件」这套机制的第一个真实用户。
 *
 * 它原本是编译进应用的内置插件,现在改成装在 userData/plugins/git-sync/ 下的普通插件。
 * 插件 id 与字段 key 一个都没动,所以老用户的启用态、配置、密钥**零迁移**。
 *
 * 与内置时期相比只少了三件事:拿配置、存状态、跑 git —— 它们分别变成了
 * imk.getConfig / imk.setState / imk.git。其余逻辑逐行照搬。
 *
 * 只 import 类型、不 import 应用的任何运行时代码:插件是独立打包的,除了 Node 内置模块
 * 与注入进来的 `imk` 之外什么都 require 不到。这正是为什么要在这里自己写一份
 * `secretSlot`(应用的 @shared/plugins 里有同名函数,但那是应用内部的)。
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ImkApi, ImkGitApi, ImkSecretsApi, PluginRuntime } from '@shared/pluginApi'
import type { PluginActionResult, PluginTarget } from '@shared/plugins'

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

interface GitSyncConfig {
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

/**
 * 远端密钥的「槽位」:访问令牌与密码分开存。
 * 与宿主 @shared/plugins 的 targetSecretSlot 必须保持一致 —— 密钥 key 是
 * `<插件id>:targets:<槽位>`,槽位算错就读不到用户已经存好的密钥。
 * (token 用目标 id 本身,是为了兼容改造前就存在的数据。)
 */
function secretSlot(target: Pick<PluginTarget, 'id' | 'auth'>): string {
  return target.auth === 'password' ? `${target.id}#password` : target.id
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

class GitSyncPlugin {
  private readonly git: ImkGitApi
  private readonly secrets: ImkSecretsApi

  private timer: ReturnType<typeof setInterval> | null = null
  private configSyncTimer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private running = false
  /** 手动触发撞上正在跑的同步时,记一次「跑完再来一轮」,不累积 */
  private queuedRerun = false
  /** 「启动后同步一次」每次进程只做一次,反复启停插件不再触发 */
  private startSyncScheduled = false

  constructor(private readonly imk: ImkApi) {
    // 少了权限就在这里当场报错,而不是运行到一半才 undefined —— 加载期的错误
    // 宿主会显示在插件卡片上,作者一眼能看出是清单忘了声明
    if (!imk.git) throw new Error('插件清单缺少 "git" 权限')
    if (!imk.secrets) throw new Error('插件清单缺少 "secrets" 权限')
    this.git = imk.git
    this.secrets = imk.secrets
  }

  onEnable(): void {
    this.schedule()
    if (!this.startSyncScheduled && this.imk.getConfig<GitSyncConfig>().syncOnStart) {
      this.startSyncScheduled = true
      // 稍等窗口与文档就绪再跑
      setTimeout(() => {
        if (this.imk.isEnabled()) void this.sync('start')
      }, 3000)
    }
  }

  onConfigChange(): void {
    this.schedule()
    this.scheduleConfigSync()
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

  async runAction(actionId: string, _ctx: unknown, targetId?: string): Promise<PluginActionResult> {
    if (actionId === 'sync-now') return this.sync('manual')
    if (actionId === 'test-connection') return this.testConnection(targetId)
    return { ok: false, message: `未知动作:${actionId}` }
  }

  // ---------- 定时 ----------

  private schedule(): void {
    this.stopTimer()
    const { intervalMinutes } = this.imk.getConfig<GitSyncConfig>()
    if (!intervalMinutes || intervalMinutes <= 0) return
    this.timer = setInterval(() => {
      if (this.imk.isEnabled()) void this.sync('timer')
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
  private scheduleConfigSync(): void {
    if (this.configSyncTimer) clearTimeout(this.configSyncTimer)
    this.configSyncTimer = setTimeout(() => {
      this.configSyncTimer = null
      if (!this.imk.isEnabled()) return
      const targets = (this.imk.getConfig<GitSyncConfig>().targets ?? []).filter(
        t => t.url.trim().length > 0
      )
      if (targets.length === 0) return
      void this.sync('config')
    }, 3000)
  }

  // ---------- 同步 ----------

  private async sync(trigger: 'timer' | 'manual' | 'start' | 'config'): Promise<PluginActionResult> {
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

    const cfg = this.imk.getConfig<GitSyncConfig>()
    const targets = (cfg.targets ?? []).filter(t => t.url.trim().length > 0)

    const fail = (message: string, detail?: string): PluginActionResult => {
      this.imk.setState({
        status: 'error',
        lastRunAt: Date.now(),
        lastMessage: message,
        lastDetail: detail
      })
      return { ok: false, message, detail }
    }

    try {
      if (targets.length === 0) return fail('尚未配置远端仓库')
      const vaultPath = await this.imk.vault.path()
      if (!vaultPath) return fail('未打开仓库，无法上传')
      if (!existsSync(vaultPath)) return fail('仓库目录不存在')
      if (!(await this.git.available())) return fail('未找到 git，请先安装 Git 并确保它在 PATH 中')
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
        if (!(await this.secrets.get('targets', secretSlot(t)))) {
          return fail(
            `远端「${repoLabel(t.url)}」选了${isPassword ? '账号密码' : '访问令牌'}认证，但还没填${isPassword ? '密码' : '访问令牌'}`,
            '在对应远端那一行填好密钥后重试；公开仓库不需要凭据的话，可把认证方式改成 SSH。'
          )
        }
      }

      // 开跑时把上一次的详情清掉,否则新任务的消息下面还挂着旧的报错文本
      this.imk.setState({
        status: 'running',
        lastMessage: trigger === 'manual' ? '正在上传…' : '正在同步…',
        lastDetail: undefined
      })

      // 先把编辑器里的脏文档落盘,否则刚敲的内容不会进这次提交
      await this.imk.flushDocument()

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
      this.imk.setState({
        status: 'ok',
        lastRunAt: Date.now(),
        lastMessage: message,
        lastDetail: undefined
      })
      return { ok: true, message }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return fail(signal.aborted ? '同步已取消' : '同步失败', detail)
    } finally {
      this.running = false
      this.abort = null
      if (this.queuedRerun) {
        this.queuedRerun = false
        if (this.imk.isEnabled()) void this.sync('manual')
      }
    }
  }

  /** 把工作区改动提交到本地;返回是否产生了新提交 */
  private async commitLocal(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    const add = await this.git.run(['add', '-A'], { cwd: vaultPath, signal })
    if (!add.ok) throw new Error(`git add 失败:${this.git.summarize(add.stderr || add.stdout, 3)}`)

    const status = await this.git.run(['status', '--porcelain'], { cwd: vaultPath, signal })
    if (status.stdout.trim().length === 0) return false

    const identity = await this.identityArgs(vaultPath, cfg, signal)
    const message = (cfg.commitMessage || 'sync: {time}').replace(/\{time\}/g, stamp())
    const commit = await this.git.run([...identity, 'commit', '-m', message], {
      cwd: vaultPath,
      signal
    })
    if (!commit.ok) {
      throw new Error(`提交失败:${this.git.summarize(commit.stderr || commit.stdout, 3)}`)
    }
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
      if (!cfg.autoInitRepo) {
        throw new Error('当前仓库还不是 git 仓库（可在插件设置中开启自动初始化）')
      }
      // 初始化时创建的分支名来自配置(默认 main),与推送用的「本地分支」是两回事
      const wantBranch = cfg.initBranch?.trim() || 'main'
      let init = await this.git.run(['init', '-b', wantBranch], { cwd: vaultPath, signal })
      if (!init.ok) {
        // 老版本 git 不支持 -b
        init = await this.git.run(['init'], { cwd: vaultPath, signal })
        if (!init.ok) throw new Error(`初始化仓库失败:${this.git.summarize(init.stderr, 3)}`)
        await this.git.run(['symbolic-ref', 'HEAD', `refs/heads/${wantBranch}`], {
          cwd: vaultPath,
          signal
        })
      }
      if (cfg.writeGitignore) {
        // wx: 已存在则不动(理论上刚初始化不会有)
        await writeFile(join(vaultPath, '.gitignore'), DEFAULT_GITIGNORE, { flag: 'wx' }).catch(
          () => {}
        )
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
    const r = await this.git.run(['rev-parse', '--short', 'HEAD'], { cwd: vaultPath, signal })
    return r.ok ? r.stdout.trim() : ''
  }

  /** 仓库没配 user.name/user.email 时用插件配置兜底,否则 commit 会直接失败 */
  private async identityArgs(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<string[]> {
    const name = (
      await this.git.run(['config', 'user.name'], { cwd: vaultPath, signal })
    ).stdout.trim()
    const email = (
      await this.git.run(['config', 'user.email'], { cwd: vaultPath, signal })
    ).stdout.trim()
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
    const secret = (await this.secrets.get('targets', secretSlot(target))) ?? ''
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
    const push = await this.git.run(
      [
        ...this.git.credentialArgs(cred?.pass ?? ''),
        'push',
        target.url.trim(),
        `refs/heads/${local}:refs/heads/${remote}`
      ],
      {
        cwd: vaultPath,
        signal,
        env: this.git.credentialEnv(cred?.user ?? '', cred?.pass ?? '')
      }
    )
    if (push.ok) return { ok: true, detail: '' }
    const hint = classifyPushError(push.stderr)
    const raw = this.git.summarize(push.stderr || push.stdout, 4)
    return { ok: false, detail: hint || raw || `退出码 ${push.code}` }
  }

  /** 测试连接:带 targetId 时只测那一个远端(界面上每个远端后面有自己的「测试连接」) */
  private async testConnection(targetId?: string): Promise<PluginActionResult> {
    const cfg = this.imk.getConfig<GitSyncConfig>()
    const configured = (cfg.targets ?? []).filter(t => t.url.trim().length > 0)
    const targets = targetId ? configured.filter(t => t.id === targetId) : configured
    if (targets.length === 0) {
      return { ok: false, message: targetId ? '该远端已不存在（可能刚被删除）' : '尚未配置远端仓库' }
    }
    if (!(await this.git.available())) return { ok: false, message: '未找到 git，请先安装 Git' }
    const vaultPath = await this.imk.vault.path()
    const cwd = vaultPath && existsSync(vaultPath) ? vaultPath : process.cwd()

    // 先清掉上一次的详情,让状态卡只反映本次测试
    this.imk.setState({
      status: 'running',
      lastMessage:
        targets.length === 1 ? `${repoLabel(targets[0].url)}:正在测试连接…` : '正在测试连接…',
      lastDetail: undefined
    })

    const lines: string[] = []
    let allOk = true
    for (const target of targets) {
      const cred = await this.credentialFor(target)
      const branch = target.remoteBranch.trim() || target.localBranch.trim()
      const r = await this.git.run(
        [
          ...this.git.credentialArgs(cred?.pass ?? ''),
          'ls-remote',
          '--heads',
          target.url.trim(),
          branch
        ],
        { cwd, timeoutMs: 30_000, env: this.git.credentialEnv(cred?.user ?? '', cred?.pass ?? '') }
      )
      const name = repoLabel(target.url)
      if (r.ok) {
        const found = r.stdout.trim().length > 0
        lines.push(`${name}:连接成功${found ? '' : `（远端还没有 ${branch} 分支，首次推送时创建）`}`)
      } else {
        allOk = false
        lines.push(
          `${name}:${classifyPushError(r.stderr) || this.git.summarize(r.stderr || r.stdout, 3) || '连接失败'}`
        )
      }
    }
    const message = allOk ? '连接测试通过' : '连接测试失败'
    this.imk.setState({
      status: allOk ? 'ok' : 'error',
      lastRunAt: Date.now(),
      lastMessage: targets.length === 1 ? `${repoLabel(targets[0].url)}:${message}` : message,
      lastDetail: lines.join('\n')
    })
    return { ok: allOk, message, detail: lines.join('\n') }
  }
}

// 返回类型显式写成 PluginRuntime:这样「生命周期方法签名写错了」在插件自己的
// typecheck 里就会报错,而不是等装到应用里才发现回调根本没被调用。
export = (imk: ImkApi): PluginRuntime => new GitSyncPlugin(imk)
