/**
 * 验收:iDraw **内置**插件。
 *
 * 不手动解包任何文件,而是走与真实启动相同的路径:
 * `ensureBundledProvisioned()` 从 `src/main/market/builtin/` 补装扩展包,
 * 然后按用户的真实路径走一遍:
 *
 *   1 笔记行首「+」→「画布」→ 先问名称 → 文件先落盘,图像插在「+」所在行,
 *     标签里挂载整个 iDraw 应用;文件树不再有「新建画布」按钮
 *   2 点模板卡片 → 5 节点 / 4 连线,标签出现未保存圆点
 *   3 「保存画布」→ 不弹路径框,直接写回创建时的 SVG
 *   4 命令面板的「新建画布」仍先问名称;「打开画布」→ 快速选择里重新打开,节点恢复
 *   5 与文件标签互切:切走时面板隐藏但 iframe 保留,切回恢复在同一张画布
 *   6 插件跟随 iMark 主题
 *   7 打开普通 SVG → 只读预览,不出现可编辑画布
 *   8 关闭画布标签 → 面板销毁
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs idraw-plugin
 */

import { app, BrowserWindow, dialog, protocol, type WebFrameMain } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { EXTENSION_WEBVIEW_SCHEME } from '../src/shared/extensionProtocol'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { registerExtensionWebviewProtocol } from '../src/main/extensions/webviewProtocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'
import { APP_VERSION } from './appVersion'

const EXT_ID = 'idraw.canvas'
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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

const FOREIGN_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
  <rect x="10" y="10" width="180" height="100" fill="#eef" stroke="#334" stroke-width="2"/>
  <text x="100" y="65" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#223">外部 SVG</text>
</svg>
`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs idraw-plugin` 跑会自动带上）')
    app.exit(2)
    return
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'imark',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    {
      scheme: EXTENSION_WEBVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])

  await app.whenReady()
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await rm(join(ud, 'extensions-data'), { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '# 图表\n\n![](diagram.svg)\n', 'utf8')
  await writeFile(join(vault, 'foreign.svg'), FOREIGN_SVG, 'utf8')
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
  registerExtensionWebviewProtocol()
  const settings = await loadSettings()
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  // 与真实启动完全一致的补装路径;不手动解包,内置包坏了这里就会失败
  await ensureBundledProvisioned(service)
  const idrawView = service.listExtensions().find(view => view.descriptor.id === EXT_ID)
  check(
    '内置扩展已补装并默认启用',
    idrawView?.source === 'bundled' && idrawView.enabled === true,
    idrawView ? `source=${idrawView.source} enabled=${idrawView.enabled}` : '未安装'
  )
  const contribs = service.getContributions()
  check(
    '插件设置页没有「打开画布 / 新建画布」动作按钮',
    contribs.actions.every(action => action.extensionId !== EXT_ID),
    JSON.stringify(contribs.actions.filter(action => action.extensionId === EXT_ID))
  )
  check(
    '命令面板里的画布命令仍然保留',
    contribs.commands.some(item => item.command === 'idraw.canvas.open') &&
      contribs.commands.some(item => item.command === 'idraw.canvas.new')
  )
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolveReady => wc.once('did-finish-load', () => resolveReady()))
  await sleep(1200)
  await service.startup()

  for (const view of service.listExtensions()) {
    console.log(
      `[ext] ${view.descriptor.id} enabled=${view.enabled} source=${view.source}` +
        (view.loadError ? ` loadError=${view.loadError}` : '')
    )
  }

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 10000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  function frame(): WebFrameMain | null {
    return (
      wc.mainFrame.framesInSubtree.find(item =>
        item.url.startsWith(`imark-webview://${EXT_ID}`)
      ) ??
      null
    )
  }

  async function waitForFrame(ms = 12000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const target = frame()
      if (target) {
        try {
          const ready = await target.executeJavaScript(
            "!!document.querySelector('.canvas-pane')",
            true
          )
          if (ready) return true
        } catch {
          /* 页面还在加载 */
        }
      }
      await sleep(100)
    }
    return false
  }

  async function inFrame<T>(code: string): Promise<T> {
    const target = frame()
    if (!target) throw new Error('webview frame 不存在')
    return (await target.executeJavaScript(code, true)) as T
  }

  async function waitForInFrame(code: string, ms = 10000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if (await inFrame<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
          return true
        }
      } catch {
        /* frame 可能正在重载 */
      }
      await sleep(80)
    }
    return false
  }

  async function fillInput(value: string): Promise<boolean> {
    if (!(await waitFor("document.querySelector('.ext-dialog-input')", 8000))) return false
    await evalJs(`(() => {
      const input = document.querySelector('.ext-dialog-input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, ${JSON.stringify(value)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return input.value
    })()`)
    await sleep(80)
    return true
  }

  async function confirmDialog(): Promise<void> {
    await evalJs("document.querySelector('.ext-dialog .line-dialog-primary')?.click()")
    await sleep(80)
  }

  async function pickPath(path: string): Promise<boolean> {
    if (!(await fillInput(path))) return false
    await sleep(120)
    const clicked = await evalJs<boolean>(`(() => {
      const items = [...document.querySelectorAll('.ext-dialog-item')]
      const hit = items.find(item => item.textContent?.includes(${JSON.stringify(path)}))
      if (!hit) return false
      hit.click()
      return true
    })()`)
    if (!clicked) {
      // 没有匹配条目时回车会选中当前项;再兜底点一次「确定」
      await evalJs(
        "document.querySelector('.ext-dialog-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
      )
      await confirmDialog()
    }
    await sleep(120)
    return clicked
  }

  const click = (sel: string): Promise<boolean> =>
    evalJs<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`
    )

  const clickTab = (title: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const tab = [...document.querySelectorAll('.tab')]
        .find(item => item.querySelector('.tab-title')?.textContent?.includes(${JSON.stringify(title)}))
      if (!tab) return false
      tab.click()
      return true
    })()`)

  console.log('\n【1】笔记行首「+」→「画布」:先问名称,再插入图像并打开标签页')
  check(
    '文件树不再有「新建画布」按钮',
    await evalJs<boolean>(
      "document.querySelector('.explorer-actions button[title=\"新建画布\"]') === null"
    )
  )
  check('行首「+」出现', await waitFor("document.querySelector('.line-plus')", 8000))
  check(
    '「+」在光标行(第 1 行)',
    (await evalJs<number>(`(() => {
      const plus = document.querySelector('.line-plus')
      return plus ? Number(plus.dataset.line) : -1
    })()`)) === 1
  )
  check('「+」点得开', await click('.line-plus'))
  check('菜单里有「画布」', await waitFor("document.querySelector('.line-menu-item')", 4000))
  check(
    '点「画布」',
    await evalJs<boolean>(`(() => {
      const el = [...document.querySelectorAll('.line-menu-item')]
        .find(item => item.textContent?.trim() === '画布')
      if (!el) return false
      el.click()
      return true
    })()`)
  )
  check('先弹出名称输入框', await waitFor("document.querySelector('.ext-dialog-input')", 8000))
  check(
    '输入框占位文字是「输入画布名称」',
    await evalJs<boolean>(
      "document.querySelector('.ext-dialog-input')?.placeholder === '输入画布名称'"
    )
  )
  check(
    '标注收进标题旁的小问号,说明在 aria-label 里',
    await evalJs<boolean>(`(() => {
      const el = document.querySelector('.ext-dialog-head .ext-dialog-help')
      if (!el || !el.querySelector('svg')) return false
      // 空 title 压住原生提示,说明改由主题化浮层展示
      if (el.getAttribute('title') !== '') return false
      return el.getAttribute('aria-label') === '画布会保存到仓库的 .assets 目录'
    })()`)
  )
  check(
    '标注不再作为正文占一行',
    await evalJs<boolean>("document.querySelector('.ext-dialog-prompt') === null")
  )
  await evalJs(
    "document.querySelector('.ext-dialog-head .ext-dialog-help')?.dispatchEvent(new MouseEvent('mouseenter'))"
  )
  check(
    '悬停弹出主题化说明浮层',
    await waitFor(
      "document.querySelector('.plugin-help-tip')?.textContent?.trim() === '画布会保存到仓库的 .assets 目录'",
      4000
    )
  )
  check(
    '说明浮层用应用样式而不是原生白框',
    await evalJs<boolean>(`(() => {
      const el = document.querySelector('.plugin-help-tip')
      if (!el) return false
      const style = getComputedStyle(el)
      return style.position === 'fixed' && style.fontSize === '11.5px' && style.zIndex === '150'
    })()`)
  )
  // 字形在行框里的位置由字体度量决定,没有 DOM API 能直接拿到墨迹边界,
  // 所以截一张浮层的位图,按亮度加权量字形落点是不是真的居中
  const tipBox = await evalJs<{
    x: number
    y: number
    width: number
    height: number
    bg: string
  } | null>(`(() => {
      const el = document.querySelector('.plugin-help-tip')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        bg: getComputedStyle(el).backgroundColor
      }
    })()`)
  let tipOffset: number | null = null
  if (tipBox) {
    try {
      const shot = await wc.capturePage({
        x: Math.round(tipBox.x),
        y: Math.round(tipBox.y),
        width: Math.round(tipBox.width),
        height: Math.round(tipBox.height)
      })
      const size = shot.getSize()
      const bmp = shot.toBitmap()
      const rgb = tipBox.bg.match(/\d+/g)?.map(Number) ?? []
      const bgLum = rgb.length >= 3 ? 0.114 * rgb[2] + 0.587 * rgb[1] + 0.299 * rgb[0] : 128
      let weight = 0
      let weightedY = 0
      // 裁掉最外几行:边框和圆角的抗锯齿不属于文字
      for (let y = 3; y < size.height - 3; y++) {
        let row = 0
        for (let x = 3; x < size.width - 3; x++) {
          const i = (y * size.width + x) * 4
          const lum = 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]
          const diff = Math.abs(lum - bgLum)
          if (diff > 12) row += diff
        }
        weight += row
        weightedY += row * (y + 0.5)
      }
      if (weight > 0) {
        const scale = size.height / tipBox.height
        tipOffset = Math.round(((weightedY / weight - size.height / 2) / scale) * 10) / 10
      }
    } catch {
      /* 无头环境偶尔截不到,不影响断言 */
    }
  }
  check(
    '说明文字在浮层内垂直居中',
    tipOffset !== null && Math.abs(tipOffset) <= 1,
    `字形中心相对盒中心偏移 ${tipOffset}px`
  )
  await evalJs(
    "document.querySelector('.ext-dialog-head .ext-dialog-help')?.dispatchEvent(new MouseEvent('mouseleave'))"
  )
  await sleep(80)
  check(
    '移出问号后说明浮层收起',
    await evalJs<boolean>("document.querySelector('.plugin-help-tip') === null")
  )
  // 人盯着输入框想久一点是正常的；旧实现 20 秒就判「宿主请求 inputBox.show 超时」
  await sleep(21000)
  check(
    '输入框停留 21 秒不会报宿主请求超时',
    await evalJs<boolean>(
      "![...document.querySelectorAll('.toast-message')].some(el => el.textContent?.includes('超时'))"
    )
  )
  check('停留后输入框仍在', await evalJs<boolean>("document.querySelector('.ext-dialog-input') !== null"))
  check('输入画布名称', await fillInput('flow.svg'))
  await confirmDialog()
  check('webview iframe 出现', await waitFor("document.querySelector('iframe.webview-frame')", 8000))
  // iframe 刚插入时 URL 还是 about:blank,等它导航到扩展协议再断言归属
  const mounted = await waitForFrame()
  check('iframe 属于 idraw.canvas', mounted, frame()?.url ?? '')
  check(
    '面板是 tab',
    await evalJs<boolean>(
      "document.querySelector('.webview-panel')?.classList.contains('webview-panel-tab') === true"
    )
  )
  check(
    '标签栏出现画布标签并激活,标题就是刚输入的名字',
    await waitFor("document.querySelector('.tab-active .tab-title')?.textContent === 'flow.svg'")
  )
  // 新建即落盘:与「新建文件」一致,名字确认的那一刻文件就存在
  const created = join(vault, '.assets', 'flow.svg')
  const createdOk = await (async () => {
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (existsSync(created)) return true
      await sleep(80)
    }
    return false
  })()
  check('创建时文件就已经写到仓库', createdOk, created)
  const blank = createdOk ? await readFile(created, 'utf8') : ''
  check('空白文件是标准 iDraw 画布骨架', blank.includes('data-idraw-canvas="1"'))
  check(
    '画布标签没有面板自带的标题栏',
    await evalJs<boolean>(
      "(() => { const el = document.querySelector('.webview-panel-tab .webview-titlebar'); return !!el && getComputedStyle(el).display === 'none' })()"
    )
  )
  check('iDraw 应用挂载完成', mounted)
  check('空画布模板卡片可见', await waitForInFrame("document.querySelector('.canvas-welcome')"))

  // 回到笔记:图像要插在点「+」的那一行,并从磁盘加载出刚建好的画布
  check('点回笔记标签', await clickTab('笔记'))
  wc.send(IPC.MenuCommand, 'file:save')
  await sleep(900)
  const noteText = await readFile(note, 'utf8')
  check(
    '画布图像插在点「+」的下一段,alt 与画布文件名一致',
    noteText.split('\n').findIndex(line => line.includes('![flow](')) === 2 &&
      noteText.includes('![flow](.assets/flow.svg)'),
    noteText.replace(/\n/g, '⏎')
  )
  check(
    '笔记里的画布图像加载成功',
    await waitFor(
      "[...document.querySelectorAll('.cm-md-image img')].some(img => img.complete && img.naturalWidth === 1600)",
      8000
    )
  )
  check(
    'SVG 图片右上角有「在画布中打开」',
    await waitFor(
      "[...document.querySelectorAll('.cm-md-image')].some(el => el.querySelector('.cm-md-svg-edit') && el.querySelector('img')?.naturalWidth === 1600)",
      5000
    )
  )
  check(
    '点图片按钮回到画布',
    await evalJs<boolean>(`(() => {
      const wrap = [...document.querySelectorAll('.cm-md-image')]
        .find(el => el.querySelector('img')?.naturalWidth === 1600)
      const btn = wrap?.querySelector('.cm-md-svg-edit')
      if (!btn) return false
      btn.click()
      return true
    })()`)
  )
  await sleep(400)
  check(
    '按图片路径直接打开,不弹选择画布',
    await evalJs<boolean>("!document.querySelector('.ext-dialog-list')")
  )
  check(
    '画布标签重新激活',
    await waitFor("document.querySelector('.tab-active .tab-title')?.textContent?.includes('flow.svg')", 8000)
  )

  console.log('\n【1a】同名画布在名称输入框内报错,不再弹通知')
  check('回到笔记', await clickTab('笔记'))
  check('「+」点得开', await click('.line-plus'))
  check(
    '点「画布」',
    await evalJs<boolean>(`(() => {
      const el = [...document.querySelectorAll('.line-menu-item')]
        .find(item => item.textContent?.trim() === '画布')
      if (!el) return false
      el.click()
      return true
    })()`)
  )
  check('再次弹出名称输入框', await waitFor("document.querySelector('.ext-dialog-input')", 8000))
  check('输入已存在的名称', await fillInput('flow.svg'))
  check(
    '输入框下方出现同名错误',
    await waitFor("document.querySelector('.ext-dialog-error')?.textContent?.includes('已存在')", 8000)
  )
  check(
    '没有弹出同名通知气泡',
    await evalJs<boolean>(
      "![...document.querySelectorAll('.toast-message')].some(el => el.textContent?.includes('已存在'))"
    )
  )
  await confirmDialog()
  await sleep(300)
  check(
    '有错误时按确定不会关闭对话框,也不会新建',
    await evalJs<boolean>(
      "document.querySelector('.ext-dialog-input') !== null && document.querySelector('.ext-dialog-error')?.textContent?.includes('已存在') === true"
    )
  )
  await evalJs("document.querySelector('.ext-dialog .line-dialog-btn:not(.line-dialog-primary)')?.click()")
  await sleep(200)
  check('取消后对话框关闭', await evalJs<boolean>("document.querySelector('.ext-dialog-input') === null"))
  check('回到画布标签', await clickTab('flow.svg'))

  console.log('\n【1b】工具栏精简为「插入」,分组形状浮层在上方展开')
  const toolbar = await inFrame<{
    insert: boolean
    file: number
    tools: number
    undo: number
    exportIcon: number
  }>(`(() => {
    const bar = document.querySelector('.canvas-toolbar')
    if (!bar) return { insert: false, file: -1, tools: -1, undo: -1, exportIcon: -1 }
    return {
      insert: [...bar.querySelectorAll('button')].some(b => b.textContent.trim() === '插入'),
      file: bar.querySelectorAll(
        'button[title^="新建 (Ctrl+N)"], button[title^="打开 (Ctrl+O)"], button[title^="保存 (Ctrl+S)"]'
      ).length,
      tools: bar.querySelectorAll(
        'button[title^="选择 (V)"], button[title^="平移 (H"], button[title^="连接线 (L)"], button[title^="文本 (T)"]'
      ).length,
      undo: bar.querySelectorAll('button[title^="撤销"], button[title^="重做"]').length,
      exportIcon: bar.querySelectorAll('button[title^="导出"]').length
    }
  })()`)
  check('工具栏仍有「插入」', toolbar.insert, JSON.stringify(toolbar))
  check('去掉新建 / 打开 / 保存图标', toolbar.file === 0, String(toolbar.file))
  check('去掉选择 / 平移 / 连线 / 文本图标', toolbar.tools === 0, String(toolbar.tools))
  check('去掉撤销 / 重做图标', toolbar.undo === 0, String(toolbar.undo))
  check('去掉导出图标', toolbar.exportIcon === 0, String(toolbar.exportIcon))
  await inFrame(
    `[...document.querySelectorAll('.canvas-toolbar button')].find(b => b.textContent.trim() === '插入')?.click()`
  )
  check('插入浮层出现', await waitForInFrame(`document.querySelector('.canvas-insert-panel')`))
  const shapeGroups = await inFrame<string[]>(
    `[...document.querySelectorAll('.canvas-insert-panel .shape-group-title')].map(el => el.textContent.trim())`
  )
  check(
    '分组:文本 / 基本形状 / 其它',
    JSON.stringify(shapeGroups) === JSON.stringify(['文本', '基本形状', '其它']),
    JSON.stringify(shapeGroups)
  )
  const shapeLabels = await inFrame<string[]>(
    `[...document.querySelectorAll('.canvas-insert-panel .shape-item > span:last-child')].map(el => el.textContent.trim())`
  )
  check(
    '包含三角形 / 星形 / 箭头 / 十字',
    ['文本', '矩形', '三角形', '星形', '箭头', '十字'].every(label => shapeLabels.includes(label)),
    JSON.stringify(shapeLabels)
  )
  await inFrame(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  check('Esc 收起插入浮层', await waitForInFrame(`!document.querySelector('.canvas-insert-panel')`))

  console.log('\n【2】插入流程图模板')
  await inFrame("document.querySelector('.canvas-template-item.is-flow')?.click()")
  check('模板产生 5 个节点', await waitForInFrame("document.querySelectorAll('[data-idraw-node]').length === 5"))
  check('模板产生 4 条连线', await waitForInFrame("document.querySelectorAll('[data-idraw-edge]').length === 4"))
  check(
    '画布标签出现未保存圆点',
    await waitFor("document.querySelector('.tab-active.tab-dirty .tab-dot')")
  )

  console.log('\n【3】保存直接写回创建时的 SVG')
  await service.executeCommand('idraw.canvas.save')
  const saved = join(vault, '.assets', 'flow.svg')
  const savedOk = await (async () => {
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (existsSync(saved) && (await readFile(saved, 'utf8')).includes('data-idraw-node="n1"')) {
        return true
      }
      await sleep(80)
    }
    return false
  })()
  check('保存不再询问路径,直接写回创建时的文件', savedOk, saved)
  check(
    '保存全程没有弹路径框',
    await evalJs<boolean>("!document.querySelector('.ext-dialog-input')")
  )
  const text = savedOk ? await readFile(saved, 'utf8') : ''
  check(
    '文件是带 iDraw 标记的标准 SVG',
    text.startsWith('<?xml') && text.includes('data-idraw-canvas="1"') && !text.includes('<style')
  )
  check('保存了 5 个节点', (text.match(/data-idraw-node=/g) ?? []).length === 5)
  check(
    '保存后画布标签不再有未保存圆点',
    await waitFor("!document.querySelector('.tab-active.tab-dirty')")
  )

  console.log('\n【4】命令面板的「新建画布」仍先问名称;之后重新打开已有画布')
  // 新建命令会停在名称输入框上,不能 await,否则测不到输入框
  void service.executeCommand('idraw.canvas.new').catch(() => undefined)
  check('再次新建也先弹名称输入框', await waitFor("document.querySelector('.ext-dialog-input')", 8000))
  check('输入第二个名称', await fillInput('scratch.svg'))
  await confirmDialog()
  check(
    '新建后画布为空',
    await waitForInFrame("document.querySelectorAll('[data-idraw-node]').length === 0")
  )
  check(
    '标签标题换成新名字',
    await waitFor("document.querySelector('.tab-active .tab-title')?.textContent === 'scratch.svg'")
  )
  const scratch = join(vault, '.assets', 'scratch.svg')
  check(
    '第二个文件也立刻落盘',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        if (existsSync(scratch)) return true
        await sleep(80)
      }
      return false
    })()
  )
  // 打开命令要等用户选完才返回;不能 await,否则测不了快速选择
  void service.executeCommand('idraw.canvas.open').catch(() => undefined)
  check('打开画布弹出快速选择', await waitFor("document.querySelector('.ext-dialog-list')"))
  check('选择 flow.svg', await pickPath('.assets/flow.svg'))
  check(
    '重新打开恢复 5 个节点',
    await waitForInFrame("document.querySelectorAll('[data-idraw-node]').length === 5")
  )
  check(
    '标签标题显示文件名',
    await waitFor("document.querySelector('.tab-active .tab-title')?.textContent?.includes('flow.svg')")
  )
  check(
    '打开画布默认 100%,不自动适应内容',
    await waitForInFrame(
      "document.querySelector('.canvas-zoom-label')?.textContent.trim() === '100%'",
      5000
    )
  )

  const editShot = join(ud, 'idraw-plugin-edit.png')
  try {
    const image = await wc.capturePage()
    await writeFile(editShot, image.toPNG())
    console.log(`\n[shot] ${editShot}`)
  } catch {
    /* 无头环境偶尔截不到,不影响断言 */
  }

  console.log('\n【5】画布标签与文件标签互切')
  check(
    '切到笔记后画布面板隐藏',
    await (async () => {
      await evalJs(`(() => {
        const tab = [...document.querySelectorAll('.tab')]
          .find(item => item.querySelector('.tab-title')?.textContent === '笔记')
        tab?.click()
      })()`)
      return waitFor("document.querySelector('.webview-panel-tab')?.classList.contains('webview-panel-hidden')")
    })()
  )
  check(
    '隐藏时 iframe 仍保留(切回不丢画布)',
    await evalJs<boolean>("!!document.querySelector('.webview-panel-tab iframe.webview-frame')")
  )
  await evalJs(`(() => {
    const tab = [...document.querySelectorAll('.tab')]
      .find(item => item.querySelector('.tab-title')?.textContent?.includes('flow.svg'))
    tab?.click()
  })()`)
  check(
    '切回画布标签面板重新显示',
    await waitFor("!document.querySelector('.webview-panel-tab')?.classList.contains('webview-panel-hidden')")
  )
  check(
    '切回后仍是同一张画布',
    await waitForInFrame("document.querySelectorAll('[data-idraw-node]').length === 5")
  )

  console.log('\n【5a】画布文件更新后,切回笔记会重新加载图像')
  const flowOnDisk = await readFile(saved, 'utf8')
  // 笔记显示按 data-idraw-fit 收边;改这个框就能看出图片有没有重新读盘
  await writeFile(saved, flowOnDisk.replace(/data-idraw-fit="[^"]*"/, 'data-idraw-fit="0 0 800 600"'), 'utf8')
  await clickTab('笔记')
  check(
    '图像按磁盘上的最新画布尺寸显示',
    await waitFor(
      "[...document.querySelectorAll('.cm-md-image img')].some(img => img.complete && img.naturalWidth === 800)",
      8000
    )
  )
  await writeFile(saved, flowOnDisk, 'utf8')
  await clickTab('flow.svg')

  console.log('\n【6】插件跟随 iMark 主题')
  const lightBg = await inFrame<string>(
    "getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()"
  )
  // 状态栏的主题按钮已移除:走菜单命令(与 Ctrl+J 同一条渲染层处理路径)
  win.webContents.send(IPC.MenuCommand, 'view:toggle-theme')
  check(
    '插件根节点切到深色',
    await waitForInFrame("document.documentElement.dataset.theme === 'dark'")
  )
  const darkBg = await inFrame<string>(
    "getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()"
  )
  check('插件使用 iMark 的深色变量', darkBg !== lightBg && darkBg.length > 0, `${lightBg} → ${darkBg}`)
  win.webContents.send(IPC.MenuCommand, 'view:toggle-theme')
  check(
    '切回亮色',
    await waitForInFrame("document.documentElement.dataset.theme === 'light'")
  )

  console.log('\n【7】普通 SVG 只读')
  void service.executeCommand('idraw.canvas.open').catch(() => undefined)
  check('再次弹出快速选择', await waitFor("document.querySelector('.ext-dialog-list')"))
  check('选择 foreign.svg', await pickPath('foreign.svg'))
  check(
    '只读预览图片加载成功',
    await waitForInFrame(
      "(() => { const img = document.querySelector('.canvas-readonly-img'); return !!img && img.complete && img.naturalWidth > 0 })()"
    )
  )
  check('没有可编辑画布', await inFrame<boolean>("!document.querySelector('.canvas-svg')"))
  check(
    '只读条说明原因',
    (await inFrame<string>("document.querySelector('.canvas-readonly-bar')?.textContent || ''")).includes('只读')
  )

  const shot = join(ud, 'idraw-plugin.png')
  try {
    const image = await wc.capturePage()
    await writeFile(shot, image.toPNG())
    console.log(`\n[shot] ${shot}`)
  } catch {
    /* 无头环境偶尔截不到,不影响断言 */
  }

  console.log('\n【8】关闭画布标签销毁面板')
  check(
    '点标签上的关闭按钮',
    await (async () => {
      await evalJs(`(() => {
        const tab = [...document.querySelectorAll('.tab')]
          .find(item => item.querySelector('.tab-title')?.textContent?.includes('foreign.svg'))
        tab?.querySelector('.tab-close')?.click()
      })()`)
      return waitFor("!document.querySelector('.tab') || document.querySelectorAll('.tab').length === 1", 8000)
    })()
  )
  check('面板随标签销毁', await waitFor("!document.querySelector('.webview-panel')", 8000))
  check(
    '回到笔记标签',
    await waitFor("document.querySelector('.tab-active .tab-title')?.textContent === '笔记'")
  )

  await shutdownExtensions()
  console.log(`\n${pass} 通过 / ${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error(err)
  app.exit(1)
})
