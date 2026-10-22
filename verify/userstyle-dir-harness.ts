/**
 * 验收:自定义样式里的**目录项**(以及列表上不再有「不使用」行、不再显示体积)。
 *
 * 这一轮改的三件事都落在这里:候选可以是单个 .css 也可以是目录(目录递归生效)、
 * 取消选择靠「再点一次已选中那一行」、行尾只留元信息不留大小。
 *
 * 跑法:node verify/run.mjs userstyle-dir
 *
 * ⚠️ 改了 `src/main/**` 或 `src/renderer/**` 之后要先跑一次 `npx electron-vite build`
 * (渲染层与 preload 走 out/ 里的构建产物,见 verify/run.mjs 顶部的说明)。
 *
 * 样式目录是数据根下的 `css/`(见 main/dataDir.ts),所以它跟着 `--user-data-dir`
 * 一起被隔离,不需要再改 `app.getPath('home')` 来躲开用户的真实目录。
 */

import { app, BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import {
  ensureUserStylesDir,
  importUserStyleDir,
  readUserStyles,
  startUserStylesWatch,
  stopUserStylesWatch,
  userStylesDir
} from '../src/main/userStyles'

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const stylesDir = userStylesDir()
  await mkdir(join(stylesDir, 'theme', 'sub'), { recursive: true })
  await mkdir(join(stylesDir, 'empty-theme'), { recursive: true })
  await writeFile(join(stylesDir, 'plain.css'), '.verify-probe { border-top-color: rgb(7, 8, 9) }\n', 'utf8')
  await writeFile(join(stylesDir, 'theme', 'a.css'), '.verify-probe { color: rgb(1, 2, 3) }\n', 'utf8')
  await writeFile(join(stylesDir, 'theme', 'sub', 'b.css'), '.verify-probe { font-style: italic }\n', 'utf8')

  const vault = join(app.getPath('userData'), 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, '笔记.md'), 'hello world\n', 'utf8')
  await writeFile(
    join(app.getPath('userData'), 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '笔记.md'),
        marketUrl: '',
        // 选中那个目录 —— 这一份是「改后」才存在的用法
        userStyle: 'theme'
      },
      null,
      2
    ),
    'utf8'
  )

  console.log('\n[A] 清单:目录与文件都是候选项')
  const state = await readUserStyles()
  const theme = state.items.find(i => i.name === 'theme')
  const plain = state.items.find(i => i.name === 'plain.css')
  const empty = state.items.find(i => i.name === 'empty-theme')

  check('目录项被列出来了(kind=dir)', theme?.kind === 'dir' && plain?.kind === 'file', JSON.stringify({ theme: theme?.kind, plain: plain?.kind }))
  check('目录项递归数到了子目录里的 .css', theme?.fileCount === 2, `数到 ${theme?.fileCount} 个`)
  check('目录项的文本是按相对路径拼好的', theme?.css?.includes('=== a.css ===') === true && theme?.css?.includes('=== sub/b.css ===') === true && theme?.css?.includes('font-style: italic') === true)
  check('没有 .css 的目录是错误项(界面上不可选)', empty?.css === null && empty?.error === '目录里没有 .css', JSON.stringify({ css: empty?.css, error: empty?.error }))
  check('清单里不再有 size 字段', theme !== undefined && !('size' in theme))

  console.log('\n[B] 渲染层:选中目录 → 目录里所有 .css 一起生效')
  const settings = await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  startUserStylesWatch()
  await sleep(2500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  // 探针:自定义样式是全局的,anything 带这个类名就够
  await evalJs(`(() => { const d = document.createElement('div'); d.className = 'verify-probe'; d.id = 'probe'; document.body.appendChild(d); return true })()`)
  const probe = (): Promise<{ color: string; fontStyle: string; borderTop: string }> =>
    evalJs(`(() => {
      const s = getComputedStyle(document.getElementById('probe'))
      return { color: s.color, fontStyle: s.fontStyle, borderTop: s.borderTopColor }
    })()`)

  const injected = await evalJs<string>(`(document.querySelector('style[data-imarkdown-style="user:theme"]') || {}).textContent || ''`)
  check('按目录名注入了一份样式(id = user:theme)', injected.includes('=== sub/b.css ==='), injected.slice(0, 60))
  const css = await probe()
  check('目录顶层那份 .css 生效了', css.color === 'rgb(1, 2, 3)', JSON.stringify(css))
  check('**子目录**那份 .css 也生效了(递归)', css.fontStyle === 'italic', JSON.stringify(css))
  check('没选中的文件不生效(同时只有一项)', css.borderTop !== 'rgb(7, 8, 9)', JSON.stringify(css))

  console.log('\n[C] 目录里存一次盘 → 跟着生效')
  await writeFile(join(stylesDir, 'theme', 'sub', 'b.css'), '.verify-probe { font-style: oblique }\n', 'utf8')
  const updated = await waitFor(`getComputedStyle(document.getElementById('probe')).fontStyle === 'oblique'`, 6000)
  check('子目录里的文件改了,页面跟着变(递归监听)', updated)

  console.log('\n[D] 界面:列表长什么样')
  await evalJs(`document.querySelector('button[title^="设置"]').click()`)
  const opened = await waitFor(`document.querySelector('.userstyle-list')`)
  check('设置面板打开了,样式列表在', opened)
  await sleep(200)
  const ui = await evalJs<{
    texts: string[]
    rows: string[]
    sizes: number
    noUseRow: boolean
    activeRow: string
    actionText: string
    openDirTooltip: string
    openDirIsIcon: boolean
  }>(
    `(() => {
      const list = document.querySelector('.userstyle-list')
      const rows = [...list.querySelectorAll('.userstyle-item')]
      const actions = document.querySelector('.userstyle-actions')
      const openDir = actions.querySelector('.userstyle-open-dir')
      return {
        texts: rows.map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
        rows: rows.map(r => r.querySelector('.userstyle-item-name').textContent.trim()),
        sizes: rows.filter(r => /(KiB|MiB|B$)/.test(r.textContent)).length,
        noUseRow: [...document.querySelectorAll('.userstyle-item')].some(r => r.textContent.includes('不使用自定义样式')),
        activeRow: (rows.find(r => r.classList.contains('userstyle-item-active')) || {}).textContent?.replace(/\\s+/g, ' ').trim() || '',
        actionText: actions.textContent.replace(/\\s+/g, ' ').trim(),
        openDirTooltip: openDir.title,
        openDirIsIcon: openDir.querySelector('svg') !== null && openDir.textContent.trim() === ''
      }
    })()`
  )
  check('目录行的元信息是「N 个 .css」', ui.texts.some(t => t.startsWith('theme') && t.includes('2 个 .css')), ui.texts.join(' | '))
  check('空目录行标出了原因', ui.texts.some(t => t.startsWith('empty-theme') && t.includes('目录里没有 .css')), ui.texts.join(' | '))
  check('列表里没有「不使用自定义样式」这一行', ui.noUseRow === false)
  check('列表里没有任何体积文本', ui.sizes === 0)
  check('生效的是被选中的那个目录', ui.activeRow.startsWith('theme'), ui.activeRow)
  check(
    '按钮行里不再显示路径(它只在 tooltip 里)',
    !ui.actionText.includes(stylesDir) && !ui.actionText.includes('.imark'),
    ui.actionText
  )
  check(
    '「打开配置文件夹」是个图标按钮,路径挪进了 tooltip',
    ui.openDirIsIcon && ui.openDirTooltip.startsWith('打开配置文件夹 ') && ui.openDirTooltip.includes(stylesDir),
    JSON.stringify({ icon: ui.openDirIsIcon, tip: ui.openDirTooltip })
  )

  console.log('\n[E] 取消选择:再点一次已选中的那一行')
  await evalJs(
    `[...document.querySelectorAll('.userstyle-item')].find(r => r.querySelector('.userstyle-item-name').textContent.trim() === 'theme').click()`
  )
  await sleep(400)
  const gone = await evalJs<boolean>(`!document.querySelector('style[data-imarkdown-style="user:theme"]')`)
  check('注入的样式被撤下了', gone)
  const saved = JSON.parse(await readFile(join(app.getPath('userData'), 'settings.json'), 'utf8')) as { userStyle: string | null }
  check('选择被落盘为 null(下次启动也不会又冒出来)', saved.userStyle === null, JSON.stringify(saved.userStyle))
  const noneActive = await evalJs<number>(`document.querySelectorAll('.userstyle-item-active').length`)
  check('界面上没有任何一行是选中态', noneActive === 0, `${noneActive} 行`)

  console.log('\n[F] 导入一个文件夹 = 整棵复制成样式目录')
  const src = join(app.getPath('userData'), 'import-me')
  await mkdir(join(src, 'deep'), { recursive: true })
  await writeFile(join(src, 'x.css'), '.x { color: red }\n', 'utf8')
  await writeFile(join(src, 'deep', 'y.css'), '.y { color: blue }\n', 'utf8')
  await writeFile(join(src, 'readme.md'), '不该被带进来\n', 'utf8')
  const outcome = await importUserStyleDir(src)
  check('导入成功', outcome.imported.length === 1 && outcome.failed.length === 0, JSON.stringify(outcome))
  check('落在同名目录下,保留了子目录结构', existsSync(join(stylesDir, 'import-me', 'deep', 'y.css')))
  check('非 .css 的文件没被带进来', !existsSync(join(stylesDir, 'import-me', 'readme.md')))
  const again = await importUserStyleDir(src)
  check('同一个文件夹再导一次 → 认成重复,不复制', again.imported.length === 0 && again.duplicates.length === 1, JSON.stringify(again))
  await rm(src, { recursive: true, force: true })

  console.log('\n[G] 点在圆点上和点在行上是一回事')
  const clickRadio = (name: string): Promise<unknown> =>
    evalJs(
      `(() => {
         const row = [...document.querySelectorAll('.userstyle-item')].find(r => r.querySelector('.userstyle-item-name').textContent.trim() === ${JSON.stringify(name)})
         row.querySelector('.userstyle-radio').click()
         return true
       })()`
    )
  await clickRadio('plain.css')
  await sleep(400)
  const picked = await probe()
  check('点圆点会选中该行', picked.borderTop === 'rgb(7, 8, 9)', JSON.stringify(picked))
  const rowActive = await evalJs<string>(
    `(document.querySelector('.userstyle-item-active') || {}).textContent?.replace(/\\s+/g, ' ').trim() || ''`
  )
  check('该行显示为选中态', rowActive.startsWith('plain.css'), rowActive)
  await clickRadio('plain.css')
  await sleep(400)
  const off = await probe()
  check('再点一次圆点 → 取消(浏览器不会自己把它勾回来)', off.borderTop !== 'rgb(7, 8, 9)', JSON.stringify(off))

  stopUserStylesWatch()

  console.log('\n[H] 首次安装播种示例(example.css / point.css)')
  await rm(stylesDir, { recursive: true, force: true })
  await ensureUserStylesDir()
  const seeded = (await readUserStyles()).items.map(i => i.name)
  check(
    '目录不存在时播种 example.css 与 point.css',
    seeded.includes('example.css') && seeded.includes('point.css'),
    seeded.join(', ')
  )
  const exampleCss = await readFile(join(stylesDir, 'example.css'), 'utf8')
  const covered = [
    '.cm-md-h1',
    '.cm-md-h6',
    '.cm-md-strong',
    '.cm-md-em',
    '.cm-md-strike',
    '.cm-md-inlinecode',
    '.cm-md-code',
    '.cm-md-codeinfo',
    '.cm-md-link',
    '.cm-md-url',
    '.cm-md-table',
    '.cm-md-quote',
    '.cm-md-listmark',
    '.cm-md-headermark',
    '.cm-md-math',
    '.cm-md-checkbox',
    '.cm-md-hr',
    '.cm-md-image img',
    '--accent',
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
    '--border',
    '--bg-code',
    '--bg-codeblock',
    '--bg-selection'
  ]
  const missing = covered.filter(sel => !exampleCss.includes(sel))
  check('example.css 覆盖帮助面板列出的每一类节点与主题变量', missing.length === 0, `缺:${missing.join(', ')}`)
  const pointCss = await readFile(join(stylesDir, 'point.css'), 'utf8')
  check(
    'point.css 同时覆盖列表标记与圆点的伪元素',
    pointCss.includes('.cm-md-listmark {') && pointCss.includes('.cm-md-listmark-bullet::after')
  )
  // 把 point.css 注入页面,验证级联真的压过内置的 --accent(内置规则在同特异性下更早)
  await evalJs(
    `(() => {
       const s = document.createElement('style')
       s.textContent = ${JSON.stringify(pointCss)}
       document.head.appendChild(s)
       const el = document.createElement('span')
       el.id = 'point-probe'
       el.className = 'cm-md-listmark cm-md-listmark-bullet'
       el.textContent = '-'
       document.body.appendChild(el)
       return true
     })()`
  )
  const bulletColor = await evalJs<string>(
    `getComputedStyle(document.getElementById('point-probe'), '::after').color`
  )
  const textColor = await evalJs<string>(`getComputedStyle(document.body).color`)
  check('point.css 把圆点改成正文色(不再是强调蓝)', bulletColor === textColor, `圆点 ${bulletColor},正文 ${textColor}`)
  await rm(join(stylesDir, 'example.css'), { force: true })
  await ensureUserStylesDir()
  check('用户删掉的示例不会被下次启动塞回来', !existsSync(join(stylesDir, 'example.css')))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
