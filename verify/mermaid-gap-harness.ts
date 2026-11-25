/**
 * 诊断:正文与图表（```mermaid）的配对间距设为 0 后,两者之间还剩多少空隙、
 * 空隙分别来自哪里(宿主行 leading / widget margin / 结构空行)。
 *
 * 跑法:xvfb-run -a node verify/run.mjs mermaid-gap
 */

import { app, dialog, protocol } from 'electron'
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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const NOTE = [
  '正文甲。',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '## 标题乙',
  '',
  '正文乙。',
  ''
].join('\n')

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
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
  await writeFile(note, NOTE, 'utf8')
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
        lineWrapping: false,
        editorFontSize: 15,
        editorFontSizeVersion: 2,
        pairGaps: { 'body-mermaid': 0, 'mermaid-heading': 0 }
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
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1800)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  // 图表是异步渲染的:等 SVG 真的进 DOM 再量
  for (let i = 0; i < 100; i++) {
    if (await evalJs<boolean>(`!!document.querySelector('.cm-md-mermaid svg')`)) break
    await sleep(100)
  }
  await sleep(300)

  interface Measure {
    rootGap: string
    paraBottom: number | null
    hostTop: number | null
    hostHeight: number | null
    hostPaddingTop: string | null
    hostLineHeight: string | null
    hostFontSize: string | null
    widgetTop: number | null
    widgetMarginTop: string | null
    widgetHeight: number | null
    headingTop: number | null
  }

  const m = await evalJs<Measure>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const para = lines.find(el => (el.textContent || '').includes('正文甲'))
      const widget = document.querySelector('.cm-md-mermaid')
      const host = widget ? widget.closest('.cm-line') : null
      const heading = lines.find(el => (el.textContent || '').includes('标题乙'))
      const cs = host ? getComputedStyle(host) : null
      const wcs = widget ? getComputedStyle(widget) : null
      const r = el => el ? el.getBoundingClientRect() : null
      return {
        rootGap: getComputedStyle(document.documentElement).getPropertyValue('--md-gap-body-mermaid'),
        paraBottom: r(para)?.bottom ?? null,
        hostTop: r(host)?.top ?? null,
        hostHeight: r(host)?.height ?? null,
        hostPaddingTop: cs?.paddingTop ?? null,
        hostLineHeight: cs?.lineHeight ?? null,
        hostFontSize: cs?.fontSize ?? null,
        widgetTop: r(widget)?.top ?? null,
        widgetMarginTop: wcs?.marginTop ?? null,
        widgetHeight: r(widget)?.height ?? null,
        headingTop: r(heading)?.top ?? null
      }
    })()`)
  console.log(JSON.stringify(m, null, 2))

  let pass = 0
  let fail = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) {
      pass += 1
      console.log(`  ✓ ${label}`)
    } else {
      fail += 1
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }
  check('正文与图表间距变量是 0', m.rootGap.trim() === '0', JSON.stringify(m.rootGap))
  check('宿主行不再叠加行高', m.hostLineHeight === '0px', JSON.stringify(m.hostLineHeight))
  check('卡片没有外边距', m.widgetMarginTop === '0px', JSON.stringify(m.widgetMarginTop))
  if (m.paraBottom !== null && m.widgetTop !== null) {
    check(
      '0 档时正文与图表边框贴在一起(±1px)',
      Math.abs(m.widgetTop - m.paraBottom) <= 1,
      JSON.stringify({ paraBottom: m.paraBottom, widgetTop: m.widgetTop })
    )
  } else {
    check('量得到正文与图表', false)
  }
  if (m.widgetTop !== null && m.widgetHeight !== null && m.headingTop !== null) {
    const widgetBottom = m.widgetTop + m.widgetHeight
    check(
      '0 档时图表边框与下方标题贴在一起(±1px)',
      Math.abs(m.headingTop - widgetBottom) <= 1,
      JSON.stringify({ widgetBottom, headingTop: m.headingTop })
    )
  } else {
    check('量得到图表与标题', false)
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
