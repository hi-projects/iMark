import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
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
