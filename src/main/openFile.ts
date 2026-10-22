/**
 * 「用 iMark 打开这个文件」的入口(双击 .md / 资源管理器「打开方式」)。
 *
 * 系统不是通过什么协议把文件送进来的,而是**把它拼在命令行参数里**:打包后
 * `iMark.exe "C:\notes\a.md"`;开发模式下是 `electron.exe <应用目录> "a.md"`。
 * 另外,当 iMark 已经开着时,Windows 会再启动一个实例 —— 单实例锁把新实例挡掉,
 * 但 Electron 会把它的 argv 通过 `second-instance` 事件交给第一个实例
 * (见 index.ts)。所以「取文件」这件事只有两个来源:启动参数、第二个实例的参数。
 *
 * 启动那一个用**暂存 + 渲染层来取**的方式交接:窗口刚建好时渲染层的服务还没初始化,
 * 推过去只能靠延时赌时序(而失败的样子是「双击了没反应」)。
 */

import { app } from 'electron'
import { statSync } from 'node:fs'

/** 带值的启动开关:下一项是它的值,不是用户要打开的文件 */
const VALUE_FLAGS = new Set(['--user-data-dir', '--imark-data-dir', '--plugin-dev'])

/**
 * 从命令行里挑出「要打开的文件」。
 *
 * 只认**真实存在的文件路径**(逐项 stat):Electron / Chromium 自己会塞进各种开关,
 * 光看「不像开关」不足以区分。argv[0] 永远是可执行文件,跳过。
 */
export function fileFromArgv(argv: readonly string[], packaged: boolean): string | null {
  const appPath = app.getAppPath()
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('-')) {
      // `--x=y` 自带值;`--x y` 那种把值一起跳过去
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    // 开发模式:argv[1] 是应用目录,不是用户文档
    if (!packaged && arg === appPath) continue
    try {
      if (statSync(arg).isFile()) return arg
    } catch {
      // 不是路径 / 不存在:继续看下一个
    }
  }
  return null
}

let pending: string | null = null

/** 暂存一个待打开的文件(启动时或第二个实例到达时) */
export function setPendingOpenFile(path: string | null): void {
  pending = path
}

/** 取走暂存的文件(只交付一次;渲染层初始化完主动来拿) */
export function takePendingOpenFile(): string | null {
  const path = pending
  pending = null
  return path
}
