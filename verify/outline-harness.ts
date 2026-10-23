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

/**
 * 大纲此刻**应该**高亮哪一节:视口最高处落在哪一节里就选谁 ——
 * 也就是最后一个起点不高于视口顶边的标题。
 * 与 src/renderer/src/editor/outline.ts 的 visibleTop 保持同一条规则。
 *
 * 依赖"视口上方的邻近标题仍在 DOM 里":CM 会多渲染视口上方最多 1000px,
 * 本 fixture 每节只有 ~10 行,够用。
 */
function expectedActive(s: Snap): string {
  let want = ''
  for (const h of s.headings) if (h.top <= 0.5) want = h.text
  // 没有任何标题高于视口顶边 = 已经在文档最顶部,第一个标题就是当前节
  return want || (s.headings[0]?.text ?? '')
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
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await writeFile(longNote, makeDoc(20), 'utf8')
  await writeFile(shortNote, makeDoc(5), 'utf8')
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

  console.log(`\n[outline] ${pass} 通过, ${fail} 失败`)
  win.destroy()
  app.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
