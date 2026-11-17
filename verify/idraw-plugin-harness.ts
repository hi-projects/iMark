/**
 * 验收:iDraw **内置**插件。
 *
 * 不手动解包任何文件,而是走与真实启动相同的路径:
 * `ensureBundledProvisioned()` 从 `src/main/market/builtin/` 补装扩展包,
 * 然后按用户的真实路径走一遍:
 *
 *   1 文件树「新建画布」→ 先问名称 → 文件先落盘,标签里挂载整个 iDraw 应用
 *   2 点模板卡片 → 5 节点 / 4 连线,标签出现未保存圆点
 *   3 「保存画布」→ 不弹路径框,直接写回创建时的 SVG
 *   4 再次「新建画布」仍先问名称;「打开画布」→ 快速选择里重新打开,节点恢复
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

  console.log('\n【1】文件树左上角「新建画布」先问名称,再打开编辑区标签页')
  check(
    '文件树出现新建画布按钮',
    await waitFor("document.querySelector('.explorer-actions button[title=\"新建画布\"]')", 8000)
  )
  await evalJs("document.querySelector('.explorer-actions button[title=\"新建画布\"]')?.click()")
  check('先弹出名称输入框', await waitFor("document.querySelector('.ext-dialog-input')", 8000))
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
  const created = join(vault, 'flow.svg')
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
  check('空画布模板卡片可见', await waitForInFrame("document.querySelector('.canvas-empty')"))

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
  const saved = join(vault, 'flow.svg')
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

  console.log('\n【4】再次新建仍先问名称;之后重新打开已有画布')
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
  const scratch = join(vault, 'scratch.svg')
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
  check('选择 flow.svg', await pickPath('flow.svg'))
  check(
    '重新打开恢复 5 个节点',
    await waitForInFrame("document.querySelectorAll('[data-idraw-node]').length === 5")
  )
  check(
    '标签标题显示文件名',
    await waitFor("document.querySelector('.tab-active .tab-title')?.textContent?.includes('flow.svg')")
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

  console.log('\n【6】插件跟随 iMark 主题')
  const lightBg = await inFrame<string>(
    "getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()"
  )
  await evalJs("document.querySelector('.status-bar button[title*=\"主题\"]')?.click()")
  check(
    '插件根节点切到深色',
    await waitForInFrame("document.documentElement.dataset.theme === 'dark'")
  )
  const darkBg = await inFrame<string>(
    "getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()"
  )
  check('插件使用 iMark 的深色变量', darkBg !== lightBg && darkBg.length > 0, `${lightBg} → ${darkBg}`)
  await evalJs("document.querySelector('.status-bar button[title*=\"主题\"]')?.click()")
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
