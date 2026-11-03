/**
 * 「远程同步（Git）」扩展。
 *
 * 配置从 `workspace.getConfiguration()` 读，密钥从 `context.secrets` 取，状态用
 * `imark.reportStatus()` 上报，git 直接用 Node 的 `child_process` 跑。
 *
 * 同步是双向的：先把本地改动提交成一次提交，再从远端拉取配置的分支并
 * 快进/合并到当前分支，最后把结果推送回远端。
 *
 * 扩展按 VS Code 信任模型以当前用户权限运行，因此这里拿到的是完整的 Node 能力；
 * 密钥只在本扩展宿主进程内使用，不写进日志、状态或仓库配置，也不改动用户的
 * remote 设置（拉取与推送都直接给 URL，凭据由一次性 credential helper 注入）。
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
/** 「从远端下载」创建的 stash 用这个前缀标记,同步时据此自动恢复 */
const DOWNLOAD_STASH_PREFIX = 'imark-download:'
const CMD_SYNC_NOW = 'imark.git-sync.syncNow'
const CMD_UPLOAD_NOW = 'imark.git-sync.uploadNow'
const CMD_DOWNLOAD_NOW = 'imark.git-sync.downloadNow'
const CMD_RESOLVE_CONFLICTS = 'imark.git-sync.resolveConflicts'
const CMD_DETECT_PROXY = 'imark.git-sync.detectProxy'
const CMD_TEST_TARGET = 'imark.git-sync.testTarget'

/** 新建仓库时写入的忽略项；已有仓库绝不改动用户的 .gitignore */
const DEFAULT_GITIGNORE = `# iMark 远程同步默认忽略
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
type SyncMode = 'sync' | 'upload' | 'download'
type SyncTrigger = 'timer' | 'manual' | 'start' | 'config'

/**
 * 拉取某一个远端的结果。
 *
 * `updated` 是快进或空仓库直接采纳远端分支；`merged` 是两边都有新提交、
 * 自动合并成功；`latest` 是本地已经包含远端（没有东西可下载）。
 */
interface PullOutcome {
  ok: boolean
  status: 'updated' | 'merged' | 'latest' | 'empty' | 'skipped' | 'conflict' | 'error'
  /** 远端带来多少提交（快进/合并时用于状态文案） */
  commits: number
  /** 失败或跳过时给用户的原因 */
  detail: string
  /** status === 'conflict' 时,仍带冲突标记的文件 */
  files?: string[]
}

interface PushOutcome {
  ok: boolean
  detail: string
}

/** 工作区里还有没处理完的冲突标记时抛出,调用方据此给出「去编辑器处理」的提示 */
class MergeConflictError extends Error {
  constructor(readonly files: string[]) {
    super('合并冲突未解决')
    this.name = 'MergeConflictError'
  }
}

/**
 * 从 `git diff --cached --check` 的输出里提取仍有冲突标记的文件。
 * 输出形如 `笔记.md:3: leftover conflict marker`;其它白空格告警忽略。
 */
function conflictMarkerFiles(output: string): string[] {
  const files = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*):\d+: leftover conflict marker$/.exec(line)
    if (match?.[1]) files.add(match[1])
  }
  return [...files]
}

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
  /** 网络代理：auto = 自动探测环境变量 / 系统代理（Windows 注册表、Linux GNOME）；manual = 用下面填的地址；找不到代理时直接连接 */
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
  /**
   * 失败已在扩展自己的界面里说明(如远端配置的黄色提示),宿主不必再记一条
   * 「命令 · 失败」到调试日志。只影响命令执行日志,不影响调用方。
   */
  silent?: boolean
}

/** 一次网络操作实际用到的代理参数 */
interface NetworkSetup {
  /** 追加到 git 命令行（在子命令之前）的 -c 参数 */
  args: string[]
  /** 追加到子进程环境变量的部分（NO_PROXY 等） */
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
  const all = Array.isArray(rawTargets)
    ? rawTargets.map(normalizeTarget).filter((item): item is GitTarget => item !== null)
    : []
  // 只支持一个远端。旧版本可能留下多行:优先取第一行填了地址的,否则取第一行;
  // 设置页只显示一行,用户编辑任意字段时会把列表收敛成这一行。
  const chosen = all.find(target => target.url.trim().length > 0) ?? all[0] ?? null
  const targets = chosen ? [chosen] : []
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

/** 状态与失败信息里对远端的称呼。只支持一个远端,不再有「第几个」。 */
function targetLabel(_all: readonly GitTarget[], _target: Pick<GitTarget, 'id'>): string {
  return '远端'
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
    return '远端已有本地没有的提交，推送被拒。请先执行「立即同步」合并远端改动，或在仓库目录手动处理后重试。'
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
      return `无法连接远端：已尝试经代理 ${ctx.proxyUrl}（${ctx.proxySource ?? '来源未知'}）。请确认代理客户端正在运行；清空「代理地址」后会直接连接。`
    }
    if (ctx?.mode === 'manual') {
      return '无法连接远端：没有可用的手动代理（地址为空或无法识别），已直接连接仍失败。请检查扩展设置里的「代理地址」。'
    }
    if (ctx && isSshRemote(ctx.remoteUrl)) {
      return '无法连接远端：SSH 地址不经过 HTTP 代理。请检查网络，或改用 HTTPS 地址（HTTPS 才能走本机代理）。'
    }
    return '无法连接远端：未检测到本机代理。若浏览器能访问而这里超时，请在扩展设置里填写本机代理（Clash / FlClash 常见为 http://127.0.0.1:7890）。'
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
  private queuedRerun: SyncMode | null = null
  /** 「启动后同步一次」每次激活只做一次 */
  private startSyncScheduled = false

  constructor(private readonly context: imark.ExtensionContext) {
    this.output = imark.window.createOutputChannel('远程同步')
    this.context.subscriptions.push(this.output)
  }

  start(): void {
    this.context.subscriptions.push(
      imark.commands.registerCommand(CMD_SYNC_NOW, () => this.sync('manual', 'sync')),
      imark.commands.registerCommand(CMD_UPLOAD_NOW, () => this.sync('manual', 'upload')),
      imark.commands.registerCommand(CMD_DOWNLOAD_NOW, () => this.sync('manual', 'download')),
      imark.commands.registerCommand(CMD_RESOLVE_CONFLICTS, () => this.resolveConflicts()),
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
    this.statusItem.text = '$(git) 远程同步'
    this.statusItem.tooltip = '立即与远端同步（下载并上传）'
    this.statusItem.command = CMD_SYNC_NOW
    this.statusItem.show()
    this.context.subscriptions.push(this.statusItem)

    this.schedule()
    if (!this.startSyncScheduled && readConfig().syncOnStart) {
      this.startSyncScheduled = true
      // 稍等窗口与文档就绪再跑
      this.startTimer = setTimeout(() => {
        this.startTimer = null
        if (!this.disposed) void this.sync('start', 'sync')
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
    this.queuedRerun = null
  }

  // ---------- 状态 ----------

  private report(update: imark.ImarkStatusUpdate): void {
    this.lastStatus = update.status
    imark.imark.reportStatus(update)
    if (!this.statusItem) return
    const label =
      update.status === 'running'
        ? '$(sync) 远程同步'
        : update.status === 'ok'
          ? '$(check) 远程同步'
          : update.status === 'partial' || update.status === 'error'
            ? '$(alert) 远程同步'
            : '$(git) 远程同步'
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
      if (!this.disposed) void this.sync('timer', 'sync')
    }, intervalMinutes * 60_000)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 配置一改就尽快试跑一次。
   * 没有它的话：用户先启用扩展（此时还没填远端）、「启动后同步一次」当场失败并被
   * 消耗掉，之后要干等一个完整间隔才会再试。
   */
  private scheduleConfigSync(): void {
    if (this.configSyncTimer) clearTimeout(this.configSyncTimer)
    this.configSyncTimer = setTimeout(() => {
      this.configSyncTimer = null
      if (this.disposed) return
      const targets = readConfig().targets.filter(t => t.url.trim().length > 0)
      if (targets.length === 0) return
      void this.sync('config', 'sync')
    }, 3000)
  }

  // ---------- 同步 ----------

  private async sync(trigger: SyncTrigger, mode: SyncMode = 'sync'): Promise<ActionResult> {
    if (this.running) {
      if (trigger === 'manual') {
        this.queuedRerun = mode
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
    // readConfig 已经只保留一个远端；地址为空时走「配置未完成」提示
    const allTargets = cfg.targets
    const targets = allTargets.filter(t => t.url.trim().length > 0)
    const wantPull = mode !== 'upload'
    const wantPush = mode !== 'download'
    const action = mode === 'download' ? '下载' : mode === 'upload' ? '上传' : '同步'

    const fail = (message: string, detail?: string): ActionResult => {
      // 状态卡只放得下一行摘要,具体原因必须同时写进扩展日志,否则用户只看到
      // 「同步失败」却不知道该去查什么。
      if (message === '同步已取消') this.output.info(message)
      else {
        this.output.error(message)
        if (detail) this.output.error(detail)
      }
      this.report({ status: 'error', lastRunAt: Date.now(), message, detail })
      return { ok: false, message, detail }
    }

    /**
     * 远端本身没填完整(缺分支/账号/密钥)。
     *
     * 设置页顶部的黄色提示已经逐行列出还缺什么,这里**不写日志、也不覆盖状态卡** ——
     * 否则用户刚点「添加远端」、还没填完,3 秒后的配置试跑就会在日志与最上方
     * 留下一条看起来像「同步失败了」的错误。
     */
    const invalid = (message: string, detail?: string): ActionResult => ({
      ok: false,
      message,
      detail,
      silent: true
    })

    try {
      if (targets.length === 0) {
        // 一行远端都没有时设置页里没有黄色提示可看,状态卡仍是唯一的说明;
        // 有行但地址全空时,黄色提示已经覆盖,不再重复。
        return cfg.targets.length > 0 ? invalid('远端配置尚未填写完整') : fail('尚未配置远端仓库')
      }
      const vaultPath = this.vaultPath()
      if (!vaultPath) return fail(`未打开仓库，无法${action}`)
      if (!existsSync(vaultPath)) return fail('仓库目录不存在')
      if (!(await isGitAvailable())) return fail('未找到 git，请先安装 Git 并确保它在 PATH 中')
      const noLocalBranch = targets.find(t => !t.localBranch.trim())
      if (noLocalBranch) {
        return invalid(
          `${targetLabel(allTargets, noLocalBranch)}没填本地分支`,
          '本地分支是必填项（要同步的那条本地分支，如 main）；远程分支留空则与本地同名。'
        )
      }
      // 认证必填校验：只对 HTTP(S) 地址要求凭据（file:// 等本地路径不需要）
      for (const target of targets) {
        if (target.auth === 'ssh') continue
        if (!/^https?:/i.test(target.url.trim())) continue
        const isPassword = target.auth === 'password'
        if (isPassword && !target.username.trim()) {
          return invalid(
            `${targetLabel(allTargets, target)}选了账号密码认证，但没填账号`,
            '把账号填上后重试。'
          )
        }
        if (!(await this.secretFor(target))) {
          return invalid(
            `${targetLabel(allTargets, target)}选了${isPassword ? '账号密码' : '访问令牌'}认证，但还没填${isPassword ? '密码' : '访问令牌'}`,
            '在对应远端那一行填好密钥后重试；公开仓库不需要凭据的话，可把认证方式改成 SSH。'
          )
        }
      }

      this.report({
        status: 'running',
        message: mode === 'download' ? '正在下载…' : mode === 'upload' ? '正在上传…' : '正在同步…',
        detail: undefined
      })

      // 先把编辑器里的脏文档落盘，否则刚敲的内容不会进这次提交
      await imark.workspace.saveAll(false)

      const created = await this.ensureRepo(vaultPath, cfg, signal)

      // 上一次合并可能还没收尾：冲突标记已经由用户在编辑器里处理掉了，
      // 这里把合并补成一次提交；标记还在就停下，绝不把标记提交上去。
      let committed = false
      let hasHead = await this.hasHead(vaultPath, signal)
      if (await this.mergeInProgress(vaultPath, signal)) {
        if (!wantPush) {
          const detail = '上一次合并还有冲突未解决。请用「立即同步」完成合并后再下载。'
          await this.reloadDocuments()
          await this.openConflictDialog(await this.conflictFiles(vaultPath, signal), true)
          this.output.warn(detail)
          this.report({ status: 'error', lastRunAt: Date.now(), message: '合并冲突未解决', detail })
          return { ok: false, message: '合并冲突未解决', detail }
        }
        const finished = await this.finishMerge(vaultPath, cfg, signal)
        if (!finished.ok) {
          const detail = `以下文件还有冲突标记：${finished.files.join('、')}。请在编辑器或冲突处理窗口中处理后，再点「立即同步」。`
          await this.reloadDocuments()
          await this.openConflictDialog(finished.files, true)
          this.output.warn(detail)
          this.report({ status: 'error', lastRunAt: Date.now(), message: '合并冲突未解决', detail })
          return { ok: false, message: '合并冲突未解决', detail }
        }
        committed = true
        hasHead = await this.hasHead(vaultPath, signal)
      }

      // 上一次「从远端下载」如果因为远端合并冲突而把本地改动留在 stash 里,
      // 现在合并已经完成,先把它恢复出来 —— 同步/上传随后会把它提交。
      if (wantPush) {
        const restored = await this.restorePendingDownloadStashes(vaultPath, signal)
        if (!restored.ok) {
          const detail = restored.files.length
            ? `暂存的本地改动与远端改动冲突：${restored.files.join('、')}。冲突标记已保留，请处理后同步。`
            : restored.detail
          await this.reloadDocuments()
          if (restored.files.length > 0) await this.openConflictDialog(restored.files, true)
          this.output.warn(detail)
          if (targets[0]) this.reportTarget(targets[0].id, 'error')
          this.report({
            status: 'error',
            lastRunAt: Date.now(),
            message: '恢复本地改动时发生冲突',
            detail
          })
          return { ok: false, message: '恢复本地改动时发生冲突', detail }
        }
      }

      // 先固定本地改动，下载/合并才有干净的起点。
      // 空仓库例外：先下载、采纳远端分支，再写脚手架提交 —— 否则首次连接一个
      // 已有内容的远端时，本地根提交会与远端变成「历史无关」，平白多一次合并。
      if (wantPush && (hasHead || (await this.hasPendingFiles(vaultPath, signal)))) {
        if (created) await this.writeScaffold(vaultPath, cfg)
        committed = (await this.commitLocal(vaultPath, cfg, signal)) || committed
        hasHead = await this.hasHead(vaultPath, signal)
      }

      // 「从远端下载」不提交本地改动,但需要干净的工作区:先 stash,拉取后再恢复。
      // 空仓库没有初始提交,stash 不了;是否采纳远端由 pullTarget 自己判断。
      let downloadStash: string | null = null
      if (mode === 'download' && hasHead) {
        const stashed = await this.stashLocalChanges(vaultPath, signal)
        if (!stashed.ok) {
          const message = '无法暂存本地改动'
          this.output.error(`${message}：${stashed.detail}`)
          this.report({
            status: 'error',
            lastRunAt: Date.now(),
            message,
            detail: stashed.detail
          })
          return { ok: false, message, detail: stashed.detail }
        }
        downloadStash = stashed.ref
      }

      const pulls = new Map<string, PullOutcome>()
      let conflict: { target: GitTarget; outcome: PullOutcome } | null = null
      if (wantPull) {
        for (const target of targets) {
          const label = targetLabel(allTargets, target)
          const outcome = await this.pullTarget(
            vaultPath,
            target,
            label,
            cfg,
            signal,
            !hasHead,
            mode === 'download'
          )
          pulls.set(target.id, outcome)
          if (outcome.status === 'updated') {
            this.log(
              'info',
              `${label}：已下载 ${outcome.commits} 个提交（${this.branchNames(target).remote}）`
            )
          } else if (outcome.status === 'merged') {
            this.log('info', `${label}：已合并 ${outcome.commits} 个远端提交`)
          } else if (outcome.status === 'empty') {
            this.log(
              'info',
              `${label}：远端还没有 ${this.branchNames(target).remote} 分支，将在本次上传时创建`
            )
          } else if (outcome.status === 'skipped') {
            this.log('info', `${label}：${outcome.detail}`)
          } else if (outcome.status === 'conflict') {
            // 合并已留在进行中状态,后续远端/推送都不能再动
            conflict = { target, outcome }
            break
          } else if (outcome.status === 'error') {
            this.output.error(`${label}：下载失败：${outcome.detail}`)
          }
        }
      }

      let stashRestored = false
      if (mode === 'download' && downloadStash && !conflict) {
        const restored = await this.applyDownloadStash(vaultPath, downloadStash, signal)
        if (restored.ok) {
          stashRestored = true
          downloadStash = null
        } else if (restored.files.length > 0) {
          // 暂存已应用并留下了冲突标记(stash 已经删掉),走统一的冲突报告
          downloadStash = null
          conflict = {
            target: targets[0]!,
            outcome: {
              ok: false,
              status: 'conflict',
              commits: 0,
              detail: restored.detail,
              files: restored.files
            }
          }
        } else {
          const detail = restored.detail
          this.output.error(detail)
          this.report({
            status: 'error',
            lastRunAt: Date.now(),
            message: '无法恢复暂存的本地改动',
            detail
          })
          return { ok: false, message: '无法恢复暂存的本地改动', detail }
        }
      }

      if (conflict) {
        await this.reloadDocuments()
        const files = conflict.outcome.files ?? []
        await this.openConflictDialog(files, true)
        const label = targetLabel(allTargets, conflict.target)
        const detail = [
          `${label}：${conflict.outcome.detail}`,
          ...(downloadStash
            ? ['本地未提交改动仍暂存在 stash 中；完成远端冲突处理后点「立即同步」，扩展会自动恢复并提交。']
            : []),
          '处理完后点「立即同步」，扩展会自动完成合并提交并继续推送。'
        ].join('\n')
        this.output.warn(`${label}：合并冲突（${files.length} 个文件）`)
        this.output.warn(detail)
        this.reportTarget(conflict.target.id, 'error')
        this.report({ status: 'error', lastRunAt: Date.now(), message: '合并冲突，等待处理', detail })
        return { ok: false, message: '合并冲突，等待处理', detail }
      }

      if ([...pulls.values()].some(o => o.status === 'updated' || o.status === 'merged')) {
        // 文件已经被外部 git 改过:刷新文件树,并让未修改的打开文档重新读盘,
        // 否则编辑器里还是旧内容(下载了也看不见,冲突更没法处理)。
        await this.reloadDocuments()
      }

      // 空仓库先采纳远端，再补本地脚手架（wx：远端已有的文件不会被覆盖）
      if (wantPush && created && !hasHead) {
        await this.writeScaffold(vaultPath, cfg)
        committed = (await this.commitLocal(vaultPath, cfg, signal)) || committed
        hasHead = await this.hasHead(vaultPath, signal)
      }

      const pushes = new Map<string, PushOutcome>()
      if (wantPush) {
        for (const target of targets) {
          const label = targetLabel(allTargets, target)
          pushes.set(target.id, await this.pushTarget(vaultPath, target, label, cfg, signal))
        }
      }

      // 汇总远端的结果：同步模式下下载与推送都成功才算成功
      const failures: { label: string; detail: string }[] = []
      for (const target of targets) {
        const label = targetLabel(allTargets, target)
        const pull = pulls.get(target.id)
        const push = pushes.get(target.id)
        const reasons: string[] = []
        if (pull && !pull.ok) reasons.push(`下载失败：${pull.detail}`)
        if (push && !push.ok) reasons.push(`推送失败：${push.detail}`)
        this.reportTarget(target.id, reasons.length > 0 ? 'error' : 'ok')
        if (reasons.length > 0) {
          failures.push({
            label,
            detail: reasons.map(reason => reason.replace(/。$/, '')).join('；')
          })
        }
      }

      const head = await this.headShort(vaultPath, signal)

      if (failures.length > 0) {
        const failedLabels = new Set(failures.map(f => f.label))
        const message = targets
          .map(t => {
            const label = targetLabel(allTargets, t)
            return failedLabels.has(label) ? `${label}：${action}失败` : `${label}：${action}成功`
          })
          .join('\n')
        const detail = failures.map(f => `${f.label}：${f.detail}`).join('\n')
        // 失败原因同时落到扩展日志里;状态卡只显示「远端：失败」。
        this.output.error(`${action}失败（${failures.length}/${targets.length}）`)
        this.output.error(detail)
        this.report({
          status: failures.length < targets.length ? 'partial' : 'error',
          lastRunAt: Date.now(),
          message,
          detail
        })
        return { ok: false, message: `${action}失败（${failures.length}/${targets.length}）`, detail }
      }

      let message: string
      if (mode === 'download') {
        const only = pulls.get(targets[0]!.id)
        message =
          only?.status === 'updated'
            ? `已下载 ${only.commits} 个提交${head ? `（当前 ${head}）` : ''}`
            : only?.status === 'merged'
              ? `已合并 ${only.commits} 个远端提交${head ? `（当前 ${head}）` : ''}`
              : only?.status === 'empty'
                ? `远端还没有 ${this.branchNames(targets[0]!).remote} 分支`
                : '无改动：本地已是远端最新'
        if (stashRestored) message += '；本地未提交改动已恢复'
      } else if (mode === 'upload') {
        message = committed
          ? `已提交并推送到远端${head ? `（提交 ${head}）` : ''}`
          : `无改动：远端已是 ${head || '最新'}`
      } else {
        const parts: string[] = []
        let downloaded = 0
        let merged = 0
        let remoteEmpty = false
        for (const outcome of pulls.values()) {
          if (outcome.status === 'updated') downloaded += outcome.commits
          else if (outcome.status === 'merged') merged += outcome.commits
          else if (outcome.status === 'empty') remoteEmpty = true
        }
        if (downloaded > 0) parts.push(`下载 ${downloaded} 个提交`)
        if (merged > 0) parts.push(`合并 ${merged} 个远端提交`)
        if (committed) parts.push(`新提交 ${head}`)
        else if (head) parts.push(`当前 ${head}`)
        parts.push('推送到远端')
        message =
          downloaded > 0 || merged > 0 || committed
            ? `已同步：${parts.join('，')}`
            : remoteEmpty
              ? `远端还没有 ${this.branchNames(targets[0]!).remote} 分支，已推送到远端`
              : `无改动：本地与远端一致${head ? `（${head}）` : ''}`
      }
      this.report({ status: 'ok', lastRunAt: Date.now(), message })
      return { ok: true, message }
    } catch (err) {
      if (err instanceof MergeConflictError) {
        const detail = `以下文件还有冲突标记：${err.files.join('、')}。请在编辑器或冲突处理窗口中处理后，再点「立即同步」。`
        await this.reloadDocuments()
        await this.openConflictDialog(err.files, true)
        this.output.warn(detail)
        this.report({ status: 'error', lastRunAt: Date.now(), message: '合并冲突未解决', detail })
        return { ok: false, message: '合并冲突未解决', detail }
      }
      const detail = err instanceof Error ? err.message : String(err)
      return fail(signal.aborted || this.disposed ? '同步已取消' : '同步失败', detail)
    } finally {
      this.running = false
      this.abort = null
      if (this.queuedRerun) {
        const queued = this.queuedRerun
        this.queuedRerun = null
        if (!this.disposed) void this.sync('manual', queued)
      }
    }
  }

  // ---------- 下载与合并 ----------

  /** 当前检出的分支名；HEAD 游离时返回空串 */
  private async currentBranch(vaultPath: string, signal: AbortSignal): Promise<string> {
    const result = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: vaultPath,
      signal
    })
    return result.ok ? result.stdout.trim() : ''
  }

  /** 仓库是否已经有至少一个提交 */
  private async hasHead(vaultPath: string, signal: AbortSignal): Promise<boolean> {
    const result = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: vaultPath, signal })
    return result.ok && result.stdout.trim().length > 0
  }

  /** 工作区是否有未提交的改动（含未跟踪文件，不含被忽略的） */
  private async hasPendingFiles(vaultPath: string, signal: AbortSignal): Promise<boolean> {
    const result = await runGit(['status', '--porcelain'], { cwd: vaultPath, signal })
    return result.ok && result.stdout.trim().length > 0
  }

  private async countCommits(
    vaultPath: string,
    from: string,
    to: string,
    signal: AbortSignal
  ): Promise<number> {
    const result = await runGit(['rev-list', '--count', from ? `${from}..${to}` : to], {
      cwd: vaultPath,
      signal
    })
    const count = Number(result.stdout.trim())
    return Number.isFinite(count) ? count : 0
  }

  /**
   * 从某个远端下载配置的分支，并合并到当前分支。
   *
   * 合并策略是「能快进就快进，分叉就自动合并，冲突就交给编辑器处理」：
   * 冲突时**保留**合并状态与冲突标记（不 abort），由编辑器的冲突界面逐处取舍；
   * 下一次同步会先检查标记是否处理完，再完成合并提交并继续推送。
   * 扩展自己不做取舍（`-X ours` / `-X theirs` 都会静默丢掉一边的改动）。
   */
  private async pullTarget(
    vaultPath: string,
    target: GitTarget,
    label: string,
    cfg: GitSyncConfig,
    signal: AbortSignal,
    allowAdopt: boolean,
    strictBranch: boolean
  ): Promise<PullOutcome> {
    const { local, remote } = this.branchNames(target)
    const current = await this.currentBranch(vaultPath, signal)
    if (!current) {
      return {
        ok: false,
        status: 'error',
        commits: 0,
        detail: '仓库当前不在任何分支上（HEAD 处于游离状态），无法下载。'
      }
    }
    if (current !== local) {
      const reason = `要下载的本地分支是 ${local}，但仓库当前在 ${current} 分支上。`
      return strictBranch
        ? { ok: false, status: 'skipped', commits: 0, detail: `${reason}请先切换到 ${local}。` }
        : {
            ok: true,
            status: 'skipped',
            commits: 0,
            detail: `${reason}已跳过下载，仍会推送本地分支。`
          }
    }

    const cred = await this.credentialFor(target)
    const setup = await this.networkSetup(target.url, cfg)
    this.logNetwork(label, target.url, setup)
    const env = { ...credentialEnv(cred?.user ?? '', cred?.pass ?? ''), ...setup.env }
    const auth = credentialArgs(cred?.pass ?? '')

    const fetch = await runGit(
      [...auth, ...setup.args, 'fetch', '--no-tags', target.url.trim(), `refs/heads/${remote}`],
      { cwd: vaultPath, signal, env }
    )
    if (!fetch.ok) {
      // 远端还没有这条分支不是错误：首次上传会创建它
      if (/couldn't find remote ref|could not find remote ref/i.test(fetch.stderr)) {
        return { ok: true, status: 'empty', commits: 0, detail: `远端还没有 ${remote} 分支` }
      }
      const hint = classifyPushError(fetch.stderr, this.failureContext(target, setup))
      return {
        ok: false,
        status: 'error',
        commits: 0,
        detail: hint || summarize(fetch.stderr || fetch.stdout, 4) || `退出码 ${fetch.code}`
      }
    }

    const fetched = (
      await runGit(['rev-parse', '--verify', 'FETCH_HEAD'], { cwd: vaultPath, signal })
    ).stdout.trim()
    if (!fetched) {
      return {
        ok: false,
        status: 'error',
        commits: 0,
        detail: '下载后读不到远端提交（FETCH_HEAD 为空）'
      }
    }

    const headResult = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: vaultPath,
      signal
    })
    const localTip = headResult.ok ? headResult.stdout.trim() : ''
    if (!localTip) {
      if (!allowAdopt) {
        return {
          ok: false,
          status: 'error',
          commits: 0,
          detail: '本地仓库还没有任何提交，无法仅下载；请使用「立即同步」或先上传一次。'
        }
      }
      // 空仓库：直接把工作区对齐到远端分支。先确认没有未跟踪文件，避免覆盖。
      const status = await runGit(['status', '--porcelain'], { cwd: vaultPath, signal })
      if (status.stdout.trim().length > 0) {
        return {
          ok: false,
          status: 'error',
          commits: 0,
          detail: '本地仓库还没有提交，且工作区有未跟踪的文件；为避免覆盖，已取消下载。'
        }
      }
      // reset --hard 会覆盖同名文件，包括被 .gitignore 忽略的（.obsidian 之类）。
      // 这些文件不出现在 status 里，必须单独和远端树比一次。
      const remoteTree = await runGit(['ls-tree', '-r', '-z', '--name-only', fetched], {
        cwd: vaultPath,
        signal
      })
      const remotePaths = new Set(remoteTree.stdout.split('\0').filter(Boolean))
      if (remotePaths.size > 0) {
        const ignored = await runGit(
          ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'],
          { cwd: vaultPath, signal }
        )
        const collisions = ignored.stdout
          .split('\0')
          .filter(path => path && remotePaths.has(path))
        if (collisions.length > 0) {
          return {
            ok: false,
            status: 'error',
            commits: 0,
            detail: `本地这些未跟踪文件与远端同名：${collisions.slice(0, 5).join('、')}。为避免覆盖，已取消下载；请先备份或移走它们再重试。`
          }
        }
      }
      const reset = await runGit(['reset', '--hard', fetched], { cwd: vaultPath, signal })
      if (!reset.ok) {
        return {
          ok: false,
          status: 'error',
          commits: 0,
          detail: `采纳远端分支失败：${summarize(reset.stderr, 3)}`
        }
      }
      return {
        ok: true,
        status: 'updated',
        commits: await this.countCommits(vaultPath, '', fetched, signal),
        detail: ''
      }
    }

    if (localTip === fetched) {
      return { ok: true, status: 'latest', commits: 0, detail: '' }
    }

    const incoming = await this.countCommits(vaultPath, localTip, fetched, signal)
    const canFastForward = await runGit(['merge-base', '--is-ancestor', localTip, fetched], {
      cwd: vaultPath,
      signal
    })
    if (canFastForward.ok) {
      const merge = await runGit(['merge', '--ff-only', fetched], { cwd: vaultPath, signal })
      if (!merge.ok) {
        return {
          ok: false,
          status: 'error',
          commits: 0,
          detail: `快进失败：${summarize(merge.stderr || merge.stdout, 4)}`
        }
      }
      return { ok: true, status: 'updated', commits: incoming, detail: '' }
    }

    const alreadyContains = await runGit(['merge-base', '--is-ancestor', fetched, localTip], {
      cwd: vaultPath,
      signal
    })
    if (alreadyContains.ok) {
      return { ok: true, status: 'latest', commits: 0, detail: '' }
    }

    // 分叉（包括两边历史无关的首次连接）：自动合并
    const identity = await this.identityArgs(vaultPath, cfg, signal)
    const merge = await runGit(
      [...identity, 'merge', '--no-edit', '--allow-unrelated-histories', fetched],
      { cwd: vaultPath, signal }
    )
    if (merge.ok) {
      return { ok: true, status: 'merged', commits: incoming, detail: '' }
    }

    // 有冲突时**不 abort**:把冲突标记留在文件里,交给编辑器的冲突界面处理。
    // 下一次同步会先把用户处理完的合并提交掉,再继续拉取/推送。
    const conflicts = await runGit(['diff', '--name-only', '-z', '--diff-filter=U'], {
      cwd: vaultPath,
      signal
    })
    const files = conflicts.stdout.split('\0').filter(Boolean)
    if (files.length > 0) {
      return {
        ok: false,
        status: 'conflict',
        commits: 0,
        files,
        detail: `远端与本地都有新提交，自动合并产生冲突：${files.join('、')}。冲突标记已保留在文件里，请在编辑器中处理后再同步。`
      }
    }
    // 没有 unmerged 文件:不是内容冲突(常见是未跟踪文件会被覆盖),abort 后如实报错
    await runGit(['merge', '--abort'], { cwd: vaultPath, signal })
    return {
      ok: false,
      status: 'error',
      commits: 0,
      detail: `远端与本地都有新提交，自动合并失败：${summarize(merge.stderr || merge.stdout, 4)}。已取消合并，本地未改动。`
    }
  }

  // ---------- 代理 ----------

  private proxyMode(cfg: GitSyncConfig): ProxyMode {
    return cfg.proxyMode === 'manual' ? 'manual' : 'auto'
  }

  /**
   * 为一次网络操作准备代理参数。
   *
   * 不能只靠环境变量：git/libcurl 不读操作系统的「系统代理」，而 Clash / FlClash
   * 开启系统代理时写的正是那里（Windows 注册表、Linux GNOME gsettings）。
   * 这里把探测结果显式拼成 `-c http.proxy=…`。
   */
  private async networkSetup(url: string, cfg: GitSyncConfig): Promise<NetworkSetup> {
    const mode = this.proxyMode(cfg)
    let detected: DetectedProxy | null = null
    if (mode === 'manual') {
      const normalized = normalizeProxyUrl(cfg.proxyUrl)
      if (normalized) detected = { url: normalized, source: '扩展设置', bypass: [] }
    } else {
      const scheme = /^https:/i.test(url.trim()) ? 'https' : /^http:/i.test(url.trim()) ? 'http' : null
      // SSH / 本地路径：没有 HTTP 代理可用，也不必白跑一次系统代理查询
      if (scheme) detected = await detectSystemProxy(scheme)
    }
    const effective = proxyForUrl(url, detected)
    if (!effective) {
      // 没有可用代理就直连；显式清空，避免宿主环境里的 HTTP_PROXY 又被 git 捡起来。
      return {
        args: ['-c', 'http.proxy='],
        env: { NO_PROXY: '*', no_proxy: '*' },
        mode,
        proxyUrl: null,
        proxySource: null
      }
    }
    const env: Record<string, string> = {}
    if (detected && detected.bypass.length > 0) {
      const bypass = detected.bypass.join(',')
      env.NO_PROXY = bypass
      env.no_proxy = bypass
    }
    return {
      args: ['-c', `http.proxy=${effective}`],
      env,
      mode,
      proxyUrl: redactUrl(effective),
      proxySource: detected?.source ?? null
    }
  }

  /** 每次网络操作留一行日志 —— 「到底走没走代理」只看界面是看不出来的 */
  private logNetwork(label: string, url: string, setup: NetworkSetup): void {
    if (!/^https?:/i.test(url.trim())) {
      this.log('info', `${label}：地址不是 HTTP(S)，不使用代理`)
      return
    }
    if (setup.proxyUrl) {
      this.log('info', `${label}：经代理 ${setup.proxyUrl}（${setup.proxySource ?? '来源未知'}）`)
      return
    }
    if (setup.mode === 'manual') {
      this.log('warn', `${label}：手动代理地址为空或无法识别，已按直连处理`)
    } else this.log('info', `${label}：直连（未检测到本机代理）`)
  }

  /** 「检测本机代理」命令：结果用通知展示，不覆盖同步状态卡 */
  private async detectProxy(): Promise<ActionResult> {
    const cfg = readConfig()
    const mode = this.proxyMode(cfg)

    let result: ActionResult
    if (mode === 'manual') {
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
        // Windows 读注册表、Linux 读 GNOME gsettings;macOS 目前只看环境变量
        const checked =
          process.platform === 'win32'
            ? '环境变量与 Windows 系统代理'
            : process.platform === 'linux'
              ? '环境变量与 GNOME 系统代理'
              : '环境变量'
        result = {
          ok: true,
          message: `未检测到本机代理（已检查${checked}）`,
          detail:
            '可在扩展设置里把「连接方式」改为「手动指定代理」；Clash / FlClash 的默认混合端口是 http://127.0.0.1:7890。'
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
    // 结果写进设置页的状态卡(面板里的展示位置),不再弹通知
    this.report({
      status: result.ok ? 'ok' : 'error',
      lastRunAt: Date.now(),
      message: result.message,
      ...(result.detail ? { detail: result.detail } : {})
    })
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
    // 只有确实处于合并状态时才检查冲突标记:普通笔记里若出现形似标记的文本,
    // 不该被当成「冲突未解决」拦下。
    const unmergedBefore = await runGit(['ls-files', '-u', '-z', '--name-only'], {
      cwd: vaultPath,
      signal
    })
    const merging = await this.mergeInProgress(vaultPath, signal)

    const add = await runGit(['add', '-A'], { cwd: vaultPath, signal })
    if (!add.ok) throw new Error(`git add 失败：${summarize(add.stderr || add.stdout, 3)}`)

    // git add 会把带着冲突标记的文件也标记成「已解决」,提交前必须自己再查一遍。
    // 合并冲突时这一条是防线:只要还有 `<<<<<<<` 之类的行,就绝不让它进提交。
    if (merging || unmergedBefore.stdout.split('\0').some(Boolean)) {
      const stagedCheck = await runGit(
        ['-c', 'core.quotePath=false', 'diff', '--cached', '--check'],
        { cwd: vaultPath, signal }
      )
      const leftover = conflictMarkerFiles(stagedCheck.stdout + stagedCheck.stderr)
      if (leftover.length > 0) throw new MergeConflictError(leftover)
    }

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

  /** 是否有上一次没做完的合并（冲突留在工作区，等待用户处理） */
  private async mergeInProgress(vaultPath: string, signal: AbortSignal): Promise<boolean> {
    const result = await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      cwd: vaultPath,
      signal
    })
    return result.ok && result.stdout.trim().length > 0
  }

  /**
   * 把用户处理完的冲突合并补成一次提交。
   *
   * `git add` 会把带着冲突标记的文件也当成「已解决」，所以这里和 `commitLocal`
   * 一样先查一遍标记；只要还有标记就返回 files，调用方据此提示用户继续处理。
   */
  private async finishMerge(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<{ ok: boolean; files: string[] }> {
    const add = await runGit(['add', '-A'], { cwd: vaultPath, signal })
    if (!add.ok) throw new Error(`git add 失败：${summarize(add.stderr || add.stdout, 3)}`)

    const check = await runGit(['-c', 'core.quotePath=false', 'diff', '--cached', '--check'], {
      cwd: vaultPath,
      signal
    })
    const files = conflictMarkerFiles(check.stdout + check.stderr)
    if (files.length > 0) return { ok: false, files }

    // --no-edit:沿用 git 的合并提交信息,不打开编辑器
    const identity = await this.identityArgs(vaultPath, cfg, signal)
    const commit = await runGit([...identity, 'commit', '--no-edit', '--allow-empty'], {
      cwd: vaultPath,
      signal
    })
    if (!commit.ok) {
      throw new Error(`完成合并失败：${summarize(commit.stderr || commit.stdout, 3)}`)
    }
    return { ok: true, files: [] }
  }

  /**
   * 让渲染层刷新文件树并重载未修改的已打开文档。
   * 拉取/合并是外部 git 改的文件,不通知渲染层的话编辑器里还是旧内容 ——
   * 下载了看不见,冲突标记也没法展示。旧宿主没有这个 API 时静默跳过。
   */
  private async reloadDocuments(): Promise<void> {
    try {
      await imark.workspace.reloadFromDisk()
    } catch {
      /* 渲染层未就绪或宿主版本较旧:不影响同步本身 */
    }
  }

  // ---------- 下载时的本地改动暂存 ----------

  /** 找一条由「从远端下载」创建的 stash(按消息前缀识别) */
  private async findDownloadStash(
    vaultPath: string,
    signal: AbortSignal
  ): Promise<string | null> {
    const list = await runGit(['stash', 'list', '--format=%gd%x09%s'], {
      cwd: vaultPath,
      signal
    })
    for (const line of list.stdout.split(/\r?\n/)) {
      const [ref, subject] = line.split('\t')
      if (ref && subject?.includes(DOWNLOAD_STASH_PREFIX)) return ref
    }
    return null
  }

  /**
   * 下载前把本地未提交改动暂存起来,让 fetch/merge 有一个干净的工作区。
   * 忽略文件不参与 stash;有未解决冲突时直接拒绝。
   */
  private async stashLocalChanges(
    vaultPath: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; ref: string | null; detail: string }> {
    const unmerged = await this.unmergedFiles(vaultPath, signal)
    if (unmerged.length > 0) {
      return {
        ok: false,
        ref: null,
        detail: '还有未解决的冲突，请先处理完再下载'
      }
    }
    const status = await runGit(['status', '--porcelain'], { cwd: vaultPath, signal })
    if (status.stdout.trim().length === 0) return { ok: true, ref: null, detail: '' }

    const message = `${DOWNLOAD_STASH_PREFIX}${stamp()}`
    const stash = await runGit(
      ['stash', 'push', '--include-untracked', '-m', message],
      { cwd: vaultPath, signal }
    )
    if (!stash.ok) {
      return {
        ok: false,
        ref: null,
        detail: `暂存本地改动失败：${summarize(stash.stderr || stash.stdout, 3)}`
      }
    }
    const ref = await this.findDownloadStash(vaultPath, signal)
    if (!ref) {
      return { ok: false, ref: null, detail: '本地改动已暂存，但找不到对应的 stash 记录' }
    }
    return { ok: true, ref, detail: '' }
  }

  /**
   * 恢复一条下载暂存。
   *
   * 成功就删掉 stash;恢复时冲突则把带标记的工作区留下(供冲突界面处理),
   * 同时删掉 stash —— 两边内容都已在冲突标记里,留着只会在下次同步时重复应用。
   */
  private async applyDownloadStash(
    vaultPath: string,
    ref: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; files: string[]; detail: string }> {
    const apply = await runGit(['stash', 'apply', ref], { cwd: vaultPath, signal })
    if (apply.ok) {
      await runGit(['stash', 'drop', ref], { cwd: vaultPath, signal })
      return { ok: true, files: [], detail: '' }
    }
    const files = await this.unmergedFiles(vaultPath, signal)
    if (files.length > 0) {
      await runGit(['stash', 'drop', ref], { cwd: vaultPath, signal })
      return {
        ok: false,
        files,
        detail: `本地未提交改动与远端改动冲突：${files.join('、')}。冲突标记已保留，请处理后同步。`
      }
    }
    return {
      ok: false,
      files: [],
      detail: `恢复暂存的本地改动失败：${summarize(apply.stderr || apply.stdout, 4)}`
    }
  }

  /**
   * 同步/上传前恢复上一次下载留下的暂存(下载时远端合并本身冲突,当时没法恢复)。
   * 有未解决冲突时先不碰 stash,交给 commitLocal 去报冲突。
   */
  private async restorePendingDownloadStashes(
    vaultPath: string,
    signal: AbortSignal
  ): Promise<{ ok: boolean; files: string[]; detail: string }> {
    for (let guard = 0; guard < 5; guard++) {
      const ref = await this.findDownloadStash(vaultPath, signal)
      if (!ref) return { ok: true, files: [], detail: '' }
      const unmerged = await this.unmergedFiles(vaultPath, signal)
      if (unmerged.length > 0) return { ok: true, files: [], detail: '' }
      const result = await this.applyDownloadStash(vaultPath, ref, signal)
      if (!result.ok) return result
    }
    return { ok: true, files: [], detail: '' }
  }

  /** 还在冲突状态(未 staged 成解决)的文件 */
  private async unmergedFiles(vaultPath: string, signal: AbortSignal): Promise<string[]> {
    const result = await runGit(['diff', '--name-only', '-z', '--diff-filter=U'], {
      cwd: vaultPath,
      signal
    })
    return result.ok ? result.stdout.split('\0').filter(Boolean) : []
  }

  /**
   * 当前所有还带着冲突标记的文件。
   *
   * 不能只看 `--diff-filter=U`:上一次同步的 `finishMerge` 会先 `git add -A`,
   * 带标记的文件一旦被 staged 就不再是 unmerged 状态,但标记还在。把
   * `--cached --check` 的结果并进来,「处理冲突」按钮才不会误报没有冲突。
   */
  private async conflictFiles(vaultPath: string, signal: AbortSignal): Promise<string[]> {
    const files = new Set(await this.unmergedFiles(vaultPath, signal))
    const check = await runGit(['-c', 'core.quotePath=false', 'diff', '--cached', '--check'], {
      cwd: vaultPath,
      signal
    })
    for (const file of conflictMarkerFiles(check.stdout + check.stderr)) files.add(file)
    return [...files]
  }

  /**
   * 打开应用的「处理合并冲突」窗口。
   *
   * `onlyUnopened`:已经开在编辑器里的文件有内联操作栏,不必再弹窗口;自动触发
   * 冲突处理时用它,只把 `.gitignore` 这类没有内联入口的文件交给窗口。
   * 返回窗口是否真的打开。
   */
  private async openConflictDialog(
    files: readonly string[],
    onlyUnopened: boolean
  ): Promise<boolean> {
    const vaultPath = this.vaultPath()
    if (!vaultPath || files.length === 0) return false
    const absolute = files.map(file => join(vaultPath, file))
    if (typeof imark.window.showConflictResolver !== 'function') return false
    try {
      return await imark.window.showConflictResolver(absolute, { onlyUnopened })
    } catch {
      return false
    }
  }

  /** 「处理合并冲突」命令:打开窗口,不自动做任何取舍 */
  private async resolveConflicts(): Promise<ActionResult> {
    const vaultPath = this.vaultPath()
    if (!vaultPath) return { ok: false, message: '未打开仓库' }
    if (!existsSync(join(vaultPath, '.git'))) {
      return { ok: false, message: '当前仓库还不是 git 仓库' }
    }
    if (!(await isGitAvailable())) {
      return { ok: false, message: '未找到 git，请先安装 Git' }
    }
    const controller = new AbortController()
    const files = await this.conflictFiles(vaultPath, controller.signal)
    if (files.length === 0) {
      const message = '没有需要处理的冲突'
      this.output.info(message)
      this.report({ status: 'ok', lastRunAt: Date.now(), message })
      return { ok: true, message }
    }
    const opened = await this.openConflictDialog(files, false)
    if (!opened) return { ok: false, message: '无法打开冲突处理窗口（渲染层未就绪）' }
    return { ok: true, message: '已打开冲突处理窗口' }
  }

  /**
   * 不是 git 仓库时按配置初始化；返回是否由本次调用新建。
   * 扩展**不改动仓库的 remote 配置** —— 拉取与推送都直接给 URL，凭据由每次现挂的
   * credential helper 提供。
   */
  private async ensureRepo(
    vaultPath: string,
    cfg: GitSyncConfig,
    signal: AbortSignal
  ): Promise<boolean> {
    if (existsSync(join(vaultPath, '.git'))) return false
    if (!cfg.autoInitRepo) {
      throw new Error('当前仓库还不是 git 仓库（可在扩展设置中开启自动初始化）')
    }
    const wantBranch = cfg.initBranch?.trim() || 'main'
    const init = await runGit(['init', '-b', wantBranch], { cwd: vaultPath, signal })
    if (!init.ok) throw new Error(`初始化仓库失败：${summarize(init.stderr, 3)}`)
    return true
  }

  /**
   * 新建仓库时写入推荐的 `.gitignore` / `README.md`（`wx`：已存在就不动）。
   *
   * 从 `ensureRepo` 里拆出来，是因为「空仓库连接已有远端」时顺序很重要：
   * 先下载并采纳远端，再写脚手架，才不会用本地生成的 `.gitignore` 与远端撞冲突。
   */
  private async writeScaffold(vaultPath: string, cfg: GitSyncConfig): Promise<void> {
    if (cfg.writeGitignore) {
      await writeFile(join(vaultPath, '.gitignore'), DEFAULT_GITIGNORE, { flag: 'wx' }).catch(
        () => {}
      )
    }
    if (cfg.writeReadme) {
      const name = basename(vaultPath) || 'Notes'
      await writeFile(
        join(vaultPath, 'README.md'),
        `# ${name}\n\n> 由 iMark 的「远程同步」扩展在初始化仓库时创建。\n`,
        { flag: 'wx' }
      ).catch(() => {})
    }
  }

  /** 当前提交的短 SHA，用于把「到底同步到哪个版本」说清楚 */
  private async headShort(vaultPath: string, signal: AbortSignal): Promise<string> {
    const result = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: vaultPath, signal })
    return result.ok ? result.stdout.trim() : ''
  }

  /** 仓库没配 user.name/user.email 时用扩展配置兜底，否则 commit 会直接失败 */
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

  /** 测试连接：界面上远端后面有自己的「测试连接」，带 targetId 时只测它 */
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
    if (reasons.length > 0) {
      this.output.error(`连接测试失败（${reasons.length}/${targets.length}）`)
      for (const reason of reasons) this.output.error(reason)
    }
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
