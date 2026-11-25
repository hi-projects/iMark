/**
 * 验收:引用竖线的垂直范围。
 *
 * 引用行的配对间距(引用上方 / 下方的留白)挂在首行 padding-top / 末行
 * padding-bottom 上;竖线是行盒里的绝对定位伪元素,`top/bottom` 从 padding 盒
 * 算起。所以必须减掉这段配对间距,否则留白越大竖线越往上 / 下冒,看起来
 * 「超过了自己的行」。
 *
 * 断言:
 *   A 每一行竖线的高度恰好是「行盒 - 上下配对间距」,且从行盒内容顶开始;
 *   B 竖线不侵入上一块与引用之间的间距;
 *   C 相邻引用行的竖线首尾相接(连续的一条,不出现断口)。
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs quote-bar
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

interface LineInfo {
  text: string
  cls: string
  box: { top: number; height: number }
  textBox: { top: number; height: number }
  paddingTop: number
  paddingBottom: number
  bar: { top: number; height: number } | null
}

async function main(): Promise<void> {
  await app.whenReady()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '引用.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  // 正文紧贴引用:首行没有结构空行,会带 1 档「引用上方」padding-top
  await writeFile(note, ['正文。', '> 引用一', '> 引用二', '> 引用三', ''].join('\n'), 'utf8')
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
        editorFontSizeVersion: 2
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
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const lines = (await wc.executeJavaScript(
    `
    (() => {
      return [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const r = el.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        const t = range.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const before = getComputedStyle(el, '::before')
        return {
          text: el.textContent,
          cls: el.className,
          box: { top: r.top, height: r.height },
          textBox: { top: t.top, height: t.height },
          paddingTop: parseFloat(cs.paddingTop || '0'),
          paddingBottom: parseFloat(cs.paddingBottom || '0'),
          bar: before.top === 'auto'
            ? null
            : { top: parseFloat(before.top), height: parseFloat(before.height) }
        }
      })
    })()`,
    true
  )) as LineInfo[]

  const quoted = lines.filter(l => /\bcm-md-quote\b/.test(l.cls) && l.bar)
  const body = lines.find(l => l.text === '正文。')
  console.log(`\n【引用竖线】${quoted.map(q => `${q.text}: pad=${q.paddingTop}/${q.paddingBottom} bar=${q.bar?.top}+${q.bar?.height}`).join(' | ')}`)

  check('三行引用都画了竖线', quoted.length === 3, String(quoted.length))

  let geometryOk = true
  for (const line of quoted) {
    const bar = line.bar!
    const expectedHeight = line.box.height - line.paddingTop - line.paddingBottom
    if (Math.abs(bar.top - line.paddingTop) > 0.6 || Math.abs(bar.height - expectedHeight) > 0.6) {
      geometryOk = false
      console.log(
        `      ${line.text}: bar.top=${bar.top} padTop=${line.paddingTop} bar.h=${bar.height} 期望 ${expectedHeight}`
      )
    }
  }
  check('每行竖线从内容顶开始、高度等于行盒减配对间距', geometryOk)

  if (body && quoted[0]) {
    const absTop = quoted[0].box.top + quoted[0].bar!.top
    check(
      '竖线没有伸进引用上方的间距(正文行下方)',
      absTop >= body.box.top + body.box.height - 0.6,
      `barTop=${Math.round(absTop)} bodyBottom=${Math.round(body.box.top + body.box.height)}`
    )
  }

  let continuous = true
  for (let i = 1; i < quoted.length; i += 1) {
    const prev = quoted[i - 1]!
    const next = quoted[i]!
    const prevBottom = prev.box.top + prev.bar!.top + prev.bar!.height
    const nextTop = next.box.top + next.bar!.top
    if (Math.abs(prevBottom - nextTop) > 0.6) {
      continuous = false
      console.log(`      ${prev.text} → ${next.text}: ${prevBottom} vs ${nextTop}`)
    }
  }
  check('相邻引用行的竖线首尾相接', continuous)

  console.log(`\n${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
