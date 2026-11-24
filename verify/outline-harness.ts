/**
 * 验收:大纲侧栏的两件事 —— 条目要全,高亮要跟得上滚动。
 *
 * 两起实测 bug:
 *   1. 编辑器滚到 4.2「处理流水线」,大纲还停在 3.2。原因是判定位置用了
 *      `view.visibleRanges[0].from` —— 那是 CodeMirror 的**预渲染**范围,
 *      视口上方还会多画最多 1000px(几十行)。
 *   2. 文档有 9 个二级标题,大纲只显示到 4.4。原因是 `extractOutline` 读完
 *      `ensureSyntaxTree` 又去读 `syntaxTree(state)` —— 后者是建 state 时
 *      只解析了前 3000 字符的快照,超过的部分整段丢失。
 *
 * 这里只读用户看得见的东西:`.cm-line` 的几何 + 大纲列表的文本/激活项。
 * 期望值由屏幕上实际可见的标题几何推出,所以不依赖实现怎么算位置。
 *
 * 跑法(仓库根目录,必须套 xvfb —— 本用例的窗口是**显示**状态,见下方说明):
 *   xvfb-run -a node verify/run.mjs outline
 *
 * ⚠️ 改了 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`。
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
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

/*
 * 窗口不藏:滚动后的重绘与逐帧回调都靠 requestAnimationFrame,
 * 隐藏的窗口会被 Chromium 节流甚至完全停掉 —— 那时 CM 不会重建视口,
 * 量出来的 DOM 全是滚动前的旧位置,用例会假失败。
 * 跑法上用 xvfb-run,窗口落在虚拟屏幕上,不会打扰桌面。
 */

const SECTION_LINES = 10

/**
 * 每节 10 行:`## 章节N` + 9 行以行号开头的正文。
 *
 * 正文故意写得长:整篇要明显超过 3000 字符 —— Language.state 建 state 时只解析
 * 前 3000 字符,曾经的大纲截断 bug 正是栽在这条线上,文档太短就测不出来。
 */
function makeDoc(sections: number): string {
  const lines: string[] = []
  for (let s = 1; s <= sections; s++) {
    lines.push(`## 章节${s}`)
    for (let i = 1; i < SECTION_LINES; i++) {
      lines.push(`L${String((s - 1) * SECTION_LINES + i).padStart(3, '0')} 正文内容占位，用于把文档撑到 3000 字符以上`)
    }
  }
  return lines.join('\n') + '\n'
}

interface Snap {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** 屏幕顶部第一条与视口相交的行 */
  firstVisible: string
  /** 大纲里带 outline-active 的那一项 */
  active: string
  /** 大纲全部条目文本 */
  outline: string[]
  /** 激活项在列表里的序号,-1 = 没有 */
  activeIndex: number
  /** 可见区第一行距滚动容器顶边的像素(诊断用) */
  firstVisibleOffset: number
  /** 已渲染的标题行,top 相对滚动容器顶边(视口上方为负) */
  headings: { text: string; top: number }[]
}

/** 与 outline.ts 的 JUMP_MARGIN 一致:视口顶边下方这一段也算「当前章节」 */
const JUMP_MARGIN = 24

/**
 * 大纲此刻**应该**高亮哪一节:视口最高处落在哪一节里就选谁 ——
 * 也就是最后一个起点不高于「视口顶边 + JUMP_MARGIN」的标题。
 * 与 src/renderer/src/editor/outline.ts 的 visibleTop 保持同一条规则。
 *
 * 依赖"视口上方的邻近标题仍在 DOM 里":CM 会多渲染视口上方最多 1000px,
 * 本 fixture 每节只有 ~10 行,够用。
 */
function expectedActive(s: Snap): string {
  // 标题行的 textContent 里可能带着行首折叠按钮的「+」
  const clean = (text: string): string => text.replace(/^\+/, '')
  let want = ''
  for (const h of s.headings) if (h.top < JUMP_MARGIN) want = h.text
  if (want) return clean(want)
  /*
   * 视口上方那条标题行可能没挂标题装饰类(预渲染的行不等于可见范围),
   * 此时 DOM 里找不到「顶边上一条标题」。用大纲顺序回推:视口内第一条
   * 标题的前一条就是当前节。
   */
  const below = s.headings.find(h => h.top >= 0)
  if (below) {
    const at = s.outline.indexOf(clean(below.text))
    if (at > 0) return s.outline[at - 1] ?? ''
  }
  // 已经在文档最顶部:第一个标题就是当前节
  return s.outline[0] ?? ''
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs outline` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const longNote = join(vault, '长文.md')
  const shortNote = join(vault, '短文.md')
  const nestedNote = join(vault, '层级.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await writeFile(longNote, makeDoc(20), 'utf8')
  await writeFile(shortNote, makeDoc(5), 'utf8')
  // 一/二/三级标题交错,用来量层级引导线的条数与位置
  await writeFile(
    nestedNote,
    ['# 第一章', '', '正文', '', '## 1.1 小节', '', '正文', '', '### 1.1.1 细节', '', '正文', '', '## 1.2 小节', '', '正文', '', '# 第二章', '', '正文', '', '## 2.1 小节', ''].join(
      '\n'
    ),
    'utf8'
  )
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: longNote,
        marketUrl: '',
        outline: true,
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
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function openNote(path: string): Promise<boolean> {
    const clicked = await evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-file')]
        .find(e => e.getAttribute('title') === ${JSON.stringify(path)})
      if (!row) return false
      row.click()
      return true
    })()`)
    await sleep(800)
    return clicked
  }

  /** 读一次「屏幕上看到的 vs 大纲高亮的」快照 */
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`(() => {
      const scroller = document.querySelector('.cm-scroller')
      const sr = scroller.getBoundingClientRect()
      const visible = [...document.querySelectorAll('.cm-line')]
        .map(el => ({ text: (el.textContent || '').trim(), rect: el.getBoundingClientRect() }))
        .filter(l => l.rect.bottom > sr.top + 0.5 && l.rect.top < sr.bottom - 0.5)
        .sort((a, b) => a.rect.top - b.rect.top)
      const items = [...document.querySelectorAll('.outline-item')]
      const activeEl = items.find(e => e.classList.contains('outline-active'))
      const headings = [...document.querySelectorAll('.cm-line')]
        .filter(el => /(^|\\s)cm-md-h[1-6](\\s|$)/.test(el.className))
        .map(el => ({ text: (el.textContent || '').trim(), top: el.getBoundingClientRect().top - sr.top }))
        .sort((a, b) => a.top - b.top)
      return {
        headings,
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        clientHeight: Math.round(scroller.clientHeight),
        firstVisible: visible[0] ? visible[0].text : '',
        firstVisibleOffset: visible[0] ? Math.round(visible[0].rect.top - sr.top) : -1,
        active: activeEl ? (activeEl.textContent || '').trim() : '',
        activeIndex: activeEl ? items.indexOf(activeEl) : -1,
        outline: items.map(e => (e.textContent || '').trim())
      }
    })()`)

  async function scrollTo(px: number): Promise<void> {
    await evalJs(`(() => { document.querySelector('.cm-scroller').scrollTop = ${Math.round(px)}; return true })()`)
    // 滚动事件 → 一帧 rAF → Vue 渲染;留足余量,同时让 CM 完成测量
    await sleep(350)
  }

  // ---------- 顶部:标题不再和右上角窗口控件挤在同一行 ----------
  const headerPadTop = await evalJs<number>(`(() => {
    const el = document.querySelector('.outline-header')
    return el ? parseFloat(getComputedStyle(el).paddingTop) || 0 : -1
  })()`)
  check('大纲标题让出窗口控件行（顶部留白 ≥36px）', headerPadTop >= 36, `${headerPadTop}px`)

  // ---------- 长文档:滚到哪儿,高亮就跟到哪儿 ----------
  check('打开长文档', await waitFor(`document.querySelectorAll('.outline-item').length >= 20`))
  await openNote(longNote)
  check('长文档:编辑器有内容', await waitFor(`document.querySelectorAll('.cm-line').length > 0`))
  await sleep(500)

  const top = await snap()
  const docChars = makeDoc(20).length
  console.log(
    `    初始 scrollTop=${top.scrollTop} 高度=${top.scrollHeight}/${top.clientHeight} 首条可见行=${top.firstVisible} 文档 ${docChars} 字符`
  )
  check('长文档:超过 3000 字符(截断 bug 的触发条件)', docChars > 3000, `chars=${docChars}`)
  check('长文档:顶部时高亮第一节', top.active === '章节1', `active=${top.active}`)
  // 这一条专门盯「大纲只显示前几节」:文档第 93 行之后的标题也必须全部出现
  check('长文档:大纲条目齐全(不被 3000 字符快照截断)', top.outline.length === 20, `len=${top.outline.length}`)
  check('长文档:最后一条是大纲末尾', top.outline[top.outline.length - 1] === '章节20', `last=${top.outline[top.outline.length - 1]}`)

  const maxScroll = top.scrollHeight - top.clientHeight
  check('长文档:可滚动(否则用例空转)', maxScroll > 1000, `maxScroll=${maxScroll}`)

  for (const ratio of [0.25, 0.5, 0.75, 0.95]) {
    await scrollTo(maxScroll * ratio)
    const s = await snap()
    const want = expectedActive(s)
    console.log(`    scrollTop=${s.scrollTop} 首条可见行="${s.firstVisible}" → 期望 ${want},实际 ${s.active}`)
    check(
      `长文档:滚到 ${Math.round(ratio * 100)}% 时高亮跟得上`,
      want !== '' && s.active === want,
      `期望 ${want},实际 ${s.active}`
    )
  }

  // 滚回顶部
  await scrollTo(0)
  const back = await snap()
  check('长文档:滚回顶部回到第一节', back.active === '章节1', `active=${back.active}`)

  // ---------- 点击大纲:跳转落点与高亮必须是同一条 ----------
  // 跳转把标题停在视口顶边下方,顶边那一小段仍属于上一条;文档末尾的标题
  // 还滚不到顶边。只按视口几何判定时,点哪条偏偏不高亮哪条。
  const clickOutline = async (index: number): Promise<void> => {
    await evalJs(`(() => {
      const items = [...document.querySelectorAll('.outline-item')]
      if (items[${index}]) items[${index}].click()
      return true
    })()`)
    // 跳转的滚动 → 一帧 rAF → Vue 渲染,留足余量
    await sleep(500)
  }

  for (const index of [2, 10, 19]) {
    await clickOutline(index)
    const s = await snap()
    const want = s.outline[index] ?? ''
    // 标题行的 textContent 里还带着行首折叠按钮的「+」,用包含判断
    const heading = s.headings.find(h => h.text.includes(want))
    console.log(
      `    点击第 ${index + 1} 条「${want}」→ scrollTop=${s.scrollTop} 首条可见行="${s.firstVisible}" ` +
        `标题 top=${heading ? Math.round(heading.top) : '不在 DOM'} 实际高亮=${s.active}`
    )
    check(`点击大纲第 ${index + 1} 条:跳转后高亮就是它`, want !== '' && s.active === want, `期望 ${want},实际 ${s.active}`)
  }

  // 点完只往回滚一点点(标题还停在视口顶边附近):高亮不能立刻翻回上一条
  await clickOutline(10)
  const landing = await snap()
  await scrollTo(landing.scrollTop - 10)
  const nudged = await snap()
  check(
    '点击后轻微滚动:高亮仍停在点中的那一条',
    nudged.active === '章节11',
    `scrollTop=${nudged.scrollTop},实际 ${nudged.active}`
  )

  // 点完之后用户自己滚动,高亮要回到跟随(点击钉住不能赖着不走)
  await scrollTo(maxScroll * 0.5)
  const afterPin = await snap()
  const wantAfterPin = expectedActive(afterPin)
  check(
    '点击大纲后继续滚动:高亮恢复跟随',
    wantAfterPin !== '' && afterPin.active === wantAfterPin,
    `期望 ${wantAfterPin},实际 ${afterPin.active}`
  )

  // ---------- 短文档:整篇都在预渲染范围里 ----------
  // 这种文档滚动时视口范围不变,updateListener 的 viewportChanged 不会触发;
  // 只能靠滚动监听,否则高亮会永远停在打开时的第一节。
  await openNote(shortNote)
  await waitFor(`document.querySelectorAll('.outline-item').length === 5`)
  await sleep(400)

  const shortTop = await snap()
  const shortMax = shortTop.scrollHeight - shortTop.clientHeight
  console.log(`    短文 scrollTop=${shortTop.scrollTop} 高度=${shortTop.scrollHeight}/${shortTop.clientHeight}`)
  check('短文档:可滚动(否则用例空转)', shortMax > 100, `maxScroll=${shortMax}`)

  if (shortMax > 100) {
    await scrollTo(shortMax)
    const s = await snap()
    const want = expectedActive(s)
    console.log(`    短文滚到底:首条可见行="${s.firstVisible}" → 期望 ${want},实际 ${s.active}`)
    check('短文档:滚到底时高亮跟得上', want !== '' && s.active === want, `期望 ${want},实际 ${s.active}`)
  }

  // ---------- 层级文档:缩进保留,引导线已在 f0e42f8 移除 ----------
  await openNote(nestedNote)
  check('层级文档:大纲有 6 条', await waitFor(`document.querySelectorAll('.outline-item').length === 6`))
  await sleep(400)

  interface OutlineShape {
    text: string
    guides: number
  }

  const shapes = await evalJs<OutlineShape[]>(`(() => {
    return [...document.querySelectorAll('.outline-item')].map(el => ({
      text: (el.textContent || '').trim(),
      guides: el.querySelectorAll('.outline-guide').length
    }))
  })()`)

  const wantTexts = ['第一章', '1.1 小节', '1.1.1 细节', '1.2 小节', '第二章', '2.1 小节']
  check(
    '层级文档:大纲文本按顺序',
    shapes.map(s => s.text).join('|') === wantTexts.join('|'),
    shapes.map(s => s.text).join('|')
  )
  check(
    '层级文档:不再绘制引导线',
    shapes.every(s => s.guides === 0),
    shapes.map(s => `${s.text}:${s.guides}`).join(' ')
  )

  // ---------- 展开 / 收起大纲:宽度做滑动动画,不是瞬间消失 ----------
  const sidebarWidth = (): Promise<number> =>
    evalJs<number>(`(() => {
      const el = document.querySelector('.outline-sidebar')
      return el ? Math.round(el.getBoundingClientRect().width) : 0
    })()`)

  const clickOutlineToggle = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const btn = [...document.querySelectorAll('.status-toggles button')]
        .find(b => (b.title || '').includes('大纲'))
      if (!btn) return false
      btn.click()
      return true
    })()`)

  /** 点一下后按帧采样 500ms,拿到宽度随时间的变化曲线 */
  const sampleWidths = (): Promise<number[]> =>
    evalJs<number[]>(`new Promise(resolve => {
      const out = []
      const t0 = performance.now()
      const tick = () => {
        const el = document.querySelector('.outline-sidebar')
        out.push(el ? Math.round(el.getBoundingClientRect().width) : 0)
        if (performance.now() - t0 < 500) requestAnimationFrame(tick)
        else resolve(out)
      }
      requestAnimationFrame(tick)
    })`)

  const isDisplayed = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = document.querySelector('.outline-sidebar')
      return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
    })()`)

  const fullWidth = await sidebarWidth()
  check('动画:开始时大纲可见且宽度 > 0', (await isDisplayed()) && fullWidth > 100, `width=${fullWidth}`)
  check('动画:找到状态栏的大纲开关', await clickOutlineToggle())

  const closing = await sampleWidths()
  await sleep(120)
  const closedDisplayed = await isDisplayed()
  const inBetweenClose = closing.some(w => w > 0 && w < fullWidth)
  console.log(`    收起宽度采样:${closing.slice(0, 12).join(',')} … ${closing.slice(-4).join(',')}`)
  check('动画:收起过程中出现中间宽度(滑动而非瞬间消失)', inBetweenClose, closing.join(','))
  check('动画:收起后大纲隐藏', !closedDisplayed)
  check('动画:收起后宽度归零', (await sidebarWidth()) === 0, `width=${await sidebarWidth()}`)

  check('动画:再次点击展开', await clickOutlineToggle())
  const opening = await sampleWidths()
  await sleep(120)
  const reopenedWidth = await sidebarWidth()
  const inBetweenOpen = opening.some(w => w > 0 && w < fullWidth)
  console.log(`    展开宽度采样:${opening.slice(0, 12).join(',')} … ${opening.slice(-4).join(',')}`)
  check('动画:展开过程中出现中间宽度(滑动而非瞬间出现)', inBetweenOpen, opening.join(','))
  check('动画:展开后恢复到原宽度', Math.abs(reopenedWidth - fullWidth) <= 1, `${reopenedWidth} vs ${fullWidth}`)

  console.log(`\n[outline] ${pass} 通过, ${fail} 失败`)
  win.destroy()
  app.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
