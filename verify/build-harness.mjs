// 把验收入口用 esbuild 打成 Electron 主进程能直接跑的 CJS。
//
// 用法(在仓库根目录):
//   node verify/build-harness.mjs verify/<x>-harness.ts out/main/.<x>-check.cjs
//
// 一般不用直接调它 —— `node verify/run.mjs <x>` 会把打包和跑一起做完。
//
// 输出**务必**落在仓库的 out/main/ 下:`createMainWindow` 是按 `__dirname` 找 preload
// 与渲染层页面的,放到别处会静默停在仓库选择界面(表现是"所有 DOM 断言超时")。
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓库根由**本文件的位置**推出来(verify/ 的上一级),不再写死绝对路径:
// 换个机器、换个 clone 目录都不用改任何一行
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(`${ROOT}/package.json`)
const esbuild = require('esbuild')

const [entry, outfile] = process.argv.slice(2)
if (!entry || !outfile) {
  console.error('用法:node verify/build-harness.mjs <入口.ts> <输出.cjs>')
  process.exit(2)
}

/**
 * 把一个模块标识符落成磁盘路径。
 *
 * **要自己展开 `@shared` 别名**:带后缀的导入(`x?raw` / `x?asset`)会被下面的
 * onResolve 拦下来、拿到自己的 namespace,于是 esbuild 的 `alias` 配置对它们
 * 不再生效 —— 不展开的话 `@shared/theme/tokens.css?raw` 会被当成
 * "相对当前文件的一个叫做 @shared 的目录",报 ENOENT。
 */
function resolveTarget(spec, resolveDir) {
  if (spec.startsWith('@shared/')) return path.join(ROOT, 'src', 'shared', spec.slice('@shared/'.length))
  return path.resolve(resolveDir, spec)
}

const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: args.path.replace(/\?raw$/, ''),
      namespace: 'raw',
      pluginData: { resolveDir: args.resolveDir || ROOT }
    }))
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({
      contents: await readFile(resolveTarget(args.path, args.pluginData.resolveDir), 'utf8'),
      loader: 'text'
    }))
  }
}

// `?asset`(electron-vite 的导入后缀):文件随产物发布,导入得到运行时的绝对路径。
// harness 不经过 electron-vite,这里退化成**源码文件的绝对路径** —— 语义一致
// (window.ts 拿到它先 existsSync,再交给 BrowserWindow),而源码目录里那个文件本来就在。
const assetPlugin = {
  name: 'asset',
  setup(build) {
    build.onResolve({ filter: /\?asset$/ }, args => ({
      path: args.path.replace(/\?asset$/, ''),
      namespace: 'asset',
      pluginData: { resolveDir: args.resolveDir || ROOT }
    }))
    build.onLoad({ filter: /.*/, namespace: 'asset' }, args => {
      const abs = resolveTarget(args.path, args.pluginData.resolveDir)
      return { contents: `export default ${JSON.stringify(abs)};`, loader: 'js' }
    })
  }
}

await esbuild.build({
  entryPoints: [path.resolve(entry)],
  outfile: path.resolve(outfile),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  alias: { '@shared': `${ROOT}/src/shared` },
  plugins: [rawPlugin, assetPlugin],
  // 每个 harness 的 main() 都是 `void main()` 起的头:里面 await 一旦被拒(比如某个
  // readFile 的 ENOENT),进程既不退出也不报退出码 —— 表现是**静静地挂到超时**,
  // 而真正的原因只在 stderr 里滚过一行。这里把它变成一次明确的非零退出。
  banner: {
    js: `process.on('unhandledRejection', (e) => {
  console.error('[harness] 未处理的 Promise 拒绝,直接退出:', e)
  process.exit(1)
})`
  },
  logLevel: 'info'
})
