/**
 * 编辑器回车行为端到端验证:标题不往下带标记,列表 / 引用照旧续。
 *
 * 起因:文件里「### 参数」的下一行看着像继承了三级标题,实际那一行是自己敲的
 * 「#### TARGETS」(或 Ctrl+4),而 WYSIWYG 会把光标不在的那一行的 `####` 藏起来 ——
 * 藏掉标记又保留字号字重,看上去就成了「没有标记却又是标题」。
 *
 * 回车本身从来不带标题:它走 @codemirror/lang-markdown 的 insertNewlineContinueMarkup,
 * 而它只收集 ListItem / Blockquote 节点,ATXHeading 不在其中。这条行为很容易被
 * 「顺手优化」改坏(为让人看清标记而把标题也续上,或者改 keymap 时把列表续标记一起弄丢),
 * 所以钉成断言:
 *   A 标题行尾回车 → 新行是纯正文(源码不带 #,也不该按标题渲染)
 *   B 标题行中间回车 → 照常断成两行,后半段是正文
 *   C 对照组:列表项回车 → 仍旧续出 `- `(别为了标题把列表改坏)
 *   D 对照组:列表 / 引用里的标题回车 → 只续外层的 `- ` / `> `,不续标题
 *   E Ctrl+4 → 才是 h4 的真正来源;顺手复现「标记被藏起来」的观感
 *   F 引用要敲出 `> ` 里的空格才开始渲染:只有 `>` 时按普通文本显示
 *   G 空行敲 ``` 回车 → 自动补一行空行 + 闭合围栏;块后面的正文不再被吞成代码。
 *     回车**之前**下文的渲染也要验:光标还在围栏行上时不能先按代码块染色
 *   G2 带语言 / 引用 / 列表里的围栏,补出来的闭合围栏保持同样形态
 *   G3 下方本来就有一条未闭合围栏时,新敲的围栏也不能和它配对吞掉中间正文
 *   G4 已有代码块的开围栏行尾回车 → 不凭空补闭合围栏(只在刚敲出来的行上生效)
 *
 * 每个用例都重写盘上文件 + 重载窗口:光标必然落在文首(新建 state 的 selection 是 0),
 * 于是只靠「回车 / 打字 / 左移」就能把用例写在头几行上,不用去猜光标在第几行
 * —— 靠 Ctrl+End 定位的版本,光标漂掉以后打出的内容落在别的行上,报了一堆假失败。
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs editor-enter
 */

import { app, dialog, protocol } from 'electron'
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

// 仓库根:打包产物固定落在 <仓库>/out/main/ 下(见文件头),所以由 __dirname 往上两级。
// 截图一类的临时产物都放这儿,别写到家目录去 —— 换个机器就没有了
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

/** 一行 DOM 的观感:文字、类名、字号字重(加起来才分得清「正文」和「长得像正文的标题」) */
type LineInfo = {
  text: string
  cls: string
  size: string
  weight: string
  bullet: string
  bar: string
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
async function main(): Promise<void> {
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
  // 起始文件用「脏」一点的内容:换行 / 空行 / 各档标记都在,顺带看住它们不被回车改样
  await writeFile(note, '开头占位\n\n# 标题\n\n正文段落\n', 'utf8')
  // 自动保存关掉:这一轮按回车就数行,不想被后台写盘搅进来
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
        return {
          text: el.textContent,
          cls: el.className,
          size: cs.fontSize,
          weight: cs.fontWeight,
          bullet: b ? getComputedStyle(b, '::after').content : '',
          // 引用竖线现在是 .cm-md-quote::before(行本身不能有 padding,见 editor.css);
          // 非引用行的伪元素 content 为 none
          bar: (() => {
            const before = getComputedStyle(el, '::before')
            if (before.content === 'none' || before.width === '0px') return 'none'
            return before.backgroundImage !== 'none' ? before.backgroundImage : before.backgroundColor
          })()
        }
      })`)

  /*
   * 正文 / 标题的分界:标题一定更大更粗(标题 600 字重,正文 400)。
   * 正文字号别写死 —— 它就是设置里的值(见 tokens.css 的 --editor-body-size);
   * 从实际渲染里读,断言才不会跟着一起过期。
   */
  const bodySizePx = await evalJs<number>(
    `parseFloat(getComputedStyle(document.querySelector('.cm-scroller')).fontSize)`
  )
  const isBody = (l: LineInfo): boolean =>
    parseFloat(l.size) <= bodySizePx + 0.5 && parseFloat(l.weight) < 600
  /** 标题:600 字重,且不比正文小(H4–H6 与正文同档,靠字重区分) */
  const isHeading = (l: LineInfo): boolean =>
    parseFloat(l.size) >= bodySizePx - 0.5 && parseFloat(l.weight) >= 600
  const looks = (l: LineInfo): string => `${JSON.stringify(l.text)} [${l.cls}] ${l.size}/${l.weight}`

  /**
   * 注意命名:sendInputEvent 要的是 W3C 旧键名(`Left` / `Down` / `End`),
   * 写成 `ArrowLeft` / `ArrowDown` 它一声不吭地丢掉 —— 光标不动,断言就全歪了。
   */
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

  /** 窗口失焦时注入的输入会被静默丢掉,先确保窗口在前、编辑器拿着焦点 */
  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  /**
   * 打字必须自检:合成输入偶尔整段丢(窗口/编辑器失焦时尤其),而丢了以后
   * 报出来的是一堆看着像产品 bug 的断言失败。落空了就重新聚焦再打一次。
   */
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
      if (!doc.includes(text[0])) {
        console.log(`    (第 ${attempt} 次输入整段没落进去:${JSON.stringify(text)} —— 重新聚焦再打)`)
        continue
      }
      console.log(`    (输入只落了一半:期望 ${JSON.stringify(text)},DOM 里是 ${JSON.stringify(doc)})`)
      return
    }
    console.log(`    (${JSON.stringify(text)} 打了三次都没落进去,后面的断言会跟着歪)`)
  }

  /**
   * 写盘 + 重载窗口,拿到一个光标在文首的干净编辑器。
   *
   * 重载之后必须验一下页面里装的确实是刚写的那份:如果重载没有真正发生、
   * 编辑器里还是上一份文档,按键就会落在别的行上,后面每一条断言都会报成假失败 ——
   * 所以这里等 DOM 行数对上了才继续,不对就再重载一次并摊开证据。
   */
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
      const dom = (await domLines()).map(l => l.text)
      console.log(`    (第 ${attempt} 次载入没等到:DOM ${JSON.stringify(dom)}`)
      console.log(`     盘上:${JSON.stringify(await readFile(note, 'utf8'))})`)
    }
    return false
  }

  const readSource = async (): Promise<string[]> => {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(600)
    const text = await readFile(note, 'utf8')
    const lines = text.split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop() // 尾换行不算一行
    return lines
  }

  /**
   * 起始文档故意以空行开头:重载后光标在 position 0,也就是这个空行的行首,
   * 打字就直接落在第 1 行上,不用按键去挪光标。
   * (别用「文首按回车开空行」那招 —— 光标停在原处,即下一行的行首,不是新空行的行首。)
   */
  const START = '\n# 标题\n\n正文段落\n'
  const TAIL = ['# 标题', '', '正文段落']

  console.log('\n【A】光标停在 `### 参数` 行尾,回车后敲 TARGETS —— 新行该是正文')
  await loadDoc(START)
  await type('### 参数')
  await key('Enter')
  await type('TARGETS')
  {
    const src = await readSource()
    check('第 1 行是手写的 `### 参数`', src[0] === '### 参数', JSON.stringify(src.slice(0, 2)))
    check('第 2 行是裸正文,回车没把 `### ` 带下来', src[1] === 'TARGETS', JSON.stringify(src.slice(0, 2)))
    check('后面原有内容没被动过', src.slice(2).join('|') === TAIL.join('|'), JSON.stringify(src.slice(2)))

    const [head, body] = await domLines()
    check('第 1 行仍按三级标题渲染', /cm-md-h3/.test(head.cls) && isHeading(head), looks(head))
    check('第 2 行不是标题(无 cm-md-hN)', !/cm-md-h[1-6]/.test(body.cls), looks(body))
    check('第 2 行按正文字号字重渲染', isBody(body), looks(body))
  }

  console.log('\n【B】光标停在 `### 参数` 中间,回车 —— 断成两行,后半段是正文')
  await loadDoc(START)
  await type('### 参数')
  await key('ArrowLeft') // 光标挪到「参」和「数」之间
  await key('Enter')
  {
    const src = await readSource()
    check('落盘:前半段留标记,后半段是裸文本', src.slice(0, 2).join('|') === '### 参|数', JSON.stringify(src.slice(0, 2)))
    check('后面原有内容没被动过', src.slice(2).join('|') === TAIL.join('|'), JSON.stringify(src.slice(2)))

    const [head, body] = await domLines()
    check('前半段还是三级标题', /cm-md-h3/.test(head.cls), looks(head))
    check('后半段是正文', !/cm-md-h[1-6]/.test(body.cls) && isBody(body), looks(body))
  }

  console.log('\n【C】对照组:列表项回车仍续 `- `(别为了标题把列表改坏)')
  await loadDoc(START)
  await type('- 第一项')
  await key('Enter')
  await type('第二项')
  {
    const src = await readSource()
    check('落盘:第二行自动带上 `- `', src.slice(0, 2).join('|') === '- 第一项|- 第二项', JSON.stringify(src.slice(0, 2)))

    const [first, second] = await domLines()
    check(
      '两行都按列表渲染(圆点是画的,不是 `- `)',
      second.bullet === '"•"' && first.bullet === '"•"',
      JSON.stringify([first.bullet, second.bullet])
    )
    check('列表行没有被当成标题', !/cm-md-h[1-6]/.test(second.cls) && isBody(second), looks(second))
  }

  console.log('\n【D】对照组:列表 / 引用里的标题,回车只续外层标记')
  await loadDoc(START)
  await type('- ### 参数')
  await key('Enter')
  {
    const src = await readSource()
    check('列表里的标题:续出的是 `- `,不是 `- ### `', src.slice(0, 2).join('|') === '- ### 参数|- ', JSON.stringify(src.slice(0, 2)))
  }

  await loadDoc(START)
  await type('> ### 参数')
  await key('Enter')
  {
    const src = await readSource()
    check('引用里的标题:续出的是 `> `,不是 `> ### `', src.slice(0, 2).join('|') === '> ### 参数|> ', JSON.stringify(src.slice(0, 2)))

    const head = (await domLines())[0]
    check('引用里的标题行仍按标题渲染', /cm-md-h3/.test(head.cls) && isHeading(head), looks(head))
    // 回归:节点名是 lezer 的 `Blockquote`(小写 q)。写成 `BlockQuote` 时这条规则
    // 永不命中 —— 标记被藏掉、引用条也不画,整行看起来就是普通正文。
    check(
      '引用行带 cm-md-quote,引用竖线真的画出来',
      /cm-md-quote/.test(head.cls) && head.bar !== 'none',
      `${looks(head)} bar=${head.bar}`
    )
  }

  console.log('\n【E】h4 的真正来源是 Ctrl+4 —— 顺便复现「#### 藏起来、只剩加大加粗」')
  await loadDoc(START)
  await type('TARGETS')
  await key('4', ['control'])
  {
    const src = await readSource()
    check('落盘:`Ctrl+4` 写的就是 `#### `', src[0] === '#### TARGETS', JSON.stringify(src.slice(0, 1)))

    // 光标还在这行上:标记该是显形的(源码所见即所得)
    const onCaret = (await domLines())[0]
    check('光标在行上时 `####` 是显形的', onCaret.text === '#### TARGETS', looks(onCaret))
    check('这一行按 h4 渲染(比 h3 小一档)', /cm-md-h4/.test(onCaret.cls) && isHeading(onCaret), looks(onCaret))

    // 光标一离开,标记就被藏起来 —— 用户看到的就是这个样子
    await key('ArrowDown')
    const away = (await domLines())[0]
    check('光标移走后 `####` 被藏起来,只剩加粗大字', away.text === 'TARGETS', looks(away))
    check('藏起来不等于降级:class 还是 h4、字号字重照旧', /cm-md-h4/.test(away.cls) && isHeading(away), looks(away))
  }

  console.log('\n【F】引用要敲出 `> ` 里的空格才开始渲染')
  await loadDoc(START)
  await type('>')
  {
    const plain = (await domLines())[0]
    check(
      '只有 `>` 时按普通文本显示(无引用条、无引用行样式)',
      plain.text === '>' && !/cm-md-quote/.test(plain.cls) && plain.bar === 'none',
      looks(plain)
    )
  }
  await type(' ')
  {
    const quoted = (await domLines())[0]
    check('补上空格后按引用渲染', /cm-md-quote/.test(quoted.cls) && quoted.bar !== 'none', looks(quoted))
  }

  console.log('\n【G】空行敲 ``` 回车 —— 自动补空行 + 闭合围栏,后面的正文不变成代码')
  await loadDoc(START)
  await type('```')
  {
    const before = await domLines()
    check(
      '回车前下面的正文不按代码块渲染(不提前染色)',
      before.every(l => !/cm-md-code/.test(l.cls)),
      before.map(l => `${JSON.stringify(l.text)} [${l.cls}]`).join(' | ')
    )
    check('围栏行本身仍是原文', before[0].text === '```', looks(before[0]))
  }
  await key('Enter')
  {
    const src = await readSource()
    check('开围栏下一行是空行(光标落点)', src[1] === '', JSON.stringify(src.slice(0, 3)))
    check('空行下面是自动补的闭合围栏', src[2] === '```', JSON.stringify(src.slice(0, 3)))
    check('后面的正文仍在代码块之外', src.slice(3).join('|') === TAIL.join('|'), JSON.stringify(src.slice(3)))

    // 光标就在中间那行:直接打字应该写进代码块,不会跑到围栏外面
    await type('const a = 1')
    const typed = await readSource()
    check('中间空行可以直接写代码', typed[1] === 'const a = 1', JSON.stringify(typed.slice(0, 3)))
    check('闭合围栏没有被挤走', typed[2] === '```' && typed.slice(3).join('|') === TAIL.join('|'), JSON.stringify(typed.slice(2)))
    const lines = await domLines()
    check(
      '三行都按代码块渲染',
      lines.slice(0, 3).every(l => /cm-md-code/.test(l.cls)),
      lines.slice(0, 3).map(l => `${JSON.stringify(l.text)} [${l.cls}]`).join(' | ')
    )
    check(
      '下面的标题恢复成标题渲染,没有留在代码块里',
      /cm-md-h1/.test(lines[3].cls) && !/cm-md-code/.test(lines[3].cls),
      looks(lines[3])
    )
  }

  console.log('\n【G2】围栏带语言 / 在引用和列表里 —— 闭合围栏形态跟着开围栏走')
  await loadDoc('\n正文\n')
  await type('```js')
  await key('Enter')
  {
    const src = await readSource()
    check('```js 回车补的是 ```', src.slice(0, 3).join('|') === '```js||```', JSON.stringify(src.slice(0, 3)))
    check('正文仍在块外', src[3] === '正文', JSON.stringify(src.slice(3)))
  }

  await loadDoc('\n正文\n')
  await type('> ```')
  await key('Enter')
  {
    const src = await readSource()
    check('引用里的围栏:空行和闭合围栏都留在引用里', src.slice(0, 3).join('|') === '> ```|> |> ```', JSON.stringify(src.slice(0, 3)))
    check('正文仍在块外', src[3] === '正文', JSON.stringify(src.slice(3)))
  }

  await loadDoc('\n正文\n')
  await type('- ```')
  await key('Enter')
  {
    const src = await readSource()
    check('列表里的围栏:空行和闭合围栏按内容列缩进', src.slice(0, 3).join('|') === '- ```|  |  ```', JSON.stringify(src.slice(0, 3)))
    check('正文仍在块外', src[3] === '正文', JSON.stringify(src.slice(3)))
  }

  console.log('\n【G3】下方本来就有一条未闭合围栏 —— 新敲的围栏不能和它配成一对')
  // 复现真实笔记:文末还留着一条没写完的围栏。在文首敲 ``` 时,新围栏会和
  // 下面那条配成"已闭合"的代码块,整段正文被读成代码 —— 只看语法树会误判。
  await loadDoc('\n正文\n\n```\n旧的未闭合代码\n')
  await type('```')
  {
    const before = await domLines()
    check(
      '回车前整段仍不按代码块渲染',
      before.every(l => !/cm-md-code/.test(l.cls)),
      before.map(l => `${JSON.stringify(l.text)} [${l.cls}]`).join(' | ')
    )
  }
  await key('Enter')
  {
    const src = await readSource()
    check('新围栏先自己闭合', src.slice(0, 3).join('|') === '```||```', JSON.stringify(src.slice(0, 3)))
    check(
      '中间正文和下方旧围栏原样保留',
      src.slice(3).join('|') === '正文||```|旧的未闭合代码',
      JSON.stringify(src.slice(3))
    )
  }

  console.log('\n【G4】已有代码块的开围栏行尾回车 —— 不凭空补闭合围栏')
  // 光标在文首 = 开围栏行首;End 到行尾再回车。这一行不是"刚敲出来"的,
  // 应当只是普通断行(行尾回车等价于在行尾加一个换行),不能把块提前闭合。
  await loadDoc('```js\ncode\n```\n')
  await key('End')
  await key('Enter')
  {
    const src = await readSource()
    check('只是在开围栏后断了一行', src.slice(0, 4).join('|') === '```js||code|```', JSON.stringify(src.slice(0, 4)))
    check('围栏数量没变', src.filter(l => l === '```').length === 1, JSON.stringify(src))
  }

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  // capturePage 偶发 UnknownVizError(见 verify 记忆):截图是观感产物,不能因此把全绿判成失败
  try {
    await writeFile(join(shots, 'editor-enter.png'), (await wc.capturePage()).toPNG())
  } catch (err) {
    console.warn(`[verify] 截图失败(不影响断言):${err instanceof Error ? err.message : String(err)}`)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
