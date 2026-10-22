/**
 * 验收:状态栏右下角的通知中心。
 *
 * 这一轮改了两件事,必须一起钉住:
 *   1. 主题切换 / 设置按钮移到状态栏**左边**(侧栏开关旁边);
 *   2. 状态栏最右侧新增通知铃铛,点开在右下角弹一个小框,列出插件与浏览器
 *      (`new Notification(...)`)发过的通知;未读数走铃铛角标,打开即已读。
 *
 * 断言尽量走**真实路径**:
 *   - 插件通知由开发目录里的探针插件执行命令,经 `imk.ui.notify` → 宿主 →
 *     渲染层 → 通知中心,不是直接往 store 里塞一条;
 *   - 浏览器通知在页面里真的 `new Notification(...)`,走 `notificationCapture.ts`
 *     的包装;
 *   - 布局断言量的是元素在窗口里的实际坐标,不是类名在不在。
 *
 * 跑法(仓库根目录;无头环境用 xvfb,不要弹出窗口):
 *   xvfb-run -a node verify/run.mjs notification
 *
 * ⚠️ 改了 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层页面走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 */

import { app, BrowserWindow, dialog } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { IPC } from '../src/shared/ipc-channels'

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

const PROBE_ID = 'harness.notice-probe'
const PROBE_NAME = '通知探针'
const PLUGIN_TEXT = '来自插件的通知'
const PLUGIN_TEXT_2 = '第二条插件通知'
const BROWSER_TITLE = '浏览器通知标题'
const BROWSER_BODY = '浏览器通知正文'

/**
 * 探针插件:只注册两条命令,执行时各发一条插件通知。
 *
 * 不在 `onEnable` 里直接发:那时窗口还没建,宿主会(正确地)把通知丢掉,
 * 断言就会变成一条永远等不到的红灯。
 */
const PROBE_MAIN = `const imark = require('imark')
exports.activate = function (context) {
  context.subscriptions.push(
    imark.commands.registerCommand('harness.notice-probe.probe-notify', function () {
      imark.window.showInformationMessage('来自插件的通知')
    })
  )
  context.subscriptions.push(
    imark.commands.registerCommand('harness.notice-probe.probe-notify-2', function () {
      imark.window.showWarningMessage('第二条插件通知')
    })
  )
  // 状态栏条目:布局断言需要一个真实的「扩展图标组」
  const item = imark.window.createStatusBarItem(imark.StatusBarAlignment.Left, 0)
  item.text = '$(bell) 探针'
  item.show()
  context.subscriptions.push(item)
}
exports.deactivate = function () {}
`

/** 小框里的一条通知,按界面上的文字与来源标签取 */
interface PanelItem {
  source: string
  name: string
  message: string
  levelClass: string
}

const PANEL_ITEMS = `
(() => {
  const items = [...document.querySelectorAll('.notif-panel .notif-item')]
  return items.map(el => ({
    source: (el.querySelector('.notif-source') || {}).textContent?.trim() || '',
    name: (el.querySelector('.notif-name') || {}).textContent?.trim() || '',
    message: (el.querySelector('.notif-message') || {}).textContent?.trim() || '',
    levelClass: [...el.classList].find(c => c.startsWith('notif-') && c !== 'notif-item') || ''
  }))
})()
`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs notification` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  // 这一轮不涉及原生对话框,但失败路径不该在无人值守时等人点
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
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '通知中心验收\n', 'utf8')
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
        autoSaveMode: 'off'
      },
      null,
      2
    ),
    'utf8'
  )

  // 探针扩展:直接放进 v2 的安装目录,由 initExtensions 扫描加载
  const probeDir = join(ud, 'plugins', PROBE_ID)
  await mkdir(probeDir, { recursive: true })
  await writeFile(
    join(probeDir, 'package.json'),
    JSON.stringify(
      {
        publisher: 'harness',
        name: 'notice-probe',
        version: '1.0.0',
        displayName: PROBE_NAME,
        description: 'harness 用:发扩展通知',
        engines: { imark: '^0.1.0' },
        main: './main.js',
        activationEvents: [
          'onCommand:harness.notice-probe.probe-notify',
          'onCommand:harness.notice-probe.probe-notify-2'
        ],
        contributes: {
          commands: [
            { command: 'harness.notice-probe.probe-notify', title: '发一条扩展通知' },
            { command: 'harness.notice-probe.probe-notify-2', title: '再发一条扩展通知' }
          ]
        }
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(join(probeDir, 'main.js'), PROBE_MAIN, 'utf8')

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  // 不补装内置插件:这一轮只需要一个干净的窗口 + 探针,少一个变量少一处噪音
  const service = await initExtensions({ appVersion: '0.1.0' })
  // 先激活探针:它贡献的状态栏条目要在首帧就出现在布局里(这时还没有任何通知)
  try {
    await service.activateExtension(PROBE_ID)
  } catch (err) {
    console.error('[harness] 激活探针扩展失败:', err)
  }
  const win: BrowserWindow = createMainWindow(settings)
  // 与 index.ts 一样:主进程的 UI 请求要能送到渲染层
  service.setRendererSender(message => {
    if (!win.isDestroyed()) win.webContents.send(IPC.ExtensionToRenderer, message)
  })
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const ok = await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)
      if (ok) return true
      await sleep(80)
    }
    return false
  }

  async function click(selector: string): Promise<boolean> {
    return evalJs<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`
    )
  }

  async function panelItems(): Promise<PanelItem[]> {
    return evalJs<PanelItem[]>(PANEL_ITEMS)
  }

  async function badgeText(): Promise<string | null> {
    return evalJs<string | null>(
      `(() => { const b = document.querySelector('.status-notify-badge'); return b ? b.textContent.trim() : null })()`
    )
  }

  /** 执行探针命令,直到通知真的送达渲染层(宿主刚启用时可能还没挂好命令) */
  async function firePluginNotice(itemId: string): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      try {
        await service.executeCommand(`${PROBE_ID}.${itemId}`, [], 'code')
        return true
      } catch {
        await sleep(100)
      }
    }
    return false
  }

  const ready = await waitFor(`document.querySelector('.status-bar') && document.querySelector('.status-notify')`, 12000)
  check('窗口进入主界面,状态栏与通知铃铛都在', ready)
  if (!ready) {
    console.log(`\n结果:${pass} 通过,${fail} 失败`)
    app.exit(1)
    return
  }
  await sleep(400)

  console.log('\n[A] 状态栏布局:主题 / 设置在左,通知铃铛在最右')

  interface LayoutMetrics {
    bar: { left: number; right: number; top: number; bottom: number }
    appActions: { left: number; right: number } | null
    toggles: { left: number; right: number } | null
    pluginGroup: { left: number; right: number } | null
    seps: { left: number; right: number }[]
    appButtons: string[]
    bell: { left: number; right: number; top: number; bottom: number } | null
    viewportWidth: number
    hasThemeInLeft: boolean
    hasSettingsInLeft: boolean
    settingsInRight: boolean
    themeInRight: boolean
    slotInPluginGroup: boolean
    bellInActions: boolean
    bellIsLast: boolean
    bellTitle: string
  }

  const layout = await evalJs<LayoutMetrics>(`
    (() => {
      const rect = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom } }
      const bar = document.querySelector('.status-bar')
      const appActions = document.querySelector('.status-app-actions')
      const toggles = document.querySelector('.status-toggles')
      const pluginGroup = document.querySelector('.status-plugin-group')
      const actions = document.querySelector('.status-actions')
      const bell = document.querySelector('.status-notify')
      return {
        bar: rect(bar),
        appActions: appActions ? rect(appActions) : null,
        toggles: toggles ? rect(toggles) : null,
        pluginGroup: pluginGroup ? rect(pluginGroup) : null,
        seps: [...document.querySelectorAll('.status-bar > .status-sep')].map(rect),
        appButtons: appActions
          ? [...appActions.querySelectorAll('button')].map(b => b.getAttribute('title') || '')
          : [],
        bell: bell ? rect(bell) : null,
        viewportWidth: window.innerWidth,
        hasThemeInLeft: !!appActions && !!appActions.querySelector('button[title*="主题"]'),
        hasSettingsInLeft: !!appActions && !!appActions.querySelector('button[title^="设置"]'),
        settingsInRight: !!actions && !!actions.querySelector('button[title^="设置"]'),
        themeInRight: !!actions && !!actions.querySelector('button[title*="主题"]'),
        slotInPluginGroup: !!pluginGroup && !!pluginGroup.querySelector('.status-plug'),
        bellInActions: !!bell && !!actions && actions.contains(bell),
        bellIsLast: !!bell && !!actions && actions.lastElementChild === bell,
        bellTitle: (bell && bell.getAttribute('title')) || ''
      }
    })()`)

  check(
    '设置与主题切换在状态栏最左边',
    layout.hasSettingsInLeft &&
      layout.hasThemeInLeft &&
      layout.appActions !== null &&
      layout.appActions.left <= layout.bar.left + 14,
    JSON.stringify({ appActions: layout.appActions, bar: layout.bar })
  )
  check(
    '顺序是设置、主题切换',
    layout.appButtons.length === 2 &&
      layout.appButtons[0]?.startsWith('设置') === true &&
      layout.appButtons[1]?.includes('主题') === true,
    JSON.stringify(layout.appButtons)
  )
  check(
    '左侧有两道竖线分隔三组',
    layout.seps.length === 2,
    JSON.stringify(layout.seps)
  )
  check(
    '第一条竖线在设置 / 主题与目录 / 大纲之间',
    layout.seps.length >= 1 &&
      layout.appActions !== null &&
      layout.toggles !== null &&
      layout.seps[0]!.left >= layout.appActions.right &&
      layout.seps[0]!.right <= layout.toggles.left,
    JSON.stringify({ sep: layout.seps[0], appActions: layout.appActions, toggles: layout.toggles })
  )
  check(
    '目录、大纲在插件图标之前',
    layout.toggles !== null &&
      layout.pluginGroup !== null &&
      layout.toggles.right <= layout.pluginGroup.left,
    JSON.stringify({ toggles: layout.toggles, pluginGroup: layout.pluginGroup })
  )
  check(
    '第二条竖线在目录 / 大纲与插件图标之间',
    layout.seps.length >= 2 &&
      layout.toggles !== null &&
      layout.pluginGroup !== null &&
      layout.seps[1]!.left >= layout.toggles.right &&
      layout.seps[1]!.right <= layout.pluginGroup.left,
    JSON.stringify({ sep: layout.seps[1], toggles: layout.toggles, pluginGroup: layout.pluginGroup })
  )
  check(
    '插件图标组在状态栏左半边,且里面是扩展自己贡献的条目',
    layout.pluginGroup !== null && layout.pluginGroup.left < layout.viewportWidth / 2 && layout.slotInPluginGroup,
    JSON.stringify({ pluginGroup: layout.pluginGroup, slotInPluginGroup: layout.slotInPluginGroup })
  )
  check(
    '右侧不再有主题 / 设置按钮',
    !layout.settingsInRight && !layout.themeInRight,
    JSON.stringify({ settingsInRight: layout.settingsInRight, themeInRight: layout.themeInRight })
  )
  check(
    '通知铃铛在右侧状态组、并且是最后一个入口',
    layout.bellInActions && layout.bellIsLast,
    JSON.stringify({ bellInActions: layout.bellInActions, bellIsLast: layout.bellIsLast })
  )
  check(
    '铃铛贴着状态栏最右边',
    layout.bell !== null && layout.bell.right >= layout.bar.right - 12 && layout.bell.left > layout.viewportWidth / 2,
    JSON.stringify({ bell: layout.bell, bar: layout.bar, viewportWidth: layout.viewportWidth })
  )
  check('未读时铃铛的提示会报出条数', layout.bellTitle === '通知', layout.bellTitle)

  console.log('\n[B] 小框:空状态、右下角定位、开合方式')

  check('初始没有通知小框', !(await evalJs<boolean>(`!!document.querySelector('.notif-panel')`)))
  check('能点中通知铃铛', await click('.status-notify'))
  check('小框出现在右下角', await waitFor(`document.querySelector('.notif-panel')`, 3000))

  const panelBox = await evalJs<{
    left: number
    right: number
    top: number
    bottom: number
    empty: string
    itemCount: number
    hasClear: boolean
    toastHidden: boolean
  } | null>(`
    (() => {
      const p = document.querySelector('.notif-panel')
      if (!p) return null
      const b = p.getBoundingClientRect()
      const host = document.querySelector('.toast-host')
      return {
        left: b.left, right: b.right, top: b.top, bottom: b.bottom,
        empty: (p.querySelector('.notif-empty') || {}).textContent?.trim() || '',
        itemCount: p.querySelectorAll('.notif-item').length,
        hasClear: !!p.querySelector('.notif-clear'),
        toastHidden: host ? getComputedStyle(host).display === 'none' : true
      }
    })()`)

  check('空状态写着「暂无通知」', panelBox?.empty === '暂无通知' && panelBox?.itemCount === 0, JSON.stringify(panelBox))
  check('没有历史时不显示「清空」', panelBox?.hasClear === false, JSON.stringify(panelBox))
  check(
    '小框贴在窗口右下角(状态栏上方)',
    panelBox !== null &&
      panelBox.right <= layout.viewportWidth &&
      panelBox.right >= layout.viewportWidth - 30 &&
      panelBox.bottom > layout.bar.top - 60 &&
      panelBox.bottom <= layout.bar.top &&
      panelBox.left > layout.viewportWidth / 2,
    JSON.stringify({ panelBox, barTop: layout.bar.top, viewportWidth: layout.viewportWidth })
  )
  check('小框打开时收起右下角气泡', panelBox?.toastHidden === true, JSON.stringify(panelBox))

  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  check('按 Esc 收起小框', await waitFor(`!document.querySelector('.notif-panel')`, 2000))

  check('再点铃铛能打开', await click('.status-notify') && (await waitFor(`document.querySelector('.notif-panel')`, 2000)))
  check('点铃铛本身只收起、不会再弹开', await click('.status-notify') && (await waitFor(`!document.querySelector('.notif-panel')`, 2000)))

  console.log('\n[C] 插件通知:未读角标、来源标签、打开即已读')

  check('探针命令执行成功', await firePluginNotice('probe-notify'))
  check('铃铛冒出未读角标 1', (await waitFor(`document.querySelector('.status-notify-badge')`, 3000)) && (await badgeText()) === '1', String(await badgeText()))
  check(
    '铃铛提示变成「1 条未读」',
    (await evalJs<string | null>(`document.querySelector('.status-notify')?.getAttribute('title') ?? null`)) === '通知（1 条未读）'
  )
  check(
    '气泡里出现插件通知',
    await waitFor(
      `(() => { const t = document.querySelector('.toast'); return !!t && t.textContent.includes(${JSON.stringify(PLUGIN_TEXT)}) && t.textContent.includes(${JSON.stringify(PROBE_NAME)}) })()`,
      3000
    )
  )

  await click('.status-notify')
  check('打开小框', await waitFor(`document.querySelector('.notif-panel')`, 2000))
  let items = await panelItems()
  check('小框里有一条插件通知', items.length === 1, JSON.stringify(items))
  check(
    '插件通知带「插件」来源标签、标题是插件名',
    items[0]?.source === '插件' && items[0]?.name === PROBE_NAME && items[0]?.message === PLUGIN_TEXT,
    JSON.stringify(items)
  )
  // v2 的 showInformationMessage 没有 success 这一档;info 是它与通知中心的对应等级
  check('通知等级沿用扩展消息的 info', items[0]?.levelClass === 'notif-info', JSON.stringify(items[0]))
  check('打开后未读角标消失', (await waitFor(`!document.querySelector('.status-notify-badge')`, 2000)))

  // 小框开着时来的通知:直接算已读,不再让铃铛冒红点
  check('小框开着时再发一条', await firePluginNotice('probe-notify-2'))
  check('列表立刻多出第二条', await waitFor(`document.querySelectorAll('.notif-panel .notif-item').length === 2`, 3000))
  check('小框开着时不累计未读角标', (await badgeText()) === null, String(await badgeText()))
  items = await panelItems()
  check(
    '第二条在最上面(新的在前)',
    items[0]?.message === PLUGIN_TEXT_2 && items[0]?.source === '插件',
    JSON.stringify(items)
  )

  await click('.status-notify')
  check('点铃铛收起小框', await waitFor(`!document.querySelector('.notif-panel')`, 2000))

  console.log('\n[D] 浏览器通知:new Notification 也进历史')

  const browser = await evalJs<{ hasCtor: boolean; threw: string }>(`
    (() => {
      if (typeof window.Notification !== 'function') return { hasCtor: false, threw: '' }
      try {
        new Notification(${JSON.stringify(BROWSER_TITLE)}, { body: ${JSON.stringify(BROWSER_BODY)} })
        return { hasCtor: true, threw: '' }
      } catch (err) {
        // 记录发生在构造之前:即使系统通知发不出去,历史里也应该有这一条
        return { hasCtor: true, threw: String(err && err.message || err) }
      }
    })()`)
  check('页面里能构造浏览器通知', browser.hasCtor, JSON.stringify(browser))
  if (browser.threw) console.log(`    (系统通知构造报了错,但不该影响历史:${browser.threw})`)

  check('浏览器通知累计未读角标 1', (await waitFor(`document.querySelector('.status-notify-badge')`, 3000)) && (await badgeText()) === '1', String(await badgeText()))
  await click('.status-notify')
  check('打开小框看历史', await waitFor(`document.querySelector('.notif-panel')`, 2000))
  items = await panelItems()
  check('历史里现在有三条', items.length === 3, JSON.stringify(items))
  check(
    '浏览器通知带「浏览器」来源标签,标题与正文都在',
    items[0]?.source === '浏览器' && items[0]?.name === BROWSER_TITLE && items[0]?.message === BROWSER_BODY,
    JSON.stringify(items)
  )

  console.log('\n[E] 清空与点外面收起')

  check('有历史时出现「清空」', await evalJs<boolean>(`!!document.querySelector('.notif-clear')`))
  check('能点中「清空」', await click('.notif-clear'))
  check(
    '清空后回到空状态',
    (await waitFor(`document.querySelector('.notif-empty')`, 2000)) &&
      (await evalJs<number>(`document.querySelectorAll('.notif-item').length`)) === 0
  )
  check('清空后「清空」按钮也消失', !(await evalJs<boolean>(`!!document.querySelector('.notif-clear')`)))
  check('清空后没有未读角标', (await badgeText()) === null, String(await badgeText()))

  check('小框仍然开着', await evalJs<boolean>(`!!document.querySelector('.notif-panel')`))
  await evalJs(`document.querySelector('.cm-content')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  check('点小框外面收起小框', await waitFor(`!document.querySelector('.notif-panel')`, 2000))

  check('收起来后铃铛能再次打开', await click('.status-notify') && (await waitFor(`document.querySelector('.notif-panel')`, 2000)))
  await click('.status-notify')

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[notification] 意外失败:', err)
  app.exit(1)
})
