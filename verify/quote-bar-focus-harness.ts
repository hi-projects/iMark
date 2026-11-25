/**
 * 回归:引用行距调小(尤其 0 档)时,光标在两行引用之间切换,竖线长度与
 * 文字位置不能变化。
 *
 * 背景:标记 `>` 在「有光标」时以源码态显示、没光标时隐藏。隐藏如果靠
 * CodeMirror 的 replace 零宽 widget 或一个不参与行高的空 inline 盒,在
 * line-height < 字号时行盒高度会随标记显隐变化 —— 竖线跟着变长/变短,
 * 文字也上下跳。
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs quote-bar-focus
 */

import { app, BrowserWindow, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'
import { APP_VERSION } from './appVersion'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

interface LineGeometry {
  top: number
  height: number
  textTop: number
  textBottom: number
  barTop: number
  barHeight: number
}

async function main(): Promise<void> {
  await app.whenReady()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '引用.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  const emptySecond = process.env.EMPTY === '1'
  await writeFile(
    note,
    emptySecond ? ['> 引用一', '> ', ''].join('\n') : ['> 引用一', '> 引用二', ''].join('\n'),
    'utf8'
  )
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off',
        lineWrapping: true,
        editorFontSize: 16,
        editorFontSizeVersion: 2,
        quoteLineSpace: Number(process.env.QLS ?? '0')
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
  win.setContentSize(1000, 800)
  const wc = win.webContents
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(1500)

  const setSel = async (anchor: number): Promise<void> => {
    await wc.executeJavaScript(
      `(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        v.dispatch({ selection: { anchor: ${anchor} } })
        v.focus()
        return true
      })()`,
      true
    )
    await sleep(400)
  }

  const snap = () =>
    wc.executeJavaScript(
      `(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        return {
          head: v.state.selection.main.head,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const r = el.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(el)
            const t = range.getBoundingClientRect()
            const before = getComputedStyle(el, '::before')
            return {
              text: el.textContent,
              top: r.top,
              height: r.height,
              textTop: t.top,
              textBottom: t.bottom,
              barTop: parseFloat(before.top || '0'),
              barHeight: parseFloat(before.height || '0')
            }
          })
        }
      })()`,
      true
    ) as Promise<{ head: number; lines: (LineGeometry & { text: string })[] }>

  // 文档:"> 引用一\n> 引用二\n"。第一行内、第二行内各放一次光标,
  // 让标记分别在两行显形;两次的行几何必须一致。
  await setSel(4)
  const onFirst = await snap()
  await setSel(emptySecond ? 6 : 10)
  const onSecond = await snap()

  console.log(`\n【QLS=${process.env.QLS ?? '0'}】`)
  console.log(`  光标在第一行:${JSON.stringify(onFirst.lines.slice(0, 2))}`)
  console.log(`  光标在第二行:${JSON.stringify(onSecond.lines.slice(0, 2))}`)

  check('两行引用都画了竖线', onFirst.lines.filter(l => l.barHeight > 0).length === 2)
  const same = onFirst.lines.slice(0, 2).every((line, i) => {
    const other = onSecond.lines[i]!
    // 空的引用续行只有 `>` 可量:标记显隐本来就会改变这段文本的范围,
    // 行盒与竖线才是要稳定的东西。
    const checkText = !emptySecond || i === 0
    return (
      Math.abs(line.top - other.top) < 0.6 &&
      Math.abs(line.height - other.height) < 0.6 &&
      (!checkText ||
        (Math.abs(line.textTop - other.textTop) < 0.6 &&
          Math.abs(line.textBottom - other.textBottom) < 0.6)) &&
      Math.abs(line.barTop - other.barTop) < 0.6 &&
      Math.abs(line.barHeight - other.barHeight) < 0.6
    )
  })
  check('切换光标不会改变引用行的位置 / 高度 / 文字 / 竖线', same)

  console.log(`\n${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
