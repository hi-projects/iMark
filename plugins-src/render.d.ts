import type { ImkRenderLayerApi } from '@shared/pluginApi'

declare global {
  /** 宿主把 render 层入口包在 `(function (imk) { … })` 里,所以入口里直接引用它 */
  const imk: ImkRenderLayerApi
}

export {}
