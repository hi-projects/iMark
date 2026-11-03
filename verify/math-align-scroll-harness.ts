/**
 * 块级公式横向滚动条的端到端验证。
 *
 * 回归两类问题:
 *   A. KaTeX 0.19 的自动编号(align / gather 的 (1)、(2)…):编号列 .katex-tag
 *      的盒子比内容窄 2px(vlist 的 -2px 右边距),空白占位格越过公式容器右边界,
 *      于是 overflow-x:auto 的公式块在一条很窄的公式上也画出滚动条。补丁在
 *      src/renderer/src/styles/katex-overrides.css。
 *   B. 编辑时的浮动预览:卡片默认 pointer-events:none,超宽公式的滚动条看得见
 *      却拖不动。现在只有内容确实溢出时才挂 .cm-md-math-preview-scrollable。
 *   C. 浮动预览会收缩到公式宽度,而 KaTeX 编号列是绝对定位、不占宽度,公式铺满
 *      卡片时编号压在公式右端。预览里让编号列参与排版(position: static)。
 *
 * 验五件事:
 *   1. 用户报告的 align 公式:渲染成 widget,容器没有横向滚动条;
 *   2. 普通 $$...$$:同样没有多出来的滚动条;
 *   3. 比编辑区还宽的公式:仍然能横向滚动(补丁不能把 overflow 关掉);
 *   4. 浮动预览:自动编号在公式右侧、不重叠,纵向仍与公式逐行对齐;
 *   5. 浮动预览:超宽公式的滚动条真能拖动、拖动后编辑器不失焦、预览不消失;
 *      窄公式的预览仍然点击穿透。
 *
 * 跑法(仓库根目录,先 `npx electron-vite build`):
 *   IMARK_VERIFY_HIDDEN=1 node verify/run.mjs math-align-scroll
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
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

/** 用户报告的最小复现:align 自动编号 (1) */
const ALIGN_DOC = ['$$', '\\begin{align}', '1', '\\end{align}', '$$', '', '末尾', ''].join('\n')
const PLAIN_DOC = ['$$', '1', '$$', '', '末尾', ''].join('\n')
/** 一定比编辑区宽的单行公式 */
const WIDE_DOC = ['$$', Array.from({ length: 120 }, () => 'a').join('+'), '$$', '', '末尾', ''].join('\n')
/** 用户报告的第二种情况:公式铺满预览卡片,两行自动编号压在公式右端 */
const TAGGED_DOC = String.raw`$$
\begin{align}
q(x_{0:T})\,/\,q(x_0) &= \prod_{t=1}^{T} q(x_t|x_{t-1}) \\
\Rightarrow\ \ q(x_{1:T}|x_0) &= \prod_{t=1}^{T} q(x_t|x_{t-1})
\end{align}
$$

末尾
`

interface MathState {
  widget: boolean
  katex: number
  tag: number
  eqnNum: number
  tagOverflowX: string | null
  clientWidth: number
  scrollWidth: number
  tagRight: number
  widgetRight: number
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface PreviewState {
  preview: boolean
  scrollable: boolean
  pointerEvents: string | null
  visibility: string | null
  clientWidth: number
  scrollWidth: number
  scrollLeft: number
  barThickness: number
  rect: Rect | null
  baseRect: Rect | null
  tagRect: Rect | null
  tagPosition: string | null
  editorFocused: boolean
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <name>` 跑会自动带上)')
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
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, `${ALIGN_DOC}\n`, 'utf8')
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
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = keyCode === 'End' ? 'End' : keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(200)
  }

  /**
   * 写盘 + 重载,光标落在文首(公式内)。
   * keepInFormula = true 时留在公式里(渲染态 widget 不出现,浮动预览出现),
   * 否则 Ctrl+End 退出公式,整块渲染成 widget。
   */
  async function loadDoc(content: string, keepInFormula = false): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
    await focusEditor()
    await key('Home', ['control'])
    if (!keepInFormula) await key('End', ['control'])
    await sleep(800)
  }

  const mathState = (): Promise<MathState> =>
    evalJs(`
      (() => {
        const w = document.querySelector('.cm-md-math-display')
        if (!w) return { widget: false }
        const tag = w.querySelector('.katex-tag')
        const wr = w.getBoundingClientRect()
        const tr = tag ? tag.getBoundingClientRect() : null
        return {
          widget: true,
          katex: w.querySelectorAll('.katex').length,
          tag: w.querySelectorAll('.katex-tag').length,
          eqnNum: w.querySelectorAll('.eqn-num').length,
          tagOverflowX: tag ? getComputedStyle(tag).overflowX : null,
          clientWidth: w.clientWidth,
          scrollWidth: w.scrollWidth,
          tagRight: tr ? tr.right : 0,
          widgetRight: wr.right
        }
      })()`)

  console.log('\n【1】align 自动编号:不再多出横向滚动条')
  await loadDoc(ALIGN_DOC)
  const align = await mathState()
  check('渲染成一个公式 widget', align.widget === true, JSON.stringify(align))
  check('widget 里是真正的 KaTeX 输出', align.katex === 1, String(align.katex))
  check('自动编号列存在', align.tag === 1 && align.eqnNum === 1, `tag=${align.tag} eqn=${align.eqnNum}`)
  check('编号列横向裁掉溢出(overflow-x: clip)', align.tagOverflowX === 'clip', String(align.tagOverflowX))
  check(
    '公式块没有横向滚动条',
    align.widget && align.scrollWidth - align.clientWidth <= 1,
    `client=${align.clientWidth} scroll=${align.scrollWidth}`
  )
  check(
    '编号列不越过容器右边界',
    align.tagRight <= align.widgetRight + 0.5,
    `tag=${align.tagRight} widget=${align.widgetRight}`
  )

  console.log('\n【2】普通 $$...$$:同样没有多出来的滚动条')
  await loadDoc(PLAIN_DOC)
  const plain = await mathState()
  check('渲染成一个公式 widget', plain.widget === true, JSON.stringify(plain))
  check(
    '公式块没有横向滚动条',
    plain.widget && plain.scrollWidth - plain.clientWidth <= 1,
    `client=${plain.clientWidth} scroll=${plain.scrollWidth}`
  )

  console.log('\n【3】比编辑区宽的公式:仍然可以横向滚动')
  await loadDoc(WIDE_DOC)
  const wide = await mathState()
  check('渲染成一个公式 widget', wide.widget === true, JSON.stringify(wide))
  check(
    '内容比容器宽(横向滚动仍然有效)',
    wide.widget && wide.scrollWidth - wide.clientWidth > 100,
    `client=${wide.clientWidth} scroll=${wide.scrollWidth}`
  )

  const previewState = (): Promise<PreviewState> =>
    evalJs(`
      (() => {
        const el = document.querySelector('.cm-md-math-preview')
        if (!el) return { preview: false }
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const rectOf = node => {
          if (!node) return null
          const b = node.getBoundingClientRect()
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
        }
        const tag = el.querySelector('.katex-tag')
        return {
          preview: true,
          scrollable: el.classList.contains('cm-md-math-preview-scrollable'),
          pointerEvents: cs.pointerEvents,
          visibility: cs.visibility,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          scrollLeft: el.scrollLeft,
          barThickness: el.offsetHeight - el.clientHeight,
          rect: { left: r.left, top: r.top, bottom: r.bottom, right: r.right },
          baseRect: rectOf(el.querySelector('.katex-base')),
          tagRect: rectOf(tag),
          tagPosition: tag ? getComputedStyle(tag).position : null,
          editorFocused: !!document.activeElement?.classList.contains('cm-content')
        }
      })()`)

  /** 按住预览卡片底部的横向滚动条往右拖(坐标是窗口内容区坐标,与页面一致) */
  async function dragPreviewScrollbar(): Promise<void> {
    const s = await previewState()
    if (!s.rect) return
    const y = s.rect.bottom - Math.max(4, s.barThickness / 2)
    const x = s.rect.left + 40
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(50)
    for (let step = 1; step <= 6; step++) {
      wc.sendInputEvent({ type: 'mouseMove', x: x + step * 12, y, button: 'left' })
      await sleep(20)
    }
    wc.sendInputEvent({ type: 'mouseUp', x: x + 72, y, button: 'left', clickCount: 1 })
    await sleep(200)
  }

  console.log('\n【4】浮动预览:自动编号不压在公式上')
  await loadDoc(TAGGED_DOC, true)
  const tagged = await previewState()
  check('光标在公式内,浮动预览出现', tagged.preview === true, JSON.stringify(tagged))
  check('编号列参与排版(position: static)', tagged.tagPosition === 'static', String(tagged.tagPosition))
  check(
    '编号在公式右侧、留有间隙',
    !!tagged.baseRect &&
      !!tagged.tagRect &&
      tagged.tagRect.left - tagged.baseRect.right >= 4,
    tagged.baseRect && tagged.tagRect
      ? `base 右=${tagged.baseRect.right.toFixed(1)} tag 左=${tagged.tagRect.left.toFixed(1)}`
      : '缺少 base/tag'
  )
  check(
    '编号与公式顶部对齐(逐行位置不变)',
    !!tagged.baseRect && !!tagged.tagRect && Math.abs(tagged.tagRect.top - tagged.baseRect.top) <= 0.5,
    tagged.baseRect && tagged.tagRect
      ? `base 顶=${tagged.baseRect.top.toFixed(1)} tag 顶=${tagged.tagRect.top.toFixed(1)}`
      : '缺少 base/tag'
  )
  check(
    '卡片没有横向滚动条(编号宽度算进了卡片)',
    tagged.preview && tagged.scrollWidth - tagged.clientWidth <= 1,
    `client=${tagged.clientWidth} scroll=${tagged.scrollWidth}`
  )

  console.log('\n【5】浮动预览:超宽公式的滚动条可以拖动')
  await loadDoc(WIDE_DOC, true)
  const before = await previewState()
  check('光标在公式内,浮动预览出现', before.preview === true, JSON.stringify(before))
  check(
    '内容确实超出卡片宽度',
    before.preview && before.scrollWidth - before.clientWidth > 100,
    `client=${before.clientWidth} scroll=${before.scrollWidth}`
  )
  check(
    '溢出时卡片接收指针事件(滚动条才拖得动)',
    before.pointerEvents === 'auto' && before.scrollable === true,
    `pointer-events=${before.pointerEvents} scrollable=${before.scrollable}`
  )
  await dragPreviewScrollbar()
  const after = await previewState()
  check('拖动后横向滚动生效', after.scrollLeft > 0, `scrollLeft=${after.scrollLeft}`)
  check('拖动后编辑器仍然有焦点', after.editorFocused === true, String(after.editorFocused))
  check('拖动后预览仍然可见', after.visibility === 'visible', String(after.visibility))

  console.log('\n【6】浮动预览:窄公式仍然点击穿透')
  await loadDoc(PLAIN_DOC, true)
  const narrow = await previewState()
  check('浮动预览出现', narrow.preview === true, JSON.stringify(narrow))
  check('没有挂 scrollable 类', narrow.scrollable === false, String(narrow.scrollable))
  check(
    '保持 pointer-events:none,不挡编辑区点击',
    narrow.pointerEvents === 'none',
    String(narrow.pointerEvents)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
