/**
 * 回归:引用里回车后,在新行输入第一个字,行位置不能跳。
 *
 * 复现步骤:
 *   1. 输入 `> ` + 阿,回车;
 *   2. 在新行输入阿 —— 第二行是否移动。
 *
 * 根因:只写了 `>` 的续行在源码上是空行,曾被当成「段落之间的结构空行」:
 * 上一行先按段尾裁掉半份行距;新行一敲字,这个裁切消失,整块就跳一下。
 * 低行距(0 / 0.1 / 0.2 档)时表现为往上跳,高行距时往下跳,本质是同一处。
 *
 * 可用环境变量扩大范围:
 *   QLS=0.1  引用行距档位(默认 1)
 *   LLS=0.1  列表行距档位(默认 1)
 *   PREFIX='- ' / '> - '  换成列表 / 引用里的列表
 *   IME=1    用输入法组合再上屏(默认直接插入文字)
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs quote-enter-repro
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
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
  const note = join(vault, '引用回车.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '', 'utf8')
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
        editorFontSize: 16,
        editorFontSizeVersion: 2,
        quoteLineSpace: Number(process.env.QLS ?? '1'),
        listLineSpace: Number(process.env.LLS ?? '1')
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

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  const focus = async (): Promise<void> => {
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }
  const type = async (text: string): Promise<void> => {
    await focus()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(30)
    }
    await sleep(400)
  }
  const key = async (keyCode: string): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(400)
  }

  const snap = () =>
    evalJs<{
      doc: string
      head: number
      lines: {
        text: string
        cls: string
        top: number
        height: number
        lineHeight: string
        textTop: number | null
        textBottom: number | null
        trim: string
      }[]
    }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        return {
          doc: view.state.doc.toString(),
          head: view.state.selection.main.head,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const r = el.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(el)
            const t = range.getBoundingClientRect()
            const cs = getComputedStyle(el)
            return {
              text: el.textContent,
              cls: el.className,
              top: Math.round(r.top * 100) / 100,
              height: Math.round(r.height * 100) / 100,
              lineHeight: cs.lineHeight,
              textTop: t.height ? Math.round(t.top * 100) / 100 : null,
              textBottom: t.height ? Math.round(t.bottom * 100) / 100 : null,
              trim: cs.textBoxTrim
            }
          })
        }
      })()`)

  const prefix = process.env.PREFIX ?? '> '
  await focus()
  await type(prefix)
  await type('阿')
  const s1 = await snap()

  await key('Return')
  const s2 = await snap()

  const useIme = process.env.IME === '1'
  let composition: Awaited<ReturnType<typeof snap>> | null = null
  if (useIme) {
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Input.imeSetComposition', {
      text: 'a',
      selectionStart: 1,
      selectionEnd: 1
    })
    await sleep(400)
    composition = await snap()
    await wc.debugger.sendCommand('Input.insertText', { text: '阿' })
    await sleep(500)
  } else {
    await type('阿')
  }
  const s3 = await snap()

  const label = `PREFIX=${JSON.stringify(prefix)} QLS=${process.env.QLS ?? '1'} LLS=${process.env.LLS ?? '1'} IME=${useIme ? 1 : 0}`
  console.log(`\n[${label}]`)
  for (const [name, s] of [
    ['1 输入引用', s1],
    ['2 回车后', s2],
    ...(composition ? ([['2.5 组合中', composition]] as const) : []),
    ['3 第二行输入后', s3]
  ] as const) {
    console.log(
      `  ${name}: doc=${JSON.stringify(s.doc)} ` +
        s.lines
          .map(
            l =>
              `| ${JSON.stringify(l.text)} top=${l.top} h=${l.height} text=${l.textTop}~${l.textBottom} ${l.cls.replace('cm-line ', '')}`
          )
          .join(' ')
    )
  }

  const states = [s2, ...(composition ? [composition] : []), s3]
  const stable = states.every(s => {
    const line2 = s.lines[1]
    return (
      line2 &&
      line2.top === s2.lines[1]?.top &&
      line2.textTop === s2.lines[1]?.textTop &&
      s.lines[0]?.height === s2.lines[0]?.height
    )
  })
  console.log(`  ${stable ? '✓' : '✗'} 输入前后行位置${stable ? '稳定' : '发生了移动'}`)
  app.exit(stable ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
