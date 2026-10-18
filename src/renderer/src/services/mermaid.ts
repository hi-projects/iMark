import type { MermaidConfig } from 'mermaid'

/**
 * Mermaid 渲染服务:编辑器 widget 与导出 HTML 共用同一条渲染路径。
 *
 * 三条纪律:
 * 1. **动态 import**:mermaid 的构建产物有几 MB,没写过 mermaid 的文档不该为它付启动成本;
 * 2. **串行队列**:mermaid.render 会在 document.body 里挂临时容器,并发渲染会互相踩;
 * 3. **结果缓存**:滚动、改一个字都会让装饰层整体重建,同一段源码会被反复要很多次。
 *
 * 主题决定的不只是颜色:`theme` 与 `themeVariables` 在 initialize 时烘进 SVG,
 * 切主题后必须重新渲染(见 wysiwyg/build.ts 的 MutationObserver),不能靠 CSS 变量。
 */

export type MermaidTheme = 'light' | 'dark'

const MAX_CACHE = 80
const cache = new Map<string, string>()

/** 同一时刻只跑一个 render;失败也不许断链 */
let chain: Promise<void> = Promise.resolve()
let seq = 0

type Mermaid = typeof import('mermaid').default
let mermaid: Mermaid | null = null
let initializedTheme: MermaidTheme | null = null

const FONT_FAMILY = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif"

/**
 * 图表在编辑器里的卡片底色(与 tokens.css 的 --bg-codeblock 一致)。
 * 导出统一走亮色,取亮色那一档。
 */
const CARD_BG: Record<MermaidTheme, string> = {
  light: '#f6f8fa',
  dark: '#212121'
}

function configFor(theme: MermaidTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // 语法错的图由我们自己画错误框,不让 mermaid 往文档里塞它的 error svg
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: FONT_FAMILY,
    themeVariables: {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      background: CARD_BG[theme]
    }
  }
}

async function loadMermaid(theme: MermaidTheme): Promise<Mermaid> {
  if (!mermaid) {
    const mod = await import('mermaid')
    mermaid = mod.default
    // 本地注册 Lucide 图标包(与应用自身的图标集同源),支持 `A@{ icon: "lucide:user" }`
    // 这类 icon shape;走 ?raw 是刻意的:600KB JSON 若让 TS 推导字面量类型会拖垮 vue-tsc
    mermaid.registerIconPacks([
      {
        name: 'lucide',
        loader: async () =>
          JSON.parse((await import('@iconify-json/lucide/icons.json?raw')).default)
      }
    ])
  }
  if (initializedTheme !== theme) {
    mermaid.initialize(configFor(theme))
    initializedTheme = theme
  }
  return mermaid
}

/** 当前界面主题下的图表配色(深色用 mermaid 的 dark 主题) */
export function currentMermaidTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'light' || !document.documentElement.dataset.theme
    ? 'light'
    : 'dark'
}

/**
 * 缓存命中的 SVG 要换一个新 id。
 *
 * Mermaid 把图表 id 写进 SVG 的 `id="imark-mermaid-N"`,样式表也用它做作用域
 * (`#imark-mermaid-N .node …`)。同一段源码在文档里出现两次、或编辑器重建时复用
 * 缓存,直接返回同一份字符串就会产生重复 id —— 导出 HTML 里尤其明显。这里把旧 id
 * 整体替换成新分配的 id(含内部 marker 的 `id`/`url(#…)` 引用)。
 */
function withUniqueId(svg: string): string {
  const match = /\bid="([^"]+)"/.exec(svg)
  if (!match) return svg
  const oldId = match[1]!
  return svg.split(oldId).join(`imark-mermaid-${++seq}`)
}

/** 渲染一段 mermaid 源码,返回内联 SVG;失败时 reject(调用方负责展示错误) */
export function renderMermaid(source: string, theme: MermaidTheme): Promise<string> {
  const key = `${theme}\u0000${source}`
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(withUniqueId(hit))

  const job = chain.then(async () => {
    // 排队期间可能已被别人渲染好
    const again = cache.get(key)
    if (again !== undefined) return withUniqueId(again)

    const api = await loadMermaid(theme)
    const result = await api.render(`imark-mermaid-${++seq}`, source)
    cache.set(key, result.svg)
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return result.svg
  })

  // 队列本身吞掉错误(否则一次语法错误会让后续所有图表都跟着 reject);
  // 但返回给调用方的 job 保留错误,由 widget / 导出层决定怎么展示
  chain = job.then(
    () => undefined,
    () => undefined
  )
  return job
}

/** 把任意异常压成一句可展示的说明(mermaid 的语法错误常常是多行) */
export function mermaidErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.trim() || '未知错误'
}
