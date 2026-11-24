/**
 * 验收:用户敲出来的空行,关闭 / 重开文档后仍然可见。
 *
 * 用户报告:第一行「啊」→ 回车 → 在空段落上再回车 → 第三行「啊」→ 回车,
 * 关掉应用再打开同一篇笔记,中间那条空行不见了。
 *
 * 源码并没有丢行:「回车 = 新段」把空段落写成「分隔空行 + 空段落行 + 分隔
 * 空行」,三条空行都在文件里;丢的是**行角色**——emptyParagraphsField 只
 * 活在这次会话里,重开文档后连排空行全被 collapseBlankRuns 当成结构空行
 * 折叠。这里断言两条:
 *   · 保存到磁盘的源码保留三条空行;
 *   · 重新加载后中间那条仍按空段落撑成整行,版式与保存前一致。
 *
 * 文档首尾的空行不算空段落(排版余量),开头 / 结尾连续空行不会凭空多出一行。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs empty-line-persist
 */

import { app, protocol, type BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { IPC } from '../src/shared/ipc-channels'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { buildAppMenu } from '../src/main/menu'
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
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface DomLine {
  text: string
  cls: string
  h: number
  top: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs empty-line-persist` 跑会自动带上)')
    app.exit(2)
    return
  }
  await app.whenReady()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'test.md')
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
        openFiles: [note],
        marketUrl: '',
        autoSave: false,
        autoSaveMode: 'off',
        editorFontSize: 14,
        editorFontSizeVersion: 2,
        lineWrapping: true,
        outline: false
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
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(2000)
  const evalJs = <T,>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  const docText = (): Promise<string> =>
    evalJs<string>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      return v.state.doc.toString()
    })()`)
  const domLines = (): Promise<DomLine[]> =>
    evalJs<DomLine[]>(`[...document.querySelectorAll('.cm-content .cm-line')].map(l => ({
      text: l.textContent,
      cls: l.className,
      h: Math.round(l.getBoundingClientRect().height * 10) / 10,
      top: Math.round(l.getBoundingClientRect().top)
    }))`)
  const isBlank = (l: DomLine): boolean => l.text.trim() === ''
  const has = (l: DomLine | undefined, cls: string): boolean =>
    !!l && l.cls.split(/\s+/).includes(cls)
  /** 中间被撑成整行的空段落(排除文末那条新段落) */
  const middleEmpties = (lines: DomLine[]): DomLine[] => {
    const last = lines[lines.length - 1]
    return lines.filter(
      l => l !== last && isBlank(l) && l.h > 10 && has(l, 'cm-md-empty-paragraph')
    )
  }
  /** 文末的新段落:保存前是空段落,重开后按「文末那条空行」撑开 */
  const tailVisible = (lines: DomLine[]): boolean => {
    const last = lines[lines.length - 1]
    return !!last && last.h > 10
  }
  // 行首「+」按钮的内容(零宽空格 + 一个 +)也会算进 textContent,用包含判断
  const bodyTops = (lines: DomLine[]): number[] =>
    lines.filter(l => l.text.includes('啊')).map(l => l.top)

  const key = async (keyCode: string): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(350)
  }
  const typeChar = async (ch: string): Promise<void> => {
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    await sleep(350)
  }

  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ selection: { anchor: 0 } })
    v.focus()
    return true
  })()`)
  await sleep(200)

  // 用户复现步骤:啊 / 回车 / 回车 / 啊 / 回车
  console.log('\n【1】按「回车 = 新段」敲出一条空段落')
  await typeChar('啊')
  await key('Enter')
  await key('Enter')
  await typeChar('啊')
  await key('Enter')
  const source = await docText()
  check(
    '源码保留「分隔 + 空段落 + 分隔」三条空行',
    source === '啊\n\n\n\n啊\n\n',
    JSON.stringify(source)
  )

  const before = await domLines()
  const beforeEmpties = middleEmpties(before)
  const beforeTops = bodyTops(before)
  console.log(`     [保存前] ${JSON.stringify(before)}`)
  check('保存前中间的空段落撑成整行', beforeEmpties.length === 1, JSON.stringify(beforeEmpties))
  check('保存前文末新段落可见', tailVisible(before), JSON.stringify(before[before.length - 1]))
  check('保存前两段正文都在', beforeTops.length === 2, JSON.stringify(beforeTops))

  console.log('\n【2】保存:空行原样写进文件')
  wc.send(IPC.MenuCommand, 'file:save')
  await sleep(1000)
  const disk = await readFile(note, 'utf8')
  check('磁盘上的源码与编辑器一致(三条空行都在)', disk === source, JSON.stringify(disk))

  console.log('\n【3】重新打开文档:空段落仍按整行显示')
  wc.reload()
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(1800)
  const after = await domLines()
  const afterTops = bodyTops(after)
  const afterEmpties = middleEmpties(after)
  console.log(`     [重开后] ${JSON.stringify(after)}`)
  check('重开后源码不变', (await docText()) === source, JSON.stringify(await docText()))
  check('中间的空行仍撑成整行(没有消失)', afterEmpties.length === 1, JSON.stringify(afterEmpties))
  check(
    '两段正文的位置与保存前一致',
    afterTops.length === 2 &&
      beforeTops.length === 2 &&
      afterTops.every((top, i) => Math.abs(top - (beforeTops[i] ?? NaN)) <= 1),
    JSON.stringify({ beforeTops, afterTops })
  )
  // 文末那条是回车留下的新段落,重开后仍按文末空行规则撑开
  check('文末的新段落在重开后仍可见', tailVisible(after), JSON.stringify(after[after.length - 1]))

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  win.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
