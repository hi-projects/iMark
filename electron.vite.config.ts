import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

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
    // 两个入口:index 是应用主窗口的,plugin 是**沙箱插件页面**的(它有自己的一整套
    // 纪律 —— 只许 require('electron'),见 src/preload/plugin.ts 顶部)。
    // 输出名按入口 key 走:out/preload/index.js 与 out/preload/plugin.js
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          plugin: resolve('src/preload/plugin.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
