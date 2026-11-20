/**
 * 验收:设置 → 外观 →「间距」的两栏选择器。
 *
 * 左栏是七个块的调色板(先点的在上面,后点的在下面,两种颜色区分);
 * 右栏是这条边界的间距预览 + 滑块,预览里可以互换上下或清除。
 * 连点同一个块两次进入同类配对(段间距 / 行间距 / 标题之间 …)。
 *
 * 断言:
 *   A 初始:七个块、没有选中、预览空、没有滑块;
 *   B 第一次点:块成为「上面」,预览显示它,还没有滑块;
 *   C 第二次点:标题在上 / 代码块在下,只列这一方向的字段;
 *   D 预览 / 写盘 / 关开面板:滑块即时生效,值进 settings.json,重开保留;
 *   E 互换、清除、自身:互换后方向对调,点已选块清空,连点两次进自身;
 *   F 正文自身:段间距 + 行间距,行间距改变同一段内的行高;
 *   G 表格配对:正文在上给表格上方,互换后给表格下方;写盘;
 *   H 表格排版:有结构空行时空行承担间距、frame 归零;紧贴标题时 frame
 *     再归零;紧贴代码块时 frame 提供间距,邻居 padding 不落在 host/void 上;
 *   I 恢复默认:所有间距根变量与 settings.json 回到默认(含表格 1.7 / 0.7);
 *   J 可访问性:节点是真 button、aria-pressed 正确、提示是 role=status。
 *
 * 跑法(先 `npm run build`,再在仓库根目录):
 *   xvfb-run -a node verify/run.mjs spacing-ring
 */

import { app, BrowserWindow, protocol, type NativeImage } from 'electron'
import { APP_VERSION } from './appVersion'
import { EDITOR_DEFAULTS } from '../src/shared/editorSettings'
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

const BODY = 16

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

/** 一段三行连写 = 同一段(没有空行),用来量行间距 */
const LINES = ['第一行正文。', '第二行正文。', '第三行正文。', ''].join('\n')

/** 标题 / 空行 / 表格 / 空行 / 正文:上下都有结构空行 */
const TABLE_BLANK = [
  '# 表格上方标题',
  '',
  '| 列甲 | 列乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '正文段落。',
  ''
].join('\n')

/** 标题紧贴表格:没有结构空行,frame 顶部归零,标题留白说了算 */
const TABLE_TIGHT_HEADING = [
  '# 紧贴标题',
  '| 列甲 | 列乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '正文段落。',
  ''
].join('\n')

/** 代码块紧贴表格:frame 顶部提供间距,邻居 padding 不该加在 host 上 */
const TABLE_TIGHT_CODE = [
  '```ts',
  'const x = 1',
  '```',
  '| 列甲 | 列乙 |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '正文段落。',
  ''
].join('\n')

// 验收窗口一律不显示。截图例外:隐藏窗口里 Chromium 会停掉合成,
// 所以截图时临时真显示一帧(跑在 xvfb 上,真实桌面看不到),截完马上藏回去。
const realShow = BrowserWindow.prototype.show
const realHide = BrowserWindow.prototype.hide
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

interface PaletteState {
  state: string
  top: string | null
  bottom: string | null
  topNodes: number
  bottomNodes: number
  panel: {
    key: string
    top: string
    bottom: string
    mode: string
  } | null
  groups: string[]
  fields: string[]
  preview: {
    mode: string
    top: string
    bottom: string
    samples: string[]
    gap: number
  } | null
  sliders: number
  hint: string
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs spacing-ring` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '圆环.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, LINES, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off',
        lineWrapping: true,
        editorFontSize: BODY,
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
  win.setContentSize(1000, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function captureShot(): Promise<NativeImage | null> {
    realShow.call(win)
    win.moveTop()
    await sleep(200)
    await Promise.race([
      evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'),
      sleep(500)
    ])
    await sleep(120)
    try {
      for (let i = 0; i < 5; i++) {
        try {
          return await wc.capturePage()
        } catch {
          await sleep(200)
        }
      }
      return null
    } finally {
      realHide.call(win)
    }
  }

  const shots = join(ud, 'shots')
  await mkdir(shots, { recursive: true })
  async function shoot(name: string, focusSelector?: string): Promise<void> {
    if (focusSelector) {
      await evalJs(
        `document.querySelector(${JSON.stringify(focusSelector)})?.scrollIntoView({ block: 'center' })`
      )
      await sleep(250)
    }
    const image = await captureShot()
    if (image) await writeFile(join(shots, `${name}.png`), image.toPNG())
  }

  async function loadDoc(content: string): Promise<boolean> {
    const count = content.split('\n').length
    const ready = `document.querySelectorAll('.cm-content .cm-line').length === ${count}`
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(note, content, 'utf8')
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      if (await waitFor(ready, 6000)) {
        await sleep(150)
        return true
      }
    }
    return false
  }

  /** 打开设置并切到「外观」 */
  async function openAppearance(): Promise<boolean> {
    await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
    await waitFor(`document.querySelector('.settings-nav-item')`)
    await evalJs(`
      [...document.querySelectorAll('.settings-nav-item')]
        .find(b => b.textContent.trim() === '外观')
        ?.click()`)
    return waitFor(`document.querySelector('[data-spacing-ring]')`)
  }

  async function closeSettings(): Promise<void> {
    await evalJs(`document.querySelector('.settings-close')?.click()`)
    await sleep(250)
  }

  const paletteState = (): Promise<PaletteState | null> =>
    evalJs<PaletteState | null>(`
      (() => {
        const ring = document.querySelector('[data-spacing-ring]')
        if (!ring) return null
        const panel = document.querySelector('[data-pair-panel]')
        const preview = document.querySelector('[data-spacing-preview]')
        return {
          state: ring.getAttribute('data-ring-state') ?? '',
          top: ring.querySelector('[data-block-role="top"]')?.getAttribute('data-block-node') ?? null,
          bottom:
            ring.querySelector('[data-block-role="bottom"]')?.getAttribute('data-block-node') ?? null,
          topNodes: ring.querySelectorAll('[data-block-role="top"]').length,
          bottomNodes: ring.querySelectorAll('[data-block-role="bottom"]').length,
          panel: panel
            ? {
                key: panel.getAttribute('data-pair-panel') ?? '',
                top: panel.getAttribute('data-pair-top') ?? '',
                bottom: panel.getAttribute('data-pair-bottom') ?? '',
                mode: panel.getAttribute('data-pair-mode') ?? ''
              }
            : null,
          groups: panel
            ? [...panel.querySelectorAll('[data-pair-direction]')].map(g =>
                g.getAttribute('data-pair-direction'))
            : [],
          fields: panel
            ? [...panel.querySelectorAll('[data-space-field]')].map(r =>
                r.getAttribute('data-space-field'))
            : [],
          preview: preview
            ? {
                mode: preview.getAttribute('data-preview-mode') ?? '',
                top: preview.getAttribute('data-preview-top') ?? '',
                bottom: preview.getAttribute('data-preview-bottom') ?? '',
                samples: [...preview.querySelectorAll('[data-sample]')].map(s =>
                  s.getAttribute('data-sample')),
                gap: preview.querySelector('[data-preview-gap]')
                  ? Math.round(
                      parseFloat(
                        getComputedStyle(preview.querySelector('[data-preview-gap]')).height
                      ) * 10
                    ) / 10
                  : 0
              }
            : null,
          sliders: document.querySelectorAll(
            '.spacing-settings input[type="range"], [data-pair-panel] input[type="range"]'
          ).length,
          hint: ring.querySelector('.spacing-ring-hint')?.textContent?.trim() ?? ''
        }
      })()`)

  /** 调色板回到空状态:点已选中的上块,直到没有选中 */
  async function resetRing(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      const state = await evalJs<string>(
        `document.querySelector('[data-spacing-ring]')?.getAttribute('data-ring-state') ?? ''`
      )
      if (state === 'empty') return
      await evalJs(
        `document.querySelector('[data-spacing-ring] [data-block-role="top"]')?.click()`
      )
      await sleep(80)
    }
  }

  async function clickNode(kind: string): Promise<void> {
    await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="${kind}"]')?.click()`)
    await sleep(100)
  }

  /** 先点 top(上面),再点 bottom(下面) */
  async function selectPair(top: string, bottom: string): Promise<boolean> {
    await resetRing()
    await clickNode(top)
    await clickNode(bottom)
    return waitFor(`document.querySelector('[data-pair-panel]')`, 3000)
  }

  /** 连点同一个块两次 = 同类配对 */
  async function selectSelf(kind: string): Promise<boolean> {
    await resetRing()
    await clickNode(kind)
    await clickNode(kind)
    return waitFor(`document.querySelector('[data-pair-mode="self"]')`, 3000)
  }

  /** 互换上下 */
  async function swapSides(): Promise<boolean> {
    await evalJs(`document.querySelector('[data-ring-swap]')?.click()`)
    await sleep(150)
    return waitFor(`document.querySelector('[data-pair-panel]')`, 2000)
  }

  async function setRange(selector: string, value: number): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const input = document.querySelector(${JSON.stringify(selector)})
        if (!input) return false
        input.value = '${value}'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()`)
  }

  const readoutOf = (selector: string): Promise<string> =>
    evalJs<string>(`
      document.querySelector(${JSON.stringify(selector)})
        ?.closest('.settings-control')?.querySelector('.settings-readout')?.textContent?.trim() ?? ''`)

  const rootVar = (name: string): Promise<string> =>
    evalJs<string>(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`)

  const near = (a: number, b: number, tol = 0.8): boolean => Math.abs(a - b) <= tol

  // ---------- A ----------
  console.log('\n【A】初始:左边七个块,什么都没选,右边预览为空')
  check('打开设置 → 外观,调色板出现了', await openAppearance())
  {
    const s = await paletteState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check('调色板状态是 empty', s?.state === 'empty', JSON.stringify(s))
    check(
      '七个块节点都在,且都是圆形按钮',
      (await evalJs<number>(`document.querySelectorAll('[data-block-node]').length`)) === 7,
      JSON.stringify(s)
    )
    check('没有上块 / 下块', s?.top === null && s?.bottom === null, JSON.stringify(s))
    check('右边预览是空状态', s?.preview?.mode === 'empty', JSON.stringify(s?.preview))
    check('没有配对面板', s?.panel === null, JSON.stringify(s?.panel))
    check('调色板里没有间距滑块', s?.sliders === 0, String(s?.sliders))
    check('提示「先点一个块，作为上面的内容」', !!s?.hint.includes('先点一个块'), s?.hint)
    const divider = await evalJs<number>(
      `parseFloat(getComputedStyle(document.querySelector('.spacing-side')).borderLeftWidth) || 0`
    )
    check('左右两栏之间有一条分隔线', divider === 1, String(divider))
  }
  await shoot('spacing-empty')

  // ---------- B ----------
  console.log('\n【B】第一次点正文:它成为「上面」,预览显示它,还没有滑块')
  await clickNode('body')
  {
    const s = await paletteState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check('状态是 top,上块是正文', s?.state === 'top' && s?.top === 'body', JSON.stringify(s))
    check('只有一个上块、没有下块', s?.topNodes === 1 && s?.bottom === null, JSON.stringify(s))
    check(
      '预览画出正文样本,下面留虚线占位',
      s?.preview?.mode === 'top' &&
        s.preview.top === 'body' &&
        s.preview.samples.join(',') === 'body' &&
        (await evalJs<boolean>(`!!document.querySelector('[data-preview-doc] .spacing-doc-ghost')`)),
      JSON.stringify(s?.preview)
    )
    check('面板还没出现,也没有滑块', s?.panel === null && s?.sliders === 0, JSON.stringify(s))
    check('提示改成「再点一个块…」', !!s?.hint.includes('再点一个块'), s?.hint)
  }
  await shoot('spacing-top')

  // ---------- C ----------
  console.log('\n【C】第二次点代码块:标题在上 / 代码块在下,只列这一方向的字段')
  await resetRing()
  await clickNode('heading')
  await clickNode('code')
  {
    const s = await paletteState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check(
      '上块是标题、下块是代码块,调色板状态是 pair',
      s?.state === 'pair' && s?.top === 'heading' && s?.bottom === 'code',
      JSON.stringify(s)
    )
    check(
      '上下块用不同角色标记(各一个)',
      s?.topNodes === 1 && s?.bottomNodes === 1,
      JSON.stringify({ top: s?.topNodes, bottom: s?.bottomNodes })
    )
    check(
      '面板 key 是 heading-code,top / bottom / 模式正确',
      s?.panel?.key === 'heading-code' &&
        s.panel.top === 'heading' &&
        s.panel.bottom === 'code' &&
        s.panel.mode === 'cross',
      JSON.stringify(s?.panel)
    )
    check(
      '只列一个方向组 heading-above',
      s?.groups.join(',') === 'heading-above',
      JSON.stringify(s?.groups)
    )
    check(
      '字段是标题下方 + 代码块上方(代码块上方只是空行时叠加)',
      s?.fields.join(',') === 'headingSpaceAfter,codeSpaceBefore',
      JSON.stringify(s?.fields)
    )
    check(
      '预览按文档样式画出标题与代码块,间距 = 1 + 1 档(32px)',
      s?.preview?.mode === 'pair' &&
        s.preview.samples.join(',') === 'heading,code' &&
        near(s.preview.gap, 32),
      JSON.stringify(s?.preview)
    )
    check(
      '代码块下方的「不生效」说明不在这个方向出现',
      !(await evalJs<boolean>(`!!document.querySelector('[data-space-inert]')`)),
      '出现了 inert 说明'
    )
    check(
      '面板里不再有标题 / 副标题 / 分组标注',
      !(await evalJs<boolean>(
        `document.querySelector('.spacing-pair-title, .spacing-pair-sub, .spacing-pair-group-head')`
      )),
      '仍有标题或说明文字'
    )
    const layout = await evalJs<{
      panelInCard: boolean
      fontInCard: boolean
      panelBeforeFont: boolean
    }>(`
      (() => {
        const card = document.querySelector('.settings-card-ring')
        const panel = document.querySelector('[data-pair-panel]')
        const fontRow = [...document.querySelectorAll('.settings-row')].find(r =>
          r.textContent?.includes('正文字号'))
        return {
          panelInCard: !!(card && panel && card.contains(panel)),
          fontInCard: !!(card && fontRow && card.contains(fontRow)),
          panelBeforeFont: !!(
            panel &&
            fontRow &&
            (panel.compareDocumentPosition(fontRow) & Node.DOCUMENT_POSITION_FOLLOWING)
          )
        }
      })()`)
    check(
      '滑块与正文字号在同一张模块卡里,滑块在上',
      layout.panelInCard && layout.fontInCard && layout.panelBeforeFont,
      JSON.stringify(layout)
    )
  }
  await shoot('spacing-pair', '[data-pair-panel]')

  // ---------- D ----------
  console.log('\n【D】拖动滑块:即时生效、写盘、关开面板后保留')
  const setOk =
    (await setRange('input[data-heading-space="after"]', 2)) &&
    (await setRange('input[data-block-space="codeBefore"]', 0.5))
  await sleep(400)
  {
    const vars = {
      headingAfter: await rootVar('--md-heading-space-after'),
      codeBefore: await rootVar('--md-code-space-before')
    }
    const readouts = {
      headingAfter: await readoutOf('input[data-heading-space="after"]'),
      codeBefore: await readoutOf('input[data-block-space="codeBefore"]')
    }
    console.log(`     [实测] ${JSON.stringify({ vars, readouts })}`)
    check(
      '根变量跟着滑块走(标题 2 档 / 代码块 0.5 档)',
      setOk && vars.headingAfter === '2' && vars.codeBefore === '0.5',
      JSON.stringify(vars)
    )
    check(
      '读数按「档 · px」显示',
      readouts.headingAfter.includes('2.0 档') &&
        readouts.headingAfter.includes('32 px') &&
        readouts.codeBefore.includes('0.5 档') &&
        readouts.codeBefore.includes('8 px'),
      JSON.stringify(readouts)
    )
  }
  await sleep(500)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '两个档位都写进了 settings.json',
    saved.headingSpaceAfter === 2 && saved.codeSpaceBefore === 0.5,
    JSON.stringify({ headingAfter: saved.headingSpaceAfter, codeBefore: saved.codeSpaceBefore })
  )

  await closeSettings()
  check('重新打开设置 → 外观', await openAppearance())
  check(
    '重新选回「标题在上 / 代码块在下」',
    (await selectPair('heading', 'code')) &&
      (await waitFor(`document.querySelector('input[data-heading-space="after"]')`)),
    '重开后面板没有出现'
  )
  {
    const restored = await evalJs<{ headingAfter: string; codeBefore: string }>(`
      (() => {
        const h = document.querySelector('input[data-heading-space="after"]')
        const c = document.querySelector('input[data-block-space="codeBefore"]')
        return { headingAfter: h?.value ?? '', codeBefore: c?.value ?? '' }
      })()`)
    check(
      '关开面板后滑块仍按磁盘值显示(2 / 0.5)',
      restored.headingAfter === '2' && restored.codeBefore === '0.5',
      JSON.stringify(restored)
    )
  }

  // ---------- E ----------
  console.log('\n【E】互换、清除、自身')
  check('点「互换上下」', await swapSides())
  {
    const s = await paletteState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check(
      '互换后代码块在上、标题在下,key 不变',
      s?.top === 'code' &&
        s?.bottom === 'heading' &&
        s?.panel?.key === 'heading-code' &&
        s.panel.top === 'code' &&
        s.panel.bottom === 'heading',
      JSON.stringify(s)
    )
    check(
      '方向组换成 code-above,字段是标题上方 + 不生效的代码块下方',
      s?.groups.join(',') === 'code-above' &&
        s.fields.join(',') === 'headingSpaceBefore' &&
        (await evalJs<boolean>(`!!document.querySelector('[data-space-inert="codeSpaceAfter"]')`)),
      JSON.stringify(s)
    )
  }
  await evalJs(`document.querySelector('[data-spacing-ring] [data-block-role="top"]')?.click()`)
  await sleep(120)
  {
    const s = await paletteState()
    check(
      '点已选中的块:清空上下块,预览回到空状态',
      s?.state === 'empty' && s?.top === null && s?.bottom === null && s?.preview?.mode === 'empty',
      JSON.stringify(s)
    )
  }
  check('选「正文在上 / 标题在下」', await selectPair('body', 'heading'))
  {
    const s = await paletteState()
    check(
      '预览把标题前的整行空行也算进去(标题上方 16 + 整行 32 = 48px)',
      s?.preview?.mode === 'pair' &&
        s.preview.samples.join(',') === 'body,heading' &&
        near(s.preview.gap, 48),
      JSON.stringify(s?.preview)
    )
    const sampleTops = (): Promise<{ body: number; head: number }> =>
      evalJs(`
        (() => {
          const d = document.querySelector('[data-preview-doc]')
          const top = sel => Math.round(d.querySelector(sel).getBoundingClientRect().top * 10) / 10
          return { body: top('[data-sample="body"]'), head: top('[data-sample="heading"]') }
        })()`)
    const beforeTops = await sampleTops()
    check('拖动「标题上方」→ 0.1 档', await setRange('input[data-heading-space="before"]', 0.1))
    await sleep(300)
    const afterTops = await sampleTops()
    check(
      '调小标题间距时正文样本不动,只有标题上移',
      near(afterTops.body, beforeTops.body, 1) && afterTops.head < beforeTops.head - 8,
      JSON.stringify({ beforeTops, afterTops })
    )
    await setRange('input[data-heading-space="before"]', 1)
    await sleep(150)
  }
  check('连点正文两次进「正文 · 自身」', await selectSelf('body'))
  {
    const s = await paletteState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check(
      '自身配对 key 是 body-body,mode 是 self',
      s?.panel?.key === 'body-body' && s.panel.mode === 'self',
      JSON.stringify(s?.panel)
    )
    check(
      '正文自身有「段间距」和「行间距」两行',
      s?.fields.join(',') === 'bodySpaceBetween,lineSpace',
      JSON.stringify(s?.fields)
    )
    check('预览标成同类配对(上下都是正文)', s?.preview?.mode === 'self', JSON.stringify(s?.preview))
  }
  await shoot('spacing-self', '[data-pair-panel]')
  await clickNode('body')
  await sleep(120)
  check(
    '再点一次正文:退出自身并清空选择',
    (await paletteState())?.state === 'empty' &&
      !(await evalJs<boolean>(`document.querySelector('[data-pair-panel]')`)),
    JSON.stringify(await paletteState())
  )

  // ---------- F ----------
  console.log('\n【F】正文自身:段间距 + 行间距,行间距改变同一段内的行高')
  check('回到三行连写的文档', await loadDoc(LINES))
  check('打开设置 → 外观并连点两次正文', (await openAppearance()) && (await selectSelf('body')))
  const heights = (): Promise<{ heights: number[]; advance: number }> =>
    evalJs(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const round = n => Math.round(n * 100) / 100
        return {
          heights: lines.map(el => round(el.getBoundingClientRect().height)),
          advance:
            lines.length > 1
              ? round(lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().top)
              : -1
        }
      })()`)
  {
    const before = await heights()
    console.log(`     [实测] 默认 ${JSON.stringify(before)}`)
    check(
      '默认 1 档:同一段三行 32px,行与行紧挨着',
      before.heights.slice(0, 3).every(h => near(h, 2 * BODY)) && near(before.advance, 2 * BODY),
      JSON.stringify(before)
    )
  }
  check('拖动「行间距」→ 2 档', await setRange('input[data-line-space="lineSpace"]', 2))
  await sleep(400)
  {
    const after = await heights()
    const readout = await readoutOf('input[data-line-space="lineSpace"]')
    console.log(`     [实测] 2 档 ${JSON.stringify(after)} / ${readout}`)
    check(
      '行高变成 (1 + 2) × 字号 = 48px,行与行跟着拉开',
      after.heights.slice(0, 3).every(h => near(h, 3 * BODY)) && near(after.advance, 3 * BODY),
      JSON.stringify(after)
    )
    check(
      '读数显示 2.0 档 · 32 px',
      readout.includes('2.0 档') && readout.includes('32 px'),
      readout
    )
  }
  await sleep(400)
  const lineSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check('行间距也写进了 settings.json', lineSaved.lineSpace === 2, String(lineSaved.lineSpace))

  // ---------- G ----------
  console.log('\n【G】表格配对:正文在上给表格上方,互换后给表格下方')
  check('选「正文在上 / 表格在下」', await selectPair('body', 'table'))
  {
    const s = await paletteState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check(
      '面板 key 是 body-table,只列「表格上方」',
      s?.panel?.key === 'body-table' && s.groups.join(',') === 'body-above' && s.fields.join(',') === 'tableSpaceBefore',
      JSON.stringify(s)
    )
  }
  check('拖动表格上方 → 2 档', await setRange('input[data-block-space="tableBefore"]', 2))
  await sleep(150)
  check('互换后表格在上、正文在下', await swapSides())
  {
    const s = await paletteState()
    check(
      '方向组换成 table-above,只列「表格下方」',
      s?.groups.join(',') === 'table-above' && s.fields.join(',') === 'tableSpaceAfter',
      JSON.stringify(s)
    )
  }
  check('拖动表格下方 → 1.5 档', await setRange('input[data-block-space="tableAfter"]', 1.5))
  await sleep(400)
  {
    const vars = {
      before: await rootVar('--md-table-space-before'),
      after: await rootVar('--md-table-space-after')
    }
    check(
      '表格两根根变量跟着滑块走(2 / 1.5)',
      vars.before === '2' && vars.after === '1.5',
      JSON.stringify(vars)
    )
  }
  await sleep(500)
  const tableSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '表格档位写进了 settings.json',
    tableSaved.tableSpaceBefore === 2 && tableSaved.tableSpaceAfter === 1.5,
    JSON.stringify({ before: tableSaved.tableSpaceBefore, after: tableSaved.tableSpaceAfter })
  )

  // ---------- H ----------
  console.log('\n【H】表格排版:结构空行承担间距,frame 该侧归零')
  await closeSettings()

  interface TableMetrics {
    hostCls: string
    hostPad: { top: number; bottom: number }
    framePad: { top: number; bottom: number }
    blankAboveCls: string
    blankAboveH: number
    blankBelowCls: string
    blankBelowH: number
    voidPad: { top: number; bottom: number }
    headingPadBottom: number
  }

  const tableMetrics = (): Promise<TableMetrics | null> =>
    evalJs<TableMetrics | null>(`
      (() => {
        const frame = document.querySelector('.cm-md-table-frame')
        if (!frame) return null
        const host = frame.closest('.cm-md-table-host')
        if (!host) return null
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const round = n => Math.round(n * 100) / 100
        const find = cls => lines.find(l => l.classList.contains(cls))
        const above = find('cm-md-block-gap-table-before')
        const below = find('cm-md-block-gap-table-after')
        const voidLine = find('cm-md-table-void')
        const heading = lines.find(l => /\\bcm-md-h\\d\\b/.test(l.className))
        const hostCs = getComputedStyle(host)
        const frameCs = getComputedStyle(frame)
        return {
          hostCls: host.className,
          hostPad: { top: parseFloat(hostCs.paddingTop), bottom: parseFloat(hostCs.paddingBottom) },
          framePad: {
            top: parseFloat(frameCs.paddingTop),
            bottom: parseFloat(frameCs.paddingBottom)
          },
          blankAboveCls: above?.className ?? '',
          blankAboveH: above ? round(above.getBoundingClientRect().height) : -1,
          blankBelowCls: below?.className ?? '',
          blankBelowH: below ? round(below.getBoundingClientRect().height) : -1,
          voidPad: voidLine
            ? {
                top: parseFloat(getComputedStyle(voidLine).paddingTop),
                bottom: parseFloat(getComputedStyle(voidLine).paddingBottom)
              }
            : { top: 0, bottom: 0 },
          headingPadBottom: heading ? parseFloat(getComputedStyle(heading).paddingBottom) : -1
        }
      })()`)

  check('载入「标题 / 空行 / 表格 / 空行 / 正文」', await loadDoc(TABLE_BLANK))
  {
    const m = await tableMetrics()
    console.log(`     [实测] ${JSON.stringify(m)}`)
    check(
      '上下都有结构空行,分别带 table-before / table-after 类',
      !!m &&
        /cm-md-block-gap/.test(m.blankAboveCls) &&
        /cm-md-block-gap-table-before/.test(m.blankAboveCls) &&
        /cm-md-block-gap-table-after/.test(m.blankBelowCls),
      JSON.stringify(m)
    )
    check(
      '空行高度按表格档位排(上方 32px / 下方 24px)',
      !!m && near(m.blankAboveH, 32) && near(m.blankBelowH, 24),
      JSON.stringify({ above: m?.blankAboveH, below: m?.blankBelowH })
    )
    check(
      '有结构空行时 frame 上下 padding 归零(不重复计间距)',
      !!m &&
        /cm-md-table-gap-line-top/.test(m.hostCls) &&
        /cm-md-table-gap-line-bottom/.test(m.hostCls) &&
        m.framePad.top === 0 &&
        m.framePad.bottom === 0,
      JSON.stringify(m && { hostCls: m.hostCls, framePad: m.framePad })
    )
  }

  check('载入「标题紧贴表格」', await loadDoc(TABLE_TIGHT_HEADING))
  {
    const m = await tableMetrics()
    console.log(`     [实测] ${JSON.stringify(m)}`)
    check(
      '表格带 tight-heading-top,frame 顶部归零',
      !!m && /cm-md-table-tight-heading-top/.test(m.hostCls) && m.framePad.top === 0,
      JSON.stringify(m && { hostCls: m.hostCls, framePad: m.framePad })
    )
    check(
      '标题自己的下留白仍在(2 档 = 32px),间距没有丢',
      !!m && near(m.headingPadBottom, 32),
      String(m?.headingPadBottom)
    )
  }

  check('载入「代码块紧贴表格」', await loadDoc(TABLE_TIGHT_CODE))
  {
    const rendered = await waitFor(`document.querySelector('.cm-md-table-frame')`, 5000)
    if (!rendered) {
      const diag = await evalJs<string>(`
        [...document.querySelectorAll('.cm-content .cm-line')]
          .map(l => l.textContent).join(' | ')`)
      check('表格渲染出来了', false, diag)
    } else {
      check('表格渲染出来了', true)
    }
    const m = await tableMetrics()
    console.log(`     [实测] ${JSON.stringify(m)}`)
    check(
      '没有结构空行、也不紧邻标题:frame 顶部提供间距(2 档 = 32px)',
      !!m &&
        !/cm-md-table-gap-line-top/.test(m.hostCls) &&
        !/cm-md-table-tight-heading-top/.test(m.hostCls) &&
        near(m.framePad.top, 32),
      JSON.stringify(m && { hostCls: m.hostCls, framePad: m.framePad })
    )
    check(
      '邻居的 padding 不落在表格 host / 折叠行上(仍是 0)',
      !!m && m.hostPad.top === 0 && m.hostPad.bottom === 0 && m.voidPad.top === 0 && m.voidPad.bottom === 0,
      JSON.stringify(m && { hostPad: m.hostPad, voidPad: m.voidPad })
    )
  }

  // ---------- I ----------
  console.log('\n【I】「恢复默认设置」:所有间距根变量与 settings.json 回到默认')
  check('重新打开设置 → 外观', await openAppearance())
  check('外观页里有「恢复默认设置」', await waitFor(`document.querySelector('.settings-reset')`))
  await evalJs(`document.querySelector('.settings-reset')?.click()`)
  await sleep(800)
  {
    const vars = await evalJs<Record<string, string>>(`
      (() => {
        const cs = getComputedStyle(document.documentElement)
        const names = {
          fontSize: '--editor-font-size',
          lineSpace: '--editor-line-space',
          headingBefore: '--md-heading-space-before',
          headingAfter: '--md-heading-space-after',
          headingBetween: '--md-heading-space-between',
          bodyBetween: '--md-body-space-between',
          codeBefore: '--md-code-space-before',
          codeAfter: '--md-code-space-after',
          listBefore: '--md-list-space-before',
          listAfter: '--md-list-space-after',
          quoteBefore: '--md-quote-space-before',
          quoteAfter: '--md-quote-space-after',
          imageBeforeHeading: '--md-image-space-before-heading',
          imageBeforeBody: '--md-image-space-before-body',
          imageAfterHeading: '--md-image-space-after-heading',
          imageAfterBody: '--md-image-space-after-body',
          tableBefore: '--md-table-space-before',
          tableAfter: '--md-table-space-after'
        }
        const out = {}
        for (const [key, name] of Object.entries(names)) out[key] = cs.getPropertyValue(name).trim()
        return out
      })()`)
    console.log(`     [实测] ${JSON.stringify(vars)}`)
    const ones = [
      'lineSpace',
      'headingBefore',
      'headingAfter',
      'headingBetween',
      'bodyBetween',
      'codeBefore',
      'codeAfter',
      'listBefore',
      'listAfter',
      'quoteBefore',
      'quoteAfter',
      'imageBeforeHeading',
      'imageBeforeBody',
      'imageAfterHeading',
      'imageAfterBody'
    ]
    check(
      '十五个 1 档的根变量都回到 1',
      ones.every(key => vars[key] === '1'),
      JSON.stringify(vars)
    )
    check(
      '正文字号也回到默认',
      vars.fontSize === `${EDITOR_DEFAULTS.editorFontSize}px`,
      JSON.stringify(vars.fontSize)
    )
    check(
      '表格回到默认 1.7 / 0.7 档',
      vars.tableBefore === '1.7' && vars.tableAfter === '0.7',
      JSON.stringify({ before: vars.tableBefore, after: vars.tableAfter })
    )
    const nodes = await evalJs<number>(`document.querySelectorAll('[data-block-node]').length`)
    check('重置后七个块仍在', nodes === 7, String(nodes))
  }
  await sleep(400)
  const resetSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '恢复默认也写回了 settings.json(含字号与表格默认)',
    resetSaved.editorFontSize === EDITOR_DEFAULTS.editorFontSize &&
      resetSaved.lineSpace === 1 &&
      resetSaved.headingSpaceAfter === 1 &&
      resetSaved.codeSpaceBefore === 1 &&
      resetSaved.tableSpaceBefore === 1.7 &&
      resetSaved.tableSpaceAfter === 0.7,
    JSON.stringify({
      lineSpace: resetSaved.lineSpace,
      headingAfter: resetSaved.headingSpaceAfter,
      codeBefore: resetSaved.codeSpaceBefore,
      tableBefore: resetSaved.tableSpaceBefore,
      tableAfter: resetSaved.tableSpaceAfter
    })
  )

  // ---------- J ----------
  console.log('\n【J】可访问性:真 button、aria-pressed、role=status')
  await resetRing()
  {
    const a11y = await evalJs<{
      tagNames: string[]
      types: string[]
      pressed: string[]
      hintRole: string
      hintLive: string
    }>(`
      (() => {
        const nodes = [...document.querySelectorAll('.spacing-ring-node')]
        const hint = document.querySelector('.spacing-ring-hint')
        return {
          tagNames: nodes.map(n => n.tagName),
          types: nodes.map(n => n.getAttribute('type') ?? ''),
          pressed: nodes.map(n => n.getAttribute('aria-pressed') ?? ''),
          hintRole: hint?.getAttribute('role') ?? '',
          hintLive: hint?.getAttribute('aria-live') ?? ''
        }
      })()`)
    console.log(`     [实测] ${JSON.stringify(a11y)}`)
    check(
      '七个块节点都是 button(type=button)',
      a11y.tagNames.length === 7 && a11y.tagNames.every(t => t === 'BUTTON') && a11y.types.every(t => t === 'button'),
      JSON.stringify(a11y)
    )
    check('空状态下 aria-pressed 全是 false', a11y.pressed.every(v => v === 'false'), JSON.stringify(a11y.pressed))
    check('提示是 role=status + aria-live=polite', a11y.hintRole === 'status' && a11y.hintLive === 'polite', JSON.stringify(a11y))
    const hintSize = await evalJs<number>(`
      (() => {
        const r = document.querySelector('.spacing-ring-hint')?.getBoundingClientRect()
        return r ? Math.max(r.width, r.height) : -1
      })()`)
    check('提示文字视觉上已隐藏(只留给读屏)', hintSize <= 1, String(hintSize))
  }
  await clickNode('quote')
  await clickNode('code')
  {
    const pressed = await evalJs<Record<string, string>>(`
      (() => {
        const out = {}
        for (const n of document.querySelectorAll('.spacing-ring-node')) {
          out[n.getAttribute('data-block-node')] = n.getAttribute('aria-pressed')
        }
        return out
      })()`)
    check(
      '上下两块 aria-pressed=true,其余为 false',
      pressed.quote === 'true' &&
        pressed.code === 'true' &&
        Object.values(pressed).filter(v => v === 'true').length === 2,
      JSON.stringify(pressed)
    )
    const swap = await evalJs<{ tag: string; label: string } | null>(`
      (() => {
        const b = document.querySelector('[data-ring-swap]')
        return b ? { tag: b.tagName, label: b.textContent?.trim() ?? '' } : null
      })()`)
    check(
      '「互换上下」是真按钮,文案可读',
      swap?.tag === 'BUTTON' && !!swap.label.includes('互换'),
      JSON.stringify(swap)
    )
    check(
      '互换 / 清除按钮放在左栏调色板里',
      await evalJs<boolean>(
        `!!document.querySelector('[data-spacing-ring] [data-ring-swap]') &&
         !!document.querySelector('[data-spacing-ring] [data-ring-clear]')`
      ),
      '按钮不在调色板内'
    )
    const buttonGap = await evalJs<number>(`
      (() => {
        const swap = document.querySelector('[data-ring-swap]')?.getBoundingClientRect()
        const clear = document.querySelector('[data-ring-clear]')?.getBoundingClientRect()
        return swap && clear ? Math.round((clear.left - swap.right) * 10) / 10 : -1
      })()`)
    check('「清除」紧挨在「互换上下」右边', buttonGap >= 4 && buttonGap <= 12, String(buttonGap))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
