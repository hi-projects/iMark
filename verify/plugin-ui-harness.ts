/**
 * 验收:插件界面的这一轮收敛(左栏、插件设置页、市场「已安装」)。
 *
 * 第一轮「把话说少一点」,八件事:
 *   1. 左栏插件列表去掉形态标签(完整权限 / 沙箱 / 无代码);
 *   2. 插件设置页顶部卡片去掉形态标签与那句「以完整权限运行…」;
 *   3. 左栏「插件」分组标题旁补一个问号,讲清脚本插件与沙箱插件的区别;
 *   4. 去掉「在市场里管理」入口;
 *   5. 插件设置页不再重复「安装于 / sha256」(市场已安装里已经有一份);
 *   6. **受限插件**的权限明细列在市场「已安装」的行上;完整权限插件只留形态徽标
 *      (node main 的清单权限不构成门禁,列出来会被误读成允许范围);
 *   7. 来源徽标词表统一(之后又改成「内置插件 / 市场插件 / 本地安装」);
 *   8. 市场「已安装」去掉「含代码 / 不含代码」徽标。
 *
 * 紧接着的一轮又调了三处,同样在这份 harness 里钉住:
 *   9. 插件设置页连来源徽标也不挂了 —— 内置插件那张卡整块消失;
 *  10. 市场「已安装」每行改成「形态 + 来源」两枚徽标(脚本插件 / 沙箱插件 / 无代码插件);
 *  11. 权限那排去掉「权限」二字,改成盾牌图标 + 柔和胶囊,并挪到名字下面(与元信息对齐)。
 *
 * 断言的都是**界面上看得见的东西**(某个容器里还找不找得到这些字、还有没有那枚标签),
 * 不是「源码里有没有那行」—— 这轮改动全是「删掉之后别把有用的东西一起删掉」的风险,
 * 所以第 2/4 段反过来钉住两件**必须留下**的东西:沙箱插件的「打开窗口」按钮、
 * 以及每枚权限 chip 自带的说明(title)。
 *
 * 跑法:node verify/run.mjs plugin-ui(顺带留三张截图在 .verify-ud/shots/)
 *
 * ⚠️ 改了 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层页面走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 *
 * 依赖:内置兜底清单里只有两个**脚本**插件(定时上传 / Advanced Table),它们会在启动时被补装。
 * 沙箱那一路(「打开窗口」按钮必须留着)自己补装一个:直接从打包好的 note-embed 包走
 * 同一条安装路径 —— 两种形态都在场,否则那几条断言就是空转的。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { installFromEnvelope } from '../src/main/market/installer'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'

registerPluginScheme()

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

/** 截图落在 .verify-ud/shots/(run.mjs 每次只清 .verify-ud/<名字>,不会带走这一份) */
const SHOTS = join(__dirname, '..', '..', '.verify-ud', 'shots')

/** 左右两侧的空白都折叠掉:断言的是一句话在不在,不是它怎么折行 */
const NAV_METRICS = `
(() => {
  const nav = document.querySelector('.settings-nav')
  // 插件行才带 .settings-nav-label(外观 / 编辑器 / 浏览市场 三项没有)
  const rows = [...nav.querySelectorAll('button.settings-nav-item')]
    .filter(b => b.querySelector('.settings-nav-label'))
  const help = nav.querySelector('.settings-nav-help')
  return {
    rowCount: rows.length,
    names: rows.map(b => (b.querySelector('.settings-nav-label') || {}).textContent || ''),
    rowText: rows.map(b => b.textContent).join(' ').replace(/\\s+/g, ''),
    chips: nav.querySelectorAll('.plugin-kind-chip').length,
    helpIcon: help ? help.querySelectorAll('svg').length : 0,
    helpTitle: help ? (help.getAttribute('title') || '') : ''
  }
})()
`

const PLUGIN_PAGE_METRICS = `
(() => {
  const page = document.querySelector('.plugin-page')
  const meta = page ? page.querySelector('.plugin-meta') : null
  const txt = el => el ? el.innerText.replace(/\\s+/g, '') : ''
  return {
    hasPage: !!page,
    hasMeta: !!meta,
    metaChips: meta ? [...meta.querySelectorAll('.plugin-chip')].map(c => c.textContent.trim()) : [],
    metaText: txt(meta),
    pageText: txt(page),
    permRows: page ? page.querySelectorAll('.market-row-perms').length : 0,
    hasOpenWindow: !!page && txt(page).includes('打开窗口')
  }
})()
`

const INSTALLED_METRICS = `
(() => {
  const rows = [...document.querySelectorAll('.market-row')]
  return {
    rowCount: rows.length,
    pageText: (document.querySelector('.market-page') || {}).innerText || '',
    plugins: rows.map(r => ({
      name: ((r.querySelector('.market-row-name b') || {}).textContent || '').trim(),
      badges: [...r.querySelectorAll('.market-row-name .market-badge')].map(b => b.textContent.trim()),
      titleText: (r.querySelector('.market-row-title') || {}).innerText || '',
      perms: [...r.querySelectorAll('.market-row-perm')].map(c => ({
        text: c.textContent.trim(),
        title: c.getAttribute('title') || ''
      }))
    }))
  }
})()
`

interface NavMetrics {
  rowCount: number
  names: string[]
  rowText: string
  chips: number
  helpIcon: number
  helpTitle: string
}

interface PluginPageMetrics {
  hasPage: boolean
  hasMeta: boolean
  metaChips: string[]
  metaText: string
  pageText: string
  permRows: number
  hasOpenWindow: boolean
}

interface InstalledMetrics {
  rowCount: number
  pageText: string
  plugins: {
    name: string
    badges: string[]
    titleText: string
    perms: { text: string; title: string }[]
  }[]
}

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
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, '笔记.md'), 'hello world\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '笔记.md'),
        autoSave: false,
        // 不连市场:这一轮要看的是本地已安装列表,不是线上内容
        marketUrl: ''
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  // 内置包在这个时点被补装进数据根 —— 后面每一段断言都建立在「这几个插件在列表里」之上
  await initPluginHost(ensureBundledProvisioned)

  // 再补一个沙箱插件:内置兜底清单里只有脚本插件,不补的话「沙箱那一行」测的是空气。
  // 包是 `npm run plugins:build` 的产物,按 __dirname 找(打包后 harness 落在 out/main/)
  const host = getPluginHost()!
  const sandboxRaw = await readFile(
    join(__dirname, '../../src/main/market/builtin/note-embed.imkpkg.json'),
    'utf8'
  )
  const installed = await installFromEnvelope(host, JSON.parse(sandboxRaw), {
    source: 'local',
    publisher: null,
    registryUrl: null,
    // restricted main 显示的是「用户同意过的 ∩ 清单声明的」,所以这里要显式给授权
    grantedPermissions: ['vault:read']
  })
  console.log(`[verify] 补装沙箱插件 ${installed.name} ${installed.version}`)

  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(2500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  // 断言查的是「有没有」,排版好不好看只能看 —— 三段各留一张
  const shot = async (name: string): Promise<void> => {
    // 先让渲染层**真的画完一帧**:窗口不在前台时合成器可能还停在上一屏,
    // capturePage 拿到的是旧画面(实测:连着截两段会得到两张字节相同的图)。
    // **必须带超时**:窗口被遮挡 / 最小化时 rAF 根本不会跑,干等会把这个用例挂死。
    await Promise.race([
      evalJs('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'),
      sleep(500)
    ])
    await sleep(120)
    await mkdir(SHOTS, { recursive: true })
    await writeFile(join(SHOTS, name), (await wc.capturePage()).toPNG())
  }

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  /** 点左栏某一项(按显示文字找,不按下标 —— 顺序不是这一轮要钉的东西) */
  async function clickNav(text: string): Promise<boolean> {
    const clicked = await evalJs<boolean>(`
      (() => {
        const b = [...document.querySelectorAll('.settings-nav-item')]
          .find(x => x.textContent.includes(${JSON.stringify(text)}))
        if (!b) return false
        b.click()
        return true
      })()
    `)
    if (!clicked) return false
    await sleep(250)
    return true
  }

  console.log('\n[准备] 打开设置面板')
  await evalJs(`document.querySelector('button[title^="设置"]').click()`)
  const opened = await waitFor(`document.querySelector('.settings-nav')`)
  check('设置面板打开了', opened)
  if (!opened) {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(1)
    return
  }
  // 等插件列表到齐(三个内置包 + harness 补装的沙箱插件)
  await waitFor(`document.querySelectorAll('.settings-nav-label').length >= 4`)
  await sleep(300)

  // ---------- 1. 左栏 ----------
  console.log('\n[左栏] 插件列表不再挂形态标签,「插件」旁边多一个问号')
  const nav = await evalJs<NavMetrics>(NAV_METRICS)
  console.log(`     行: ${nav.names.join(' / ')}`)
  check(
    '前提:三个内置插件 + 补装的沙箱插件都在列表里(形态覆盖 script 与 sandboxed)',
    nav.rowCount === 4,
    `实际 ${nav.rowCount} 行 —— 少一行就有断言测不到东西`
  )
  check('列表里没有形态标签', nav.chips === 0, `还剩 ${nav.chips} 枚`)
  check(
    '行文字里没有「完整权限 / 沙箱 / 无代码」',
    !/完整权限|沙箱|无代码/.test(nav.rowText),
    nav.rowText
  )
  check('「插件」分组标题旁有问号图标', nav.helpIcon === 1, `找到 ${nav.helpIcon} 个 svg`)
  check(
    '问号的提示讲清了 node / restricted / render 三层',
    nav.helpTitle.includes('node main') &&
      nav.helpTitle.includes('restricted main') &&
      nav.helpTitle.includes('render 层'),
    nav.helpTitle
  )
  // 启用态就是运行态:Advanced Table 启用后从没执行过「操作」,但它的页面已经跑起来了,
  // 圆点不该还是灰的(本轮用户反馈的问题)
  const quickDot = await evalJs<{ cls: string; title: string }>(`
    (() => {
      const row = [...document.querySelectorAll('.settings-nav-item')]
        .find(x => x.textContent.includes('Advanced Table'))
      const dot = row ? row.querySelector('.plugin-status-dot') : null
      return {
        // 基础类也叫 plugin-status-dot,必须排除,否则永远命中它而不是状态后缀
        cls: dot ? ([...dot.classList].find(c => c.startsWith('plugin-status-') && c !== 'plugin-status-dot') || '') : '',
        title: dot ? (dot.getAttribute('title') || '') : ''
      }
    })()
  `)
  check('启用中的 Advanced Table 左栏是绿点', quickDot.cls === 'plugin-status-ok',
    `${quickDot.cls || '(没找到圆点)'} / title=${quickDot.title || '(空)'}`)
  check('圆点提示是「已启用」而不是「待运行」', quickDot.title === '已启用', quickDot.title)

  // ---------- 2. 插件设置页 · 脚本插件 ----------
  console.log('\n[插件设置页 · 定时上传（Git）] 信息卡整块消失,权限/校验值/入口都撤了')
  const onGit = await clickNav('定时上传')
  check('进到了插件设置页', onGit)
  const gitPage = await evalJs<PluginPageMetrics>(PLUGIN_PAGE_METRICS)
  check('页面渲染出来了', gitPage.hasPage)
  check(
    '内置插件的顶部卡片整块不显示(不再只剩一枚「内置插件」)',
    gitPage.hasMeta === false,
    `卡片内容:${gitPage.metaText || '(空)'}`
  )
  check('不再有「安装于」', !gitPage.pageText.includes('安装于'), gitPage.metaText)
  check('不再有 sha256', !gitPage.pageText.includes('sha256'))
  check('不再有「在市场里管理」', !gitPage.pageText.includes('在市场里管'))
  check('不再有「完整权限」字样', !gitPage.pageText.includes('完整权限'))
  check('权限那一行撤了(改列在市场「已安装」里)', gitPage.permRows === 0)
  await shot('plugin-ui-settings.png')

  // ---------- 3. 插件设置页 · 沙箱插件(反过来钉住不能删的东西) ----------
  console.log('\n[插件设置页 · 笔记引用面板(restricted + render)] 旧窗口入口必须消失')
  const onSandbox = await clickNav('笔记引用面板')
  check('进到了两层插件的设置页', onSandbox)
  const sandboxPage = await evalJs<PluginPageMetrics>(PLUGIN_PAGE_METRICS)
  check('「打开窗口」按钮已经移除', !sandboxPage.hasOpenWindow, sandboxPage.pageText.slice(0, 120))
  // 只看顶部卡片:note-embed 自己的描述里就写着「沙箱插件样板」,
  // 拿整页文字来断言会把插件作者的话也算进去
  check(
    '卡片里不再挂形态或来源标签',
    !/沙箱|本地安装|内置插件/.test(sandboxPage.metaText),
    sandboxPage.metaText
  )
  await shot('plugin-ui-sandbox.png')

  // ---------- 3.5 启用中的插件不再写「待运行 / 尚未运行」 ----------
  console.log('\n[插件设置页 · Advanced Table] 启用即运行中,状态卡不该写「待运行」')
  const onQuick = await clickNav('Advanced Table')
  check('进到了 Advanced Table 的设置页', onQuick)
  const quickStatus = await evalJs<string>(
    `(() => document.querySelector('.plugin-status-card')?.innerText.replace(/\\s+/g, ' ').trim() ?? '')()`
  )
  check(
    '状态卡是「运行中 / 已启用」',
    quickStatus.includes('运行中') && quickStatus.includes('已启用'),
    quickStatus
  )
  check('状态卡不再出现「待运行 / 尚未运行」', !/待运行|尚未运行/.test(quickStatus), quickStatus)

  // 日志是固定结构:时间 + 级别徽标 + 正文,逐条渲染;不是一整块自由文本
  const hasLogToggle = await waitFor(
    `[...document.querySelectorAll('.plugin-link')].some(b => b.textContent.includes('插件日志'))`
  )
  const logUi = await evalJs<{
    toggle: string
    rows: number
    levels: string[]
    times: number
    messages: number
  }>(`
    (async () => {
      const toggle = [...document.querySelectorAll('.plugin-link')].find(b => b.textContent.includes('插件日志'))
      if (!toggle) return { toggle: '', rows: 0, levels: [], times: 0, messages: 0 }
      toggle.click()
      await new Promise(r => setTimeout(r, 0))
      const rows = [...document.querySelectorAll('.plugin-log-line')]
      const text = sel => (sel ? sel.textContent.trim() : '')
      return {
        toggle: text(toggle),
        rows: rows.length,
        levels: rows.map(r => text(r.querySelector('.plugin-log-level'))),
        times: rows.filter(r => /^\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(text(r.querySelector('.plugin-log-time')))).length,
        messages: rows.filter(r => text(r.querySelector('.plugin-log-message')).length > 0).length
      }
    })()
  `)
  check('有「插件日志」入口且按条计数', hasLogToggle && /最近 \d+ 条/.test(logUi.toggle), logUi.toggle)
  check(
    '每条日志都有时间/级别/正文',
    logUi.rows > 0 &&
      logUi.times === logUi.rows &&
      logUi.messages === logUi.rows &&
      logUi.levels.every(Boolean),
    JSON.stringify(logUi)
  )
  check('级别徽标直接给出级别名', logUi.levels.includes('debug'), logUi.levels.join(' / '))

  // ---------- 4. 市场 · 已安装 ----------
  console.log('\n[市场 · 已安装] 只有受限插件列权限胶囊,完整权限插件只留徽标')
  const onMarket = await clickNav('浏览市场')
  check('打开了市场页', onMarket)
  const onTab = await evalJs<boolean>(`
    (() => {
      const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.includes('已安装'))
      if (!t) return false
      t.click()
      return true
    })()
  `)
  check('切到「已安装」页签', onTab)
  const listed = await waitFor(`document.querySelectorAll('.market-row').length >= 4`)
  await sleep(300)
  const inst = await evalJs<InstalledMetrics>(INSTALLED_METRICS)
  console.log(`     行: ${inst.plugins.map(p => `${p.name}[${p.badges.join(',')}]`).join(' / ')}`)
  check('前提:四行都在', listed && inst.rowCount === 4, `实际 ${inst.rowCount} 行`)

  const byName = (n: string): InstalledMetrics['plugins'][number] | undefined =>
    inst.plugins.find(p => p.name.includes(n))
  const git = byName('定时上传')
  const sandbox = byName('笔记引用面板')
  const quick = byName('Advanced Table')

  check(
    'node main 的徽标是「完整权限插件 + 内置插件」',
    JSON.stringify(git?.badges) === JSON.stringify(['完整权限插件', '内置插件']),
    git?.badges.join(' / ') ?? '(没找到这一行)'
  )
  check(
    '两层插件的徽标是「受限权限插件 + Render 层 + 本地安装」',
    JSON.stringify(sandbox?.badges) === JSON.stringify(['受限权限插件', 'Render 层', '本地安装']),
    sandbox?.badges.join(' / ') ?? '(没找到这一行)'
  )
  check(
    '权限胶囊本身不再带「权限」二字',
    sandbox !== undefined && !sandbox.perms.some(p => p.text.includes('权限')),
    sandbox?.perms.map(p => p.text).join(' / ')
  )
  // node main 本来就有完整 Node:清单里的权限不构成门禁,列在这里会被读成
  // 「只被允许做这几件事」。声明留在安装确认框与详情页(那里写明「以下为告知」)。
  check(
    '完整权限插件不列权限胶囊(只留「完整权限插件」徽标)',
    git !== undefined && git.perms.length === 0,
    git?.perms.map(p => p.text).join(' / ') || '(空)'
  )
  check(
    '每枚权限胶囊自带说明(title 非空)',
    sandbox !== undefined && sandbox.perms.length > 0 && sandbox.perms.every(p => p.title.length > 0),
    sandbox?.perms.map(p => `${p.text}:${p.title ? '有' : '无'}`).join(' ')
  )
  check(
    '两层插件也列了权限(1 条:读取仓库文件)',
    sandbox?.perms.length === 1 && sandbox.perms[0]?.text === '读取仓库文件',
    `${sandbox?.perms.length ?? 0} 条:${sandbox?.perms.map(p => p.text).join(' / ') ?? ''}`
  )
  check(
    '没有权限的插件不留空行',
    quick !== undefined && quick.perms.length === 0,
    quick ? `Advanced Table 有 ${quick.perms.length} 条` : '没找到 Advanced Table 那一行'
  )
  check('列表里不再有「含代码 / 不含代码」', !inst.pageText.includes('含代码'))
  check('整页都不再说「应用自带」', !inst.pageText.includes('应用自带'))
  await shot('plugin-ui-installed.png')

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
