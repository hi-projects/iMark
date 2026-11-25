import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import pkg from './package.json'

// Electron 44.7.0 的 Windows 包没有随附 crashpad_handler.exe,Chromium 每次启动都会
// 打印 `registration_protocol_win.cc ... CreateFile ... (0x2)`(崩溃上报的命名管道
// 不存在)。它无害,但在控制台很吵。
//
// 只在 `app.commandLine` 里 append 太晚(Chromium 已经初始化过),所以让 electron-vite
// 在 **启动 Electron 的命令行** 上就带上开关。真正把这条日志从控制台去掉的是
// scripts/dev.mjs 里的 stderr 单行过滤;这里只是尽量不启动崩溃上报。
if (!process.env.ELECTRON_CLI_ARGS) {
  process.env.ELECTRON_CLI_ARGS = JSON.stringify([
    '--disable-breakpad',
    '--disable-crash-reporter'
  ])
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          // 应用主进程
          index: resolve('src/main/index.ts'),
          // 扩展宿主入口：main 用 utilityProcess.fork(join(__dirname, ...)) 启动它。
          // 它必须和 index.js 输出在同一目录（out/main/）。
          extensionHostProcess: resolve('src/main/extensions/extensionHostProcess.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    // 只有一个入口:应用主窗口的 preload。扩展 webview 的内容由主进程的
    // imark-webview:// 协议服务,不注入 preload。
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    // 关于页显示应用版本:构建时从 package.json 注入,避免在界面里再维护一份常量
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    // Mermaid 必须进依赖预打包。
    //
    // 它内部依赖 dayjs、@braintree/sanitize-url 这类 CJS 包:走原生 ESM
    // (exclude)时,开发服务器把 dayjs.min.js 原样发给浏览器,报
    // "does not provide an export named 'default'",图表渲染失败只剩一条空框。
    // 预打包后这些依赖由 esbuild 做 ESM interop,dev 与构建产物行为一致。
    // (旧注释担心动态 chunk 文件名对不上;Vite 6 实测 dev 渲染正常。)
    optimizeDeps: {
      include: ['mermaid']
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
