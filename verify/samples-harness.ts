/**
 * 验收:两个真实样例插件的两层行为。
 *
 *   note-embed  restricted main + render:面板列出仓库笔记、点击预览、状态栏动作
 *               经 main 转发到 render 切换面板;
 *   todo-marks  render-only:自己画 CM6 装饰与 DOM 面板,停用后全部收走。
 *
 * 跑法:node verify/run.mjs samples
 * ⚠️ 改了 src/renderer/** 或 plugins-src/** 之后先 build + plugins:build。
 */

import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost, type PluginHost } from '../src/main/plugins/host'
import { createMainWindow } from '../src/main/window'
import { installFromEnvelope } from '../src/main/market/installer'
import { registerPluginScheme, pluginWebContentsOf } from '../src/main/plugins/restrictedPage'
import noteEmbedPackage from '../src/main/market/builtin/note-embed.imkpkg.json?raw'
import todoMarksPackage from '../src/main/market/builtin/todo-marks.imkpkg.json?raw'

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  let last = await fn()
  while (!ok(last) && Date.now() < end) {
    await sleep(120)
    last = await fn()
  }
  return last
}

registerPluginScheme()

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
  await writeFile(join(vault, '第一篇.md'), '# 第一篇\n这是第一篇的正文。\n', 'utf8')
  await writeFile(join(vault, '第二篇.md'), '# 第二篇\nTODO: 第二篇还有一件事。\n', 'utf8')

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        vaultPath: vault,
        vaults: [vault],
        skipVaultPicker: true,
        lastFile: join(vault, '第二篇.md'),
        autoSave: false,
        marketUrl: '',
        plugins: {}
      },
      null,
      2
    ),
    'utf8'
  )
  const settings = await loadSettings()

  await initPluginHost()
  const host = getPluginHost() as PluginHost

  const installedNote = await installFromEnvelope(host, JSON.parse(noteEmbedPackage), {
    source: 'local',
    publisher: null,
    registryUrl: null,
    grantedPermissions: ['vault:read']
  })
  const installedTodo = await installFromEnvelope(host, JSON.parse(todoMarksPackage), {
    source: 'local',
    publisher: null,
    registryUrl: null,
    grantedPermissions: []
  })
  console.log(`[verify] 已安装 ${installedNote.id} / ${installedTodo.id}`)

  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  console.log('\n[A] note-embed:restricted main + render')
  await host.save('note-embed', { enabled: true })
  const panelReady = await until(
    () => evalJs<boolean>(`!!document.querySelector('.imk-note-panel')`),
    v => v
  )
  check('render 层创建了自己的面板', panelReady)
  const notes = await until(
    () => evalJs<string[]>(`[...document.querySelectorAll('.imk-note-list li')].map(li => li.textContent)`),
    list => list.some(t => t.includes('第一篇.md')) && list.some(t => t.includes('第二篇.md'))
  )
  check('restricted main 读到了仓库笔记列表', notes.length >= 2, JSON.stringify(notes))

  const preview = await evalJs<boolean>(`
    (() => {
      const item = [...document.querySelectorAll('.imk-note-list li')].find(li => li.textContent.includes('第一篇.md'))
      if (!item) return false
      item.click()
      return true
    })()
  `)
  check('点得动笔记列表', preview)
  const previewText = await until(
    () => evalJs<string>(`document.querySelector('.imk-note-preview')?.textContent || ''`),
    text => text.includes('这是第一篇的正文')
  )
  check('main → render 的预览内容到了', previewText.includes('这是第一篇的正文'), previewText.slice(0, 80))

  const beforeToggle = await evalJs<boolean>(`document.querySelector('.imk-note-panel').hidden`)
  const toggled = await host.runAction('note-embed', 'toggle')
  check('清单动作 toggle 由 main 层接住', toggled.ok, toggled.message)
  const afterToggle = await until(
    () => evalJs<boolean>(`document.querySelector('.imk-note-panel').hidden`),
    hidden => hidden !== beforeToggle
  )
  check('main → render 的 toggle 真的切换了面板', afterToggle !== beforeToggle)

  console.log('\n[B] todo-marks:render-only')
  await host.save('todo-marks', { enabled: true })
  const todoPanel = await until(
    () => evalJs<boolean>(`!!document.querySelector('.imk-todo-panel')`),
    v => v
  )
  check('render 层创建了自己的待办面板', todoPanel)
  const todoItems = await until(
    () => evalJs<string[]>(`[...document.querySelectorAll('.imk-todo-list li')].map(li => li.textContent)`),
    list => list.some(t => t.includes('TODO'))
  )
  check('扫到了当前文档里的 TODO', todoItems.some(t => t.includes('TODO')), JSON.stringify(todoItems))
  const marks = await until(
    () => evalJs<number>(`document.querySelectorAll('.cm-content .imk-todo').length`),
    n => n >= 1
  )
  check('CM6 装饰真的画到了正文上', marks >= 1, String(marks))
  const refreshed = await host.runAction('todo-marks', 'refresh')
  check('render-only 插件的清单动作走 render', refreshed.ok, refreshed.message)

  console.log('\n[C] 停用清理')
  await host.save('todo-marks', { enabled: false })
  const todoGone = await until(
    () => evalJs<boolean>(`!document.querySelector('.imk-todo-panel') && document.querySelectorAll('.cm-content .imk-todo').length === 0`),
    v => v
  )
  check('todo-marks 停用后面板与装饰都消失', todoGone)
  await host.save('note-embed', { enabled: false })
  const noteGone = await until(
    () => evalJs<boolean>(`!document.querySelector('.imk-note-panel')`),
    v => v
  )
  check('note-embed 停用后面板消失', noteGone)
  const pageGone = await until(async () => pluginWebContentsOf('note-embed') === null, v => v, 4000)
  check('note-embed 的隐藏执行页也关闭', pageGone)

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
