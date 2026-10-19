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
import type { PluginActionResult, PluginTarget, PluginTargetResult } from '@shared/plugins'
import {
  detectSystemProxy,
  normalizeProxyUrl,
  probeProxy,
  proxyForUrl,
  type DetectedProxy,
  type ProxyMode
} from './proxy'

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
  /** 网络代理:auto = 自动探测环境变量 / Windows 系统代理;manual = 用下面填的地址;off = 直连 */
  proxyMode: ProxyMode
  /** 手动模式的代理地址(支持 http/https/socks5) */
  proxyUrl: string
}

/** 一次网络操作实际用到的代理参数 */
interface NetworkSetup {
  /** 追加到 git 命令行(在子命令之前)的 -c 参数 */
  args: string[]
  /** 追加到子进程环境变量的部分(NO_PROXY / 强制直连) */
  env: Record<string, string>
  mode: ProxyMode
  /** 实际生效的代理地址;null = 直连(已脱敏,可直接展示) */
  proxyUrl: string | null
  /** 代理来源,用于日志与失败提示 */
  proxySource: string | null
}

/** 失败原因的分类现场:同样的 timeout,「没代理」「代理挂了」「SSH」要说不同的话 */
interface FailureContext {
  mode: ProxyMode
  /** 已脱敏的代理地址;null = 本次直连 */
  proxyUrl: string | null
  proxySource: string | null
  remoteUrl: string
}

/**
 * 状态与失败信息里对某个远端的称呼:第几个(与设置页里的行序一致)。
 *
 * 不用地址末段当标签:仓库名可能很短(如 rl),也可能几个远端同名,用户还得回头
 * 对着地址认是哪一行。序号是唯一与界面一一对应的说法。
 */
function targetLabel(all: readonly PluginTarget[], target: Pick<PluginTarget, 'id'>): string {
  const index = all.findIndex(t => t.id === target.id)
  return index >= 0 ? `第 ${index + 1} 个远端` : '远端'
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

/** scp 风格的 SSH 地址(`git@host:path`)与 `ssh://` 都不经过 HTTP 代理 */
function isSshRemote(url: string): boolean {
  const text = url.trim()
  return /^ssh:\/\//i.test(text) || /^[^/@\s]+@[^/\s:]+:/.test(text)
}

/** 把 git 的报错翻译成有指导意义的中文 */
function classifyPushError(stderr: string, ctx?: FailureContext): string {
  const text = stderr.toLowerCase()
  if (/\b407\b|proxy authentication required/.test(text)) {
    return '代理要求认证（407）：请检查本机代理客户端的认证设置。'
  }
  if (/non-fast-forward|fetch first|rejected|behind/.test(text)) {
    return '远端已有本地没有的提交，推送被拒。请在仓库目录自行处理（如 git pull --rebase）后重试。'
  }
  if (/authentication failed|could not read username|403|401|invalid credentials/.test(text)) {
    return '认证失败：请检查访问令牌是否有效、是否有该仓库的写权限。'
  }
  if (
    /could not resolve host|unable to access|could not connect|failed to connect|connection refused|network is unreachable|connection|timed out/.test(
      text
    )
  ) {
    if (ctx?.proxyUrl) {
      // 已经告诉 git 走代理还连不上,最可能的是代理客户端没开、或地址/端口不对
      return `无法连接远端：已尝试经代理 ${ctx.proxyUrl}（${ctx.proxySource ?? '来源未知'}）。请确认代理客户端正在运行；不需要代理时可把「连接方式」改为「直连」。`
    }
    if (ctx?.mode === 'off') {
      return '无法连接远端：当前为直连（不使用代理）。若浏览器能打开而这里超时，请在插件设置里开启「自动检测」或填写本机代理。'
    }
    if (ctx?.mode === 'manual') {
      return '无法连接远端：手动代理地址为空或无法识别，请检查插件设置里的「代理地址」。'
    }
    if (ctx && isSshRemote(ctx.remoteUrl)) {
      return '无法连接远端：SSH 地址不经过 HTTP 代理。请检查网络，或改用 HTTPS 地址（HTTPS 才能走本机代理）。'
    }
    return '无法连接远端：未检测到本机代理。若浏览器能访问而这里超时，请在插件设置里填写本机代理（Clash / FlClash 常见为 http://127.0.0.1:7890）。'
  }
  if (/repository not found|does not exist/.test(text)) {
    return '远端仓库不存在或无权访问：请检查地址与令牌权限。'
  }
  return ''
}

class GitSyncPlugin {
  private readonly git: ImkGitApi
  private readonly secrets: ImkSecretsApi
  private readonly vault: NonNullable<ImkApi['vault']>

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
    if (!imk.vault) throw new Error('插件清单缺少 "vault:read" 权限')
    this.git = imk.git
    this.secrets = imk.secrets
    this.vault = imk.vault
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
    if (actionId === 'test-all') return this.testConnection()
    if (actionId === 'test-connection') return this.testConnection(targetId)
    if (actionId === 'detect-proxy') return this.detectProxy()
    return { ok: false, message: `未知动作：${actionId}` }
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
        // 这不是「成功完成」,而是「已接受、还在进行中」:
        // 显式给 running,宿主的兜底才不会把状态徽标写成「成功」
        return {
          ok: true,
          status: 'running',
          message: '正在同步中，已排队：本轮结束后立即执行'
        }
      }
      return { ok: false, message: '正在同步中，已跳过本次触发' }
    }
    // 互斥标志必须在任何 await 之前落位:先前放在校验之后,两个并发触发会双双通过检查,
    // 两个 git 进程撞在一起(实测表现为第二个报 git 引用锁冲突)
    this.running = true
    this.abort = new AbortController()
    const signal = this.abort.signal

    const cfg = this.imk.getConfig<GitSyncConfig>()
    // 全量清单留着算「第几个远端」:过滤掉没填地址的行之后,下标就和界面上的行号对不上了
    const allTargets = cfg.targets ?? []
    const targets = allTargets.filter(t => t.url.trim().length > 0)

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
      const vaultPath = await this.vault.path()
      if (!vaultPath) return fail('未打开仓库，无法上传')
      if (!existsSync(vaultPath)) return fail('仓库目录不存在')
      if (!(await this.git.available())) return fail('未找到 git，请先安装 Git 并确保它在 PATH 中')
      const noLocalBranch = targets.find(t => !t.localBranch.trim())
      if (noLocalBranch) {
        return fail(
          `${targetLabel(allTargets, noLocalBranch)}没填本地分支`,
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
            `${targetLabel(allTargets, t)}选了账号密码认证，但没填账号`,
            '把账号填上后重试。'
          )
        }
        if (!(await this.secrets.get('targets', secretSlot(t)))) {
          return fail(
            `${targetLabel(allTargets, t)}选了${isPassword ? '账号密码' : '访问令牌'}认证，但还没填${isPassword ? '密码' : '访问令牌'}`,
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
      const { pushed, failed } = await this.pushAll(vaultPath, targets, allTargets, cfg, signal)

      if (failed.length > 0) {
        // 多远端时状态正文就是逐远端的结果;整体成败由徽标承担。
        // 失败原因仍进 lastDetail —— 宿主只把它写进操作日志,不挂在状态卡上。
        const failedLabels = new Set(failed.map(f => f.label))
        const message = targets
          .map(t => {
            const label = targetLabel(allTargets, t)
            return failedLabels.has(label) ? `${label}：推送失败` : `${label}：推送成功`
          })
          .join('\n')
        const detail = failed.map(f => `${f.label}：${f.detail}`).join('\n')
        this.imk.setState({
          status: pushed.length > 0 ? 'partial' : 'error',
          lastRunAt: Date.now(),
          lastMessage: message,
          lastDetail: detail
        })
        return { ok: false, message: `推送失败（${failed.length}/${targets.length}）`, detail }
      }

      const head = await this.headShort(vaultPath, signal)
      const message =
        targets.length > 1
          ? targets.map(t => `${targetLabel(allTargets, t)}：推送成功`).join('\n')
          : committed
            ? `已提交并推送到 ${pushed.length} 个远端${head ? `（提交 ${head}）` : ''}`
            : `无改动：远端已是 ${head || '最新'}`
      this.imk.setState({
        status: 'ok',
        lastRunAt: Date.now(),
        lastMessage: message,
        // 多远端的状态正文只有逐行结果,提交号作为明细进操作日志
        lastDetail: targets.length > 1 && head ? `提交 ${head}` : undefined
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

  // ---------- 代理 ----------

  private proxyMode(cfg: GitSyncConfig): ProxyMode {
    return cfg.proxyMode === 'manual' || cfg.proxyMode === 'off' ? cfg.proxyMode : 'auto'
  }

  /**
   * 为一次网络操作准备代理参数。
   *
   * 为什么不能只靠环境变量:git/libcurl 不会读 Windows 的「系统代理」,
   * 而 Clash / FlClash 开启系统代理时写的正是那里。这里把探测结果显式拼成
   * `-c http.proxy=…`,让 git 与浏览器走同一条路。
   */
  private async networkSetup(url: string, cfg: GitSyncConfig): Promise<NetworkSetup> {
    const mode = this.proxyMode(cfg)
    if (mode === 'off') {
      // 直连要能压过环境变量与全局 git config:空值关掉 http.proxy,NO_PROXY=* 再兜一层
      return {
        args: ['-c', 'http.proxy='],
        env: { NO_PROXY: '*', no_proxy: '*' },
        mode,
        proxyUrl: null,
        proxySource: null
      }
    }

    let detected: DetectedProxy | null = null
    if (mode === 'manual') {
      const normalized = normalizeProxyUrl(cfg.proxyUrl)
      if (normalized) detected = { url: normalized, source: '插件设置', bypass: [] }
    } else {
      const scheme = /^https:/i.test(url.trim()) ? 'https' : /^http:/i.test(url.trim()) ? 'http' : null
      // SSH / 本地路径:没有 HTTP 代理可用,也不必白跑一次注册表查询
      if (scheme) detected = await detectSystemProxy(scheme)
    }
    const effective = proxyForUrl(url, detected)
    const env: Record<string, string> = {}
    if (effective && detected && detected.bypass.length > 0) {
      const bypass = detected.bypass.join(',')
      env.NO_PROXY = bypass
      env.no_proxy = bypass
    }
    return {
      args: effective ? ['-c', `http.proxy=${effective}`] : [],
      env,
      mode,
      // 日志与报错里展示的地址要脱敏:代理地址本身可能带用户名/口令
      proxyUrl: effective ? this.git.redact(effective) : null,
      proxySource: effective ? (detected?.source ?? null) : null
    }
  }

  /** 每个远端每次网络操作留一行日志 —— 「到底走没走代理」只看界面是看不出来的 */
  private logNetwork(label: string, url: string, setup: NetworkSetup): void {
    if (!/^https?:/i.test(url.trim())) {
      this.imk.log('info', `${label}：地址不是 HTTP(S)，不使用代理`)
      return
    }
    if (setup.proxyUrl) {
      this.imk.log('info', `${label}：经代理 ${setup.proxyUrl}（${setup.proxySource ?? '来源未知'}）`)
      return
    }
    if (setup.mode === 'off') this.imk.log('info', `${label}：直连（插件里已关闭代理）`)
    else if (setup.mode === 'manual') {
      this.imk.log('warn', `${label}：手动代理地址为空或无法识别，已按直连处理`)
    } else this.imk.log('info', `${label}：直连（未检测到本机代理）`)
  }

  /** 「检测本机代理」动作:把自动探测的结果直接摆在状态卡上 */
  private async detectProxy(): Promise<PluginActionResult> {
    const cfg = this.imk.getConfig<GitSyncConfig>()
    const mode = this.proxyMode(cfg)

    if (mode === 'off') {
      return { ok: true, message: '当前为直连：不使用代理（环境变量里的代理也会被忽略）' }
    }
    if (mode === 'manual') {
      const url = normalizeProxyUrl(cfg.proxyUrl)
      if (!url) {
        return {
          ok: false,
          message: `手动代理地址无法识别：${cfg.proxyUrl?.trim() || '(空)'}`,
          detail: '示例：http://127.0.0.1:7890、socks5://127.0.0.1:7891'
        }
      }
      const reachable = await probeProxy(url)
      return {
        ok: true,
        message: `手动代理：${this.git.redact(url)}（${reachable ? '端口可连接' : '端口连不上'}）`,
        ...(reachable ? {} : { detail: '请确认代理客户端正在运行，或检查地址与端口。' })
      }
    }

    // 大多数远端是 HTTPS,先按它探;没有再按 HTTP 探(只设了 HTTP_PROXY 的情况)
    const found = (await detectSystemProxy('https')) ?? (await detectSystemProxy('http'))
    if (!found) {
      const checked = process.platform === 'win32' ? '环境变量与 Windows 系统代理' : '环境变量'
      return {
        ok: true,
        message: `未检测到本机代理（已检查${checked}）`,
        detail:
          '可在插件设置里把「连接方式」改为「手动指定代理」；Clash / FlClash 的默认混合端口是 http://127.0.0.1:7890。'
      }
    }
    const reachable = await probeProxy(found.url)
    return {
      ok: true,
      message: `检测到本机代理：${this.git.redact(found.url)}（${found.source}${reachable ? '，端口可连接' : '，但端口连不上'}）`,
      ...(reachable ? {} : { detail: '代理已配置但连接不上：请确认代理客户端正在运行。' })
    }
  }

  private failureContext(target: PluginTarget, setup: NetworkSetup): FailureContext {
    return {
      mode: setup.mode,
      proxyUrl: setup.proxyUrl,
      proxySource: setup.proxySource,
      remoteUrl: target.url
    }
  }

  /** 把工作区改动提交到本地;返回是否产生了新提交 */
  private async commitLocal(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    const add = await this.git.run(['add', '-A'], { cwd: vaultPath, signal })
    if (!add.ok) throw new Error(`git add 失败：${this.git.summarize(add.stderr || add.stdout, 3)}`)

    const status = await this.git.run(['status', '--porcelain'], { cwd: vaultPath, signal })
    if (status.stdout.trim().length === 0) return false

    const identity = await this.identityArgs(vaultPath, cfg, signal)
    const message = (cfg.commitMessage || 'sync: {time}').replace(/\{time\}/g, stamp())
    const commit = await this.git.run([...identity, 'commit', '-m', message], {
      cwd: vaultPath,
      signal
    })
    if (!commit.ok) {
      throw new Error(`提交失败：${this.git.summarize(commit.stderr || commit.stdout, 3)}`)
    }
    return true
  }

  /** 逐个远端推送,收集成功/失败明细(失败也继续推其余远端) */
  private async pushAll(
    vaultPath: string,
    targets: PluginTarget[],
    allTargets: readonly PluginTarget[],
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<{ pushed: string[]; failed: { label: string; detail: string }[] }> {
    const pushed: string[] = []
    const failed: { label: string; detail: string }[] = []
    for (const target of targets) {
      const label = targetLabel(allTargets, target)
      const result = await this.pushTarget(vaultPath, target, label, cfg, signal)
      // 每推完一个就上报,设置页的卡片不用等整轮结束才变色
      this.reportTarget(target.id, result.ok ? 'ok' : 'error')
      if (result.ok) pushed.push(label)
      else failed.push({ label, detail: result.detail })
    }
    return { pushed, failed }
  }

  /**
   * 上报某个远端的**最近一次操作结果**。
   *
   * 设置页据此决定远端卡片的边框颜色(绿/红);没有上报过的远端保持灰色。
   * 这只说「上一次对它做的事成了没有」,输入是否填齐由设置页自己检查 —— 两件事分开。
   */
  private reportTarget(targetId: string, result: PluginTargetResult): void {
    this.imk.setState({ targetResults: { [targetId]: result } })
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
        if (!init.ok) throw new Error(`初始化仓库失败：${this.git.summarize(init.stderr, 3)}`)
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
    label: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<{ ok: boolean; detail: string }> {
    const cred = await this.credentialFor(target)
    const { local, remote } = this.branchNames(target)
    const setup = await this.networkSetup(target.url, cfg)
    this.logNetwork(label, target.url, setup)
    // 直接给 URL:插件不改动仓库的 remote 配置;凭据由一次性 helper 注入(ssh 模式则不注入)
    const push = await this.git.run(
      [
        ...this.git.credentialArgs(cred?.pass ?? ''),
        ...setup.args,
        'push',
        target.url.trim(),
        `refs/heads/${local}:refs/heads/${remote}`
      ],
      {
        cwd: vaultPath,
        signal,
        env: { ...this.git.credentialEnv(cred?.user ?? '', cred?.pass ?? ''), ...setup.env }
      }
    )
    if (push.ok) return { ok: true, detail: '' }
    const hint = classifyPushError(push.stderr, this.failureContext(target, setup))
    const raw = this.git.summarize(push.stderr || push.stdout, 4)
    return { ok: false, detail: hint || raw || `退出码 ${push.code}` }
  }

  /** 测试连接:带 targetId 时只测那一个远端(界面上每个远端后面有自己的「测试连接」) */
  private async testConnection(targetId?: string): Promise<PluginActionResult> {
    const cfg = this.imk.getConfig<GitSyncConfig>()
    // 序号按界面上的全量行序算,不按过滤后的下标(见 sync 里的同名注释)
    const allTargets = cfg.targets ?? []
    const configured = allTargets.filter(t => t.url.trim().length > 0)
    const targets = targetId ? configured.filter(t => t.id === targetId) : configured
    if (targets.length === 0) {
      return { ok: false, message: targetId ? '该远端已不存在（可能刚被删除）' : '尚未配置远端仓库' }
    }
    if (!(await this.git.available())) return { ok: false, message: '未找到 git，请先安装 Git' }
    const vaultPath = await this.vault.path()
    const cwd = vaultPath && existsSync(vaultPath) ? vaultPath : process.cwd()

    // 先清掉上一次的详情,让状态卡只反映本次测试
    this.imk.setState({
      status: 'running',
      lastMessage:
        targets.length === 1
          ? `${targetLabel(allTargets, targets[0])}：正在测试连接…`
          : '正在测试连接…',
      lastDetail: undefined
    })

    const lines: string[] = []
    const reasons: string[] = []
    let okCount = 0
    for (const target of targets) {
      const cred = await this.credentialFor(target)
      const branch = target.remoteBranch.trim() || target.localBranch.trim()
      const name = targetLabel(allTargets, target)
      const setup = await this.networkSetup(target.url, cfg)
      this.logNetwork(name, target.url, setup)
      const r = await this.git.run(
        [
          ...this.git.credentialArgs(cred?.pass ?? ''),
          ...setup.args,
          'ls-remote',
          '--heads',
          target.url.trim(),
          branch
        ],
        {
          cwd,
          timeoutMs: 30_000,
          env: { ...this.git.credentialEnv(cred?.user ?? '', cred?.pass ?? ''), ...setup.env }
        }
      )
      this.reportTarget(target.id, r.ok ? 'ok' : 'error')
      if (r.ok) {
        okCount += 1
        const found = r.stdout.trim().length > 0
        lines.push(
          `${name}：连接测试通过${found ? '' : `（远端还没有 ${branch} 分支，首次推送时创建）`}`
        )
      } else {
        const reason =
          classifyPushError(r.stderr, this.failureContext(target, setup)) ||
          this.git.summarize(r.stderr || r.stdout, 3) ||
          '连接失败'
        lines.push(`${name}：连接测试失败`)
        reasons.push(`${name}：${reason}`)
      }
    }
    const allOk = okCount === targets.length
    const overall = allOk ? '成功' : okCount > 0 ? '部分失败' : '失败'
    // 状态只保存一段文本:单远端就是那一行,多远端逐行罗列。
    // 整体成败由状态徽标承担 —— 不再在正文里重复一遍「部分失败」。
    // 失败原因放进 lastDetail —— 宿主会把它写进操作日志,也不挂在状态卡上。
    const message = targets.length === 1 ? lines[0]! : lines.join('\n')
    const detail = reasons.length > 0 ? reasons.join('\n') : undefined
    this.imk.setState({
      status: allOk ? 'ok' : okCount > 0 ? 'partial' : 'error',
      lastRunAt: Date.now(),
      lastMessage: message,
      lastDetail: detail
    })
    return { ok: allOk, message: targets.length === 1 ? lines[0]! : overall, detail }
  }
}

// 返回类型显式写成 PluginRuntime:这样「生命周期方法签名写错了」在插件自己的
// typecheck 里就会报错,而不是等装到应用里才发现回调根本没被调用。
export = (imk: ImkApi): PluginRuntime => new GitSyncPlugin(imk)
