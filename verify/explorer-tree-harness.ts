/**
 * 验收:文件树的两件事 —— Obsidian 风格的层级引导线,以及侧栏开关的滑动动画。
 *
 *   A 每行按自身深度画 depth 条竖线,位置与该层目录的展开箭头对齐(8 + (n-1)*14)
 *   B 竖线宽 1px 且撑满行高 —— 相邻行接起来才是连续的一条
 *   C 列表面板收起/展开时宽度逐帧变化,而不是瞬间 display:none
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs explorer-tree
 *
 * 窗口必须保持**显示**状态(与 outline 用例相同):逐帧采样靠 requestAnimationFrame,
 * 隐藏的窗口会被 Chromium 节流。xvfb-run 把窗口放在虚拟屏幕上,不会弹到桌面。
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
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

interface RowShape {
  name: string
  isDir: boolean
  paddingLeft: number
  height: number
  /** 展开箭头相对行左缘的位置;文件行没有箭头 */
  chevron: { left: number; width: number } | null
  guides: { left: number; width: number; height: number }[]
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs explorer-tree` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await rm(vault, { recursive: true, force: true })
  await mkdir(join(vault, '第一章', '子节'), { recursive: true })
  await mkdir(join(vault, '第二章'), { recursive: true })
  await writeFile(join(vault, '根文件.md'), '# 根文件\n', 'utf8')
  await writeFile(join(vault, '第一章', '1.1.md'), '# 1.1\n', 'utf8')
  await writeFile(join(vault, '第一章', '子节', '1.1.1.md'), '# 1.1.1\n', 'utf8')
  await writeFile(join(vault, '第二章', '2.1.md'), '# 2.1\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: null,
        marketUrl: '',
        explorer: true,
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  // 用 JSON 过一道:executeJavaScript 的结构化克隆对某些 DOM 派生对象不友好
  const snapRows = async (): Promise<RowShape[]> =>
    JSON.parse(
      await evalJs<string>(`JSON.stringify(
        [...document.querySelectorAll('.explorer-item')]
          .filter(el => !el.classList.contains('explorer-editing'))
          .map(el => {
            const r = el.getBoundingClientRect()
            const chev = el.querySelector('.explorer-chevron')
            return {
              name: (el.querySelector('.explorer-name')?.textContent || '').trim(),
              isDir: !!chev,
              paddingLeft: Math.round(parseFloat(getComputedStyle(el).paddingLeft)),
              height: Math.round(r.height),
              chevron: chev ? (() => {
                const cr = chev.getBoundingClientRect()
                return { left: cr.left - r.left, width: cr.width }
              })() : null,
              guides: [...el.querySelectorAll('.explorer-guide')].map(g => {
                const gr = g.getBoundingClientRect()
                return {
                  left: Math.round(gr.left - r.left),
                  width: Math.round(gr.width),
                  height: Math.round(gr.height)
                }
              })
            }
          })
      )`)
    )

  // 仓库加载后会自动展开第一层目录
  check(
    '文件树:列出第一层与已展开的子项',
    await waitFor(`[...document.querySelectorAll('.explorer-name')].some(e => e.textContent.trim() === '1.1.md')`)
  )
  await sleep(300)

  // 展开第二层目录「子节」,造出 depth=2 的行
  const clicked = await evalJs<boolean>(`(() => {
    const row = [...document.querySelectorAll('.explorer-item')]
      .find(el => (el.querySelector('.explorer-name')?.textContent || '').trim() === '子节')
    if (!row) return false
    row.click()
    return true
  })()`)
  check('文件树:找到并展开第二层目录', clicked)
  check('文件树:第三层文件出现', await waitFor(`[...document.querySelectorAll('.explorer-name')].some(e => e.textContent.trim() === '1.1.1.md')`))
  await sleep(300)

  const rows = await snapRows()
  // rows 的 depth 从 1 起(仓库根的直接子项 = 1)
  const wantDepth: Record<string, number> = {
    第一章: 1,
    '1.1.md': 2,
    子节: 2,
    '1.1.1.md': 3,
    第二章: 1,
    '2.1.md': 2,
    根文件: 1,
    '根文件.md': 1
  }
  // 名字里的扩展名不固定,按「去掉 .md」匹配
  const depthOf = (name: string): number | undefined => wantDepth[name] ?? wantDepth[name.replace(/\.md$/, '')]

  const countOk = rows.every(r => {
    const d = depthOf(r.name)
    return d != null && r.guides.length === d - 1
  })
  check(
    '引导线:每行条数 = 所在深度 - 1',
    countOk,
    rows.map(r => `${r.name}:${r.guides.length}(depth=${depthOf(r.name)})`).join(' ')
  )

  const leftsOk = rows.every(r => {
    const d = depthOf(r.name) ?? 1
    // 祖先 depth 为 1..d-1,竖线落在 13px 展开箭头的中心(左缘 + 6)
    const want = Array.from({ length: d - 1 }, (_, i) => 8 + (i + 1) * 14 + 6)
    return r.guides.map(g => g.left).join(',') === want.join(',')
  })
  check(
    '引导线:水平位置对齐各层展开箭头',
    leftsOk,
    rows.map(r => `${r.name}=[${r.guides.map(g => g.left).join(',')}]`).join(' ')
  )

  // 严格对齐:竖线中心 == 祖先目录那枚 13px 展开箭头的中心
  const parents: Record<string, string[]> = {
    '1.1.md': ['第一章'],
    子节: ['第一章'],
    '1.1.1.md': ['第一章', '子节'],
    '2.1.md': ['第二章'],
    '根文件.md': []
  }
  const chevronBy = new Map(rows.filter(r => r.chevron).map(r => [r.name, r.chevron!]))
  const alignDetail: string[] = []
  const alignOk = rows.every(r => {
    const chain = parents[r.name] ?? []
    return r.guides.every((g, i) => {
      const anc = chevronBy.get(chain[i] ?? '')
      if (!anc) {
        alignDetail.push(`${r.name}[${i}] 找不到祖先箭头`)
        return false
      }
      const arrowCenter = anc.left + anc.width / 2
      const guideCenter = g.left + g.width / 2
      if (Math.abs(arrowCenter - guideCenter) > 0.6) {
        alignDetail.push(`${r.name}[${i}] 线=${guideCenter} 箭头=${arrowCenter}`)
        return false
      }
      return true
    })
  })
  check('引导线:严格落在祖先展开箭头中心', alignOk, alignDetail.join('; '))

  const spansOk = rows.every(r => r.guides.every(g => Math.abs(g.height - r.height) <= 1))
  check(
    '引导线:撑满行高(相邻行相连)',
    spansOk,
    rows.map(r => `${r.name}:${r.guides.map(g => `${g.height}/${r.height}`).join(',')}`).join(' ')
  )

  const widthOk = rows.every(r => r.guides.every(g => g.width === 1))
  check('引导线:宽 1px', widthOk)

  // ---------- 侧栏开关:宽度滑动过渡 ----------
  const explorerWidth = (): Promise<number> =>
    evalJs<number>(`(() => {
      const el = document.querySelector('.explorer')
      return el ? Math.round(el.getBoundingClientRect().width) : 0
    })()`)

  const clickExplorerToggle = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const btn = [...document.querySelectorAll('.status-toggles button')]
        .find(b => (b.title || '').includes('文件列表'))
      if (!btn) return false
      btn.click()
      return true
    })()`)

  const sampleWidths = (): Promise<number[]> =>
    evalJs<number[]>(`new Promise(resolve => {
      const out = []
      const t0 = performance.now()
      const tick = () => {
        const el = document.querySelector('.explorer')
        out.push(el ? Math.round(el.getBoundingClientRect().width) : 0)
        if (performance.now() - t0 < 500) requestAnimationFrame(tick)
        else resolve(out)
      }
      requestAnimationFrame(tick)
    })`)

  const isDisplayed = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = document.querySelector('.explorer')
      return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0
    })()`)

  const fullWidth = await explorerWidth()
  check('动画:开始时文件树可见且宽度 > 0', (await isDisplayed()) && fullWidth > 100, `width=${fullWidth}`)
  check('动画:找到状态栏的文件列表开关', await clickExplorerToggle())

  const closing = await sampleWidths()
  await sleep(120)
  const inBetweenClose = closing.some(w => w > 0 && w < fullWidth)
  console.log(`    收起宽度采样:${closing.slice(0, 12).join(',')} … ${closing.slice(-4).join(',')}`)
  check('动画:收起过程中出现中间宽度(滑动而非瞬间消失)', inBetweenClose, closing.join(','))
  check('动画:收起后文件树隐藏', !(await isDisplayed()))
  check('动画:收起后宽度归零', (await explorerWidth()) === 0, `width=${await explorerWidth()}`)

  check('动画:再次点击展开', await clickExplorerToggle())
  const opening = await sampleWidths()
  await sleep(120)
  const reopenedWidth = await explorerWidth()
  const inBetweenOpen = opening.some(w => w > 0 && w < fullWidth)
  console.log(`    展开宽度采样:${opening.slice(0, 12).join(',')} … ${opening.slice(-4).join(',')}`)
  check('动画:展开过程中出现中间宽度(滑动而非瞬间出现)', inBetweenOpen, opening.join(','))
  check('动画:展开后恢复到原宽度', Math.abs(reopenedWidth - fullWidth) <= 1, `${reopenedWidth} vs ${fullWidth}`)

  console.log(`\n[explorer-tree] ${pass} 通过, ${fail} 失败`)
  win.destroy()
  app.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
