/**
 * 「定时上传（Git）」—— v2 扩展模型实现。
 *
 * 与 v1 的差别只在「外围」：配置从 `workspace.getConfiguration()` 读，密钥从
 * `context.secrets` 取，状态用 `imark.reportStatus()` 上报，git 直接用 Node 的
 * `child_process` 跑。提交、推送、代理探测、失败分类的逻辑与旧版逐行一致。
 *
 * 扩展按 VS Code 信任模型以当前用户权限运行，因此这里拿到的是完整的 Node 能力；
 * 密钥只在本扩展宿主进程内使用，不写进日志、状态或仓库配置，也不改动用户的
 * remote 设置（推送时直接给 URL，凭据由一次性 credential helper 注入）。
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import * as imark from 'imark'
import {
  credentialArgs,
  credentialEnv,
  isGitAvailable,
  redactUrl,
  runGit,
  summarize
} from './git'
import {
  detectSystemProxy,
  normalizeProxyUrl,
  probeProxy,
  proxyForUrl,
  type DetectedProxy,
  type ProxyMode
} from './proxy'

const SECTION = 'imark.git-sync'
const CMD_SYNC_NOW = 'imark.git-sync.syncNow'
const CMD_TEST_ALL = 'imark.git-sync.testAll'
const CMD_DETECT_PROXY = 'imark.git-sync.detectProxy'
const CMD_TEST_TARGET = 'imark.git-sync.testTarget'

/** 新建仓库时写入的忽略项；已有仓库绝不改动用户的 .gitignore */
const DEFAULT_GITIGNORE = `# iMark 定时上传默认忽略
.obsidian/
.trash/
node_modules/
*.imark-tmp
.DS_Store
Thumbs.db
desktop.ini
`

type TargetAuth = 'token' | 'password' | 'ssh'
type TargetResult = 'ok' | 'error'

interface GitTarget {
  id: string
  url: string
  auth: TargetAuth
  username: string
  localBranch: string
  remoteBranch: string
}

interface GitSyncConfig {
  targets: GitTarget[]
  intervalMinutes: number
  syncOnStart: boolean
  commitMessage: string
  authorName: string
  authorEmail: string
  autoInitRepo: boolean
  /** 初始化仓库时创建的分支名（git init -b）；默认 main */
  initBranch: string
  writeGitignore: boolean
  /** 初始化仓库时是否创建一个 README.md（已存在则不覆盖） */
  writeReadme: boolean
  /** 网络代理：auto = 自动探测环境变量 / Windows 系统代理；manual = 用下面填的地址；off = 直连 */
  proxyMode: ProxyMode
  /** 手动模式的代理地址（支持 http/https/socks5） */
  proxyUrl: string
}

interface TargetActionArgs {
  targetId?: string
  source?: 'action'
}

interface ActionResult {
  ok: boolean
  message: string
  detail?: string
}

/** 一次网络操作实际用到的代理参数 */
interface NetworkSetup {
  /** 追加到 git 命令行（在子命令之前）的 -c 参数 */
  args: string[]
  /** 追加到子进程环境变量的部分（NO_PROXY / 强制直连） */
  env: Record<string, string>
  mode: ProxyMode
  /** 实际生效的代理地址；null = 直连（已脱敏，可直接展示） */
  proxyUrl: string | null
  /** 代理来源，用于日志与失败提示 */
  proxySource: string | null
}

/** 失败原因的分类现场：同样的 timeout，「没代理」「代理挂了」「SSH」要说不同的话 */
interface FailureContext {
  mode: ProxyMode
  proxyUrl: string | null
  proxySource: string | null
  remoteUrl: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeTarget(raw: unknown): GitTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = text(item.id)
  if (!id) return null
  const auth: TargetAuth =
    item.auth === 'password' || item.auth === 'ssh' ? item.auth : 'token'
  return {
    id,
    url: text(item.url),
    auth,
    username: text(item.username),
    localBranch: text(item.localBranch),
    remoteBranch: text(item.remoteBranch)
  }
}

function readConfig(): GitSyncConfig {
  const config = imark.workspace.getConfiguration(SECTION)
  const rawTargets = config.get<unknown>('targets', [])
  const targets = Array.isArray(rawTargets)
    ? rawTargets.map(normalizeTarget).filter((item): item is GitTarget => item !== null)
    : []
  return {
    targets,
    intervalMinutes: config.get<number>('intervalMinutes', 10),
    syncOnStart: config.get<boolean>('syncOnStart', true),
    commitMessage: config.get<string>('commitMessage', 'sync: {time}'),
    authorName: config.get<string>('authorName', 'iMark'),
    authorEmail: config.get<string>('authorEmail', 'imark@local'),
    autoInitRepo: config.get<boolean>('autoInitRepo', true),
    initBranch: config.get<string>('initBranch', 'main'),
    writeGitignore: config.get<boolean>('writeGitignore', true),
    writeReadme: config.get<boolean>('writeReadme', false),
    proxyMode: config.get<ProxyMode>('proxyMode', 'auto'),
    proxyUrl: config.get<string>('proxyUrl', 'http://127.0.0.1:7890')
  }
}

/**
 * 状态与失败信息里对某个远端的称呼：第几个（与设置页里的行序一致）。
 * 不用地址末段当标签：仓库名可能很短，也可能几个远端同名。
 */
function targetLabel(all: readonly GitTarget[], target: Pick<GitTarget, 'id'>): string {
  const index = all.findIndex(t => t.id === target.id)
  return index >= 0 ? `第 ${index + 1} 个远端` : '远端'
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 远端密钥的「槽位」：访问令牌与密码分开存。
 * 扩展宿主会在 key 前加 `<扩展id>:`，所以这里只写 `targets:<槽位>`。
 */
function secretSlot(target: Pick<GitTarget, 'id' | 'auth'>): string {
  return target.auth === 'password' ? `${target.id}#password` : target.id
}

/** scp 风格的 SSH 地址（`git@host:path`）与 `ssh://` 都不经过 HTTP 代理 */
function isSshRemote(url: string): boolean {
  const value = url.trim()
  return /^ssh:\/\//i.test(value) || /^[^/@\s]+@[^/\s:]+:/.test(value)
}

/** 把 git 的报错翻译成有指导意义的中文 */
function classifyPushError(stderr: string, ctx?: FailureContext): string {
  const value = stderr.toLowerCase()
  if (/\b407\b|proxy authentication required/.test(value)) {
    return '代理要求认证（407）：请检查本机代理客户端的认证设置。'
  }
  if (/non-fast-forward|fetch first|rejected|behind/.test(value)) {
    return '远端已有本地没有的提交，推送被拒。请在仓库目录自行处理（如 git pull --rebase）后重试。'
  }
  if (/authentication failed|could not read username|403|401|invalid credentials/.test(value)) {
    return '认证失败：请检查访问令牌是否有效、是否有该仓库的写权限。'
  }
  if (
    /could not resolve host|unable to access|could not connect|failed to connect|connection refused|network is unreachable|connection|timed out/.test(
      value
    )
  ) {
    if (ctx?.proxyUrl) {
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
  if (/repository not found|does not exist/.test(value)) {
    return '远端仓库不存在或无权访问：请检查地址与令牌权限。'
  }
  return ''
}

class GitSyncPlugin {
  private readonly output: imark.OutputChannel
  private statusItem: imark.StatusBarItem | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private configSyncTimer: ReturnType<typeof setTimeout> | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private running = false
  private disposed = false
  private lastStatus: imark.ImarkStatus = 'idle'
  /** 手动触发撞上正在跑的同步时，记一次「跑完再来一轮」，不累积 */
  private queuedRerun = false
  /** 「启动后同步一次」每次激活只做一次 */
  private startSyncScheduled = false

  constructor(private readonly context: imark.ExtensionContext) {
    this.output = imark.window.createOutputChannel('Git 同步')
    this.context.subscriptions.push(this.output)
  }

  start(): void {
    this.context.subscriptions.push(
      imark.commands.registerCommand(CMD_SYNC_NOW, () => this.sync('manual')),
      imark.commands.registerCommand(CMD_TEST_ALL, () => this.testConnection()),
      imark.commands.registerCommand(CMD_DETECT_PROXY, () => this.detectProxy()),
      imark.commands.registerCommand(CMD_TEST_TARGET, (args?: TargetActionArgs) =>
        this.testConnection(args?.targetId)
      ),
      imark.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration(SECTION)) return
        this.schedule()
        this.scheduleConfigSync()
      })
    )

    this.statusItem = imark.window.createStatusBarItem(imark.StatusBarAlignment.Right, 90)
    this.statusItem.text = '$(git) Git 同步'
    this.statusItem.tooltip = '立即上传到 Git 远端'
    this.statusItem.command = CMD_SYNC_NOW
    this.statusItem.show()
    this.context.subscriptions.push(this.statusItem)

    this.schedule()
    if (!this.startSyncScheduled && readConfig().syncOnStart) {
      this.startSyncScheduled = true
      // 稍等窗口与文档就绪再跑
      this.startTimer = setTimeout(() => {
        this.startTimer = null
        if (!this.disposed) void this.sync('start')
      }, 3000)
    }
  }

  stop(): void {
    this.disposed = true
    this.stopTimer()
    if (this.configSyncTimer) clearTimeout(this.configSyncTimer)
    this.configSyncTimer = null
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    this.abort?.abort()
    this.abort = null
    this.running = false
    this.queuedRerun = false
  }

  // ---------- 状态 ----------

  private report(update: imark.ImarkStatusUpdate): void {
    this.lastStatus = update.status
    imark.imark.reportStatus(update)
    if (!this.statusItem) return
    const label =
      update.status === 'running'
        ? '$(sync) Git 同步'
        : update.status === 'ok'
          ? '$(check) Git 同步'
          : update.status === 'partial' || update.status === 'error'
            ? '$(alert) Git 同步'
            : '$(git) Git 同步'
    this.statusItem.text = label
    if (update.message) this.statusItem.tooltip = update.message
  }

  /**
   * 上报某个远端的**最近一次操作结果**。
   * 设置页据此决定远端卡片的边框颜色（绿/红）；没有上报过的远端保持灰色。
   */
  private reportTarget(targetId: string, result: TargetResult): void {
    this.report({ status: this.lastStatus, targetResults: { [targetId]: result } })
  }

  private log(level: 'info' | 'warn', message: string): void {
    if (level === 'warn') this.output.warn(message)
    else this.output.info(message)
  }

  // ---------- 定时 ----------

  private schedule(): void {
    this.stopTimer()
    const { intervalMinutes } = readConfig()
    if (!intervalMinutes || intervalMinutes <= 0) return
    this.timer = setInterval(() => {
      if (!this.disposed) void this.sync('timer')
    }, intervalMinutes * 60_000)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 配置一改就尽快试跑一次。
   * 没有它的话：用户先启用插件（此时还没填远端）、「启动后同步一次」当场失败并被
   * 消耗掉，之后要干等一个完整间隔才会再试。
   */
  private scheduleConfigSync(): void {
    if (this.configSyncTimer) clearTimeout(this.configSyncTimer)
    this.configSyncTimer = setTimeout(() => {
      this.configSyncTimer = null
      if (this.disposed) return
      const targets = readConfig().targets.filter(t => t.url.trim().length > 0)
      if (targets.length === 0) return
      void this.sync('config')
    }, 3000)
  }

  // ---------- 同步 ----------

  private async sync(trigger: 'timer' | 'manual' | 'start' | 'config'): Promise<ActionResult> {
    if (this.running) {
      if (trigger === 'manual') {
        this.queuedRerun = true
        this.report({
          status: 'running',
          message: '正在同步中，已排队：本轮结束后立即执行'
        })
        return { ok: true, message: '正在同步中，已排队：本轮结束后立即执行' }
      }
      return { ok: false, message: '正在同步中，已跳过本次触发' }
    }
    // 互斥标志必须在任何 await 之前落位，否则两个并发触发会双双通过检查，
    // 两个 git 进程撞在一起（实测表现为第二个报 git 引用锁冲突）
    this.running = true
    this.abort = new AbortController()
    const signal = this.abort.signal

    const cfg = readConfig()
    // 全量清单留着算「第几个远端」：过滤掉没填地址的行之后，下标就和界面行号对不上
    const allTargets = cfg.targets
    const targets = allTargets.filter(t => t.url.trim().length > 0)

    const fail = (message: string, detail?: string): ActionResult => {
      this.report({ status: 'error', lastRunAt: Date.now(), message, detail })
      return { ok: false, message, detail }
    }

    try {
      if (targets.length === 0) return fail('尚未配置远端仓库')
      const vaultPath = this.vaultPath()
      if (!vaultPath) return fail('未打开仓库，无法上传')
      if (!existsSync(vaultPath)) return fail('仓库目录不存在')
      if (!(await isGitAvailable())) return fail('未找到 git，请先安装 Git 并确保它在 PATH 中')
      const noLocalBranch = targets.find(t => !t.localBranch.trim())
      if (noLocalBranch) {
        return fail(
          `${targetLabel(allTargets, noLocalBranch)}没填本地分支`,
          '本地分支是必填项（要推送的那条本地分支，如 main）；远程分支留空则与本地同名。'
        )
      }
      // 认证必填校验：只对 HTTP(S) 地址要求凭据（file:// 等本地路径不需要）
      for (const target of targets) {
        if (target.auth === 'ssh') continue
        if (!/^https?:/i.test(target.url.trim())) continue
        const isPassword = target.auth === 'password'
        if (isPassword && !target.username.trim()) {
          return fail(
            `${targetLabel(allTargets, target)}选了账号密码认证，但没填账号`,
            '把账号填上后重试。'
          )
        }
        if (!(await this.secretFor(target))) {
          return fail(
            `${targetLabel(allTargets, target)}选了${isPassword ? '账号密码' : '访问令牌'}认证，但还没填${isPassword ? '密码' : '访问令牌'}`,
            '在对应远端那一行填好密钥后重试；公开仓库不需要凭据的话，可把认证方式改成 SSH。'
          )
        }
      }

      this.report({
        status: 'running',
        message: trigger === 'manual' ? '正在上传…' : '正在同步…',
        detail: undefined
      })

      // 先把编辑器里的脏文档落盘，否则刚敲的内容不会进这次提交
      await imark.workspace.saveAll(false)

      await this.ensureRepo(vaultPath, cfg, signal)

      const committed = await this.commitLocal(vaultPath, cfg, signal)
      // 无论有没有新提交都推一次：上一次推送失败（离线/被拒）时也能补上
      const { pushed, failed } = await this.pushAll(vaultPath, targets, allTargets, cfg, signal)

      if (failed.length > 0) {
        const failedLabels = new Set(failed.map(f => f.label))
        const message = targets
          .map(t => {
            const label = targetLabel(allTargets, t)
            return failedLabels.has(label) ? `${label}：推送失败` : `${label}：推送成功`
          })
          .join('\n')
        const detail = failed.map(f => `${f.label}：${f.detail}`).join('\n')
        this.report({
          status: pushed.length > 0 ? 'partial' : 'error',
          lastRunAt: Date.now(),
          message,
          detail
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
      this.report({
        status: 'ok',
        lastRunAt: Date.now(),
        message,
        detail: targets.length > 1 && head ? `提交 ${head}` : undefined
      })
      return { ok: true, message }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return fail(signal.aborted || this.disposed ? '同步已取消' : '同步失败', detail)
    } finally {
      this.running = false
      this.abort = null
      if (this.queuedRerun) {
        this.queuedRerun = false
        if (!this.disposed) void this.sync('manual')
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
   * 不能只靠环境变量：git/libcurl 不读 Windows 的「系统代理」，而 Clash / FlClash
   * 开启系统代理时写的正是那里。这里把探测结果显式拼成 `-c http.proxy=…`。
   */
  private async networkSetup(url: string, cfg: GitSyncConfig): Promise<NetworkSetup> {
    const mode = this.proxyMode(cfg)
    if (mode === 'off') {
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
      // SSH / 本地路径：没有 HTTP 代理可用，也不必白跑一次注册表查询
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
      proxyUrl: effective ? redactUrl(effective) : null,
      proxySource: effective ? (detected?.source ?? null) : null
    }
  }

  /** 每个远端每次网络操作留一行日志 —— 「到底走没走代理」只看界面是看不出来的 */
  private logNetwork(label: string, url: string, setup: NetworkSetup): void {
    if (!/^https?:/i.test(url.trim())) {
      this.log('info', `${label}：地址不是 HTTP(S)，不使用代理`)
      return
    }
    if (setup.proxyUrl) {
      this.log('info', `${label}：经代理 ${setup.proxyUrl}（${setup.proxySource ?? '来源未知'}）`)
      return
    }
    if (setup.mode === 'off') this.log('info', `${label}：直连（插件里已关闭代理）`)
    else if (setup.mode === 'manual') {
      this.log('warn', `${label}：手动代理地址为空或无法识别，已按直连处理`)
    } else this.log('info', `${label}：直连（未检测到本机代理）`)
  }

  /** 「检测本机代理」命令：结果用通知展示，不覆盖同步状态卡 */
  private async detectProxy(): Promise<ActionResult> {
    const cfg = readConfig()
    const mode = this.proxyMode(cfg)

    let result: ActionResult
    if (mode === 'off') {
      result = { ok: true, message: '当前为直连：不使用代理（环境变量里的代理也会被忽略）' }
    } else if (mode === 'manual') {
      const url = normalizeProxyUrl(cfg.proxyUrl)
      if (!url) {
        result = {
          ok: false,
          message: `手动代理地址无法识别：${cfg.proxyUrl?.trim() || '(空)'}`,
          detail: '示例：http://127.0.0.1:7890、socks5://127.0.0.1:7891'
        }
      } else {
        const reachable = await probeProxy(url)
        result = {
          ok: true,
          message: `手动代理：${redactUrl(url)}（${reachable ? '端口可连接' : '端口连不上'}）`,
          ...(reachable ? {} : { detail: '请确认代理客户端正在运行，或检查地址与端口。' })
        }
      }
    } else {
      // 大多数远端是 HTTPS，先按它探；没有再按 HTTP 探（只设了 HTTP_PROXY 的情况）
      const found = (await detectSystemProxy('https')) ?? (await detectSystemProxy('http'))
      if (!found) {
        const checked = process.platform === 'win32' ? '环境变量与 Windows 系统代理' : '环境变量'
        result = {
          ok: true,
          message: `未检测到本机代理（已检查${checked}）`,
          detail:
            '可在插件设置里把「连接方式」改为「手动指定代理」；Clash / FlClash 的默认混合端口是 http://127.0.0.1:7890。'
        }
      } else {
        const reachable = await probeProxy(found.url)
        result = {
          ok: true,
          message: `检测到本机代理：${redactUrl(found.url)}（${found.source}${reachable ? '，端口可连接' : '，但端口连不上'}）`,
          ...(reachable ? {} : { detail: '代理已配置但连接不上：请确认代理客户端正在运行。' })
        }
      }
    }

    this.output.info(result.message)
    if (result.detail) this.output.info(result.detail)
    if (result.ok) await imark.window.showInformationMessage(result.message)
    else await imark.window.showWarningMessage(result.message)
    return result
  }

  private failureContext(target: GitTarget, setup: NetworkSetup): FailureContext {
    return {
      mode: setup.mode,
      proxyUrl: setup.proxyUrl,
      proxySource: setup.proxySource,
      remoteUrl: target.url
    }
  }

  // ---------- 本地仓库 ----------

  private vaultPath(): string | null {
    return imark.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  }

  /** 把工作区改动提交到本地；返回是否产生了新提交 */
  private async commitLocal(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    const add = await runGit(['add', '-A'], { cwd: vaultPath, signal })
    if (!add.ok) throw new Error(`git add 失败：${summarize(add.stderr || add.stdout, 3)}`)

    const status = await runGit(['status', '--porcelain'], { cwd: vaultPath, signal })
    if (status.stdout.trim().length === 0) return false

    const identity = await this.identityArgs(vaultPath, cfg, signal)
    const message = (cfg.commitMessage || 'sync: {time}').replace(/\{time\}/g, stamp())
    const commit = await runGit([...identity, 'commit', '-m', message], {
      cwd: vaultPath,
      signal
    })
    if (!commit.ok) {
      throw new Error(`提交失败：${summarize(commit.stderr || commit.stdout, 3)}`)
    }
    return true
  }

  /** 逐个远端推送，收集成功/失败明细（失败也继续推其余远端） */
  private async pushAll(
    vaultPath: string,
    targets: GitTarget[],
    allTargets: readonly GitTarget[],
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<{ pushed: string[]; failed: { label: string; detail: string }[] }> {
    const pushed: string[] = []
    const failed: { label: string; detail: string }[] = []
    for (const target of targets) {
      const label = targetLabel(allTargets, target)
      const result = await this.pushTarget(vaultPath, target, label, cfg, signal)
      // 每推完一个就上报，设置页的卡片不用等整轮结束才变色
      this.reportTarget(target.id, result.ok ? 'ok' : 'error')
      if (result.ok) pushed.push(label)
      else failed.push({ label, detail: result.detail })
    }
    return { pushed, failed }
  }

  /**
   * 不是 git 仓库时按配置初始化。
   * 插件**不改动仓库的 remote 配置** —— 推送一律直接给 URL，凭据由每次现挂的
   * credential helper 提供。
   */
  private async ensureRepo(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<void> {
    if (existsSync(join(vaultPath, '.git'))) return
    if (!cfg.autoInitRepo) {
      throw new Error('当前仓库还不是 git 仓库（可在插件设置中开启自动初始化）')
    }
    const wantBranch = cfg.initBranch?.trim() || 'main'
    let init = await runGit(['init', '-b', wantBranch], { cwd: vaultPath, signal })
    if (!init.ok) {
      // 老版本 git 不支持 -b
      init = await runGit(['init'], { cwd: vaultPath, signal })
      if (!init.ok) throw new Error(`初始化仓库失败：${summarize(init.stderr, 3)}`)
      await runGit(['symbolic-ref', 'HEAD', `refs/heads/${wantBranch}`], {
        cwd: vaultPath,
        signal
      })
    }
    if (cfg.writeGitignore) {
      // wx：已存在则不动
      await writeFile(join(vaultPath, '.gitignore'), DEFAULT_GITIGNORE, { flag: 'wx' }).catch(
        () => {}
      )
    }
    if (cfg.writeReadme) {
      const name = basename(vaultPath) || 'Notes'
      await writeFile(
        join(vaultPath, 'README.md'),
        `# ${name}\n\n> 由 iMark 的「定时上传」插件在初始化仓库时创建。\n`,
        { flag: 'wx' }
      ).catch(() => {})
    }
  }

  /** 当前提交的短 SHA，用于把「到底同步到哪个版本」说清楚 */
  private async headShort(vaultPath: string, signal: AbortSignal): Promise<string> {
    const result = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: vaultPath, signal })
    return result.ok ? result.stdout.trim() : ''
  }

  /** 仓库没配 user.name/user.email 时用插件配置兜底，否则 commit 会直接失败 */
  private async identityArgs(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<string[]> {
    const name = (await runGit(['config', 'user.name'], { cwd: vaultPath, signal })).stdout.trim()
    const email = (
      await runGit(['config', 'user.email'], { cwd: vaultPath, signal })
    ).stdout.trim()
    const args: string[] = []
    if (!name) args.push('-c', `user.name=${cfg.authorName || 'iMark'}`)
    if (!email) args.push('-c', `user.email=${cfg.authorEmail || 'imark@local'}`)
    return args
  }

  /** 解析该远端要推送的分支：本地分支必填；远端分支留空 = 与本地同名 */
  private branchNames(target: GitTarget): { local: string; remote: string } {
    const local = target.localBranch.trim()
    const remote = target.remoteBranch.trim() || local
    return { local, remote }
  }

  private secretKey(target: GitTarget): string {
    return `targets:${secretSlot(target)}`
  }

  private async secretFor(target: GitTarget): Promise<string> {
    return (await this.context.secrets.get(this.secretKey(target))) ?? ''
  }

  /**
   * 按认证方式取出要注入给 git 的用户名/密码：
   * - token：用户固定 oauth2（私有令牌的通用写法），密码是访问令牌
   * - password：用户是配置里的账号，密码是存的密钥
   * - ssh：返回 null —— 交给本机 SSH 密钥，不注入任何凭据
   */
  private async credentialFor(
    target: GitTarget
  ): Promise<{ user: string; pass: string } | null> {
    if (target.auth === 'ssh') return null
    const secret = await this.secretFor(target)
    if (!secret) return null
    const user = target.auth === 'password' ? target.username.trim() : 'oauth2'
    return { user, pass: secret }
  }

  private async pushTarget(
    vaultPath: string,
    target: GitTarget,
    label: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<{ ok: boolean; detail: string }> {
    const cred = await this.credentialFor(target)
    const { local, remote } = this.branchNames(target)
    const setup = await this.networkSetup(target.url, cfg)
    this.logNetwork(label, target.url, setup)
    const push = await runGit(
      [
        ...credentialArgs(cred?.pass ?? ''),
        ...setup.args,
        'push',
        target.url.trim(),
        `refs/heads/${local}:refs/heads/${remote}`
      ],
      {
        cwd: vaultPath,
        signal,
        env: { ...credentialEnv(cred?.user ?? '', cred?.pass ?? ''), ...setup.env }
      }
    )
    if (push.ok) return { ok: true, detail: '' }
    const hint = classifyPushError(push.stderr, this.failureContext(target, setup))
    const raw = summarize(push.stderr || push.stdout, 4)
    return { ok: false, detail: hint || raw || `退出码 ${push.code}` }
  }

  /** 测试连接：带 targetId 时只测那一个远端（界面上每个远端后面有自己的「测试连接」） */
  private async testConnection(targetId?: string): Promise<ActionResult> {
    const cfg = readConfig()
    const allTargets = cfg.targets
    const configured = allTargets.filter(t => t.url.trim().length > 0)
    const targets = targetId ? configured.filter(t => t.id === targetId) : configured
    if (targets.length === 0) {
      return {
        ok: false,
        message: targetId ? '该远端已不存在（可能刚被删除）' : '尚未配置远端仓库'
      }
    }
    if (!(await isGitAvailable())) return { ok: false, message: '未找到 git，请先安装 Git' }
    const vaultPath = this.vaultPath()
    const cwd = vaultPath && existsSync(vaultPath) ? vaultPath : process.cwd()

    this.report({
      status: 'running',
      message:
        targets.length === 1
          ? `${targetLabel(allTargets, targets[0])}：正在测试连接…`
          : '正在测试连接…',
      detail: undefined
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
      const result = await runGit(
        [
          ...credentialArgs(cred?.pass ?? ''),
          ...setup.args,
          'ls-remote',
          '--heads',
          target.url.trim(),
          branch
        ],
        {
          cwd,
          timeoutMs: 30_000,
          env: { ...credentialEnv(cred?.user ?? '', cred?.pass ?? ''), ...setup.env }
        }
      )
      this.reportTarget(target.id, result.ok ? 'ok' : 'error')
      if (result.ok) {
        okCount += 1
        const found = result.stdout.trim().length > 0
        lines.push(
          `${name}：连接测试通过${found ? '' : `（远端还没有 ${branch} 分支，首次推送时创建）`}`
        )
      } else {
        const reason =
          classifyPushError(result.stderr, this.failureContext(target, setup)) ||
          summarize(result.stderr || result.stdout, 3) ||
          '连接失败'
        lines.push(`${name}：连接测试失败`)
        reasons.push(`${name}：${reason}`)
      }
    }
    const allOk = okCount === targets.length
    const overall = allOk ? '成功' : okCount > 0 ? '部分失败' : '失败'
    const message = targets.length === 1 ? lines[0]! : lines.join('\n')
    const detail = reasons.length > 0 ? reasons.join('\n') : undefined
    this.report({
      status: allOk ? 'ok' : okCount > 0 ? 'partial' : 'error',
      lastRunAt: Date.now(),
      message,
      detail
    })
    return { ok: allOk, message: targets.length === 1 ? lines[0]! : overall, detail }
  }
}

let instance: GitSyncPlugin | null = null

export function activate(context: imark.ExtensionContext): void {
  instance = new GitSyncPlugin(context)
  instance.start()
}

export function deactivate(): void {
  instance?.stop()
  instance = null
}
