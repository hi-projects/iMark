/**
 * Mermaid 图表渲染端到端验证。
 *
 * 验的是 WYSIWYG 装饰层里 `case 'FencedCode'` 的 mermaid 分支,以及导出 HTML 那条路:
 *
 *  · 光标不在围栏内 → 首行换成 MermaidWidget,其余行清空并折叠(与表格/块级公式同一套跨行手法);
 *  · 光标进入围栏 / 点击图表 → 退回源码态;移开 → 重新渲染;
 *  · 语法错误 → 错误框而不是整块空白,更不能把编辑器搞崩;
 *  · 切主题 → SVG 必须重渲染(配色是渲染时烘进去的,不是 CSS 变量);
 *  · Lucide 图标包(icon shape)能真的拿到图标;
 *  · 导出 HTML 里图表是内联 SVG,失败的那块降级成错误块且不影响整份导出。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   node verify/run.mjs mermaid
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

const REPO = join(__dirname, '..', '..')

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``
}

const FLOWCHART = fence(
  'mermaid',
  ['flowchart LR', '  A[开始] --> B{判断}', '  B -->|是| C[结束]', '  B -->|否| A'].join('\n')
)

const MULTI = [
  '# 多种图表',
  '',
  FLOWCHART,
  '',
  fence(
    'mermaid',
    [
      'sequenceDiagram',
      '  participant A as 用户',
      '  participant B as 系统',
      '  A->>B: 请求',
      '  B-->>A: 响应'
    ].join('\n')
  ),
  '',
  fence('mermaid', ['pie title 占比', '  "甲": 40', '  "乙": 60'].join('\n')),
  '',
  fence(
    'mermaid',
    ['classDiagram', '  class Animal {', '    +String name', '    +eat()', '  }', '  Animal <|-- Dog'].join('\n')
  ),
  '',
  fence('mermaid', ['mindmap', '  root((iMark))', '    编辑', '    导出'].join('\n')),
  '',
  fence(
    'mermaid',
    [
      'gantt',
      '  title 计划',
      '  dateFormat YYYY-MM-DD',
      '  section 阶段',
      '  开发 :a1, 2026-01-01, 5d',
      '  测试 :after a1, 3d'
    ].join('\n')
  ),
  '',
  '末尾'
].join('\n')

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs mermaid` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '图表.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })

  await writeFile(note, '占位\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  // 【4】要同时看到六张图:CodeMirror 只为视口内的行建 widget DOM,
  // 窗口太矮时排在后面的图根本不会被实例化 —— 把验收窗口加高,不是等它自己出来。
  win.setContentSize(900, 2000)
  const wc = win.webContents
  wc.on('console-message', (_event, ...args: unknown[]) => {
    const first = args[0]
    if (first && typeof first === 'object') {
      const details = first as { level?: string; message?: string }
      if (details.level !== 'debug') {
        console.log(`[renderer:${details.level}] ${details.message}`)
      }
    } else if (typeof args[1] === 'string') {
      console.log(`[renderer:${String(first)}] ${args[1]}`)
    }
  })
  wc.on('render-process-gone', (_event, details) => console.log('[render-process-gone]', details))
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }

  async function key(keyCode: string): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code })
    await sleep(140)
  }

  /** 轮询直到条件成立;返回最后一次取到的值(超时返回 null) */
  async function waitFor<T>(
    read: () => Promise<T>,
    ok: (value: T) => boolean,
    timeout = 30000,
    interval = 200
  ): Promise<T | null> {
    const deadline = Date.now() + timeout
    let last: T | null = null
    while (Date.now() < deadline) {
      last = await read()
      if (ok(last)) return last
      await sleep(interval)
    }
    return null
  }

  /*
   * 数的是**图表容器**而不是 <svg>:icon shape 会在外层 SVG 里再嵌一层 <svg>,
   * 按 svg 计数会把一张图标图数成 3 张。
   */
  const readyCount = (): Promise<number> =>
    evalJs(`document.querySelectorAll('.cm-content .cm-md-mermaid-ready').length`)
  const errorCount = (): Promise<number> =>
    evalJs(`document.querySelectorAll('.cm-content .cm-md-mermaid-error').length`)
  const widgetCount = (): Promise<number> =>
    evalJs(`document.querySelectorAll('.cm-content .cm-md-mermaid').length`)
  const voidCount = (): Promise<number> =>
    evalJs(`document.querySelectorAll('.cm-content .cm-line.cm-md-mermaid-void').length`)

  const cursorLine = (): Promise<number> =>
    evalJs(`
      (() => {
        const sel = document.getSelection()
        if (!sel || !sel.anchorNode) return -1
        let el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
        const line = el?.closest?.('.cm-line')
        if (!line) return -1
        return [...document.querySelectorAll('.cm-content .cm-line')].indexOf(line) + 1
      })()`)

  /** 光标所在的 DOM 行是不是 mermaid 源码态(cs-md-code / mermaid-void 都算块内) */
  const cursorInFence = (): Promise<boolean> =>
    evalJs(`
      (() => {
        const sel = document.getSelection()
        if (!sel || !sel.anchorNode) return false
        const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
        const line = el?.closest?.('.cm-line')
        if (!line) return false
        return line.className.includes('cm-md-code') || line.querySelector('.cm-md-mermaid') !== null
      })()`)

  const dump = async (tag: string): Promise<void> => {
    const rows = await evalJs<{ text: string; cls: string }[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const c = el.cloneNode(true)
        c.querySelectorAll('.line-plus').forEach(w => w.remove())
        return { text: c.textContent, cls: el.className.replace('cm-line', '').trim() }
      })`)
    console.log(
      `\n  ${tag} —— ${rows.length} 行 / ${await readyCount()} 张 SVG / ${await errorCount()} 个错误 / ${await voidCount()} 个折叠行,光标第 ${await cursorLine()} 行`
    )
    rows.forEach((r, i) => console.log(`    ${String(i + 1).padStart(3)} | ${r.text}${r.cls ? `   〔${r.cls}〕` : ''}`))
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1000)
    await focusEditor()
  }

  // ---------- 1. 基本渲染 ----------

  console.log('\n【1】光标在代码块外 → 渲染成 SVG,源码整块折叠')
  const single = `# 标题\n\n${FLOWCHART}\n\n末尾\n`
  await loadDoc(single)
  const rendered = await waitFor(readyCount, n => n === 1)
  check('一张 SVG 渲染出来了', rendered === 1, String(rendered))
  check('没有错误框', (await errorCount()) === 0, String(await errorCount()))
  const info = await evalJs<{ nodes: number; text: string; svgLen: number }>(`
    (() => {
      const svg = document.querySelector('.cm-content .cm-md-mermaid-ready svg')
      return {
        nodes: svg ? svg.querySelectorAll('.node').length : -1,
        text: svg ? svg.textContent : '',
        svgLen: svg ? svg.outerHTML.length : 0
      }
    })()`)
  check('流程图节点都在(3 个)', info.nodes === 3, String(info.nodes))
  check('节点标签进入了 SVG', info.text.includes('开始') && info.text.includes('判断'), JSON.stringify(info.text))
  check('SVG 有实际内容', info.svgLen > 500, String(info.svgLen))
  const rawText = await evalJs<string>(`document.querySelector('.cm-content').textContent`)
  check(
    '原始围栏源码一行都看不见',
    !rawText.includes('flowchart LR') && !rawText.includes('A[开始]'),
    JSON.stringify(rawText.slice(0, 200))
  )
  check('围栏后续行折叠成 5 个 void 行', (await voidCount()) === 5, String(await voidCount()))
  const heights = await evalJs<{ widget: number; voids: number[] }>(`
    (() => {
      const line = document.querySelector('.cm-content .cm-md-mermaid')?.closest('.cm-line')
      return {
        widget: line ? Math.round(line.getBoundingClientRect().height) : -1,
        voids: [...document.querySelectorAll('.cm-content .cm-line.cm-md-mermaid-void')]
          .map(el => Math.round(el.getBoundingClientRect().height * 100) / 100)
      }
    })()`)
  check('widget 行撑起了图表高度', heights.widget > 80, `${heights.widget}px`)
  check('折叠行真的是零高度', heights.voids.every(h => h < 1), JSON.stringify(heights.voids))
  await dump('渲染之后')

  // ---------- 1b. 普通代码块不受影响 ----------

  console.log('\n【1b】普通代码块按常规代码块显示(没被 mermaid 分支误伤)')
  await loadDoc('# 代码\n\n```ts\nconst answer = 42\n```\n\n末尾\n')
  const plain = await evalJs<{ lines: number; info: string; widgets: number; raw: string }>(`
    (() => ({
      lines: document.querySelectorAll('.cm-content .cm-line.cm-md-code').length,
      info: document.querySelector('.cm-content .cm-md-codeinfo')?.textContent ?? '',
      widgets: document.querySelectorAll('.cm-content .cm-md-mermaid').length,
      raw: document.querySelector('.cm-content').textContent
    }))()`)
  check('3 行代码块样式都在', plain.lines === 3, JSON.stringify(plain.lines))
  check('info string(ts)按代码信息样式显示', plain.info === 'ts', JSON.stringify(plain.info))
  check('没有生成 Mermaid widget', plain.widgets === 0, String(plain.widgets))
  check('围栏标记已隐藏', !plain.raw.includes('```'), JSON.stringify(plain.raw.slice(0, 120)))

  // ---------- 2. 光标进块 → 源码态;移开 → 再渲染 ----------

  console.log('\n【2】光标移进围栏 → 退回源码态;移开 → 重新渲染')
  await loadDoc(single)
  await waitFor(readyCount, n => n === 1)
  await focusEditor()
  await key('ArrowDown') // 第 2 行(空行)
  await key('ArrowDown') // 第 3 行 = ```mermaid
  await sleep(400)
  check('光标确实进了围栏', await cursorInFence(), `第 ${await cursorLine()} 行`)
  check('SVG 消失(源码态)', (await widgetCount()) === 0, String(await widgetCount()))
  const sourceRows = await evalJs<string[]>(`
    [...document.querySelectorAll('.cm-content .cm-line.cm-md-code')].map(el => {
      const c = el.cloneNode(true)
      c.querySelectorAll('.line-plus').forEach(w => w.remove())
      return c.textContent
    })`)
  check('6 行围栏源码都按代码样式显示', sourceRows.length === 6, JSON.stringify(sourceRows))
  check(
    '源码里能看到 flowchart 与节点',
    sourceRows.some(t => t.includes('flowchart LR')) && sourceRows.some(t => t.includes('A[开始]')),
    JSON.stringify(sourceRows)
  )
  // 走到文末(越过围栏和末尾那段)
  for (let i = 0; i < 8; i++) await key('ArrowDown')
  await sleep(300)
  check('光标离开了围栏', !(await cursorInFence()), `第 ${await cursorLine()} 行`)
  const again = await waitFor(readyCount, n => n === 1)
  check('图表重新渲染出来', again === 1, String(again))

  // ---------- 3. 鼠标点图表 → 进源码态 ----------

  console.log('\n【3】鼠标点图表 → 光标落进围栏 → 翻回源码态')
  await loadDoc(single)
  await waitFor(readyCount, n => n === 1)
  // 等异步渲染后的重新测量落定再取坐标 —— 占位框和 SVG 的高度差很大,
  // 抢在重排前算出来的坐标可能已经不在图上
  await sleep(700)
  const spot = await evalJs<{ x: number; y: number }>(`
    (() => {
      const r = document.querySelector('.cm-content .cm-md-mermaid').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await sleep(600)
  // 点中心而不是顶部:占位框只有 48px,若异步撑高后没有触发重新测量,
  // CodeMirror 会按旧的 113px 行高把点击映射到后面的行(点图却把光标送到文末)
  check('点一下图表就退回源码态', (await widgetCount()) === 0, String(await widgetCount()))
  check('光标确实进到了围栏行上', await cursorInFence(), `第 ${await cursorLine()} 行`)

  // ---------- 4. 多种图表类型 ----------

  console.log('\n【4】flowchart / sequence / pie / class / mindmap / gantt 一起渲染')
  await loadDoc(MULTI)
  const many = await waitFor(
    async () => ({ ready: await readyCount(), errors: await errorCount() }),
    v => v.ready === 6,
    60000
  )
  check('6 张图全部渲染出来', many?.ready === 6, JSON.stringify(many))
  check('没有任何错误框', many?.errors === 0, JSON.stringify(many))
  const types = await evalJs<string[]>(`
    [...document.querySelectorAll('.cm-content .cm-md-mermaid-ready svg')]
      .map(svg => svg.getAttribute('aria-roledescription') || svg.getAttribute('data-diagram-type') || svg.id)`)
  console.log(`    (SVG 标识:${JSON.stringify(types)})`)
  check('每张图都有独立 id(没有互相踩临时容器)', new Set(types).size === 6, JSON.stringify(types))

  // ---------- 4b. 相同源码复用缓存时,id 必须重新分配 ----------

  console.log('\n【4b】两段完全相同的 mermaid 源码:都能渲染,且 SVG id 不重复')
  await loadDoc(`# 重复图表\n\n${FLOWCHART}\n\n${FLOWCHART}\n\n末尾\n`)
  const dup = await waitFor(readyCount, n => n === 2, 30000)
  check('两张相同的图都渲染出来了', dup === 2, String(dup))
  const ids = await evalJs<string[]>(`
    [...document.querySelectorAll('.cm-content .cm-md-mermaid-ready > svg')]
      .map(svg => svg.id)`)
  check('两张 SVG 的 id 互不相同(缓存命中时重新分配)', new Set(ids).size === 2, JSON.stringify(ids))

  // ---------- 5. 语法错误 ----------

  console.log('\n【5】语法错误 → 错误框,而不是空白或崩溃')
  const broken = '# 错误\n\n' + fence('mermaid', 'this is not a mermaid diagram') + '\n\n末尾\n'
  await loadDoc(broken)
  const error = await waitFor(errorCount, n => n === 1, 30000)
  check('出现了一个错误框', error === 1, String(error))
  const errorText = await evalJs<string>(`document.querySelector('.cm-md-mermaid-error')?.textContent ?? ''`)
  check('错误框里有说明文字', errorText.length > 10 && errorText.includes('Mermaid'), JSON.stringify(errorText))
  check('错误块不会把源码留在屏幕上', (await widgetCount()) === 1, String(await widgetCount()))
  // 点进错误块仍然能改
  const errorSpot = await evalJs<{ x: number; y: number }>(`
    (() => {
      const r = document.querySelector('.cm-content .cm-md-mermaid').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  wc.sendInputEvent({ type: 'mouseDown', x: errorSpot.x, y: errorSpot.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: errorSpot.x, y: errorSpot.y, button: 'left', clickCount: 1 })
  await sleep(500)
  check('点错误块也能回到源码修改', await cursorInFence(), `第 ${await cursorLine()} 行`)

  // ---------- 6. 主题切换 → 重渲染 ----------

  console.log('\n【6】切到深色 → SVG 必须重新渲染')
  await loadDoc(single)
  await waitFor(readyCount, n => n === 1)
  const before = await evalJs<string>(`
    (() => {
      const svg = document.querySelector('.cm-content .cm-md-mermaid-ready svg')
      svg.setAttribute('data-before', '1')
      return svg.outerHTML
    })()`)
  await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true })()`)
  const rerendered = await waitFor(
    async () => ({
      fresh: await evalJs<number>(
        `document.querySelectorAll('.cm-content .cm-md-mermaid-ready svg:not([data-before])').length`
      ),
      errors: await errorCount()
    }),
    v => v.fresh === 1,
    30000
  )
  check('深色主题下产生了新的 SVG', rerendered?.fresh === 1, JSON.stringify(rerendered))
  const after = await evalJs<string>(
    `document.querySelector('.cm-content .cm-md-mermaid-ready svg')?.outerHTML ?? ''`
  )
  check('新旧 SVG 配色确实不同(不是复用旧图)', after !== before, `${before.length} vs ${after.length}`)
  await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true })()`)
  await sleep(500)

  // ---------- 7. Lucide 图标(icon shape) ----------

  console.log('\n【7】icon shape 能加载本地 Lucide 图标包')
  const iconDoc =
    '# 图标\n\n' +
    fence(
      'mermaid',
      [
        'flowchart TD',
        '  A@{ icon: "lucide:user", form: "square", label: "用户" }',
        '  B@{ icon: "lucide:settings", label: "设置" }',
        '  A --> B'
      ].join('\n')
    ) +
    '\n\n末尾\n'
  await loadDoc(iconDoc)
  const iconResult = await waitFor(
    async () => ({
      ready: await readyCount(),
      errors: await errorCount()
    }),
    v => v.ready === 1 || v.errors === 1,
    60000
  )
  check('图标图渲染成功(没有 "Icon set not found")', iconResult?.ready === 1, JSON.stringify(iconResult))
  const iconSvg = await evalJs<string>(
    `document.querySelector('.cm-content .cm-md-mermaid-ready svg')?.outerHTML ?? ''`
  )
  check('SVG 里真的有图标路径(带 currentColor 的 stroke)', iconSvg.includes('stroke="currentColor"'))

  // ---------- 8. 导出 HTML ----------

  console.log('\n【8】导出 HTML:图表内联成 SVG,坏图降级但整份照常导出')
  const exportDoc =
    '# 导出验证\n\n' +
    FLOWCHART +
    '\n\n' +
    fence('mermaid', 'not a diagram at all') +
    '\n\n' +
    fence('js', 'const answer = 42') +
    '\n\n普通段落\n'
  await loadDoc(exportDoc)
  const exportPath = join(ud, 'export-mermaid.html')
  await rm(exportPath, { force: true })
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: false,
    filePath: exportPath
  })
  wc.send(IPC.MenuCommand, 'file:export-html')
  const exported = await waitFor(
    async () => {
      try {
        await access(exportPath)
        return await readFile(exportPath, 'utf8')
      } catch {
        return ''
      }
    },
    html => html.includes('</html>'),
    40000
  )
  check('导出的 HTML 落盘了', typeof exported === 'string' && exported.endsWith('</html>\n'), String(exported?.length))
  check('成功的图表内联成了 SVG', (exported?.match(/<div class="mermaid-diagram"><svg/g) ?? []).length === 1)
  check('占位符没有漏到产物里', !exported?.includes('data-mermaid-index'))
  check('失败的图表降级成错误块', exported?.includes('mermaid-diagram-error') === true)
  check('错误块里保留了源码', exported?.includes('not a diagram at all') === true)
  check(
    '普通代码块仍然走 highlight.js(fence 拦截没有误伤)',
    exported?.includes('<pre class="hljs"><code>') === true && exported?.includes('hljs-keyword') === true
  )
  check('普通内容照常导出', exported?.includes('普通段落') === true)
  await rm(exportPath, { force: true })

  // ---------- 截图 ----------

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  await loadDoc(`# Mermaid 渲染\n\n${FLOWCHART}\n\n${fence('mermaid', ['pie title 占比', '  "甲": 40', '  "乙": 60'].join('\n'))}\n`)
  await waitFor(readyCount, n => n === 2, 30000)
  await evalJs(`(() => { document.querySelector('.cm-scroller').scrollTop = 0; return true })()`)
  await sleep(400)
  try {
    await writeFile(join(shots, 'mermaid.png'), (await wc.capturePage()).toPNG())
  } catch (err) {
    // Electron 偶尔会在合成器状态切换时让 capturePage 以 UnknownVizError 失败,
    // 那是截图设施的问题,不该把整个功能验收判失败
    console.log('  (截图跳过:', err instanceof Error ? err.message : String(err), ')')
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  app.exit(2)
})
