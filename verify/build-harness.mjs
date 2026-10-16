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

const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: args.path.replace(/\?raw$/, ''),
      namespace: 'raw',
      pluginData: { resolveDir: args.resolveDir || ROOT }
    }))
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({
      contents: await readFile(path.resolve(args.pluginData.resolveDir, args.path), 'utf8'),
      loader: 'text'
    }))
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
  plugins: [rawPlugin],
  logLevel: 'info'
})
