/**
 * 多实例协调:**同一个仓库只保留一个窗口**。
 *
 * 多开之后,用户很可能通过「再点一次应用 / 双击仓库里的 .md」把同一个仓库开第二遍。
 * 这时新实例不该再冒出一个窗口,而应该把已有窗口叫到前面来 —— 两个窗口同时编辑
 * 同一个仓库只会让「谁最后保存谁赢」变得更难理解。
 *
 * 协调靠数据根下的**占用记录**:打开仓库的实例写 `<数据根>/instances/<仓库哈希>.json`,
 * 里面有自己的 PID 与一个本机 IPC 端点。另一个实例要打开同一个仓库时读到它,
 * 直接连端点请求「聚焦你的窗口」(如果带文件,把文件也递过去);对方回 ok:true
 * 就说明它确实还开着这个仓库,本实例退出。记录在切回仓库选择页、关窗或退出时删除。
 *
 * 几个必须讲清楚的取舍:
 *   - 用**文件**做跨进程互斥:`open(..., 'wx')` 原子创建,崩溃后靠 PID 探活回收,
 *     不需要常驻的协调进程;
 *   - 用**本机 IPC** 而不是只写文件:聚焦窗口必须由窗口所属的进程自己调
 *     `win.focus()`;文件只能传达状态,叫不动窗口。Windows 用命名管道,其他平台
 *     用临时目录下的 Unix socket;
 *   - 记录里的 endpoint 为空/连不上、但 PID 还活着时返回 `busy`,**不抢**这个仓库 ——
 *     宁可提示用户,也不制造两个窗口同时写同一批文件;
 *   - 只协调共享同一数据根的实例(安装版与开发版各自的数据根不同,互不可见)。
 */

import { app, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { VaultClaimResult } from '@shared/types'
import { dataRoot } from './dataDir'
import { getMainWindow } from './window'
import { setPendingOpenFile } from './openFile'

interface ClaimRecord {
  pid: number
  /** 本机 IPC 端点;服务没起来时为空串 */
  endpoint: string
  vaultPath: string
  /** 只用于排查 */
  startedAt: number
}

const CLAIM_DIR = 'instances'
/** 向另一个实例发请求的超时;对方收到请求会立刻答,窗口没建好也先答应 */
const REQUEST_TIMEOUT_MS = 4_000
const CLAIM_ATTEMPTS = 3

let server: Server | null = null
let endpoint: string | null = null
/** 本实例当前占着的仓库(规范化后的路径);null = 没开仓库 */
let claimedVault: string | null = null
/**
 * 窗口还没建出来时收到的「叫到前面」请求。
 *
 * 两个实例几乎同时冷启动时,先占到记录的实例可能还在初始化扩展/建菜单;
 * 这时不能让它等窗口(等多久都不保险),也不能回 not-owner(对方会再开一个窗口)。
 * 先答应下来,建窗完成后由 flushPendingFocus() 补上聚焦与文件投递。
 */
let pendingFocus: { vaultPath: string; filePath: string | null } | null = null

function claimDir(): string {
  return join(dataRoot(), CLAIM_DIR)
}

/** 路径比较统一走这里:Windows/macOS 大小写不敏感,且要吃掉相对路径与尾斜杠 */
function normalizePath(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}

function sameVault(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

function claimPath(vaultPath: string): string {
  const key = createHash('sha256').update(normalizePath(vaultPath)).digest('hex').slice(0, 24)
  return join(claimDir(), `${key}.json`)
}

/**
 * 本实例的 IPC 端点。名字里带数据根哈希与 PID:同一台机器上可能同时跑
 * 多个安装(各自数据根不同),端点不能撞。
 */
function endpointName(): string {
  const key = createHash('sha256')
    .update(`${normalizePath(dataRoot())}\u0000${process.pid}`)
    .digest('hex')
    .slice(0, 16)
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\imark-${key}`
    : join(tmpdir(), `imark-${key}.sock`)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function readClaim(path: string): ClaimRecord | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.endpoint !== 'string' ||
      typeof parsed.vaultPath !== 'string'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      endpoint: parsed.endpoint,
      vaultPath: parsed.vaultPath,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
    }
  } catch {
    // 另一个实例刚建了文件、还没写完:调用方会稍后重读
    return null
  }
}

/**
 * 原子抢记录。`wx` 在文件已存在时失败 —— 这就是跨进程互斥的整个实现;
 * 先建文件再写内容,内容很短,写完前别的实例读到的是「解析不了」,不会当成有效主人。
 */
function tryWriteClaim(path: string, record: ClaimRecord): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    writeSync(fd, JSON.stringify(record))
  } catch (err) {
    try {
      unlinkSync(path)
    } catch {
      /* 清理失败可忽略,下一次会按无主回收 */
    }
    throw err
  } finally {
    closeSync(fd)
  }
  return true
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM:进程在,只是当前用户查不了;也算活着
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 只有记录还是读到的那个主人时才删,防止误删别人刚抢到的新记录 */
function removeClaimIfOwner(path: string, owner: ClaimRecord): void {
  const current = readClaim(path)
  if (!current || current.pid !== owner.pid) return
  try {
    unlinkSync(path)
  } catch {
    /* 已经被别人清掉 */
  }
}

type OwnerAnswer = 'ok' | 'not-owner' | 'unreachable'

function connectOrNull(endpoint: string): Socket | null {
  try {
    return connect(endpoint)
  } catch {
    // 记录被手改/写坏时 connect 会同步抛;别让一个坏端点把打开仓库整条流程打断
    return null
  }
}

/** 请记录里的实例把窗口叫到前面(带文件时顺便打开)。一句话请求、一句话应答 */
function askOwner(
  owner: ClaimRecord,
  vaultPath: string,
  filePath?: string | null
): Promise<OwnerAnswer> {
  if (!owner.endpoint) return Promise.resolve('unreachable')
  return new Promise<OwnerAnswer>(resolveAnswer => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const socket = connectOrNull(owner.endpoint)
    if (!socket) {
      resolveAnswer('unreachable')
      return
    }
    let buffer = ''

    const finish = (answer: OwnerAnswer): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.destroy()
      resolveAnswer(answer)
    }

    timer = setTimeout(() => finish('unreachable'), REQUEST_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ type: 'focus-vault', vaultPath, filePath: filePath ?? null })}\n`
      )
    })
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { ok?: unknown }
        finish(reply.ok === true ? 'ok' : 'not-owner')
      } catch {
        finish('not-owner')
      }
    })
    socket.on('error', () => finish('unreachable'))
    socket.on('close', () => finish('unreachable'))
  })
}

/** 文件必须在仓库里且真的存在 —— 不允许借这条通道让窗口去开任意路径 */
function isFileInsideVault(vaultPath: string, filePath: string): boolean {
  const rel = relative(normalizePath(vaultPath), normalizePath(filePath))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/**
 * 找一个**正开着**、且仓库目录包含这个文件的窗口。
 *
 * 双击 .md 的判断顺序靠它:先问已经运行的窗口,再看 `settings.vaults`。
 * 只看 settings 会漏掉两种真实情况:
 *   - 对方刚打开仓库、`settings.json` 还没写完(异步落盘);
 *   - 文件在对方仓库的子目录里,而子目录本身又是一个「最近仓库」——
 *     按 settings 会挑那个更深的仓库,新开一个窗口,而用户要的是在已经
 *     开着外层仓库的窗口里打开这份文件。
 * 多个窗口的仓库互相嵌套时取最深的那个。
 */
export function vaultOpenInAnotherWindow(filePath: string): string | null {
  let names: string[] = []
  try {
    names = readdirSync(claimDir())
  } catch {
    return null
  }
  let best: string | null = null
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = readClaim(join(claimDir(), name))
    if (!record || record.pid === process.pid || !isProcessAlive(record.pid)) continue
    if (!isFileInsideVault(record.vaultPath, filePath)) continue
    if (!best || normalizePath(record.vaultPath).length > normalizePath(best).length) {
      best = record.vaultPath
    }
  }
  return best
}

/**
 * 从已知仓库里挑出包含这个文件的、最深的那一个。
 *
 * 与渲染层 `vaultService.containingVault` 的判断保持一致:仓库可以嵌套,取最深
 * 的那个,文件浏览器与侧栏才会落在离文件最近的仓库里。
 *
 * 启动时带文件的那条路要用它来决定**认领哪个仓库**:带文件启动时应用会优先打开
 * 文件(而不是恢复上次仓库),若还按 `settings.vaultPath` 去认领,文件属于另一个
 * 仓库时就会把请求转给一个根本没开那个仓库的窗口。
 */
export function vaultContaining(
  filePath: string,
  vaults: readonly (string | null | undefined)[]
): string | null {
  let best: string | null = null
  for (const vault of vaults) {
    if (!vault || !isFileInsideVault(vault, filePath)) continue
    if (!best || normalizePath(vault).length > normalizePath(best).length) best = vault
  }
  return best
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.moveTop()
  win.focus()
  // Windows 的前台窗口限制可能让 focus() 只把任务栏按钮闪一下;
  // 真的没抢到焦点时至少闪一下,让用户知道该看哪儿
  if (!win.isFocused()) win.flashFrame(true)
}

/** 把请求里带的文件交给窗口;窗口还在加载时暂存,等渲染层初始化完来取 */
function deliverFile(win: BrowserWindow, vaultPath: string, filePath: string | null): void {
  if (!filePath || !isFileInsideVault(vaultPath, filePath)) return
  if (win.webContents.isLoading()) setPendingOpenFile(filePath)
  else win.webContents.send(IPC.OpenFileFromSystem, filePath)
}

function handleRequest(raw: string): { ok: boolean } {
  let req: { type?: unknown; vaultPath?: unknown; filePath?: unknown }
  try {
    req = JSON.parse(raw) as typeof req
  } catch {
    return { ok: false }
  }
  if (req.type !== 'focus-vault' || typeof req.vaultPath !== 'string') return { ok: false }
  const vaultPath = req.vaultPath
  if (!claimedVault || !sameVault(claimedVault, vaultPath)) return { ok: false }
  const filePath = typeof req.filePath === 'string' ? req.filePath : null

  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    // 窗口还没建好:先答应,建窗完成后再补聚焦与文件
    pendingFocus = { vaultPath, filePath }
    return { ok: true }
  }

  focusWindow(win)
  deliverFile(win, vaultPath, filePath)
  if (!app.isPackaged) console.log(`[iMark] 另一个实例请求打开已开着的仓库,已聚焦窗口:${vaultPath}`)
  return { ok: true }
}

/**
 * 建窗完成后调用:把「窗口还没建好时收到」的请求补做掉。
 *
 * 放在 `ready-to-show` 之后调,别在 createMainWindow 返回后立刻 focus():
 * 那会让窗口在首帧之前被 show() 出来,闪一下白底。
 */
export function flushPendingFocus(): void {
  const pending = pendingFocus
  pendingFocus = null
  if (!pending) return
  if (!claimedVault || !sameVault(claimedVault, pending.vaultPath)) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  focusWindow(win)
  deliverFile(win, pending.vaultPath, pending.filePath)
  if (!app.isPackaged) {
    console.log(`[iMark] 窗口就绪,补做另一个实例的切换请求:${pending.vaultPath}`)
  }
}

/** 启动本机 IPC 服务;失败也不影响开仓库,只是别的实例叫不动本窗口 */
export async function startInstanceBroker(): Promise<void> {
  if (server) return
  try {
    mkdirSync(claimDir(), { recursive: true })
  } catch (err) {
    console.warn('[iMark] 建多实例协调目录失败,本次实例不参与仓库占用协调:', err)
    return
  }

  endpoint = endpointName()
  // UNIX socket 是文件,上次异常退出可能留下同名残留
  if (process.platform !== 'win32') {
    try {
      unlinkSync(endpoint)
    } catch {
      /* 本来就不存在 */
    }
  }

  const candidate = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      try {
        const reply = handleRequest(line)
        if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`)
      } catch {
        if (!socket.destroyed) socket.end('{"ok":false}\n')
      }
    })
    socket.on('error', () => {
      /* 对方断开/超时:没有需要收尾的状态 */
    })
  })

  await new Promise<void>(resolveReady => {
    const onError = (err: Error): void => {
      candidate.removeListener('error', onError)
      // 失败后这个对象不再用;挂一个空监听,防止后续 error 事件变成未捕获异常
      candidate.on('error', () => {
        /* 启动失败的残留错误,已记录过一次 */
      })
      console.warn('[iMark] 多实例协调端口启动失败,本次实例无法接收切换请求:', err)
      endpoint = null
      resolveReady()
    }
    candidate.once('error', onError)
    candidate.listen(endpoint!, () => {
      candidate.removeListener('error', onError)
      candidate.on('error', err => {
        console.warn('[iMark] 多实例协调端口出错:', err)
      })
      server = candidate
      resolveReady()
    })
  })

  cleanupStaleClaims()
}

/** 清掉崩溃留下的占用记录;正在运行的实例(包括自己)的记录不动 */
function cleanupStaleClaims(): void {
  let names: string[] = []
  try {
    names = readdirSync(claimDir())
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(claimDir(), name)
    const record = readClaim(path)
    if (!record || record.pid === process.pid || isProcessAlive(record.pid)) continue
    try {
      unlinkSync(path)
    } catch {
      /* 别的实例也在清,忽略 */
    }
  }
}

/**
 * 认领一个仓库。返回:
 *   - `ok`        本实例现在拥有它,可以打开;
 *   - `forwarded` 另一个实例开着它,已把那个窗口叫到前面(带文件时也递过去了),
 *                 调用方不应再打开;
 *   - `busy`      记录在,但联系不上主人(端口没起来/超时)。**不抢**:宁可提示,
 *                 也不制造两个窗口同时写同一批文件。
 */
export async function claimVault(
  vaultPath: string,
  filePath?: string | null
): Promise<VaultClaimResult> {
  const target = normalizePath(vaultPath)
  // 同一个窗口从 A 仓库切到 B 仓库:先释放 A,再认领 B
  if (claimedVault && claimedVault !== target) releaseVault()
  if (claimedVault === target) return 'ok'

  // 协调目录正常由 startInstanceBroker 建好;验收 harness 只起渲染层/主进程模块、
  // 不调 startInstanceBroker,这里补一次,别让「第一次开仓库」直接失败
  try {
    mkdirSync(claimDir(), { recursive: true })
  } catch (err) {
    console.warn('[iMark] 建多实例协调目录失败,本次不改用占用协调:', err)
    return 'busy'
  }

  const path = claimPath(vaultPath)
  const record: ClaimRecord = {
    pid: process.pid,
    endpoint: endpoint ?? '',
    vaultPath: resolve(vaultPath),
    startedAt: Date.now()
  }

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    try {
      if (tryWriteClaim(path, record)) {
        claimedVault = target
        if (!app.isPackaged) console.log(`[iMark] 占用仓库:${record.vaultPath}`)
        return 'ok'
      }
    } catch (err) {
      console.warn('[iMark] 写仓库占用记录失败:', err)
      return 'busy'
    }

    const owner = readClaim(path)
    if (!owner) {
      // 文件在、但还没写完(或刚被删):稍等再试
      await delay(20)
      continue
    }
    if (owner.pid === process.pid) {
      // 本进程之前认领过(例如启动时主进程先认领了一次)
      claimedVault = target
      return 'ok'
    }
    if (!isProcessAlive(owner.pid)) {
      removeClaimIfOwner(path, owner)
      continue
    }

    const answer = await askOwner(owner, vaultPath, filePath)
    if (answer === 'ok') return 'forwarded'
    if (answer === 'not-owner') {
      // 对方说它已经不开了(切回选择页的释放恰好慢了一拍):回收,自己开
      removeClaimIfOwner(path, owner)
      continue
    }
    return 'busy'
  }
  return 'busy'
}

/** 释放占用。vaultPath 给了就只释放它,避免旧仓库的失败流程误伤刚认领的新仓库 */
export function releaseVault(vaultPath?: string): void {
  if (!claimedVault) return
  if (vaultPath !== undefined && !sameVault(claimedVault, vaultPath)) return
  const path = claimPath(claimedVault)
  const current = readClaim(path)
  if (current && current.pid === process.pid) {
    try {
      unlinkSync(path)
    } catch {
      /* 已被清理 */
    }
  }
  if (!app.isPackaged) console.log(`[iMark] 释放仓库:${claimedVault}`)
  claimedVault = null
}

/** 退出前:删自己的记录、关端点。正常关窗会走到这里;崩溃则由下一个实例按 PID 回收 */
export function stopInstanceBroker(): void {
  releaseVault()
  if (server) {
    server.close()
    server = null
  }
  if (endpoint && process.platform !== 'win32') {
    try {
      unlinkSync(endpoint)
    } catch {
      /* 已被系统清理 */
    }
  }
  endpoint = null
}
