/**
 * 验收:自动保存的四种方式(与 VS Code 的 files.autoSave 对齐)——
 * 关闭 / 定时保存(afterDelay)/ 切换焦点时(onFocusChange)/ 切换窗口时(onWindowChange)。
 *
 * 重点:
 * - 上一版的实时保存 / 定时保存配置能迁到新模型(afterDelay,延迟 1 秒 / 原间隔);
 * - 定时模式是「停止输入 N 秒后」写盘,1 秒档就是原来的实时保存;
 * - 焦点与窗口模式只在对应事件发生时写盘,平时不碰磁盘;
 * - 没有改动不写盘;关闭后输入不再落盘。
 *
 * 跑法:node verify/run.mjs autosave-modes
 *
 * ⚠️ 改了 `src/renderer/**` 或 `src/preload/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层页面走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  const settingsFile = join(ud, 'settings.json')
  await mkdir(vault, { recursive: true })
  await writeFile(note, '起始内容\n', 'utf8')
  // 故意写上一版的配置:这一轮要先证明它能迁到新模型(定时 30 秒)
  await writeFile(
    settingsFile,
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: note,
        marketUrl: '',
        autoSave: true,
        autoSaveRealtime: false,
        autoSaveInterval: 30
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  check(
    '旧配置迁移为「定时保存 · 30 秒」',
    settings.autoSaveMode === 'afterDelay' && settings.autoSaveDelay === 30,
    JSON.stringify({ mode: settings.autoSaveMode, delay: settings.autoSaveDelay })
  )
  check(
    '旧字段不再留在内存设置里',
    !('autoSave' in settings) && !('autoSaveRealtime' in settings) && !('autoSaveInterval' in settings)
  )
  await initExtensions({ appVersion: '0.1.0' })

  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
  }

  /**
   * 焦点探针。
   *
   * 验收跑在无人值守的桌面会话里,窗口焦点可能被系统或启动它的终端随时拿走 ——
   * 那会合理地触发「切换焦点/窗口」保存。所以「没失焦就不写盘」不能假设焦点一直稳,
   * 而要证明:等待期间若真写了盘,必定伴随过一次焦点/窗口事件。
   */
  await evalJs(`
    (() => {
      window.__autoSaveProbe = { windowBlur: 0, editorFocusOut: 0 }
      window.addEventListener('blur', () => { window.__autoSaveProbe.windowBlur += 1 }, true)
      document.addEventListener('focusout', e => {
        if (e.target instanceof Element && e.target.closest('.cm-editor')) {
          window.__autoSaveProbe.editorFocusOut += 1
        }
      }, true)
      return true
    })()`)

  async function resetFocusProbe(): Promise<void> {
    await evalJs(
      `(() => { window.__autoSaveProbe.windowBlur = 0; window.__autoSaveProbe.editorFocusOut = 0; return true })()`
    )
  }

  async function readFocusProbe(): Promise<{ windowBlur: number; editorFocusOut: number }> {
    return evalJs(`({ ...window.__autoSaveProbe })`)
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  /**
   * 打字必须自检:窗口没焦点时注入的按键会被静默丢掉,后面就会变成一串
   * 看着像产品 bug 的断言失败(与 editor-enter-harness 同一套做法)。
   */
  async function type(text: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(240)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return true
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)} → ${JSON.stringify(doc)})`)
    }
    return false
  }

  /** 等文件里出现某段文字;超时返回 false 并留下盘上的内容 */
  async function waitForFileText(text: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if ((await readFile(note, 'utf8')).includes(text)) return true
      await sleep(100)
    }
    console.log(`    (等 ${ms}ms 后盘上仍是:${JSON.stringify(await readFile(note, 'utf8'))})`)
    return false
  }

  async function openEditorSettings(): Promise<void> {
    await evalJs(`document.querySelector('.status-app-actions button[title^="设置"]')?.click()`)
    await waitFor(`document.querySelector('.settings-dialog')`, 3000)
    await evalJs(
      `(() => { const b = [...document.querySelectorAll('.settings-nav-item')].find(x => x.textContent.trim() === '编辑器'); b?.click(); return !!b })()`
    )
    await waitFor(`document.querySelector('.settings-section-title')?.textContent === '自动保存'`, 3000)
  }

  async function clickMode(label: string): Promise<boolean> {
    const ok = await evalJs<boolean>(
      `(() => { const b = [...document.querySelectorAll('.settings-card .settings-preset')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b })()`
    )
    await sleep(400)
    return ok
  }

  async function closeSettings(): Promise<void> {
    await evalJs(`document.querySelector('.settings-close')?.click()`)
    await sleep(200)
  }

  async function setDelayInput(sec: number): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const input = document.querySelector('.settings-number')
        if (!input) return false
        input.value = '${sec}'
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
  }

  /** 模拟编辑器失去焦点:焦点事件是这一模式的唯一触发源 */
  async function blurEditor(): Promise<void> {
    await evalJs(`(() => { const el = document.activeElement; if (el instanceof HTMLElement) el.blur(); return true })()`)
    await sleep(100)
  }

  /** 模拟窗口失去焦点。真实的 OS 失焦在验收环境里不好稳定制造,直接派发同名事件 */
  async function blurWindow(): Promise<void> {
    await evalJs(`(() => { window.dispatchEvent(new Event('blur')); return true })()`)
    await sleep(100)
  }

  const editorReady = await waitFor(`document.querySelector('.cm-content')?.textContent?.includes('起始内容')`, 10000)
  check('窗口进入编辑器并载入起始文档', editorReady)

  console.log('\n[A] 设置面板:四种保存方式齐全,旧配置落在「定时保存」')
  await openEditorSettings()
  const modeState = await evalJs<{ labels: string[]; timedActive: boolean; delayRow: boolean }>(`
    (() => {
      const buttons = [...document.querySelectorAll('.settings-card .settings-preset')]
      const labels = buttons.map(b => b.textContent.trim())
      const timed = buttons.find(b => b.textContent.trim() === '定时保存')
      return {
        labels,
        timedActive: timed?.classList.contains('settings-preset-active') === true,
        delayRow: !!document.querySelector('.settings-number')
      }
    })()`)
  for (const label of ['关闭', '定时保存', '切换焦点时', '切换窗口时']) {
    check(`有「${label}」这一项`, modeState.labels.includes(label), JSON.stringify(modeState.labels))
  }
  check('迁移后的配置选中「定时保存」', modeState.timedActive, JSON.stringify(modeState))
  check('定时模式显示保存延迟', modeState.delayRow, JSON.stringify(modeState))

  // 切到 1 秒档:这就是原来的实时保存,也方便后面的断言快速看到结果
  check('能点中 1 秒档', await clickMode('1 秒'))
  const oneSecond = await readSettings()
  check(
    '1 秒档已落进 settings.json',
    oneSecond.autoSaveMode === 'afterDelay' && oneSecond.autoSaveDelay === 1,
    JSON.stringify(oneSecond)
  )
  check(
    '旧字段没有写回磁盘',
    !('autoSave' in oneSecond) && !('autoSaveRealtime' in oneSecond) && !('autoSaveInterval' in oneSecond),
    JSON.stringify(oneSecond)
  )
  await closeSettings()

  console.log('\n[B] 定时保存:停止输入 1 秒后写盘')
  const typed = '定时A'
  check('输入落进编辑器', await type(typed))
  // 1 秒延迟还没到:标签上的未保存圆点此时必须在
  check('输入后激活标签显示未保存圆点', await waitFor(`getComputedStyle(document.querySelector('.tab-active .tab-dot')).opacity === '1'`, 800))
  check('1~3 秒内磁盘上出现新内容', await waitForFileText(typed, 3000))
  check('自动保存后圆点消失', await waitFor(`!document.querySelector('.tab-active .tab-dot')`, 2000))
  check(
    '状态栏给出「已自动保存」反馈',
    await waitFor(`document.querySelector('.status-autosave')?.textContent?.includes('已自动保存')`, 1500)
  )

  console.log('\n[C] 没有新输入就不写盘')
  const before = (await stat(note)).mtimeMs
  await sleep(2600)
  const after = (await stat(note)).mtimeMs
  check('安静 2.6 秒后 mtime 不变', before === after, `${before} → ${after}`)

  console.log('\n[D] 切换焦点时:平常不写,编辑器失焦才写')
  await openEditorSettings()
  check('能选中「切换焦点时」', await clickMode('切换焦点时'))
  check('选择已落进 settings.json', (await readSettings()).autoSaveMode === 'onFocusChange')
  check('该模式不显示保存延迟', !(await evalJs<boolean>(`!!document.querySelector('.settings-number')`)))
  await closeSettings()

  const focusTyped = '焦点B'
  check('输入落进编辑器', await type(focusTyped))
  await resetFocusProbe()
  await sleep(2500)
  const diskBeforeBlur = await readFile(note, 'utf8')
  const focusProbe = await readFocusProbe()
  const wroteBeforeBlur = diskBeforeBlur.includes(focusTyped)
  check(
    '没有焦点事件时不写盘',
    !wroteBeforeBlur || focusProbe.windowBlur + focusProbe.editorFocusOut > 0,
    JSON.stringify({ focusProbe, diskBeforeBlur })
  )
  if (wroteBeforeBlur) console.log(`    (等待期间窗口自己失焦了:${JSON.stringify(focusProbe)},这次保存不算产品触发)`)
  await blurEditor()
  check('编辑器失焦后写盘', await waitForFileText(focusTyped, 3000))

  console.log('\n[E] 切换窗口时:平常不写,窗口失焦才写')
  await openEditorSettings()
  check('能选中「切换窗口时」', await clickMode('切换窗口时'))
  check('选择已落进 settings.json', (await readSettings()).autoSaveMode === 'onWindowChange')
  check('该模式不显示保存延迟', !(await evalJs<boolean>(`!!document.querySelector('.settings-number')`)))
  await closeSettings()

  const windowTyped = '窗口C'
  check('输入落进编辑器', await type(windowTyped))
  await resetFocusProbe()
  await sleep(2500)
  const diskBeforeWindowBlur = await readFile(note, 'utf8')
  const windowProbe = await readFocusProbe()
  const wroteBeforeWindowBlur = diskBeforeWindowBlur.includes(windowTyped)
  check(
    '没有窗口失焦事件时不写盘',
    !wroteBeforeWindowBlur || windowProbe.windowBlur > 0,
    JSON.stringify({ windowProbe, diskBeforeWindowBlur })
  )
  if (wroteBeforeWindowBlur) console.log(`    (等待期间窗口自己失焦了:${JSON.stringify(windowProbe)})`)
  await blurWindow()
  check('窗口失焦后写盘', await waitForFileText(windowTyped, 3000))

  console.log('\n[F] 延迟值真的在控制等待时间(5 秒档),且没有 1 小时上限')
  await openEditorSettings()
  check('切回「定时保存」', await clickMode('定时保存'))
  const maxAttr = await evalJs<string | null>(`document.querySelector('.settings-number')?.getAttribute('max') ?? null`)
  check('延迟输入框不再有最大值', maxAttr === null, String(maxAttr))
  check('能设置超过 1 小时的延迟', await setDelayInput(7200))
  await sleep(400)
  check('长延迟已落进 settings.json', (await readSettings()).autoSaveDelay === 7200)

  const timedStart = Date.now()
  check('能改延迟为 5 秒', await setDelayInput(5))
  await sleep(400)
  check('延迟已落进 settings.json', (await readSettings()).autoSaveDelay === 5)
  await closeSettings()

  const timedTyped = '延迟D'
  check('输入落进编辑器', await type(timedTyped))
  await sleep(2500)
  check('2.5 秒时还没写(1 秒档会在这之前写)', !(await readFile(note, 'utf8')).includes(timedTyped))
  check('延迟到了以后写盘', await waitForFileText(timedTyped, 6000))
  const elapsed = Date.now() - timedStart
  check('写盘发生在 5 秒延迟之后', elapsed >= 4000, `用了 ${elapsed}ms`)

  console.log('\n[G] 关闭自动保存后,输入不再落盘')
  await openEditorSettings()
  check('能选中「关闭」', await clickMode('关闭'))
  check('选择已落进 settings.json', (await readSettings()).autoSaveMode === 'off')
  check('关闭时不显示保存延迟', !(await evalJs<boolean>(`!!document.querySelector('.settings-number')`)))
  await closeSettings()

  const offTyped = '关闭E'
  check('输入落进编辑器', await type(offTyped))
  await sleep(2600)
  const diskAfterOff = await readFile(note, 'utf8')
  check('关闭后 2.6 秒磁盘内容不变', !diskAfterOff.includes(offTyped), JSON.stringify(diskAfterOff))

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[autosave-modes] 意外失败:', err)
  app.exit(1)
})
