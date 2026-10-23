/// <reference types="vite/client" />

import type { WindowApi } from '@shared/api'

declare global {
  interface Window {
    /**
     * 宿主桥的**一次性取用**函数(见 preload/index.ts)。
     *
     * 只有 services/api.ts 应该调用它;取走之后对任何代码(包括扩展)都返回 null。
     * 这里刻意**不**声明 `window.api` —— 那个全局已经不存在了,声明它只会让
     * 残留的 `window.api` 调用悄悄通过类型检查。
     */
    __imarkTakeApi: () => WindowApi | null
  }
}

export {}
