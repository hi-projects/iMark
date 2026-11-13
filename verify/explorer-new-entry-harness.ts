/**
 * 文件树「新建」输入行的落点。
 *
 * 现象:点某个目录行上的「新建文件 / 新建文件夹」,输入行永远出现在列表最前
 * (仓库根的位置),看不出到底在哪个目录里建。正确的位置是**目标父目录展开后
 * 的第一个子项**,缩进也跟着父目录的层级走;只有从顶部工具栏新建(父目录 =
 * 仓库根)时才出现在最前。
 *
 * 断言:
 *   A 目录行「新建文件」→ 输入行紧跟该目录行、在它第一个子项之前,
 *     缩进与建好后的文件行一致(图标 + 无展开箭头的 16px 补偿)
 *   B 输入框自动聚焦;打字只显示名字(不挂 `.md` 提示),
 *     回车 → 文件真的建在那个目录里,且名字自动补齐 `.md`
 *   C 工具栏「新建文件」(仓库根)→ 输入行在列表最前,缩进第一层
 *   D 右键菜单「新建文件」→ 同样落在该目录下
 *   E 目录行「新建文件夹」→ 同样落在该目录下,并建出子目录
 *   F 重命名输入行仍在原位且自动聚焦;输入框只放名字、默认选中不含 `.md`,
 *     回车后自动补回 `.md`;`.txt` 这类扩展名保持原样
 *   G 点击行选中它;按 F2 对选中的文件 / 文件夹打开改名输入框(名字不带 `.md`)
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs explorer-new-entry
 */

import { app, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// 验收窗口一律不显示
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
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

interface EditInfo {
  /** 输入行是否存在 */
  found: boolean
  /** 输入行前面 / 后面的兄弟行说明(名字或位置) */
  prev: string | null
  next: string | null
  /** 输入行与父目录行的 paddingLeft */
  padding: number | null
  parentPadding: number | null
  /** 输入框左缘 / 相邻行名字左缘(px):两者对齐 = 输入框落在建好后的那一列 */
  inputLeft: number | null
  siblingLeft: number | null
  /** 输入框里第一个字符的左缘(左缘 + 边框 + 左内边距) */
  textLeft: number | null
  /** 输入框文字 / 相邻行名字的基线,各自相对自己那一行的行顶(px):同一值 = 行内同一位置 */
  inputBaseline: number | null
  siblingBaseline: number | null
  /** 输入框字号 / 相邻行名字字号 */
  inputFontSize: number | null
  siblingFontSize: number | null
  /** 输入框的边框/背景:应当只有一条底线,没有方块边框与底色 */
  borderTop: number | null
  borderLeft: number | null
  borderBottom: number | null
  background: string | null
  focused: boolean
  /** 输入行是不是列表里的第一个 .explorer-item */
  first: boolean
  index: number
}

const EDIT_INFO = (name: string) => `
(() => {
  const items = [...document.querySelectorAll('.explorer-list .explorer-item')]
  const input = document.querySelector('.explorer-editing input')
  if (!input) return { found: false, prev: null, next: null, padding: null, parentPadding: null, inputLeft: null, siblingLeft: null, textLeft: null, inputBaseline: null, siblingBaseline: null, inputFontSize: null, siblingFontSize: null, borderTop: null, borderLeft: null, borderBottom: null, background: null, focused: false, first: false, index: -1 }
  const row = input.closest('.explorer-item')
  const idx = items.indexOf(row)
  const label = el => {
    if (!el) return null
    if (!el.classList.contains('explorer-item')) return '<' + el.tagName.toLowerCase() + '>'
    const n = el.querySelector('.explorer-name')
    return n ? n.textContent : '(editing)'
  }
  const dir = items.find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
  const px = el => el ? parseFloat(getComputedStyle(el).paddingLeft) : null
  // 树里每层的缩进固定 +14;文件行没有展开箭头,靠 +16 补偿 —— 反过来就能算出行的层级。
  // 取「同一层级」的行来比名字列:输入行正好是某棵子树的最后一项时,紧挨着的下一行
  // 是别的顶层项,拿它比会得到一个完全不同的缩进。
  const depthOf = el => {
    const pad = parseFloat(getComputedStyle(el).paddingLeft)
    const isFile = !el.querySelector('.explorer-chevron, .explorer-chevron-space')
    return Math.round((pad - 8 - (isFile ? 16 : 0)) / 14)
  }
  const rowDepth = depthOf(row)
  const sameDepth = el =>
    !!el && el.classList.contains('explorer-item') && !!el.querySelector('.explorer-name') && depthOf(el) === rowDepth
  const sibling =
    [row.nextElementSibling, row.previousElementSibling].find(sameDepth) ??
    items.find(el => el !== row && sameDepth(el))
  const siblingName = sibling ? sibling.querySelector('.explorer-name') : null
  const inputRect = input.getBoundingClientRect()
  const inputStyle = getComputedStyle(input)
  // 基线:行盒内文字基线的位置 =(行盒高 - (ascent + descent)) / 2 + ascent
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = inputStyle.fontSize + ' ' + inputStyle.fontFamily
  const fm = ctx.measureText('Mg')
  const textHeight = fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent
  const padTop = parseFloat(inputStyle.paddingTop)
  const padBottom = parseFloat(inputStyle.paddingBottom)
  const inputLineBox = input.clientHeight - padTop - padBottom
  const nameRect = siblingName ? siblingName.getBoundingClientRect() : null
  const nameStyle = siblingName ? getComputedStyle(siblingName) : null
  const rowTop = row.getBoundingClientRect().top
  const siblingTop = sibling ? sibling.getBoundingClientRect().top : null
  return {
    found: true,
    prev: label(row.previousElementSibling),
    next: label(row.nextElementSibling),
    padding: px(row),
    parentPadding: px(dir),
    inputLeft: inputRect.left,
    siblingLeft: nameRect ? nameRect.left : null,
    textLeft: inputRect.left + parseFloat(inputStyle.paddingLeft) + parseFloat(inputStyle.borderLeftWidth),
    // 输入行与相邻行不是同一行(上下相差一个行高),所以基线都要相对各自行顶来比
    inputBaseline: inputRect.top - rowTop + padTop + (inputLineBox - textHeight) / 2 + fm.fontBoundingBoxAscent,
    siblingBaseline:
      nameRect && siblingTop !== null
        ? nameRect.top - siblingTop + (nameRect.height - textHeight) / 2 + fm.fontBoundingBoxAscent
        : null,
    inputFontSize: parseFloat(inputStyle.fontSize),
    siblingFontSize: nameStyle ? parseFloat(nameStyle.fontSize) : null,
    borderTop: parseFloat(inputStyle.borderTopWidth),
    borderLeft: parseFloat(inputStyle.borderLeftWidth),
    borderBottom: parseFloat(inputStyle.borderBottomWidth),
    background: inputStyle.backgroundColor,
    focused: document.activeElement === input,
    first: idx === 0,
    index: idx
  }
})()`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs explorer-new-entry` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  /** 路径一律相对仓库根,拼成绝对路径再落盘(相对路径会写进当前工作目录) */
  const mk = async (rel: string, text?: string): Promise<void> => {
    const p = join(vault, rel)
    await mkdir(dirname(p), { recursive: true })
    if (text !== undefined) await writeFile(p, text, 'utf8')
    else await mkdir(p, { recursive: true })
  }
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await mk('ros2/assets')
  await mk('ros2/C++工程化/接口.md', '# 接口\n')
  await mk('ros2/C++工程化/数据类型.md', '# 数据类型\n')
  await mk('ros2/ros2-moveit2/管线.md', '# 管线\n')
  await mk('ros2/ros2-moveit2/配置打包器.md', '# 配置打包器\n')
  await mk('vla/pi0.5.md', '# pi0.5\n')
  const lastFile = join(vault, 'ros2/ros2-moveit2/管线.md')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile,
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  const win = createMainWindow(settings)
  win.setContentSize(1000, 800)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(60)
    }
    return false
  }
  const editInfo = (name: string): Promise<EditInfo> => evalJs<EditInfo>(EDIT_INFO(name))
  /** 输入框左缘是否落在建好后那一行的名字列上(±1px 容差:文件行与目录行的图标宽度差 1px) */
  const aligned = (i: EditInfo): boolean =>
    i.inputLeft !== null && i.siblingLeft !== null && Math.abs(i.inputLeft - i.siblingLeft) <= 1.5
  /** 输入框里第一个字符是否落在同级名字的列上(±1px 容差) */
  const textAligned = (i: EditInfo): boolean =>
    i.textLeft !== null && i.siblingLeft !== null && Math.abs(i.textLeft - i.siblingLeft) <= 1.5
  /** 输入框文字与相邻行名字同字号、同一基线(±1px) */
  const textMatchesRow = (i: EditInfo): boolean =>
    i.inputFontSize !== null &&
    i.siblingFontSize !== null &&
    i.inputFontSize === i.siblingFontSize &&
    i.inputBaseline !== null &&
    i.siblingBaseline !== null &&
    Math.abs(i.inputBaseline - i.siblingBaseline) <= 1
  /** 框只画一条底线:上下左右没有边框,没有底色 */
  const underlineOnly = (i: EditInfo): boolean =>
    i.borderTop === 0 &&
    i.borderLeft === 0 &&
    i.borderBottom === 1 &&
    (i.background === 'rgba(0, 0, 0, 0)' || i.background === 'transparent')
  const rowNames = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.explorer-list .explorer-item .explorer-name')].map(e => e.textContent)`)

  const clickRow = (name: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      if (!row) return false
      row.click()
      return true
    })()`)

  const clickRowAction = (name: string, title: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      const btn = row && row.querySelector('button[title=${JSON.stringify(title)}]')
      if (!btn) return false
      btn.click()
      return true
    })()`)

  /** 只敲字不回车,方便检查输入过程中的显示 */
  const typeValue = (value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const input = document.querySelector('.explorer-editing input')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

  const pressEnter = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const input = document.querySelector('.explorer-editing input')
      if (!input) return false
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)

  const typeAndEnter = (value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const input = document.querySelector('.explorer-editing input')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)

  const escape = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const input = document.querySelector('.explorer-editing input')
      if (!input) return true
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)

  // 等仓库树出现(目录默认收起,只列第一层)
  const treeReady = await waitFor(`document.querySelector('.explorer-list .explorer-name')`)
  check('仓库树已加载', treeReady)
  await sleep(300)
  {
    const firstLevel = await rowNames()
    check(
      '目录默认收起:只看到第一层(ros2 / vla)',
      firstLevel.length === 2 && firstLevel.includes('ros2') && firstLevel.includes('vla'),
      JSON.stringify(firstLevel)
    )
  }

  // 先展开 ros2,再展开 ros2-moveit2(嵌套目录默认收起)
  await clickRow('ros2')
  await sleep(300)
  await clickRow('ros2-moveit2')
  await sleep(300)
  check('ros2-moveit2 已展开(能看到 管线.md)', (await rowNames()).includes('管线.md'))

  // ---------- A ----------
  console.log('\n【A】目录行「新建文件」:输入行落在该目录下')
  await clickRowAction('ros2-moveit2', '新建文件')
  const aReady = await waitFor(`document.querySelector('.explorer-editing input')`)
  check('出现新建输入行', aReady)
  const a = await editInfo('ros2-moveit2')
  console.log(`     prev=${a.prev} next=${a.next} padding=${a.padding}/${a.parentPadding} left=${a.inputLeft}/${a.siblingLeft}`)
  check('紧跟在 ros2-moveit2 目录行之后(不是在列表最前)', a.prev === 'ros2-moveit2' && !a.first, JSON.stringify([a.prev, a.first, a.index]))
  check('位于该目录第一个子项之前', a.next === '管线.md', String(a.next))
  check('缩进与建好后的文件行一致(父目录 +14 层 +16 无箭头补偿)', a.padding !== null && a.parentPadding !== null && a.padding === a.parentPadding + 30, `${a.padding} vs ${a.parentPadding}`)
  check('输入框与相邻文件名的列对齐', aligned(a), `${a.inputLeft} vs ${a.siblingLeft}`)
  check('输入框里第一个字符与相邻文件名对齐', textAligned(a), `${a.textLeft} vs ${a.siblingLeft}`)
  check(
    '输入框字号、基线与相邻行一致',
    textMatchesRow(a),
    JSON.stringify([a.inputFontSize, a.siblingFontSize, a.inputBaseline, a.siblingBaseline])
  )
  check(
    '输入框只画一条底线(没有方块边框和底色)',
    underlineOnly(a),
    JSON.stringify([a.borderTop, a.borderLeft, a.borderBottom, a.background])
  )
  check('输入框自动聚焦', a.focused)

  // ---------- B ----------
  console.log('\n【B】输入名字:只显示名字,回车后自动补 .md')
  check('输入行接受输入', await typeValue('新文件'))
  await sleep(120)
  const b = await evalJs<{ value: string; ghost: boolean }>(`(() => ({
    value: document.querySelector('.explorer-editing input').value,
    ghost: !!document.querySelector('.explorer-name-ghost')
  }))()`)
  console.log(`     value=${JSON.stringify(b.value)} ghost=${b.ghost}`)
  check('输入框里只有敲进去的名字', b.value === '新文件', b.value)
  check('输入框后面不再显示 .md 提示', !b.ghost)
  check('回车确认输入', await pressEnter())
  const created = join(vault, 'ros2/ros2-moveit2/新文件.md')
  const createdOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(created)) return true
      await sleep(80)
    }
    return false
  })()
  check('文件建在 ros2/ros2-moveit2/ 下', createdOk, created)
  // 落盘之后还要等 IPC 返回 + 刷新仓库,输入行才会收起
  check('建完后输入行消失', await waitFor(`!document.querySelector('.explorer-editing input')`))
  await sleep(400)
  const namesAfterCreate = await rowNames()
  check('新文件出现在树里', namesAfterCreate.includes('新文件.md'), JSON.stringify(namesAfterCreate))

  // ---------- C ----------
  console.log('\n【C】工具栏「新建文件」(仓库根):输入行在最前')
  await escape()
  await evalJs(`(() => {
    const btn = document.querySelector('.explorer-header button[title="新建文件"]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const c = await editInfo('新文件.md')
  console.log(`     prev=${c.prev} next=${c.next} padding=${c.padding} left=${c.inputLeft}/${c.siblingLeft}`)
  check('输入行是列表里的第一个 .explorer-item', c.first && c.prev === null, JSON.stringify([c.prev, c.first, c.index]))
  check('下一行是第一个顶层项', c.next === 'ros2', String(c.next))
  check('缩进为第一层的文件行(8 + 1*14 + 16)', c.padding === 38, String(c.padding))
  check('输入框与相邻文件名的列对齐', aligned(c), `${c.inputLeft} vs ${c.siblingLeft}`)
  check('输入框自动聚焦', c.focused)
  const cPlaceholder = await evalJs<string>(`document.querySelector('.explorer-editing input').placeholder`)
  check('空输入框的占位提示只是「文件名」', cPlaceholder === '文件名', cPlaceholder)
  await escape()
  await sleep(200)

  // ---------- D ----------
  console.log('\n【D】右键菜单「新建文件」:同样落在该目录下')
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
      .find(el => el.querySelector('.explorer-name')?.textContent === 'ros2-moveit2')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 260 }))
    return true
  })()`)
  await waitFor(`document.querySelector('.explorer-menu')`)
  const menuClicked = await evalJs<boolean>(`(() => {
    const item = [...document.querySelectorAll('.explorer-menu-item')]
      .find(el => el.querySelector('.explorer-menu-label')?.textContent === '新建文件')
    if (!item) return false
    item.click()
    return true
  })()`)
  check('右键菜单里点到「新建文件」', menuClicked)
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const d = await editInfo('ros2-moveit2')
  console.log(`     prev=${d.prev} next=${d.next} padding=${d.padding}/${d.parentPadding}`)
  check('输入行紧跟 ros2-moveit2 目录行', d.prev === 'ros2-moveit2' && !d.first, JSON.stringify([d.prev, d.first]))
  check('缩进与建好后的文件行一致', d.padding !== null && d.parentPadding !== null && d.padding === d.parentPadding + 30, `${d.padding} vs ${d.parentPadding}`)
  await escape()
  await sleep(200)

  // ---------- E ----------
  console.log('\n【E】目录行「新建文件夹」:同样落在该目录下,并建出子目录')
  await clickRowAction('ros2-moveit2', '新建文件夹')
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const e = await editInfo('ros2-moveit2')
  console.log(`     prev=${e.prev} next=${e.next} padding=${e.padding}/${e.parentPadding} left=${e.inputLeft}/${e.siblingLeft}`)
  check('输入行紧跟 ros2-moveit2 目录行', e.prev === 'ros2-moveit2' && !e.first, JSON.stringify([e.prev, e.first]))
  check('缩进比父目录深一层(目录行要留出展开箭头)', e.padding !== null && e.parentPadding !== null && e.padding === e.parentPadding + 14, `${e.padding} vs ${e.parentPadding}`)
  check('输入框与相邻文件名的列对齐', aligned(e), `${e.inputLeft} vs ${e.siblingLeft}`)
  check('输入框里第一个字符与相邻文件名对齐', textAligned(e), `${e.textLeft} vs ${e.siblingLeft}`)
  check('输入框字号、基线与相邻行一致', textMatchesRow(e), JSON.stringify([e.inputFontSize, e.siblingFontSize, e.inputBaseline, e.siblingBaseline]))
  check('焦点在输入框', e.focused)
  await typeAndEnter('新目录')
  const dirCreated = join(vault, 'ros2/ros2-moveit2/新目录')
  const dirOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(dirCreated)) return true
      await sleep(80)
    }
    return false
  })()
  check('子目录真的建出来了', dirOk, dirCreated)

  // ---------- F ----------
  console.log('\n【F】重命名输入行:只放名字、默认选中不含 .md,回车自动补回')
  await escape()
  await sleep(300)
  await clickRowAction('管线.md', '重命名')
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const f = await editInfo('管线.md')
  const rename = await evalJs<{ value: string; start: number; end: number; length: number }>(`(() => {
    const input = document.querySelector('.explorer-editing input')
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd, length: input.value.length }
  })()`)
  console.log(`     value=${rename.value} select=${rename.start}-${rename.end} padding=${f.padding}`)
  check('重命名输入框只带名字(不含 .md)', rename.value === '管线', rename.value)
  check('默认选中整个名字(不含 .md)', rename.start === 0 && rename.end === rename.length, `${rename.start}-${rename.end}/${rename.length}`)
  check('重命名输入行在文件原来的位置(不是列表最前)', !f.first, String(f.index))
  check('重命名输入框与同级文件名的列对齐', aligned(f), `${f.inputLeft} vs ${f.siblingLeft}`)
  check('重命名输入框里第一个字符与同级文件名对齐', textAligned(f), `${f.textLeft} vs ${f.siblingLeft}`)
  check('重命名字号、基线与同级文件名一致', textMatchesRow(f), JSON.stringify([f.inputFontSize, f.siblingFontSize, f.inputBaseline, f.siblingBaseline]))
  check('重命名输入框同样只画一条底线', underlineOnly(f), JSON.stringify([f.borderTop, f.borderLeft, f.borderBottom, f.background]))
  check('重命名输入框自动聚焦', f.focused)
  check('输入新名字', await typeValue('管线改名'))
  check('改名时也不显示 .md 提示', !(await evalJs<boolean>(`!!document.querySelector('.explorer-name-ghost')`)))
  await pressEnter()
  const renamed = join(vault, 'ros2/ros2-moveit2/管线改名.md')
  const renamedOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(renamed)) return true
      await sleep(80)
    }
    return false
  })()
  check('敲名字直接回车 → 文件带 .md 改好名', renamedOk, renamed)
  check('原文件不在了', !existsSync(join(vault, 'ros2/ros2-moveit2/管线.md')))

  // 名字已带仓库认得的非 .md 扩展名(.txt)时不能拆,否则改名会偷偷换成 .md
  await escape()
  await sleep(300)
  await clickRowAction('配置打包器.md', '重命名')
  await waitFor(`document.querySelector('.explorer-editing input')`)
  await typeValue('笔记.txt')
  check('输入 .txt 名字后回车仍保留 .txt', await pressEnter())
  const txtOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(vault, 'ros2/ros2-moveit2/笔记.txt'))) return true
      await sleep(80)
    }
    return false
  })()
  check('改名后仍是 .txt(没被改成 .md)', txtOk)
  await escape()

  // 文件夹改名同样要落在名字列上(目录行有展开箭头,输入框前要留出箭头位)
  await sleep(300)
  await clickRowAction('新目录', '重命名')
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const fDir = await editInfo('新目录')
  const fDirValue = await evalJs<string>(`document.querySelector('.explorer-editing input').value`)
  console.log(`     value=${fDirValue} padding=${fDir.padding} left=${fDir.inputLeft}/${fDir.siblingLeft}`)
  check('文件夹改名输入框带原文件夹名', fDirValue === '新目录', fDirValue)
  check('文件夹改名输入框与同级名字的列对齐', aligned(fDir), `${fDir.inputLeft} vs ${fDir.siblingLeft}`)
  check('文件夹改名输入框里第一个字符与同级名字对齐', textAligned(fDir), `${fDir.textLeft} vs ${fDir.siblingLeft}`)
  check('文件夹改名字号、基线与同级名字一致', textMatchesRow(fDir), JSON.stringify([fDir.inputFontSize, fDir.siblingFontSize, fDir.inputBaseline, fDir.siblingBaseline]))
  await escape()

  // ---------- G ----------
  console.log('\n【G】F2:重命名文件树里选中的文件 / 文件夹')
  const pressF2 = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
      return true
    })()`)
  const selectedName = (): Promise<string | null> =>
    evalJs<string | null>(`document.querySelector('.explorer-item.explorer-selected .explorer-name')?.textContent ?? null`)
  const editingValue = (): Promise<string | null> =>
    evalJs<string | null>(`document.querySelector('.explorer-editing input')?.value ?? null`)

  await sleep(300)
  await clickRow('新文件.md')
  await sleep(200)
  check('点击文件行后该行显示为选中', (await selectedName()) === '新文件.md', String(await selectedName()))
  // 点文件行会把焦点交给编辑器,真实按键的 target 是编辑器正文(contenteditable),
  // 不是 window —— 这样重放才能覆盖"编辑器有焦点时 F2 不响应"的回归
  const pressF2InEditor = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = document.querySelector('.cm-content')
      if (!el) return false
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
      return true
    })()`)
  check('焦点在编辑器正文里也能按 F2(真实按键路径)', await pressF2InEditor())
  const gFileReady = await waitFor(`document.querySelector('.explorer-editing input')`)
  check('F2 打开改名输入框', gFileReady)
  check('改名框里是选中文件的名字(不含 .md)', (await editingValue()) === '新文件', String(await editingValue()))
  const gFile = await editInfo('新文件.md')
  check('F2 改名框与同级名字的列对齐', aligned(gFile), `${gFile.inputLeft} vs ${gFile.siblingLeft}`)
  await escape()
  await sleep(200)

  await clickRow('新目录')
  await sleep(200)
  check('点击文件夹行后该行显示为选中', (await selectedName()) === '新目录', String(await selectedName()))
  await pressF2()
  await waitFor(`document.querySelector('.explorer-editing input')`)
  check('F2 也能重命名文件夹', (await editingValue()) === '新目录', String(await editingValue()))
  await escape()
  await sleep(200)

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
