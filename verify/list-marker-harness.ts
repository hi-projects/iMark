/**
 * 正文下方直接敲列表符号的观感。
 *
 * 两个毛病:
 *   1. 在正文正下方敲 `-`,CommonMark 把上一行 + 这行解析成 SetextHeading2 ——
 *      上一行先被撑成二级标题(字号突变);用户只是想要一个无序列表。
 *   2. 敲出 `- ` 后仍不渲染(同一个 SetextHeading2),要等补上第一个字、解析
 *      变成 BulletList 才显示圆点。`* ` / `+ ` / `1. ` 则是另一种情况:空的
 *      列表项不能打断段落,整行并进前面的 Paragraph,同样要等文字才渲染。
 *
 * 修法(渲染层,不改文档):
 *   - 单横线的 SetextHeading2 不当标题;只敲 `-` 时按普通正文显示,
 *     `- `(带空格)才交给 HeaderMark 规则画成圆点,与 `* ` / `1. ` 一致;
 *     `--` 及以上仍是正常的下划线。
 *   - 段落续行上「只有标记 + 空格」的行,提前把标记画成列表符号。
 *   - 大纲同步:单横线那行不算标题。
 *
 * 断言:
 *   A 正文下敲 `-`:上一行保持正文字号,`-` 仍是普通文本(还不是列表),大纲里没有标题
 *   B 再补空格(`- `):立刻显示圆点
 *   C 补上正文(`- x`):解析回真正的列表,圆点与正文都不变
 *   D 回归:`--` 仍按 Setext 下划线渲染成二级标题(别把标题功能改坏)
 *   E `* ` / `+ ` 也在输入文字的瞬间显示圆点;单独的 `*` 还不算列表
 *   F `1. ` 立刻显示有序标记,补字后是真正的有序列表
 *   G 空行之后的 `1.` 不渲染,补上空格才显示有序标记
 *   H 回归:空行之后的 `-` 本来就能立即渲染(普通列表不受影响)
 *   I 删除空的有序列表项后不留对齐空格,光标顶格
 *   J 标题前主动留出的空行占完整行高(不被列表后的块间距压扁)
 *   K 列表后第一行正文按上键:光标跳过块间距空行,空行不被撑开
 *
 * 跑法(先 `npm run build`,再在仓库根目录):
 *   xvfb-run -a node verify/run.mjs list-marker
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

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

type LineInfo = {
  text: string
  cls: string
  size: string
  weight: string
  /** 列表标记的文本(无序是 `-`,有序是 `1.`) */
  mark: string
  /** 标记伪元素的 content(只有圆点标记才有) */
  bullet: string
  /** 行盒高度(px):用来断言空行有没有被压成块间距 */
  height: number
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

async function main(): Promise<void> {
  await app.whenReady()

  // 新建/保存对话框一律当成「取消」,验收不弹窗
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
  await writeFile(note, '', 'utf8')
  // 自动保存关掉:断言只关心编辑器里的渲染,不要被后台写盘搅进来
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
        outline: true
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  const domLines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const cs = getComputedStyle(el)
        const b = el.querySelector('.cm-md-listmark-bullet')
        const m = el.querySelector('.cm-md-listmark')
        return {
          text: el.textContent,
          cls: el.className,
          size: cs.fontSize,
          weight: cs.fontWeight,
          mark: m ? m.textContent : '',
          bullet: b ? getComputedStyle(b, '::after').content : '',
          height: Math.round(el.getBoundingClientRect().height * 10) / 10
        }
      })`)

  const outlineItems = (): Promise<{ text: string; level: string }[]> =>
    evalJs(`[...document.querySelectorAll('.outline-list .outline-item')].map(el => ({
      text: el.textContent.trim(),
      level: [...el.classList].find(c => /^outline-h[1-6]$/.test(c)) ?? ''
    }))`)

  const bodySizePx = await evalJs<number>(
    `parseFloat(getComputedStyle(document.querySelector('.cm-scroller')).fontSize)`
  )
  const isBody = (l: LineInfo): boolean =>
    parseFloat(l.size) <= bodySizePx + 0.5 && parseFloat(l.weight) < 600
  const isHeading = (l: LineInfo): boolean =>
    parseFloat(l.size) >= bodySizePx - 0.5 && parseFloat(l.weight) >= 600
  const looks = (l: LineInfo): string => `${JSON.stringify(l.text)} [${l.cls}] ${l.size}/${l.weight} mark=${JSON.stringify(l.mark)}`

  /** sendInputEvent 只认 W3C 旧键名,ArrowLeft 会静默丢掉 */
  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(160)
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  /** 合成输入会偶发整段丢失,落了空就重新聚焦再打一次 */
  async function type(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(240)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return
      if (doc.includes(text[0])) {
        console.log(`    (输入只落了一半:期望 ${JSON.stringify(text)},DOM 里是 ${JSON.stringify(doc)})`)
        return
      }
      console.log(`    (第 ${attempt} 次输入整段没落进去:${JSON.stringify(text)} —— 重新聚焦再打)`)
    }
    console.log(`    (${JSON.stringify(text)} 打了三次都没落进去,后面的断言会跟着歪)`)
  }

  /** 写盘 + 重载窗口:光标回到文首,每次用例都从干净文档开始 */
  async function loadDoc(content: string): Promise<boolean> {
    const lines = content.split('\n').length
    const ready = `document.querySelectorAll('.cm-content .cm-line').length === ${lines}`
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(note, content, 'utf8')
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      if (await waitFor(ready, 6000)) {
        await focusEditor()
        return true
      }
    }
    return false
  }

  const readSource = async (): Promise<string[]> => {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(600)
    const text = await readFile(note, 'utf8')
    const lines = text.split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /**
   * 正文 + 下移一行 + 标记:把「正文正下方敲列表符号」的场景搭出来。
   * 别用回车 —— 回车现在是「新段」,会在两行之间留一条空行,这里要的是
   * 紧挨着上一行的状态(旧文档里很常见,渲染规则仍要守住)。
   */
  async function paragraphThen(marker: string): Promise<void> {
    await loadDoc('阿\n')
    await key('ArrowDown')
    await type(marker)
    // 大纲刷新有 300ms 防抖,等它结算
    await sleep(450)
  }

  // ---------- A ----------
  console.log('\n【A】正文下敲 `-`:上一行不变大,`-` 仍是普通文本')
  await paragraphThen('-')
  {
    const lines = await domLines()
    const [para, marker] = lines
    check('文档里是两行', lines.length === 2, JSON.stringify(lines.map(l => l.text)))
    check('上一行保持正文字号字重(没被撑成二级标题)', !!para && !/cm-md-h[1-6]/.test(para.cls) && isBody(para), para ? looks(para) : '缺行')
    check('`-` 行没被当成标题', !!marker && !/cm-md-h[1-6]/.test(marker.cls), marker ? looks(marker) : '缺行')
    check('只有 `-` 还不算列表(没有圆点、没有列表标记)', !!marker && marker.bullet === '' && marker.mark === '', marker ? looks(marker) : '缺行')
    check('`-` 按正文样式显示', !!marker && isBody(marker), marker ? looks(marker) : '缺行')
    const src = await readSource()
    check('落盘内容没被改(还是 `阿` + `-`)', src.join('|') === '阿|-', JSON.stringify(src))
    const outline = await outlineItems()
    check('大纲里没有凭空多出的二级标题', outline.length === 0, JSON.stringify(outline))
  }

  // ---------- B ----------
  console.log('\n【B】补上空格(`- `):仍然立即渲染,上一行还是正文')
  await paragraphThen('- ')
  {
    const lines = await domLines()
    const [para, marker] = lines
    check('上一行保持正文', !!para && !/cm-md-h[1-6]/.test(para.cls) && isBody(para), para ? looks(para) : '缺行')
    check('`- ` 立刻渲染成圆点', !!marker && marker.bullet === '"•"', marker ? looks(marker) : '缺行')
    const outline = await outlineItems()
    check('大纲里仍没有标题', outline.length === 0, JSON.stringify(outline))
  }

  // ---------- C ----------
  console.log('\n【C】再打一个字(`- x`):解析成真正的列表,观感不变')
  await paragraphThen('- x')
  {
    const lines = await domLines()
    const [para, item] = lines
    check('落盘:`- x`(普通列表)', (await readSource()).join('|') === '阿|- x')
    check('上一行保持正文', !!para && !/cm-md-h[1-6]/.test(para.cls) && isBody(para), para ? looks(para) : '缺行')
    check('列表行仍是圆点', !!item && item.bullet === '"•"', item ? looks(item) : '缺行')
    check('列表行是正文样式(不是标题)', !!item && !/cm-md-h[1-6]/.test(item.cls) && isBody(item), item ? looks(item) : '缺行')
  }

  // ---------- D ----------
  console.log('\n【D】回归:`--` 仍是 Setext 下划线,上一行照常是二级标题')
  await paragraphThen('--')
  {
    const lines = await domLines()
    const [para, underline] = lines
    check('上一行按二级标题渲染', !!para && /cm-md-h2/.test(para.cls) && isHeading(para), para ? looks(para) : '缺行')
    check('下划线不是圆点', !!underline && underline.bullet === '', underline ? looks(underline) : '缺行')
    const outline = await outlineItems()
    check('大纲里是这条标题', outline.length === 1 && outline[0].text === '阿' && outline[0].level === 'outline-h2', JSON.stringify(outline))
  }

  // ---------- E ----------
  console.log('\n【E】`* ` / `+ ` 同样立刻渲染;单独的 `*` 还不算列表')
  await paragraphThen('* ')
  {
    const lines = await domLines()
    const [para, marker] = lines
    check('`* ` 上一行保持正文', !!para && !/cm-md-h[1-6]/.test(para.cls) && isBody(para), para ? looks(para) : '缺行')
    check('`* ` 立刻渲染成圆点', !!marker && marker.bullet === '"•"', marker ? looks(marker) : '缺行')
  }
  await paragraphThen('+ ')
  {
    const marker = (await domLines())[1]
    check('`+ ` 立刻渲染成圆点', !!marker && marker.bullet === '"•"', marker ? looks(marker) : '缺行')
  }
  await paragraphThen('*')
  {
    const lines = await domLines()
    const marker = lines[1]
    check('单独的 `*` 仍是普通文本(没有圆点)', !!marker && marker.bullet === '' && marker.mark === '', marker ? looks(marker) : '缺行')
    check('单独的 `*` 也没把上一行撑成标题', !!lines[0] && !/cm-md-h[1-6]/.test(lines[0].cls) && isBody(lines[0]), lines[0] ? looks(lines[0]) : '缺行')
  }

  // ---------- F ----------
  console.log('\n【F】`1. ` 立刻显示有序标记,补字后是真正的有序列表')
  await paragraphThen('1. ')
  {
    const lines = await domLines()
    const [para, marker] = lines
    check('`1. ` 上一行保持正文', !!para && !/cm-md-h[1-6]/.test(para.cls) && isBody(para), para ? looks(para) : '缺行')
    check('`1. ` 立刻带上列表标记样式', !!marker && marker.mark === '1.', marker ? looks(marker) : '缺行')
    check('有序标记不画圆点', !!marker && marker.bullet === '', marker ? looks(marker) : '缺行')
  }
  await paragraphThen('1. x')
  {
    const lines = await domLines()
    const item = lines[1]
    check('落盘:`1. x`(有序列表)', (await readSource()).join('|') === '阿|1. x')
    check('补字后仍是有序标记', !!item && item.mark === '1.' && item.bullet === '', item ? looks(item) : '缺行')
    check('上一行保持正文', !!lines[0] && !/cm-md-h[1-6]/.test(lines[0].cls) && isBody(lines[0]), lines[0] ? looks(lines[0]) : '缺行')
  }

  // ---------- G ----------
  console.log('\n【G】空行之后的 `1.` 不渲染,补上空格才渲染')
  await loadDoc('')
  await type('1.')
  {
    const line = (await domLines())[0]
    check('单独的 `1.` 仍是普通文本', !!line && line.mark === '', line ? looks(line) : '缺行')
  }
  await type(' ')
  {
    const line = (await domLines())[0]
    check('补上空格后立刻显示有序标记', !!line && line.mark === '1.', line ? looks(line) : '缺行')
  }

  // ---------- H ----------
  console.log('\n【H】回归:空行之后的 `-` 本来就能立即渲染')
  await loadDoc('')
  await type('阿')
  // 新段回车会在下面留一条空行,光标正落在空行下面那行
  await key('Enter')
  await type('-')
  {
    const lines = await domLines()
    const marker = lines[2]
    check('空行后的 `-` 仍是圆点', !!marker && marker.bullet === '"•"', marker ? looks(marker) : '缺行')
  }

  // ---------- I ----------
  console.log('\n【I】删除空的有序列表项后光标顶格')
  await loadDoc('1. 张三\n2. 李四\n3. 王五')
  await key('End', ['control'])
  await key('Enter')
  {
    const lines = await domLines()
    const last = lines[lines.length - 1]
    check('回车续出下一个有序项', !!last && last.text.trim().startsWith('4.'), last ? looks(last) : '缺行')
  }
  await key('Backspace')
  {
    const lines = await domLines()
    const last = lines[lines.length - 1]
    check('空列表项删除后没有残留缩进', !!last && last.text === '', last ? looks(last) : '缺行')
  }

  // ---------- J ----------
  console.log('\n【J】标题前主动留出的空行有完整行高')
  await loadDoc('- 一\n- 二\n# 附录')
  await key('End', ['control'])
  await key('Home')
  await key('Enter')
  {
    const lines = await domLines()
    // 光标停在标题行首,回车 = 新段:标题上面多出「空段」(两条空行),
    // 紧贴标题的那条才是新段落的分隔,不能被列表后的块间距压扁
    const blank = lines[3]
    check('标题前多出新段的空行', lines.length === 5, JSON.stringify(lines.map(l => l.text)))
    check(
      '紧贴标题的空行是完整行高(不是一档块间距)',
      !!blank && blank.height >= bodySizePx * 2 - 1,
      blank ? JSON.stringify(blank) : '缺行'
    )
    check('标题仍在空行之后', !!lines[4] && lines[4].text.includes('附录'), lines[4] ? looks(lines[4]) : '缺行')
  }

  // ---------- K ----------
  console.log('\n【K】列表后的正文按上键:跳过块间距空行')
  await loadDoc('- 啊\n\n啊')
  await key('End', ['control'])
  await key('ArrowUp')
  {
    const selection = await evalJs<{ text: string } | null>(`
      (() => {
        const view = document.querySelector('.cm-content')?.cmTile?.root?.view
        if (!view) return null
        return { text: view.state.doc.lineAt(view.state.selection.main.head).text }
      })()`)
    const lines = await domLines()
    const blank = lines[1]
    check('光标落在列表项上,没有停在空行', selection?.text === '- 啊', JSON.stringify(selection))
    check(
      '空行仍保持收起(没有被光标撑开)',
      !!blank && blank.cls.includes('cm-md-block-gap') && blank.height < bodySizePx * 2 - 1,
      blank ? JSON.stringify(blank) : '缺行'
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
