/**
 * `context.globalState` / `workspaceState` 的持久化。
 *
 * 宿主进程只持有内存缓存，每次 `update()` 通过 RPC 把值送回 main；main 在这里
 * 合并并按扩展做 100ms 防抖写盘。这样插件把状态当普通对象高频改也不会把磁盘写爆，
 * 而宿主崩溃/重启后值仍然在。
 *
 * 文件布局：`extensions-data/<id>/state.json`
 *   { version: 1, global: {...}, workspace: {...} }
 *
 * workspaceState 目前按“当前工作区一份”保存。iMark 是单仓库编辑器，不存在 VS Code
 * 那种多根工作区；将来要支持多仓库时，把 workspace 换成 `Record<root, ...>` 即可，
 * 文件格式有 version 字段兜底。
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../files'
import { extensionStorageDir } from './paths'

export interface ExtensionStateSnapshot {
  global: Record<string, unknown>
  workspace: Record<string, unknown>
}

interface StateFile extends ExtensionStateSnapshot {
  version: 1
}

const EMPTY: StateFile = { version: 1, global: {}, workspace: {} }

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

export class ExtensionStateStore {
  private readonly files = new Map<string, StateFile>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  private async load(id: string): Promise<StateFile> {
    const cached = this.files.get(id)
    if (cached) return cached
    let file: StateFile = { ...EMPTY }
    try {
      const parsed = JSON.parse(
        await readFile(join(extensionStorageDir(id), 'state.json'), 'utf8')
      ) as Partial<StateFile>
      file = {
        version: 1,
        global: cloneRecord(parsed.global),
        workspace: cloneRecord(parsed.workspace)
      }
    } catch {
      /* 没有/损坏：按空状态处理，不阻塞激活 */
    }
    this.files.set(id, file)
    return file
  }

  async snapshot(id: string): Promise<ExtensionStateSnapshot> {
    const file = await this.load(id)
    return { global: { ...file.global }, workspace: { ...file.workspace } }
  }

  /** 同步读取（宿主 init 组装时用；缺失就是空状态） */
  snapshotSync(id: string): ExtensionStateSnapshot {
    const file = this.files.get(id)
    return file
      ? { global: { ...file.global }, workspace: { ...file.workspace } }
      : { global: {}, workspace: {} }
  }

  /** 预热：在 fork 宿主前把文件读进来，init 就不必等磁盘 */
  async preload(id: string): Promise<void> {
    await this.load(id)
  }

  set(id: string, scope: 'global' | 'workspace', key: string, value: unknown): void {
    const file = this.files.get(id) ?? { ...EMPTY, global: {}, workspace: {} }
    const bucket = scope === 'global' ? file.global : file.workspace
    if (value === undefined) delete bucket[key]
    else bucket[key] = value
    this.files.set(id, file)
    this.schedulePersist(id)
  }

  private schedulePersist(id: string): void {
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.persist(id)
    }, 100)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  async persist(id: string): Promise<void> {
    const file = this.files.get(id)
    if (!file) return
    try {
      await mkdir(extensionStorageDir(id), { recursive: true })
      await writeFileAtomic(
        join(extensionStorageDir(id), 'state.json'),
        JSON.stringify(file, null, 2)
      )
    } catch (err) {
      console.error(`[iMark] 扩展 ${id} 的状态写盘失败:`, err)
    }
  }

  async remove(id: string): Promise<void> {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.files.delete(id)
    await rm(extensionStorageDir(id), { recursive: true, force: true }).catch(() => {})
  }

  async flushAll(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.all([...this.files.keys()].map(id => this.persist(id)))
  }

  /** 扩展的 globalStorage 目录；激活时确保存在 */
  async ensureStorage(id: string): Promise<string> {
    const dir = extensionStorageDir(id)
    await mkdir(dir, { recursive: true })
    return dir
  }
}
