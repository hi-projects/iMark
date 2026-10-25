/// <reference types="vite/client" />

import type { WindowApi } from '@shared/api'

declare global {
  interface Window {
    /**
     * 宿主桥的**一次性取用**函数(见 preload/index.ts)。
     *
     * 只有 services/api.ts 应该调用它;取走之后对任何代码(包括扩展)都返回 null。
     * 不要另外声明 `window.api` —— 那会让页面脚本误以为可以绕过一次性取用。
     */
    __imarkTakeApi: () => WindowApi | null
  }
}

export {}
