/**
 * 插件开发模式 —— `--plugin-dev=<目录>`。
 *
 * 平时装一个插件要经过:写代码 → 打包成信封 → 在市场或本地文件里挑中它 →
 * 确认 → 解包安装 → 加载。改一行 `console.log` 要重走一遍,这个循环
 * 长到没人愿意用,于是作者会在别的地方"临时"改代码,最终发布的字节和调试过的
 * 不是同一份 —— 这才是它真正贵的地方。开发模式把这条路砍成:
 *
 *   npm run plugins:watch                     # tsc -w,改 .ts 就编译
 *   npm run dev -- --plugin-dev=<目录>         # 目录里的 main.js 一变小就重载
 *
 * 它**不绕过任何校验**:清单照样过 validateManifest,加载失败照样登记成坏插件,
 * 权限照样注入强制。唯一的区别是代码取自你指的那个目录而不是安装目录,
 * 且退出应用后不留痕迹(应用不会"安装"它,只是这一次运行里加载它)。
 *
 * 目录的约定:和安装后的插件目录**完全一样** —— `manifest.json` 加清单里
 * 声明的入口文件。`npm run plugins:build` 会把清单一并拷进
 * `plugins-src/dist/plugins-src/<id>/`,所以指向那里就能直接跑。
 */

import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateManifest, type PluginManifest } from '@shared/pluginPackage'

/** 文件变化到重载之间的静默期:编辑器的保存往往连发好几个事件 */
const RELOAD_DEBOUNCE = 300

export const DEV_FLAG = '--plugin-dev='

/**
 * 从命令行里挑出 `--plugin-dev=<目录>`。
 *
 * 支持两种写法:`--plugin-dev=<目录>`(用等号)与 `--plugin-dev <目录>`(空格分开)。
 * npm 转发的额外参数是原样拼在命令行上的,两种都很常见,而认错了的表现是
 * 「参数没生效但也没报错」,最难查。
 */
export function devDirsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(DEV_FLAG)) {
      const value = arg.slice(DEV_FLAG.length).trim()
      if (value) out.push(value)
      continue
    }
    if (arg === '--plugin-dev') {
      const value = (argv[i + 1] ?? '').trim()
      // 后面跟的是另一个开关就当作没给值:不能把 `--plugin-dev --foo` 里的 `--foo`
      // 当成目录名,那只会得到一句莫名其妙的"目录不存在"
      if (value && !value.startsWith('--')) {
        out.push(value)
        i++
      }
    }
  }
  // 去重:同一个目录写两遍会让两个 watcher 互相触发对方的重载
  return [...new Set(out.map(dir => resolve(dir)))]
}

export interface DevSourceLoaded {
  ok: true
  dir: string
  manifest: PluginManifest
}

export interface DevSourceFailed {
  ok: false
  dir: string
  error: string
}

/** 读并校验一个开发目录的清单。读不到/不合法都返回一句人话,不抛。 */
export async function readDevSource(dir: string): Promise<DevSourceLoaded | DevSourceFailed> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch (err) {
    return {
      ok: false,
      dir,
      error: `读不到 ${join(dir, 'manifest.json')}(${
        err instanceof Error ? err.message : String(err)
      })`
    }
  }
  const checked = validateManifest(raw)
  if (!checked.ok || !checked.value) {
    return { ok: false, dir, error: `清单不合法:${checked.errors.slice(0, 5).join(';')}` }
  }
  return { ok: true, dir, manifest: checked.value }
}

/**
 * 盯着一个开发目录,变化时回调(已去抖)。返回停止函数。
 *
 * 用 `fs.watch` 而不是轮询:轮询在 SSD 上也要每秒 stat 一遍整个目录树,
 * 而这里要的正是"编译器刚写完"那个时刻。`recursive` 在 Linux 上需要
 * Node 20+(inotify 原生支持递归),拿不到就退回只盯顶层 —— 插件的入口文件
 * 都在顶层,退化的只是子目录里的资源文件,而那些改了本来也不需要重载代码。
 */
export function watchDevSource(dir: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, RELOAD_DEBOUNCE)
  }

  // 只关心"有什么变了":重载会把整个插件重新读一遍,过滤器省下的那点解析
  // 远不如漏掉一次编译产物来得贵
  const start = (recursive: boolean): FSWatcher | null => {
    try {
      const watcher = watch(dir, { recursive }, () => fire())
      watcher.on('error', err => {
        console.error(`[iMark] 监听 ${dir} 失败:`, err)
      })
      return watcher
    } catch (err) {
      if (recursive) return null
      console.error(`[iMark] 监听 ${dir} 失败:`, err)
      return null
    }
  }

  const watcher = start(true) ?? start(false)
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}
