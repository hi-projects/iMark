/**
 * 文件存储:一个目录 + 几个 JSON 文件,没有数据库。
 *
 * 自托管插件市场的规模是「一个团队几十个插件」,用不上数据库,而引入一个
 * (以及它的安装、备份、迁移、连接池)会把「clone 下来就能跑」这件事毁掉。
 *
 * 两条硬规矩:
 *   1. **原子写**:先写 `<file>.tmp` 再 rename。rename 在同一文件系统内是原子的,
 *      所以进程被 kill 也不会留下半份 JSON —— 半份 JSON 会让整个服务端起不来。
 *   2. **同文件串行**:读-改-写之间穿插别的请求会丢更新(两个并发发布丢一个)。
 *      这里用一个朴素的 promise 队列把同一文件的写串起来。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 同一文件的写锁:上一次写完成后才开始下一次 */
const queues = new Map()

function withLock(file, fn) {
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // 队列自己不能因为某次失败而卡死,所以 catch 掉再存回去
  queues.set(
    file,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

export class Store {
  constructor(dataDir) {
    this.dir = dataDir
    this.blobsDir = join(dataDir, 'blobs')
  }

  async init() {
    await mkdir(this.blobsDir, { recursive: true })
  }

  path(name) {
    return join(this.dir, name)
  }

  blobPath(integrity) {
    return join(this.blobsDir, `${integrity}.json`)
  }

  async readJson(name, fallback) {
    try {
      return JSON.parse(await readFile(this.path(name), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return fallback
      // 文件存在但坏了:不要静默吞掉,否则会以「数据凭空消失」的形式表现出来
      console.error(`[market] ${name} 读不出来(按损坏处理):`, err.message)
      throw err
    }
  }

  async writeJson(name, value) {
    const file = this.path(name)
    return withLock(file, async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
      await rename(tmp, file)
    })
  }

  /**
   * 一次「读-改-写」。**所有会改变数据的路径都必须走它**:
   * 分开写 read + write 就等于把丢更新的窗口留给了并发。
   */
  async update(name, fallback, mutate) {
    const file = this.path(name)
    return withLock(file, async () => {
      let current = fallback
      try {
        current = JSON.parse(await readFile(file, 'utf8'))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      const result = mutate(current)
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(current, null, 2), 'utf8')
      await rename(tmp, file)
      return result
    })
  }

  // ---------- 包体(blob) ----------

  /**
   * 存一份信封。**按 integrity 命名 = 天然去重**:
   * 同一个版本被两个作者、两条路径发布上来,磁盘上也只有一份。
   */
  async putBlob(integrity, envelope) {
    const file = this.blobPath(integrity)
    return withLock(file, async () => {
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(envelope), 'utf8')
      await rename(tmp, file)
    })
  }

  async getBlob(integrity) {
    try {
      return JSON.parse(await readFile(this.blobPath(integrity), 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }
}
