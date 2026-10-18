import type { ImkRestrictedApi } from '@shared/pluginApi'

declare global {
  interface Window {
    /** restricted main 页面里由 preload 注入的能力面 */
    imark: ImkRestrictedApi
  }
}

export {}
