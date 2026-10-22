/**
 * 验收:仿 Obsidian 的多标签页。
 *
 * 只钉用户看得见的结果(标签栏 DOM、编辑器内容、状态栏、settings.json),
 * 不检查内部数据结构 —— 标签/状态怎么存是实现细节,行为错了才算错。
 *
 * 覆盖:
 *   1 空仓库:标签栏存在但没有标签
 *   2 点文件 → 新标签;再点另一个 → 第二个标签,顺序与激活项正确
 *   3 点标签切回:内容、文件树高亮、状态栏都跟着换
 *   4 输入 → 标签出现脏标记(激活页也显示圆点);切走后仍保留;保存后圆点消失
 *   5 每个标签有自己的滚动位置(切回来能回到原处)
 *   6 拖动排序
 *   7 关闭脏标签会询问;选择「不保存」后内容不落盘、标签消失
 *   8 "+" 新建未命名标签;Ctrl+W 关闭后回到上一个标签
 *   9 已打开的文件再点一次 = 激活,不会开第二份
 *  10 关闭窗口再启动:标签顺序与激活项原样恢复
 *
 * 跑法(仓库根目录):
 *   node verify/run.mjs tabs
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
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

/** 窗口全程隐藏:验收在后台跑,不能弹窗打扰正在用电脑的人 */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

type Win = BrowserWindow

/**
 * 原生对话框的返回值:默认 1 = 「不保存」。记录消息,断言提示确实存在;
 * 需要「保存」的用例先把 0 压进 dialogQueue。
 */
const dialogMessages: string[] = []
const dialogQueue: number[] = []
;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = (
  _win: unknown,
  o: { message?: string }
) => {
  dialogMessages.push(o?.message ?? '')
  return dialogQueue.shift() ?? 1
}
;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
  canceled: true,
  filePath: undefined
})
;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
  canceled: true,
  filePaths: []
})

function evalJs<T>(win: Win, code: string): Promise<T> {
  return win.webContents.executeJavaScript(code, true) as Promise<T>
}

async function waitFor(win: Win, code: string, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await evalJs<boolean>(win, `(() => { try { return !!(${code}) } catch { return false } })()`)) {
      return true
    }
    await sleep(80)
  }
  return false
}

async function waitCount(win: Win, n: number, ms = 5000): Promise<boolean> {
  return waitFor(win, `document.querySelectorAll('.tab').length === ${n}`, ms)
}

async function tabLabels(win: Win): Promise<string[]> {
  return evalJs<string[]>(
    win,
    `[...document.querySelectorAll('.tab-title')].map(el => el.textContent.trim())`
  )
}

async function activeLabel(win: Win): Promise<string> {
  return evalJs<string>(
    win,
    `document.querySelector('.tab-active .tab-title')?.textContent?.trim() ?? ''`
  )
}

function clickFile(win: Win, path: string): Promise<boolean> {
  return evalJs<boolean>(
    win,
    `(() => {
      const el = [...document.querySelectorAll('.explorer-file')]
        .find(e => e.getAttribute('title') === ${JSON.stringify(path)})
      if (!el) return false
      el.click()
      return true
    })()`
  )
}

function clickTab(win: Win, index: number): Promise<boolean> {
  return evalJs<boolean>(
    win,
    `(() => {
      const el = document.querySelectorAll('.tab')[${index}]
      if (!el) return false
      el.click()
      return true
    })()`
  )
}

function closeTabAt(win: Win, index: number): Promise<boolean> {
  return evalJs<boolean>(
    win,
    `(() => {
      const el = document.querySelectorAll('.tab')[${index}]?.querySelector('.tab-close')
      if (!el) return false
      el.click()
      return true
    })()`
  )
}

function tabDirty(win: Win, index: number): Promise<boolean> {
  return evalJs<boolean>(
    win,
    `document.querySelectorAll('.tab')[${index}]?.classList.contains('tab-dirty') ?? false`
  )
}

function contentHas(win: Win, text: string): Promise<boolean> {
  return waitFor(win, `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(text)})`)
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs tabs` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const noteA = join(vault, '甲.md')
  const noteB = join(vault, '乙.md')
  // 甲要够长:滚动位置恢复那一条需要一个能滚起来的文档
  const textA =
    '# 甲\n\n第一份文档。\n\n' +
    Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 行,用来把文档撑长。`).join('\n\n') +
    '\n'
  const textB = '# 乙\n\n第二份文档。\n'

  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(noteA, textA, 'utf8')
  await writeFile(noteB, textB, 'utf8')

  await loadSettings()
  await saveSettings({
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: null,
    openFiles: [],
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false
  })

  await initExtensions({ appVersion: '0.1.0' })

  const settingsFile = join(ud, 'settings.json')
  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
  }
  async function waitSettings(
    predicate: (s: Record<string, unknown>) => boolean,
    ms = 5000
  ): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if (predicate(await readSettings())) return true
      } catch {
        /* 写盘途中可能读到半截 */
      }
      await sleep(60)
    }
    return false
  }

  async function openWindow(): Promise<Win> {
    const win = createMainWindow(await loadSettings())
    win.webContents.setBackgroundThrottling(false)
    await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()))
    await waitFor(win, `document.querySelector('.app-shell')`)
    await waitFor(win, `document.querySelector('.explorer-file') || document.querySelector('.editor-empty-hint')`)
    return win
  }

  async function closeWindow(win: Win): Promise<void> {
    await new Promise<void>(resolve => {
      win.once('closed', () => resolve())
      win.close()
    })
    await sleep(150)
  }

  // ------------------------------------------------------------------
  console.log('\n【1】空会话:有标签栏,没有标签')
  {
    const win = await openWindow()
    check('标签栏存在', await waitFor(win, `document.querySelector('.tab-bar')`))
    check('没有标签', (await tabLabels(win)).length === 0)
    check('编辑器是空状态', !!(await evalJs<boolean>(win, `document.querySelector('.editor-empty-hint')`)))

    // ------------------------------------------------------------------
    console.log('\n【2】点文件 → 标签;点另一个 → 第二个标签')
    check('点开甲', await clickFile(win, noteA))
    check('出现一个标签「甲」', await waitCount(win, 1) && (await tabLabels(win))[0] === '甲')
    check('甲是激活标签', (await activeLabel(win)) === '甲')
    check('编辑器装载了甲', await contentHas(win, '第一份文档。'))
    // 文件名只在标签上显示一次;状态栏不再重复(2026-10 起)
    check('状态栏不再重复文件名', !(await evalJs<boolean>(win, `!!document.querySelector('.status-file')`)))

    check('点开乙', await clickFile(win, noteB))
    check('两个标签,顺序为甲、乙', await waitCount(win, 2) && (await tabLabels(win)).join(',') === '甲,乙')
    check('乙自动激活', (await activeLabel(win)) === '乙')
    check('编辑器装载了乙', await contentHas(win, '第二份文档。'))

    // ------------------------------------------------------------------
    console.log('\n【3】点标签切回')
    check('点第一个标签', await clickTab(win, 0))
    check('甲重新激活', await waitFor(win, `document.querySelector('.tab-active .tab-title')?.textContent?.trim() === '甲'`))
    check('内容切回甲', await contentHas(win, '第一份文档。'))
    check('文件树高亮甲', await waitFor(win, `[...document.querySelectorAll('.explorer-file')].find(e => e.getAttribute('title') === ${JSON.stringify(noteA)})?.classList.contains('explorer-file-active')`))
    check('窗口标题写着甲.md', await (async () => {
      const until = Date.now() + 3000
      while (Date.now() < until) {
        if (win.getTitle().includes('甲.md')) return true
        await sleep(60)
      }
      return false
    })())

    // ------------------------------------------------------------------
    console.log('\n【4】输入 → 脏标记;切走后仍保留;保存后圆点消失')
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' })
    check('甲出现脏标记', await waitFor(win, `document.querySelectorAll('.tab')[0]?.classList.contains('tab-dirty')`))
    check('脏标记只在标签上显示,状态栏不再重复', !(await evalJs<boolean>(win, `!!document.querySelector('.status-file')`)))
    check('激活标签上圆点可见', await waitFor(win, `getComputedStyle(document.querySelector('.tab-active .tab-dot')).opacity === '1'`))
    check('圆点占用关闭按钮的槽位', await evalJs<boolean>(win, `getComputedStyle(document.querySelector('.tab-active .tab-close')).opacity === '0'`))
    check('切到乙', await clickTab(win, 1))
    check('乙内容不受影响', await contentHas(win, '第二份文档。'))
    check('甲的脏标记还在', await tabDirty(win, 0))

    // 手动保存后圆点立刻消失(自动保存走同一条 markTabSaved 路径)
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' })
    check('乙也变成脏标签', await waitFor(win, `document.querySelector('.tab-active')?.classList.contains('tab-dirty')`))
    win.webContents.send(IPC.MenuCommand, 'file:save')
    check('手动保存后脏标记消失', await waitFor(win, `!document.querySelector('.tab-active')?.classList.contains('tab-dirty')`))
    check('手动保存后圆点消失', await waitFor(win, `!document.querySelector('.tab-active .tab-dot')`))
    check('× 回到激活标签的槽位', await evalJs<boolean>(win, `getComputedStyle(document.querySelector('.tab-active .tab-close')).opacity === '1'`))

    // ------------------------------------------------------------------
    console.log('\n【5】每个标签有自己的滚动位置')
    check('切回甲', await clickTab(win, 0))
    await contentHas(win, '第一份文档。')
    const scrolled = await evalJs<number>(
      win,
      `(() => { const s = document.querySelector('.cm-scroller'); if (!s) return 0; s.scrollTop = 900; return s.scrollTop })()`
    )
    await sleep(200)
    check('甲确实滚下去了', scrolled > 400, String(scrolled))
    check('切到乙再切回甲', (await clickTab(win, 1)) && (await clickTab(win, 0)))
    await contentHas(win, '第一份文档。')
    const restored = await evalJs<number>(
      win,
      `document.querySelector('.cm-scroller')?.scrollTop ?? 0`
    )
    check('切回来时滚动位置被恢复', restored > 400, String(restored))

    // ------------------------------------------------------------------
    console.log('\n【6】拖动排序')
    const dragged = await evalJs<boolean>(
      win,
      `(() => {
        const tabs = [...document.querySelectorAll('.tab')]
        if (tabs.length < 2) return false
        const from = tabs[0], to = tabs[1]
        const dt = new DataTransfer()
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        const r = to.getBoundingClientRect()
        const x = r.right - 2, y = r.top + r.height / 2
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        return true
      })()`
    )
    check('拖到乙的右半边', dragged && (await waitFor(win, `[...document.querySelectorAll('.tab-title')].map(e => e.textContent.trim()).join(',') === '乙,甲'`), JSON.stringify(await tabLabels(win))))
    check('激活项仍是甲', (await activeLabel(win)) === '甲')

    // ------------------------------------------------------------------
    console.log('\n【7】关闭脏标签:询问后选择「不保存」')
    const beforeDialog = dialogMessages.length
    check('点甲的关闭按钮', await closeTabAt(win, 1))
    check('弹出了确认', await (async () => {
      const until = Date.now() + 3000
      while (Date.now() < until) {
        if (dialogMessages.length > beforeDialog) return true
        await sleep(60)
      }
      return false
    })())
    check('提示里写着甲.md', dialogMessages[beforeDialog]?.includes('甲.md') ?? false, dialogMessages[beforeDialog] ?? '')
    check('只剩乙一个标签', await waitCount(win, 1) && (await tabLabels(win)).join(',') === '乙')
    check('乙自动激活', (await activeLabel(win)) === '乙')
    check('甲的内容没有写回磁盘', !(await readFile(noteA, 'utf8')).includes('X'))
    check('会话记忆只剩乙', await waitSettings(s => JSON.stringify(s.openFiles) === JSON.stringify([noteB]) && s.lastFile === noteB))

    // ------------------------------------------------------------------
    console.log('\n【8】“+”新建未命名标签;Ctrl+W 关闭')
    check('点 +', await evalJs<boolean>(win, `(() => { const b = document.querySelector('.tab-new'); if (!b) return false; b.click(); return true })()`))
    check('出现未命名标签并激活', await waitCount(win, 2) && (await activeLabel(win)) === '未命名')
    check('编辑区是空的', await waitFor(win, `document.querySelector('.cm-content')?.textContent?.trim() === ''`))
    check('lastFile 清空(未命名无法跨启动恢复)', await waitSettings(s => s.lastFile === null))
    win.webContents.send(IPC.MenuCommand, 'file:close-tab')
    check('Ctrl+W 关掉未命名标签', await waitCount(win, 1) && (await tabLabels(win)).join(',') === '乙')
    check('回到乙', (await activeLabel(win)) === '乙' && (await contentHas(win, '第二份文档。')))
    check('lastFile 回到乙', await waitSettings(s => s.lastFile === noteB))

    // ------------------------------------------------------------------
    console.log('\n【9】已打开的文件再点一次 = 激活,不会重复开')
    check('再次点开甲', await clickFile(win, noteA))
    check('变成两个标签', await waitCount(win, 2) && (await tabLabels(win)).join(',') === '乙,甲')
    check('甲激活', (await activeLabel(win)) === '甲')
    check('点文件树里的乙(已打开)', await clickFile(win, noteB))
    check('标签数量不变', (await tabLabels(win)).length === 2)
    check('乙被激活', await waitFor(win, `document.querySelector('.tab-active .tab-title')?.textContent?.trim() === '乙'`))

    // ------------------------------------------------------------------
    console.log('\n【10】关闭窗口再启动:标签原样恢复')
    check('关闭前是两个标签', (await tabLabels(win)).join(',') === '乙,甲')
    check('会话已记录两个文件', await waitSettings(s => JSON.stringify(s.openFiles) === JSON.stringify([noteB, noteA]) && s.lastFile === noteB))
    check('关闭前没有脏标签', !(await tabDirty(win, 0)) && !(await tabDirty(win, 1)))
    const beforeClose = await tabLabels(win)
    const beforeActive = await activeLabel(win)
    await closeWindow(win)

    const again = await openWindow()
    check('重启后恢复两个标签', await waitCount(again, 2) && (await tabLabels(again)).join(',') === beforeClose.join(','), (await tabLabels(again)).join(','))
    check('激活项也恢复', await waitFor(again, `document.querySelector('.tab-active .tab-title')?.textContent?.trim() === ${JSON.stringify(beforeActive)}`))
    check('恢复的当前页内容正确', await contentHas(again, '第二份文档。'))
    check('lastFile 没有被恢复流程弄丢', await waitSettings(s => s.lastFile === noteB))

    // ------------------------------------------------------------------
    console.log('\n【11】带脏标签关闭窗口:选择「保存」→ 所有脏标签落盘')
    again.webContents.sendInputEvent({ type: 'char', keyCode: 'Y' })
    check('乙变成脏标签', await waitFor(again, `document.querySelector('.tab-active')?.classList.contains('tab-dirty')`))
    dialogQueue.push(0) // 窗口关闭提示:保存
    await closeWindow(again)
    check('窗口关闭前把乙写回了磁盘', (await readFile(noteB, 'utf8')).includes('Y'))
    const third = await openWindow()
    check('重启后读到的就是保存过的内容', await contentHas(third, 'Y'))
    check('恢复后不是脏状态', await waitFor(third, `!document.querySelector('.tab-active')?.classList.contains('tab-dirty')`))
    await closeWindow(third)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[tabs] 未捕获异常:', err)
  app.exit(1)
})
