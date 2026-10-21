/**
 * 扩展日志：内存里保留最近若干条给设置页，磁盘上按扩展追加完整历史。
 *
 * 两个来源共用同一份格式：
 * - 宿主进程自己 `console.*` 的输出（带扩展前缀转发过来）；
 * - 扩展通过 `window.createOutputChannel()` / `imark.reportStatus()` 产生的行。
 */

import { appendFile, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PluginLogEntry, PluginLogLevel } from '@shared/plugins'
import { extensionLogPath, extensionLogsRoot } from './paths'

const MAX_TAIL = 300

export class ExtensionLogStore {
  private readonly tails = new Map<string, PluginLogEntry[]>()
  private readonly chains = new Map<string, Promise<void>>()
  private rootReady: Promise<void> | null = null

  private ensureRoot(): Promise<void> {
    if (!this.rootReady) {
      this.rootReady = mkdir(extensionLogsRoot(), { recursive: true }).then(
        () => undefined,
        () => undefined
      )
    }
    return this.rootReady
  }

  add(id: string, level: PluginLogLevel, message: string): PluginLogEntry {
    const entry: PluginLogEntry = { at: Date.now(), level, message }
    const tail = this.tails.get(id) ?? []
    tail.push(entry)
    if (tail.length > MAX_TAIL) tail.splice(0, tail.length - MAX_TAIL)
    this.tails.set(id, tail)
    void this.append(id, entry)
    return entry
  }

  private append(id: string, entry: PluginLogEntry): void {
    const line = `${new Date(entry.at).toISOString()} [${entry.level}] ${entry.message}\n`
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        await this.ensureRoot()
        await appendFile(extensionLogPath(id), line, 'utf8')
      })
      .catch(() => {
        /* 日志失败不能影响扩展运行 */
      })
    this.chains.set(id, next)
  }

  list(id: string, limit = 80): PluginLogEntry[] {
    const tail = this.tails.get(id) ?? []
    return tail.slice(Math.max(0, tail.length - limit))
  }

  async remove(id: string): Promise<void> {
    this.tails.delete(id)
    this.chains.delete(id)
    await rm(extensionLogPath(id), { force: true }).catch(() => {})
    await mkdir(dirname(extensionLogPath(id)), { recursive: true }).catch(() => {})
  }

  /** 把多行文本拆成独立日志行，保留级别 */
  addLines(id: string, level: PluginLogLevel, text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this.add(id, level, line)
    }
  }
}
