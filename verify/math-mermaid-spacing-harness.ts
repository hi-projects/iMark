/**
 * 验收:块级公式($$ … $$)与图表(```mermaid)的「上方 / 下方」间距。
 *
 * 期望:
 *   · 公式 / 图表和正文之间那条结构空行挂各自的间距类,默认 1 档 = 16px;
 *   · 圆环里选「公式」自身 / 「图表」自身,面板给出上方、下方两根滑块;
 *   · 拖滑块即时改根变量、空行高度跟着变,并写进 settings.json;
 *   · 正文↔公式 / 正文↔图表 的配对方向映射正确(正文在上 → 上方档,
 *     公式在上 → 下方档),互换按钮换到另一侧;
 *   · 预览样本按公式 / 图表画,不是空白。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs math-mermaid-spacing
 */

import { app, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
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
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const NOTE = [
  '正文甲。',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '正文乙。',
  '',
  '```mermaid',
  'flowchart LR',
  'A --> B',
  '```',
  '',
  '正文丙。',
  ''
].join('\n')

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs math-mermaid-spacing` 跑会自动带上)')
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
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1400)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 10000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(100)
    }
    return false
  }

  const gapHeights = (): Promise<Record<string, number>> =>
    evalJs<Record<string, number>>(`
      (() => {
        const out = {}
        for (const el of document.querySelectorAll('.cm-content .cm-line')) {
          const cls = el.className
          const m = cls.match(/cm-md-block-gap-(math|mermaid)-(before|after)/)
          if (m) out[m[1] + '-' + m[2]] = Math.round(el.getBoundingClientRect().height * 10) / 10
        }
        return out
      })()`)

  // ---------- 1. 默认 1 档:公式 / 图表的上下空行 ----------

  console.log('\n【1】公式与图表上下的结构空行按各自档位收紧(默认 1 档 = 16px)')
  check('公式渲染成块', await waitFor(`document.querySelector('.cm-content .cm-md-math-display')`))
  check('图表渲染成块', await waitFor(`document.querySelector('.cm-content .cm-md-mermaid')`))
  {
    const heights = await gapHeights()
    console.log(`     [实测] ${JSON.stringify(heights)}`)
    check('公式上方 / 下方的空行都在', 'math-before' in heights && 'math-after' in heights, JSON.stringify(heights))
    check('图表上方 / 下方的空行都在', 'mermaid-before' in heights && 'mermaid-after' in heights, JSON.stringify(heights))
    check(
      '默认都是 1 档(16px)',
      Object.values(heights).every(h => Math.abs(h - 16) <= 0.6),
      JSON.stringify(heights)
    )
  }

  // ---------- 2. 圆环:公式自身 / 图表自身 ----------

  console.log('\n【2】圆环里有「公式」「图表」两块,自身配对给出上下两根滑块')
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  check('设置面板打开', await waitFor(`document.querySelector('[data-spacing-preview]')`))
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '样式')
      ?.click()`)
  await sleep(300)
  check(
    '圆环上有公式节点',
    await evalJs<boolean>(`!!document.querySelector('.spacing-ring-node[data-block-node="math"]')`)
  )
  check(
    '圆环上有图表节点',
    await evalJs<boolean>(`!!document.querySelector('.spacing-ring-node[data-block-node="mermaid"]')`)
  )

  async function clickNode(kind: string): Promise<void> {
    await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="${kind}"]')?.click()`)
    await sleep(150)
  }
  async function resetRing(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const state = await evalJs<string>(
        `document.querySelector('[data-spacing-ring]')?.getAttribute('data-ring-state') ?? ''`
      )
      if (state === 'empty') return
      await evalJs(`document.querySelector('[data-spacing-ring] [data-block-role="top"]')?.click()`)
      await sleep(100)
    }
  }
  async function selectSelf(kind: string): Promise<boolean> {
    await resetRing()
    await clickNode(kind)
    await clickNode(kind)
    return waitFor(`document.querySelector('[data-pair-mode="self"]')`, 3000)
  }
  async function selectPair(top: string, bottom: string): Promise<boolean> {
    await resetRing()
    await clickNode(top)
    await clickNode(bottom)
    return waitFor(`document.querySelector('[data-pair-mode="cross"]')`, 3000)
  }
  /** 当前面板上每根滑块对应的字段(side 名,如 mathSpaceBefore) */
  const rows = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('[data-pair-panel] input[type="range"]')].map(i =>
        i.getAttribute('data-block-space') ||
        i.getAttribute('data-heading-space') ||
        i.getAttribute('data-image-space') ||
        i.getAttribute('data-line-space') ||
        '?')`
    )
  const previewSamples = (): Promise<string[]> =>
    evalJs<string[]>(
      `[...document.querySelectorAll('[data-spacing-preview] [data-sample]')].map(s => s.getAttribute('data-sample'))`
    )

  check('选「公式 · 自身」', await selectSelf('math'))
  {
    const r = await rows()
    const samples = await previewSamples()
    console.log(`     [公式自身] ${JSON.stringify({ r, samples })}`)
    check('有公式上方 / 下方两根滑块', r.includes('mathBefore') && r.includes('mathAfter'), JSON.stringify(r))
    check('预览样本画的是公式', samples.includes('math'), JSON.stringify(samples))
  }

  check('选「图表 · 自身」', await selectSelf('mermaid'))
  {
    const r = await rows()
    const samples = await previewSamples()
    console.log(`     [图表自身] ${JSON.stringify({ r, samples })}`)
    check(
      '有图表上方 / 下方两根滑块',
      r.includes('mermaidBefore') && r.includes('mermaidAfter'),
      JSON.stringify(r)
    )
    check('预览样本画的是图表', samples.includes('mermaid'), JSON.stringify(samples))
  }

  // ---------- 3. 正文↔公式 / 正文↔图表 的方向映射 ----------

  console.log('\n【3】正文与公式 / 图表的配对:方向对应上方 / 下方档')
  check('选「正文在上 / 公式在下」', await selectPair('body', 'math'))
  {
    const r = await rows()
    check('只给「公式上方」这一档', r.length === 1 && r[0] === 'mathBefore', JSON.stringify(r))
  }
  check('互换后变成「公式在上 / 正文在下」', await (async () => {
    await evalJs(`document.querySelector('[data-ring-swap]')?.click()`)
    await sleep(200)
    return waitFor(`document.querySelector('[data-pair-top="math"]')`, 2000)
  })())
  {
    const r = await rows()
    check('只给「公式下方」这一档', r.length === 1 && r[0] === 'mathAfter', JSON.stringify(r))
  }
  check('选「正文在上 / 图表在下」', await selectPair('body', 'mermaid'))
  {
    const r = await rows()
    check('只给「图表上方」这一档', r.length === 1 && r[0] === 'mermaidBefore', JSON.stringify(r))
  }

  // ---------- 4. 拖滑块:根变量、空行高度、写盘 ----------

  console.log('\n【4】拖「公式上方」到 2 档:空行变高并写进 settings.json')
  check('回到「公式 · 自身」', await selectSelf('math'))
  const setRange = async (selector: string, value: number): Promise<boolean> => {
    const ok = await evalJs<boolean>(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (!input) return false
      input.value = '${value}'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(450)
    return ok
  }
  check('拖动上方滑块', await setRange('input[data-block-space="mathBefore"]', 2))
  {
    const vars = await evalJs<{ before: string; after: string }>(`(() => {
      const cs = getComputedStyle(document.documentElement)
      return {
        before: cs.getPropertyValue('--md-math-space-before').trim(),
        after: cs.getPropertyValue('--md-math-space-after').trim()
      }
    })()`)
    const heights = await gapHeights()
    console.log(`     [实测] ${JSON.stringify({ vars, heights })}`)
    check('根变量变成 2', vars.before === '2' && vars.after === '1', JSON.stringify(vars))
    check('公式上方空行变成 32px', Math.abs((heights['math-after'] ?? -1) - 16) <= 0.6 && Math.abs((heights['math-before'] ?? -1) - 32) <= 0.6, JSON.stringify(heights))
  }
  check('图表下方也调到 2 档', await (async () => {
    await selectSelf('mermaid')
    return setRange('input[data-block-space="mermaidAfter"]', 2)
  })())
  {
    const heights = await gapHeights()
    check('图表下方空行变成 32px', Math.abs((heights['mermaid-after'] ?? -1) - 32) <= 0.6, JSON.stringify(heights))
  }
  await sleep(500)
  {
    const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
    check(
      '两档写进了 settings.json',
      saved.mathSpaceBefore === 2 && saved.mermaidSpaceAfter === 2,
      JSON.stringify({ math: saved.mathSpaceBefore, mermaid: saved.mermaidSpaceAfter })
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
