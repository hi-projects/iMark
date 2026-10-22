/**
 * 验收:设置面板里「点一下才变高」的内容,不能把上面的文字挤到别的折行位置。
 *
 * 起因是实测到的一个 bug:设置 → 外观,点开「可以改哪些东西?」→ 内容变高 →
 * `.settings-body` 长出滚动条 → 正文可用宽度少掉一个滚动条宽 → 上面那段说明
 * **重新折行**(最后一个字被挤到第二行)。同一块面板,点一下前后长得不一样。
 *
 * 所以断言的是**可用宽度不变**,而不是「有没有滚动条」:展开前后量 `.settings-body`
 * 的 clientWidth 与说明文字的折行落点,两者必须一模一样。同时先确认展开后
 * **确实**出了滚动条、而且滚动条**确实**占宽度 —— 否则这个用例是空转的
 * (前者说明没造出溢出,后者说明平台用的是覆盖式滚动条,两种情况下这条断言都没有意义)。
 *
 * 跑法:node verify/run.mjs settings-reflow
 *
 * ⚠️ 改了 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层页面走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 *
 * 注意:样式目录是数据根下的 `css/`(见 src/main/dataDir.ts),跟着 `--user-data-dir`
 * 一起被隔离 —— 本用例仍只读不写,目录里有几个文件都不影响结论。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'

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

/** 一次测量结果。全部取整到 0.01px:浮点尾巴会让「等于」变成偶然 */
interface Metrics {
  /** .settings-body 的可用宽度(不含滚动条) */
  width: number
  /** 滚动条占掉的宽度。0 = 平台用的是覆盖式滚动条,这个用例在该平台上没有意义 */
  gutter: number
  /** 内容是否高过了可视区(即当前有没有滚动条) */
  scrollable: boolean
  /** 说明文字的高度与落在第几行 */
  descLines: number
  /** 说明文字最后一个字的顶边 —— 折行位置一变它就变 */
  lastCharTop: number
  /** 帮助正文的高度。0 = 没展开 */
  helpHeight: number
  /** 面板与视口尺寸 —— 断言不成立时,先看这里是不是屏幕/窗口尺寸没造出该有的场景 */
  dialog: string
  viewport: string
}

const METRICS = `
(() => {
  const round = n => Math.round(n * 100) / 100
  const body = document.querySelector('.settings-body')
  const help = document.querySelector('.userstyle-help')
  const desc = help.closest('.settings-section').querySelector('.settings-section-desc')
  const rect = desc.getBoundingClientRect()
  const lineHeight = parseFloat(getComputedStyle(desc).lineHeight)

  // 最后一个「有内容的字」:说明文字末尾的换行/缩进空白不算,否则量到的是空矩形
  const walker = document.createTreeWalker(desc, NodeFilter.SHOW_TEXT)
  let text = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) text = n
  let i = text.data.length - 1
  while (i > 0 && /\\s/.test(text.data[i])) i -= 1
  const r = document.createRange()
  r.setStart(text, i)
  r.setEnd(text, i + 1)

  return {
    width: body.clientWidth,
    gutter: body.offsetWidth - body.clientWidth,
    scrollable: body.scrollHeight > body.clientHeight,
    descLines: Math.round(rect.height / lineHeight),
    lastCharTop: round(r.getBoundingClientRect().top),
    helpHeight: round(help.getBoundingClientRect().height) - round(help.querySelector('summary').getBoundingClientRect().height),
    dialog: (() => { const d = document.querySelector('.settings-dialog').getBoundingClientRect(); return round(d.width) + 'x' + round(d.height) })(),
    viewport: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio
  }
})()
`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, '笔记.md'), 'hello world\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '笔记.md'),
        autoSave: false,
        marketUrl: ''
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  await initExtensions({ appVersion: '0.1.0' })
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  // 等渲染层把仓库、文档、样式清单都装上
  await sleep(2500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const metrics = (): Promise<Metrics> => evalJs<Metrics>(METRICS)

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  // 面板尺寸是 90vw × 86vh(见 settings.css):窗口一矮,面板跟着缩到装不下内容的地步,
  // 「收起时放得下、展开才溢出」这个场景就造不出来(两种状态都在滚,断言等于空转)。
  // 所以窗口本身不够大时缩一档,把 **CSS 视口**撑到至少 1040×780 —— 那正是设计尺寸
  // 880×620 所需的大小(缩放变小 → 塞进更多 CSS px)。够大就不动它,不去改窗口尺寸。
  const [dipW, dipH] = win.getContentSize()
  const zoom = Math.min(1, dipW / 1040, dipH / 780)
  if (zoom < 1) wc.setZoomFactor(zoom)
  await sleep(600)

  console.log('\n[设置 · 外观:展开「可以改哪些东西?」]')

  await evalJs(`document.querySelector('button[title^="设置"]').click()`)
  const opened = await waitFor(`document.querySelector('.settings-body') && document.querySelector('.userstyle-help')`)
  check('设置面板打开了,并且停在「外观」页', opened)
  if (!opened) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }
  await sleep(300)

  const collapsed = await metrics()
  await evalJs(`document.querySelector('.userstyle-help > summary').click()`)
  await sleep(300)
  const expanded = await metrics()

  console.log(`     收起: ${JSON.stringify(collapsed)}`)
  console.log(`     展开: ${JSON.stringify(expanded)}`)

  check('折叠区真的展开了(正文有高度)', expanded.helpHeight > 0, `展开后正文高 ${expanded.helpHeight}px`)
  check(
    '展开前内容没溢出(此时没有滚动条)',
    collapsed.scrollable === false,
    '窗口/面板太矮,收起时就已经在滚了 —— 这个场景没造出来,下面的断言测不到东西'
  )
  check('展开后内容溢出(此时有滚动条)', expanded.scrollable === true, '没造出溢出,下面的断言是空转的')
  check('这个平台的滚动条占宽度(否则本条断言无意义)', expanded.gutter > 0, `滚动条宽 ${expanded.gutter}px`)

  // 这一条是**关键断言**:修好的时候它必然过,坏的时候必然不过(实测差 15px)。
  // 下面那条折行断言是「用户看到的症状」,但它命不命中取决于折行点离右边界的远近 ——
  // 换了字体/DPI/窗口宽度,同一段文字可能怎么都不折,于是那一条就测不到东西了。
  check(
    '展开前后可用宽度不变',
    collapsed.width === expanded.width,
    `收起 ${collapsed.width}px → 展开 ${expanded.width}px`
  )
  check(
    '说明文字没有重新折行',
    collapsed.descLines === expanded.descLines && collapsed.lastCharTop === expanded.lastCharTop,
    `行数 ${collapsed.descLines} → ${expanded.descLines},末字顶边 ${collapsed.lastCharTop} → ${expanded.lastCharTop}`
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
