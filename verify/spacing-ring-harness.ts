/**
 * 验收:设置 → 外观 →「样式」的块对圆环。
 *
 * 圆环把原来一长串方向滑块换成「先选块,再选块对」:
 *   空状态七个块围一圈 → 点一个到中心 → 再点一个调两者间距;
 *   中心旁的「自身」圆点调同类块之间。字段与间距引擎都是原有的,
 *   唯一的新数据是表格的上 / 下档(tableSpaceBefore / tableSpaceAfter)。
 *
 * 断言:
 *   A 初始:七个块、没有中心、没有自身点、没有间距滑块;
 *   B 选中中心:一个中心 + 六个外圈,自身点出现;
 *   C 配对:标题 → 代码块,两个方向组的字段正确,不生效的字段给灰字说明;
 *   D 预览 / 写盘 / 关开面板:滑块即时生效,值进 settings.json,重开保留;
 *   E 换中心、清配对、自身:点「以 X 为中心」对调,点中心逐级退出;
 *   F 正文自身:段间距 + 行间距,行间距改变同一段内的行高;
 *   G 表格配对:表格上方 / 下方两根滑块可调、写盘;
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
const TABLE_BEFORE = 1.7 * BODY
const TABLE_AFTER = 0.7 * BODY

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

interface RingState {
  state: string
  center: string | null
  ringNodes: number
  selfNode: string | null
  panel: {
    key: string
    center: string
    target: string
    mode: string
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

  const ringState = (): Promise<RingState | null> =>
    evalJs<RingState | null>(`
      (() => {
        const ring = document.querySelector('[data-spacing-ring]')
        if (!ring) return null
        const panel = document.querySelector('[data-pair-panel]')
        return {
          state: ring.getAttribute('data-ring-state') ?? '',
          center: ring.querySelector('[data-block-role="center"]')?.getAttribute('data-block-node') ?? null,
          ringNodes: ring.querySelectorAll('[data-block-role="ring"]').length,
          selfNode: ring.querySelector('[data-block-self]')?.getAttribute('data-block-self') ?? null,
          panel: panel
            ? {
                key: panel.getAttribute('data-pair-panel') ?? '',
                center: panel.getAttribute('data-pair-center') ?? '',
                target: panel.getAttribute('data-pair-target') ?? '',
                mode: panel.getAttribute('data-pair-mode') ?? ''
              }
            : null,
          sliders: document.querySelectorAll('.spacing-settings input[type="range"]').length,
          hint: ring.querySelector('.spacing-ring-hint')?.textContent?.trim() ?? ''
        }
      })()`)

  /** 圆环回到空状态:反复点中心块,直到没有中心 */
  async function resetRing(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const state = await evalJs<string>(
        `document.querySelector('[data-spacing-ring]')?.getAttribute('data-ring-state') ?? ''`
      )
      if (state === 'empty') return
      await evalJs(
        `document.querySelector('[data-spacing-ring] [data-block-role="center"]')?.click()`
      )
      await sleep(100)
    }
  }

  async function clickNode(kind: string): Promise<void> {
    await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="${kind}"]')?.click()`)
    await sleep(100)
  }

  /** 圆环:选中心 + 第二个块,等配对面板出现 */
  async function selectPair(center: string, target: string): Promise<boolean> {
    await resetRing()
    await clickNode(center)
    await clickNode(target)
    return waitFor(`document.querySelector('[data-pair-panel]')`, 3000)
  }

  /** 圆环:选中心 + 中心旁的「自身」 */
  async function selectSelf(kind: string): Promise<boolean> {
    await resetRing()
    await clickNode(kind)
    await evalJs(`document.querySelector('.spacing-ring-self')?.click()`)
    await sleep(100)
    return waitFor(`document.querySelector('[data-pair-mode="self"]')`, 3000)
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
  console.log('\n【A】初始:七个块围成一圈,没有中心、没有自身点、没有间距滑块')
  check('打开设置 → 外观,圆环出现了', await openAppearance())
  {
    const s = await ringState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check('圆环状态是 empty', s?.state === 'empty', JSON.stringify(s))
    check('七个块节点都在', s?.ringNodes === 7 || (await evalJs<number>(`document.querySelectorAll('[data-block-node]').length`)) === 7, JSON.stringify(s))
    check('没有中心块', s?.center === null, JSON.stringify(s?.center))
    check('没有「自身」圆点', s?.selfNode === null, JSON.stringify(s?.selfNode))
    check('没有配对面板', s?.panel === null, JSON.stringify(s?.panel))
    check('圆环里没有间距滑块(字号行还在,但不算圆环的)', s?.sliders === 0, String(s?.sliders))
    check('提示是「点一个块，把它放到中心」', !!s?.hint.includes('点一个块'), s?.hint)
  }
  await shoot('ring-empty')

  // ---------- B ----------
  console.log('\n【B】点一个块:它到中心,其余六个围成一圈,中心旁出现「自身」')
  await clickNode('body')
  {
    const s = await ringState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check('圆环状态是 centered', s?.state === 'centered', JSON.stringify(s))
    check('中心是正文', s?.center === 'body', JSON.stringify(s?.center))
    check('外圈剩六个块', s?.ringNodes === 6, String(s?.ringNodes))
    check('「自身」圆点出现且对着正文', s?.selfNode === 'body', JSON.stringify(s?.selfNode))
    check('面板还没出现', s?.panel === null, JSON.stringify(s?.panel))
    check('提示改成「再点一个块…」', !!s?.hint.includes('再点一个块'), s?.hint)
  }
  await shoot('ring-center')

  // ---------- C ----------
  console.log('\n【C】标题 ↔ 代码块:两个方向组的字段正确,不生效的字段给灰字说明')
  await resetRing()
  await clickNode('heading')
  {
    const s = await ringState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check('中心换成标题', s?.center === 'heading' && s?.state === 'centered', JSON.stringify(s))
  }
  await clickNode('code')
  {
    const s = await ringState()
    console.log(`     [实测] ${JSON.stringify(s)}`)
    check(
      '配对面板 key 是 heading-code,中心 / 目标 / 模式正确',
      s?.panel?.key === 'heading-code' &&
        s.panel.center === 'heading' &&
        s.panel.target === 'code' &&
        s.panel.mode === 'cross',
      JSON.stringify(s?.panel)
    )
    const groups = await evalJs<{
      directions: string[]
      headingRows: string[]
      blockRows: string[]
      inert: string[]
    }>(`
      (() => {
        const panel = document.querySelector('[data-pair-panel]')
        return {
          directions: [...panel.querySelectorAll('[data-pair-direction]')].map(g =>
            g.getAttribute('data-pair-direction')),
          headingRows: [...panel.querySelectorAll('input[data-heading-space]')].map(i =>
            i.getAttribute('data-heading-space')),
          blockRows: [...panel.querySelectorAll('input[data-block-space]')].map(i =>
            i.getAttribute('data-block-space')),
          inert: [...panel.querySelectorAll('[data-space-inert]')].map(i =>
            i.getAttribute('data-space-inert'))
        }
      })()`)
    console.log(`     [实测] ${JSON.stringify(groups)}`)
    check(
      '两个方向组:标题在上 / 代码块在上',
      groups.directions.join(',') === 'heading-above,code-above',
      JSON.stringify(groups.directions)
    )
    check(
      '标题下方与标题上方各一根标题滑块,代码块上方一根块滑块',
      groups.headingRows.join(',') === 'after,before' && groups.blockRows.join(',') === 'codeBefore',
      JSON.stringify(groups)
    )
    check(
      '代码块下方紧邻标题不生效,给的是灰色说明而不是滑块',
      groups.inert.join(',') === 'codeSpaceAfter',
      JSON.stringify(groups.inert)
    )
  }
  await shoot('ring-pair', '[data-pair-panel]')

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
    '重新选回「标题 ↔ 代码块」',
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
  console.log('\n【E】换中心、清配对、自身')
  await evalJs(`document.querySelector('[data-ring-recenter="code"]')?.click()`)
  await sleep(150)
  {
    const s = await ringState()
    console.log(`     [实测] ${JSON.stringify(s?.panel)}`)
    check(
      '点「以代码块为中心」:配对关系对调,key 不变',
      s?.center === 'code' &&
        s?.panel?.key === 'heading-code' &&
        s?.panel.center === 'code' &&
        s.panel.target === 'heading',
      JSON.stringify(s?.panel)
    )
  }
  await evalJs(`document.querySelector('[data-spacing-ring] [data-block-role="center"]')?.click()`)
  await sleep(120)
  {
    const s = await ringState()
    check(
      '点中心:先清掉配对,中心还在',
      s?.state === 'centered' && s?.center === 'code' && s?.panel === null,
      JSON.stringify(s)
    )
  }
  await evalJs(`document.querySelector('[data-spacing-ring] [data-block-role="center"]')?.click()`)
  await sleep(120)
  {
    const s = await ringState()
    check(
      '再点一次中心:回到空状态,七块重新围成一圈',
      s?.state === 'empty' &&
        s?.center === null &&
        (await evalJs<number>(`document.querySelectorAll('[data-spacing-ring] .spacing-ring-node').length`)) === 7,
      JSON.stringify(s)
    )
  }
  check('「正文 · 自身」配对出现', await selectSelf('body'))
  {
    const s = await ringState()
    const fields = await evalJs<string[]>(`
      [...document.querySelectorAll('[data-pair-panel] [data-space-field]')]
        .map(r => r.getAttribute('data-space-field'))`)
    console.log(`     [实测] ${JSON.stringify({ s, fields })}`)
    check(
      '自身配对 key 是 body-body,mode 是 self',
      s?.panel?.key === 'body-body' && s.panel.mode === 'self',
      JSON.stringify(s?.panel)
    )
    check(
      '正文自身有「段间距」和「行间距」两行',
      fields.join(',') === 'bodySpaceBetween,lineSpace',
      JSON.stringify(fields)
    )
  }
  await shoot('ring-self', '[data-pair-panel]')
  await evalJs(`document.querySelector('.spacing-ring-self')?.click()`)
  await sleep(120)
  check(
    '再点「自身」退出同类配对(面板消失、中心还在)',
    (await ringState())?.state === 'centered' && !(await evalJs<boolean>(`document.querySelector('[data-pair-panel]')`)),
    JSON.stringify(await ringState())
  )

  // ---------- F ----------
  console.log('\n【F】正文自身:段间距 + 行间距,行间距改变同一段内的行高')
  check('回到三行连写的文档', await loadDoc(LINES))
  check('打开设置 → 外观并选「正文 · 自身」', (await openAppearance()) && (await selectSelf('body')))
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
  console.log('\n【G】表格配对:表格上方 / 下方两根滑块可调、写盘')
  check('圆环上选「正文 ↔ 表格」', await selectPair('body', 'table'))
  {
    const groups = await evalJs<{ key: string; fields: string[] }>(`
      (() => {
        const panel = document.querySelector('[data-pair-panel]')
        return {
          key: panel?.getAttribute('data-pair-panel') ?? '',
          fields: [...panel.querySelectorAll('input[data-block-space]')].map(i =>
            i.getAttribute('data-block-space'))
        }
      })()`)
    console.log(`     [实测] ${JSON.stringify(groups)}`)
    check(
      '面板 key 是 body-table,列出表格上方 / 下方两根滑块',
      groups.key === 'body-table' && groups.fields.join(',') === 'tableBefore,tableAfter',
      JSON.stringify(groups)
    )
  }
  const tableSetOk =
    (await setRange('input[data-block-space="tableBefore"]', 2)) &&
    (await setRange('input[data-block-space="tableAfter"]', 1.5))
  await sleep(400)
  {
    const vars = {
      before: await rootVar('--md-table-space-before'),
      after: await rootVar('--md-table-space-after')
    }
    check(
      '表格两根根变量跟着滑块走(2 / 1.5)',
      tableSetOk && vars.before === '2' && vars.after === '1.5',
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
      '表格回到默认 1.7 / 0.7 档',
      vars.tableBefore === '1.7' && vars.tableAfter === '0.7',
      JSON.stringify({ before: vars.tableBefore, after: vars.tableAfter })
    )
    const nodes = await evalJs<number>(`document.querySelectorAll('[data-block-node]').length`)
    check('重置后圆环仍在,七个块都在', nodes === 7, String(nodes))
  }
  await sleep(400)
  const resetSaved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as Record<string, unknown>
  check(
    '恢复默认也写回了 settings.json(含表格默认)',
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
      a11y.tagNames.every(t => t === 'BUTTON') && a11y.types.every(t => t === 'button'),
      JSON.stringify(a11y)
    )
    check('空状态下 aria-pressed 全是 false', a11y.pressed.every(v => v === 'false'), JSON.stringify(a11y.pressed))
    check('提示是 role=status + aria-live=polite', a11y.hintRole === 'status' && a11y.hintLive === 'polite', JSON.stringify(a11y))
  }
  await clickNode('quote')
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
      '选中中心后只有那一块 aria-pressed=true',
      pressed.quote === 'true' && Object.entries(pressed).filter(([, v]) => v === 'true').length === 1,
      JSON.stringify(pressed)
    )
    const selfPressed = await evalJs<string>(
      `document.querySelector('.spacing-ring-self')?.getAttribute('aria-pressed') ?? ''`
    )
    check('「自身」圆点也有 aria-pressed,未选中时为 false', selfPressed === 'false', selfPressed)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
