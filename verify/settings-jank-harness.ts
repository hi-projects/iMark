/**
 * 设置面板与卡顿的回归验证:点设置图标后,不该被「开关前就按下」的那一下关掉。
 *
 * 起因(用户报的现象):电脑反应迟钝时,点设置图标没反应;点页面其他地方,
 * 设置面板才弹出来,但立刻又消失 —— 表现成「不点别处不出来,点了出来秒退」。
 *
 * 机制:主线程卡住时,点图标和随后点别处会一起堆在输入队列里。卡顿结束后:
 *   1. 先派发第一下,click 打开面板,Vue 把 .settings-mask 挂进 DOM;
 *   2. 紧接着派发第二下的 mousedown,它落在刚出现的全屏遮罩上,
 *      @mousedown.self 的「点外面关闭」当场把面板关掉。
 * 输入事件的 timeStamp 是**按下那一刻**,所以卡在队列里的那一下一定早于遮罩
 * 挂载;SettingsDialog 用 maskShownAt 把这类点击忽略掉(见 onMaskDown)。
 *
 * 断言:
 *   A 无卡顿:点图标 → 面板出现;面板内的点击不关闭;点遮罩 → 关闭
 *   B 卡顿期间连点两下(图标 + 遮罩)→ 面板保持打开(修复的主目标)
 *   C B 之后正常点遮罩 → 关闭(别把「点外面关闭」一起改坏)
 *   D 无卡顿:面板刚出现就立刻点遮罩 → 仍然关闭(修的是排队点击,不是新鲜点击)
 *
 * 跑法(在仓库根目录):
 *   xvfb-run -a node verify/run.mjs settings-jank
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// 无人值守:窗口不弹到桌面上(仍照常渲染,输入事件也照常送)
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
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

interface Point {
  x: number
  y: number
}

type LogEntry = { ev: 'mousedown' | 'mask'; t: number; target?: string; on?: boolean }

async function main(): Promise<void> {
  app.on('window-all-closed', () => {})
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'note.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '# 标题\n\n正文。\n', 'utf8')

  await loadSettings()
  await saveSettings({
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: note,
    openFiles: [note],
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false
  })
  await initExtensions({ appVersion: APP_VERSION })

  const win = createMainWindow(await loadSettings())
  win.webContents.setBackgroundThrottling(false)
  await new Promise<void>(r => win.webContents.once('did-finish-load', () => r()))
  await sleep(1800)
  win.focus()

  const evalJs = <T,>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>

  /*
   * 记录「谁按下了、什么时候按下的」与遮罩的挂载/卸载。
   * mousedown 的 timeStamp 与 performance.now() 同一时钟 —— 断言就靠它区分
   * 「卡在队列里的旧点击」和「面板出现后新按下的点击」。
   */
  await evalJs(`(() => {
    window.__log = []
    document.addEventListener('mousedown', e => {
      const el = e.target
      const cls = el && typeof el.className === 'string' ? el.className : String(el?.tagName ?? '')
      window.__log.push({ ev: 'mousedown', t: Math.round(e.timeStamp), target: cls })
    }, true)
    new MutationObserver(() => {
      window.__log.push({ ev: 'mask', t: Math.round(performance.now()), on: !!document.querySelector('.settings-mask') })
    }).observe(document.body, { childList: true, subtree: true })
    return true
  })()`)

  const geometry = await evalJs<{ btn: Point; inner: { w: number; h: number } }>(`(() => {
    const b = document.querySelector('.status-app-actions button')
    const r = b.getBoundingClientRect()
    return {
      btn: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      inner: { w: window.innerWidth, h: window.innerHeight }
    }
  })()`)

  /** 完整的一次点击:先移过去,再按下、抬起(真鼠标总是这样,少一步命中测试会不一样) */
  const click = async (p: Point, gap = 30): Promise<void> => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    await sleep(10)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(gap)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  }

  const maskOn = (): Promise<boolean> => evalJs<boolean>(`!!document.querySelector('.settings-mask')`)
  const readLog = (): Promise<LogEntry[]> => evalJs<LogEntry[]>(`window.__log`)
  const resetLog = (): Promise<unknown> => evalJs(`(window.__log = [])`)

  /** 主线程忙等:把 renderer 堵住,期间送进来的输入只能排队 */
  const block = (ms: number): Promise<unknown> =>
    evalJs(`(() => { const end = Date.now() + ${ms}; while (Date.now() < end) {} return true })()`)

  // ---------- A ----------
  console.log('\n【A】无卡顿:点图标 → 开;点面板内 → 不关;点遮罩 → 关')
  await resetLog()
  await click(geometry.btn)
  await sleep(500)
  check('点设置图标后面板打开', await maskOn())

  const frame = await evalJs<{ left: number; top: number; width: number; height: number }>(`(() => {
    const r = document.querySelector('.settings-dialog-frame').getBoundingClientRect()
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  })()`)
  // 遮罩上、面板外的一点:左侧留白的中线处,纵向取面板中线
  const maskPoint: Point = {
    x: Math.max(2, Math.round(frame.left / 2)),
    y: Math.round(frame.top + frame.height / 2)
  }
  // 面板内一个不承载交互的位置(底部留白),用来确认「点面板不会关」
  const insidePoint: Point = {
    x: Math.round(frame.left + frame.width / 2),
    y: Math.round(frame.top + frame.height - 10)
  }

  await click(insidePoint)
  await sleep(350)
  check('点面板内部不会关闭面板', await maskOn(), JSON.stringify(insidePoint))

  await click(maskPoint)
  await sleep(500)
  check('点遮罩(面板外)会关闭面板', !(await maskOn()), JSON.stringify(maskPoint))

  // ---------- B ----------
  console.log('\n【B】卡顿 1.5s 期间连点两下(图标 + 遮罩):两下都排队,面板不该秒退')
  await resetLog()
  const busy = block(1500)
  await sleep(150)
  await click(geometry.btn, 20) // 这两下都在卡顿期间送出,派发要等主线程空出来
  await sleep(30)
  await click(maskPoint, 20)
  await busy
  await sleep(800)
  {
    const log = await readLog()
    const mounted = log.filter(e => e.ev === 'mask' && e.on)
    const unmounted = log.filter(e => e.ev === 'mask' && e.on === false)
    const queued = log.find(e => e.ev === 'mousedown' && e.target === 'settings-mask')
    check('排队的那下点击确实落在遮罩上', Boolean(queued), JSON.stringify(log))
    check(
      '它按下时遮罩还没挂载(timeStamp 早于挂载时刻)',
      Boolean(queued && mounted[0] && queued.t < mounted[0]!.t),
      JSON.stringify(log)
    )
    check('面板没有被它关掉', await maskOn(), JSON.stringify(log))
    check('遮罩只挂载过一次、没有卸载', mounted.length === 1 && unmounted.length === 0, JSON.stringify(log))
  }

  // ---------- C ----------
  console.log('\n【C】B 之后正常点遮罩:仍应关闭(别把「点外面关闭」改坏)')
  await resetLog()
  await click(maskPoint)
  await sleep(600)
  check('卡顿结束后再点遮罩,面板关闭', !(await maskOn()), JSON.stringify(await readLog()))

  // ---------- D ----------
  console.log('\n【D】无卡顿:面板刚出现就立刻点遮罩:仍应关闭(只忽略排队旧点击)')
  await click(geometry.btn)
  await sleep(450)
  check('面板打开', await maskOn())
  await click(maskPoint)
  await sleep(500)
  check('立刻点遮罩也会关闭(修复没有过度拦截)', !(await maskOn()))

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
