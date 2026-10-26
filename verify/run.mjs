// 打包 + 跑一个验收 harness。用法(在仓库根目录,或任意目录都行):
//
//   node verify/run.mjs <名字> [额外传给 electron 的参数...]
//
// 例:node verify/run.mjs extensions-model
//
// 它做四件事,每一件都是**必须**的,所以别再手敲(手敲漏掉任意一件都会得到
// 一个看起来像"应用坏了"的假失败):
//
//   1. 先 esbuild 打包到 out/main/(渲染层页面是按 __dirname 找的);
//   2. **清掉子进程环境里的 ELECTRON_RUN_AS_NODE** —— 这台开发机的 shell 里默认就设着它,
//      漏掉的话 Electron 会降级成普通 node 跑,报错是
//      `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`,
//      看着像 electron 少了个 API,其实是根本没进 Electron;
//   3. 给一个**独立的 userData**(仓库里的 .verify-ud/<名字>,已 gitignore):
//      harness 会往那里写桩 settings.json、还会 rm -rf 那里的 vault 和 plugins。
//      有 `--user-data-dir` 时数据根就是它(见 src/main/dataDir.ts),所以**一切**
//      ——包括样式目录与 profile——都在这一个临时目录里,碰不到用户真实的 ~/.imark;
//   4. 每次都从这个干净目录重来(上次跑剩的扩展登记会让断言结果不一样)。
//
// ⚠️ **它只重新打包 harness,不会重新构建应用。** harness 是从源码 bundle 的,但
// preload 与渲染层页面是按 `__dirname` 去 out/ 里找**构建产物**的 —— 改了
// `src/preload/` 或 `src/renderer/` 之后不跑一次 `npx electron-vite build`,
// harness 里跑的就是旧代码,而症状是"我明明改了,断言却按老行为走"。
// (改 `src/main/**` 也一样:harness 会重新 bundle 主进程代码,但它 import 的那些
// 模块也可能被别处引用到旧产物上 —— 拿不准就 build 一次,它只要几秒。)
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [name, ...rest] = process.argv.slice(2)

if (!name) {
  console.error('用法:node verify/run.mjs <名字>   (名字 = verify/<名字>-harness.ts 的前半段)')
  const files = existsSync(path.join(ROOT, 'verify'))
    ? [
        'extensions-model',
        'extensions-host-groups',
        'extensions-editor',
        'extensions-webview',
        'quick-edit',
        'git-sync',
        'git-sync-auth',
        'git-sync-proxy',
        'agent',
        'market-package',
        'market-ui',
        'install-confirm',
        'bundled-upgrade',
        'table-render',
        'table-cells',
        'heading-sizes',
        'code-block',
        'code-indent',
        'font-zoom',
        'math-block',
        'mermaid',
        'editor-enter',
        'outline',
        'cursor',
        'session-restore',
        'vault-prune',
        'system-open',
        'tabs',
        'image-paste',
        'autosave-modes',
        'data-dir',
        'settings-reflow',
        'settings-system',
        'notification',
        'userstyle-dir'
      ]
    : []
  if (files.length) console.error(`现有:${files.join(' / ')}`)
  process.exit(2)
}

const entry = path.join(ROOT, 'verify', `${name}-harness.ts`)
const bundle = path.join(ROOT, 'out', 'main', `.${name}-check.cjs`)
const ud = path.join(ROOT, '.verify-ud', name)

if (!existsSync(entry)) {
  console.error(`找不到 ${path.relative(ROOT, entry)}`)
  process.exit(2)
}
if (!existsSync(path.join(ROOT, 'out', 'main'))) {
  console.error('out/main/ 还不存在 —— 先跑一次 `npm run build`(它会清空 out/,所以每次 build 后要重新打包)')
  process.exit(2)
}

const run = (cmd, args) =>
  new Promise(resolve => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: childEnv() })
    p.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })

function childEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

mkdirSync(path.dirname(ud), { recursive: true })
rmSync(ud, { recursive: true, force: true })

console.log(`[verify] 打包 ${path.relative(ROOT, entry)} → ${path.relative(ROOT, bundle)}`)
if (await run(process.execPath, [path.join(ROOT, 'verify', 'build-harness.mjs'), entry, bundle])) {
  process.exit(1)
}

// electron 这个 npm 包在 Node 里 `require` 出来的就是可执行文件的**绝对路径**
// (Windows 上是 electron.exe)。别用 node_modules/.bin/electron —— 那是给 POSIX shell
// 用的无扩展名脚本,Windows 上 existsSync 能过但 spawn 会 ENOENT。
const electron = createRequire(`${ROOT}/package.json`)('electron')
if (!existsSync(electron)) {
  console.error('找不到 electron,先 npm install')
  process.exit(2)
}

// 无人值守时把窗口做成"不可见但仍渲染",避免一个个 Electron 窗口弹到用户桌面上。
// 默认关闭;设 IMARK_VERIFY_HIDDEN=1 打开(Windows/macOS;Linux 无头用 xvfb-run)。
const hiddenLauncher = path.join(ROOT, 'verify', 'hidden-window-launcher.cjs')
const hidden = process.env.IMARK_VERIFY_HIDDEN === '1' && existsSync(hiddenLauncher)
const electronArgs = hidden
  ? [hiddenLauncher, bundle, `--user-data-dir=${ud}`, ...rest]
  : [bundle, `--user-data-dir=${ud}`, ...rest]

console.log(`[verify] 跑 ${name}(userData = ${path.relative(ROOT, ud)},每次重来)`)
const code = await run(electron, electronArgs)
console.log(`[verify] ${name} 退出码 ${code}`)
process.exit(code)
