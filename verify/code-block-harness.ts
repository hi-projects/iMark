/**
 * 代码块外观验收:左侧留白 + 右上角复制按钮。
 *
 * 验的是 WYSIWYG 装饰层里 `case 'FencedCode'` / `case 'CodeBlock'` 这一轮改动:
 *
 *  · 代码正文不能紧贴代码块左边缘(色块左缘仍占满正文栏,文字退开 1.25em);
 *  · 每个代码块首行右上角有一个复制按钮;
 *  · 点按钮复制的是**去掉围栏标记与末尾换行**的正文,且不改动文档、不移动光标;
 *  · 按钮给出「已复制」反馈,过一会儿自己变回「复制」;
 *  · 缩进代码块(没有围栏)也能复制;
 *  · 左缘留白不能把整行选区带偏(用 Ctrl+A 量选区矩形左缘);
 *  · 代码块里选中多行时,除第一行外,左边那 1.25em 留白不能被选区染色
 *    (drawSelection 画整行选区只认 content 左缘,那一截要靠伪元素盖回去)。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   node verify/run.mjs code-block
 *
 * 设置里把软换行关掉再跑:不换行时 .cm-line 仍只有正文栏那么宽(长代码从行尾
 * 溢出),按钮靠 right 定位就停在这条可视右缘上;换行开启时行宽同理。关掉换行
 * 是为了顺带量「超长行」这一路,两条路都不会让按钮跑出编辑区。
 */

import { app, dialog, protocol, type BrowserWindow, type NativeImage } from 'electron'
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
const REPO = join(__dirname, '..', '..')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const FENCED = ['```python', 'import torch', '', 'x = 1', '```'].join('\n')
const INDENTED = ['    indented line', '    second'].join('\n')
const DOC = `# 代码块验收\n\n${FENCED}\n\n普通段落\n\n${INDENTED}\n\n末尾\n`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs code-block` 跑会自动带上)')
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
  const note = join(vault, '代码块.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })

  await writeFile(note, DOC, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false,
        lineWrapping: false
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
  wc.on('console-message', (_event, ...args: unknown[]) => {
    const first = args[0]
    if (first && typeof first === 'object') {
      const details = first as { level?: string; message?: string }
      if (details.level !== 'debug') console.log(`[renderer:${details.level}] ${details.message}`)
    } else if (typeof args[1] === 'string') {
      console.log(`[renderer:${String(first)}] ${args[1]}`)
    }
  })
  wc.on('render-process-gone', (_event, details) => console.log('[render-process-gone]', details))
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  /**
   * capturePage 偶发 UnknownVizError(见 verify 记忆)。像素取样需要一张图,
   * 所以这里重试几次;截图本身只是观感产物,不该让整轮验收崩掉。
   */
  async function capture(): Promise<Electron.NativeImage | null> {
    for (let i = 0; i < 5; i++) {
      try {
        return await wc.capturePage()
      } catch {
        await sleep(200)
      }
    }
    return null
  }

  async function captureShot(): Promise<NativeImage> {
    const image = await capture()
    if (!image) throw new Error('截图不可用')
    return image
  }

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

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
    await sleep(140)
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(900)
    await focusEditor()
  }

  await focusEditor()

  // ---------- 1. 左侧留白 ----------

  console.log('\n【1】代码正文从色块左缘退开,色块本身仍占满正文栏')
  const geometry = await evalJs<{
    lines: number
    insets: number[]
    lineLeft: number
    contentLeft: number
    borderLeft: string
  }>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line.cm-md-code')]
      const insets = lines.map(line => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        const text = walker.nextNode()
        if (!text || !text.textContent.trim()) return -1
        const range = document.createRange()
        range.selectNodeContents(text)
        return Math.round((range.getBoundingClientRect().left - line.getBoundingClientRect().left) * 100) / 100
      }).filter(v => v >= 0)
      const first = lines[0]
      return {
        lines: lines.length,
        insets,
        lineLeft: Math.round(first.getBoundingClientRect().left),
        contentLeft: Math.round(document.querySelector('.cm-content').getBoundingClientRect().left),
        borderLeft: getComputedStyle(first).borderLeftWidth
      }
    })()`)
  check('两个代码块(围栏 5 行 + 缩进 2 行)的 7 行都有代码样式', geometry.lines === 7, String(geometry.lines))
  check(
    '代码文字离色块左缘至少 10px',
    geometry.insets.length > 0 && geometry.insets.every(v => v >= 10),
    JSON.stringify(geometry.insets)
  )
  check(
    '色块左缘仍与正文栏左缘对齐(留白画在块内)',
    Math.abs(geometry.lineLeft - geometry.contentLeft) <= 1,
    `${geometry.lineLeft} vs ${geometry.contentLeft}`
  )
  check('留白来自 border-left', parseFloat(geometry.borderLeft) >= 10, geometry.borderLeft)

  // ---------- 2. 复制按钮 ----------

  console.log('\n【2】每个代码块首行右上角都有复制按钮')
  await evalJs(`
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.__copied = text } }
    })
    window.__copied = null
    true`)
  const buttons = await evalJs<
    { count: number; firstLine: string; sameLine: boolean; rightGap: number; topGap: number; inRightHalf: boolean }[]
  >(`
    (() => {
      const buttons = [...document.querySelectorAll('.cm-md-code-copy')]
      return buttons.map(btn => {
        const line = btn.closest('.cm-line')
        const lr = line.getBoundingClientRect()
        const br = btn.getBoundingClientRect()
        return {
          count: buttons.length,
          firstLine: line.textContent.trim(),
          sameLine: !!line && line.className.includes('cm-md-code'),
          rightGap: Math.round(lr.right - br.right),
          topGap: Math.round(br.top - lr.top),
          inRightHalf: br.left > lr.left + lr.width / 2
        }
      })
    })()`)
  check('两个代码块各有一个复制按钮', buttons.length === 2 && buttons[0].count === 2, String(buttons.length))
  check('按钮挂在代码行上', buttons.every(b => b.sameLine))
  check('按钮位于行的右半侧', buttons.every(b => b.inRightHalf))
  check(
    '按钮贴在行右上角(右边距 / 上边距都很小)',
    buttons.every(b => b.rightGap >= 0 && b.rightGap <= 16 && b.topGap >= 0 && b.topGap <= 12),
    JSON.stringify(buttons.map(b => ({ r: b.rightGap, t: b.topGap })))
  )

  // ---------- 3. 点按钮 → 复制正文 ----------

  console.log('\n【3】点击复制:正文正确、文档不变、光标不动、有反馈')
  // 取正文时把按钮本身摘掉(它会显示「已复制」,不能把它当成文档内容)
  const textFromDom = (): Promise<string> => evalJs<string>(`
    (() => {
      const c = document.querySelector('.cm-content').cloneNode(true)
      c.querySelectorAll('.cm-md-code-copy').forEach(b => b.remove())
      return c.textContent
    })()`)
  const textBefore = await textFromDom()
  const spot = await evalJs<{ x: number; y: number }>(`
    (() => {
      const r = document.querySelector('.cm-md-code-copy').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await sleep(300)
  const copied = await evalJs<string | null>(`window.__copied`)
  check('复制到的正文不含围栏标记', copied === 'import torch\n\nx = 1', JSON.stringify(copied))
  check('复制完文档没有被改动', (await textFromDom()) === textBefore)
  check(
    '按钮给出「copied」反馈',
    (await evalJs<string>(`document.querySelector('.cm-md-code-copy').textContent`)) === 'copied'
  )
  await sleep(1700)
  check(
    '反馈过一会儿自己复原',
    (await evalJs<string>(`document.querySelector('.cm-md-code-copy').textContent`)) === 'copy'
  )

  // ---------- 4. 缩进代码块 ----------

  console.log('\n【4】缩进代码块也能复制(第二次点击第二个按钮)')
  await evalJs(`window.__copied = null; true`)
  const spot2 = await evalJs<{ x: number; y: number }>(`
    (() => {
      const buttons = [...document.querySelectorAll('.cm-md-code-copy')]
      const r = buttons[buttons.length - 1].getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  wc.sendInputEvent({ type: 'mouseDown', x: spot2.x, y: spot2.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: spot2.x, y: spot2.y, button: 'left', clickCount: 1 })
  await sleep(300)
  check(
    '缩进代码块复制出的是去掉 4 空格缩进的正文',
    (await evalJs<string | null>(`window.__copied`)) === 'indented line\nsecond',
    JSON.stringify(await evalJs<string | null>(`window.__copied`))
  )

  // ---------- 5. 整行选区没有被左缘留白带偏 ----------

  console.log('\n【5】Ctrl+A 全选时,选区左缘仍贴着正文栏左缘')
  await focusEditor()
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
  await sleep(400)
  const selectionLeft = await evalJs<{ marker: number; line: number }>(`
    (() => {
      const marker = document.querySelector('.cm-selectionBackground')?.getBoundingClientRect().left ?? -1
      const line = document.querySelector('.cm-line').getBoundingClientRect().left
      return { marker: Math.round(marker), line: Math.round(line) }
    })()`)
  check(
    '选区左缘与正文栏左缘相差不超过 1px',
    selectionLeft.marker >= 0 && Math.abs(selectionLeft.marker - selectionLeft.line) <= 1,
    JSON.stringify(selectionLeft)
  )

  // ---------- 6. 代码块内不画行首「+」 ----------

  console.log('\n【6】光标在代码块里时左边不出现「+」,回到段落又出现')
  await focusEditor()
  await key('Home', ['control'])
  await key('ArrowDown')
  await key('ArrowDown') // 第 3 行 = 围栏行
  const plusOnFence = await evalJs<number>(`document.querySelectorAll('.line-plus').length`)
  check('围栏行上不画「+」', plusOnFence === 0, String(plusOnFence))
  await key('ArrowDown') // 第 4 行 = 围栏内的代码
  const plusInFence = await evalJs<number>(`document.querySelectorAll('.line-plus').length`)
  check('围栏内的代码行上不画「+」', plusInFence === 0, String(plusInFence))
  await key('Home', ['control'])
  for (let i = 0; i < 8; i++) await key('ArrowDown') // 第 9 行 = 普通段落
  const plusOnParagraph = await evalJs<number>(`document.querySelectorAll('.line-plus').length`)
  check('普通段落上「+」仍然出现', plusOnParagraph === 1, String(plusOnParagraph))
  for (let i = 0; i < 2; i++) await key('ArrowDown') // 第 11 行 = 缩进代码
  const plusInIndented = await evalJs<number>(`document.querySelectorAll('.line-plus').length`)
  check('缩进代码行上也不画「+」', plusInIndented === 0, String(plusInIndented))

  // ---------- 7. 不换行 + 超长行:按钮不能跑到可视区外 ----------

  console.log('\n【7】关闭自动换行、代码行超长时,按钮仍在可视区右上角')
  await loadDoc(`# 长行\n\n\`\`\`ts\n${'const value = 1234567890; '.repeat(40)}\n\`\`\`\n\n末尾\n`)
  const longGeo = await evalJs<{
    lineWidth: number
    contentWidth: number
    scrollerWidth: number
    buttonRight: number
    scrollerRight: number
    visible: boolean
  }>(`
    (() => {
      const line = document.querySelector('.cm-line.cm-md-code').getBoundingClientRect()
      const content = document.querySelector('.cm-content').getBoundingClientRect()
      const scroller = document.querySelector('.cm-scroller').getBoundingClientRect()
      const btn = document.querySelector('.cm-md-code-copy').getBoundingClientRect()
      return {
        lineWidth: Math.round(line.width),
        contentWidth: Math.round(content.width),
        scrollerWidth: Math.round(scroller.width),
        buttonRight: Math.round(btn.right),
        scrollerRight: Math.round(scroller.right),
        visible: btn.right <= scroller.right && btn.left >= scroller.left
      }
    })()`)
  console.log(`    (几何: ${JSON.stringify(longGeo)})`)
  check('超长行时复制按钮仍在编辑区可视范围内', longGeo.visible)

  // ---------- 8. 多行选中:留白不被选区染色 ----------

  console.log('\n【8】代码块里选中多行时,除第一行外的左边留白不显示选区底色')
  await loadDoc(DOC)
  await focusEditor()
  await key('Home', ['control'])
  await key('ArrowDown')
  await key('ArrowDown')
  await key('ArrowDown') // 第 4 行 = import torch
  await key('Home')
  await key('ArrowDown', ['shift'])
  await key('ArrowDown', ['shift']) // 选到第 6 行行首
  await key('End', ['shift']) // 再选到第 6 行行尾
  await sleep(200)

  const selGeo = await evalJs<{
    border: number
    blank: { left: number; top: number; height: number }
    markers: number
    unselected: { left: number; top: number; height: number }
    before: { content: string; left: string; width: string; zIndex: string }
  }>(`
    (() => {
      const codeLines = [...document.querySelectorAll('.cm-line.cm-md-code')]
      // DOC 里第 5 行是围栏内的空行(整行都落在选区中段),第 11 行是没被选中的缩进代码
      const blank = codeLines[2].getBoundingClientRect()
      const unselected = codeLines[5].getBoundingClientRect()
      const first = codeLines[0]
      const cs = getComputedStyle(first, '::before')
      return {
        border: parseFloat(getComputedStyle(first).borderLeftWidth),
        blank: { left: blank.left, top: blank.top, height: blank.height },
        markers: document.querySelectorAll('.cm-selectionBackground').length,
        unselected: { left: unselected.left, top: unselected.top, height: unselected.height },
        before: { content: cs.content, left: cs.left, width: cs.width, zIndex: cs.zIndex }
      }
    })()`)
  check('多行选区已经建立(至少 2 块选区矩形)', selGeo.markers >= 2, String(selGeo.markers))
  check(
    '代码行左缘有盖住留白的伪元素(z-index 高于选区图层)',
    selGeo.before.content !== 'none' &&
      selGeo.before.zIndex === '1' &&
      parseFloat(selGeo.before.width) >= 10 &&
      parseFloat(selGeo.before.left) <= -10,
    JSON.stringify(selGeo.before)
  )

  // 像素级检查:同一水平位置,选中空行(围栏内)的留白应和未选中代码行的留白同色;
  // 而选区本身的颜色必须明显不同,否则这条检查会因为根本没选中而假通过。
  const shot = await capture()
  if (!shot) {
    console.log('  (截图不可用,跳过像素级取样)')
  } else {
    const viewport = await evalJs<{ w: number; h: number }>(`({ w: innerWidth, h: innerHeight })`)
    const bitmap = shot.toBitmap()
    const imgSize = shot.getSize()
    const scale = imgSize.width / viewport.w
    const pixel = (x: number, y: number): [number, number, number] => {
      const i = (Math.round(y * scale) * imgSize.width + Math.round(x * scale)) * 4
      return [bitmap[i + 2], bitmap[i + 1], bitmap[i]] // BGRA
    }
    const dist = (a: number[], b: number[]): number =>
      Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
    const probeX = Math.round(selGeo.border / 2)
    const stripY = Math.round(selGeo.blank.top + selGeo.blank.height / 2)
    const plainY = Math.round(selGeo.unselected.top + selGeo.unselected.height / 2)
    const stripColor = pixel(selGeo.blank.left + probeX, stripY)
    const plainColor = pixel(selGeo.unselected.left + probeX, plainY)
    const insideColor = pixel(selGeo.blank.left + selGeo.border + 60, stripY)
    console.log(
      `    (取样: 选中行留白 ${stripColor}, 未选中行留白 ${plainColor}, 选区内部 ${insideColor})`
    )
    check(
      '选中行左边的留白与未选中代码行同色(没有被选区染色)',
      dist(stripColor, plainColor) <= 6,
      `${stripColor} vs ${plainColor}`
    )
    check(
      '同一行的选区内部确实是选区色(取样点有效)',
      dist(insideColor, plainColor) >= 15,
      `${insideColor} vs ${plainColor}`
    )
  }

  const selShots = join(REPO, '.verify-ud', 'shots')
  await mkdir(selShots, { recursive: true })
  try {
    await writeFile(join(selShots, 'code-block-selection.png'), (await captureShot()).toPNG())
    await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true })()`)
    await sleep(400)
    await writeFile(
      join(selShots, 'code-block-selection-dark.png'),
      (await captureShot()).toPNG()
    )
    await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true })()`)
    await sleep(200)
  } catch (err) {
    console.log('  (截图跳过:', err instanceof Error ? err.message : String(err), ')')
  }

  // ---------- 截图 ----------

  await loadDoc(DOC)
  await evalJs(`(() => { document.querySelector('.cm-scroller').scrollTop = 0; return true })()`)
  await sleep(300)
  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  try {
    await writeFile(join(shots, 'code-block.png'), (await captureShot()).toPNG())
    await evalJs(`(() => { document.documentElement.dataset.theme = 'dark'; return true })()`)
    await sleep(400)
    await writeFile(join(shots, 'code-block-dark.png'), (await captureShot()).toPNG())
    await evalJs(`(() => { document.documentElement.dataset.theme = 'light'; return true })()`)
  } catch (err) {
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
