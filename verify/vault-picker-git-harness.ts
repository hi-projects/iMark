/**
 * 仓库选择页：从远端克隆 + 项目级远端管理。
 *
 * 用户可见的两件事：
 *   A 选择页是 Obsidian 式左右结构：左边「最近仓库」，右边三个动作图标；
 *   B 右侧「从远端克隆仓库」能把远端克隆成本地仓库，打开它，并且**顺手**把
 *     这一份远端写进项目级 Git 配置（不再写进「远程同步」扩展的 workspace 覆盖层）。
 *
 * 后半段验证「项目级管理」本身：左侧项目行的 Git 设置能读回刚写的远端、
 * 改地址/分支时不清掉已保存的令牌、移除配置后设置页与列表标记一起消失。
 *
 * 真 git、真克隆 —— 远端是临时目录里的裸仓库，用 file:// 地址克隆（本地路径
 * 克隆不走 upload-pack，git 不会打印进度）。除了磁盘/设置里的结果，还拦下
 * 主进程推给渲染层的克隆进度，确认进度真的在走。
 *
 * 跑法（先 npm run build；Linux 无头用 xvfb-run）：
 *   IMARK_VERIFY_HIDDEN=1 xvfb-run -a node verify/run.mjs vault-picker-git
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { APP_VERSION } from './appVersion'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { getSettingsSync, loadSettings } from '../src/main/settings'
import { getSecret } from '../src/main/secrets'
import { initExtensions } from '../src/main/extensions/service'
import { installExtensionPackage } from '../src/main/extensions/installer'
import {
  projectGitKey,
  projectGitSecretKey,
  readProjectGitRemotes,
  setProjectGitRemote
} from '../src/main/projectGit'
import { createMainWindow } from '../src/main/window'
import { credentialArgs } from '../src/main/git'
import { IPC } from '../src/shared/ipc-channels'
import type { CloneProgress, ProjectGitRemoteConfig, VaultGitRemote } from '../src/shared/types'

const run = promisify(execFile)
const REPO = join(__dirname, '..', '..')
const EXT_ID = 'imark.git-sync'

// 特权 scheme 必须在 app ready 之前注册（与 src/main/index.ts 一致）
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

/** 验收窗口一律不显示：窗口照常创建与渲染，只是不出现在屏幕上 */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'harness',
      GIT_AUTHOR_EMAIL: 'harness@local',
      GIT_COMMITTER_NAME: 'harness',
      GIT_COMMITTER_EMAIL: 'harness@local'
    }
  })
  return stdout
}

/** 直接读设置缓存里的项目级 Git 配置：验证的是扩展真正会读的那份值 */
function projectConfigOf(root: string): ProjectGitRemoteConfig | null {
  return getSettingsSync()?.projectGit?.[projectGitKey(root)] ?? null
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs vault-picker-git` 跑会自动带上）')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})
  await app.whenReady()

  const ud = app.getPath('userData')
  const source = join(ud, 'source-repo')
  const remote = join(ud, 'source-remote.git')
  const cloneParent = join(ud, 'clones')
  const cloned = join(cloneParent, 'cloned-notes')
  // 用 file:// 而不是裸路径:本地路径克隆不走 upload-pack,git 不输出进度;
  // file:// 走真正的传输路径,才能验收「克隆时有进度」。
  const cloneUrl = pathToFileURL(remote).href
  const notePath = join(source, '笔记.md')
  const noteBody = '# 第一篇\n\n从远端克隆下来的笔记。\n'

  // 干净起步：内置包、扩展登记、密钥、旧克隆都不能影响断言
  for (const dir of [source, remote, cloneParent, join(ud, 'plugins'), join(ud, 'logs')]) {
    await rm(dir, { recursive: true, force: true })
  }
  await rm(join(ud, 'secrets.json'), { force: true })
  await mkdir(source, { recursive: true })
  await writeFile(notePath, noteBody, 'utf8')
  await git(source, ['init', '--initial-branch=main'])
  await git(source, ['add', '-A'])
  await git(source, ['commit', '-m', 'first'])
  // 裸仓库当远端；clone 用本地路径，不经过网络与凭据
  await git(ud, ['clone', '--bare', source, remote])

  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: false,
        vaultPath: null,
        vaults: [],
        lastFile: null,
        openFiles: [],
        autoSaveMode: 'off',
        marketUrl: '',
        marketAutoCheck: false,
        extensions: {
          [EXT_ID]: { enabled: true, config: {} }
        }
      },
      null,
      2
    ),
    'utf8'
  )

  const envelope = JSON.parse(
    await readFile(join(REPO, 'src/main/market/builtin/imark.git-sync.imkpkg.json'), 'utf8')
  ) as unknown
  await installExtensionPackage(envelope, { source: 'bundled', appVersion: APP_VERSION })

  registerIpc()
  registerImarkProtocol()
  await initExtensions({ appVersion: APP_VERSION })

  // 克隆位置由对话框选择：直接返回临时目录，不弹窗口
  ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
    canceled: false,
    filePaths: [cloneParent]
  })

  const settings = await loadSettings()
  const win = createMainWindow(settings)
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', details => {
    if (details.level === 'error') console.log(`     [渲染层错误] ${details.message}`)
  })
  await new Promise<void>(res =>
    win.webContents.once('did-finish-load', () => res())
  )

  function evalJs<T>(code: string): Promise<T> {
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async function waitFor(code: string, ms = 10_000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
          return true
        }
      } catch {
        /* 页面还没就绪 */
      }
      await sleep(60)
    }
    return false
  }

  async function click(selector: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  /** 给受控输入/下拉赋值：走原型 setter + input/change，v-model 才会收到 */
  async function setField(selector: string, value: string): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }

  const textOf = (selector: string): Promise<string | null> =>
    evalJs<string | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      return el ? (el.textContent || '').trim() : null
    })()`)

  async function waitText(selector: string, expected: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if ((await textOf(selector).catch(() => null)) === expected) return true
      await sleep(60)
    }
    return false
  }

  async function remoteOf(path: string): Promise<VaultGitRemote | null> {
    return (await readProjectGitRemotes([path]))[path] ?? null
  }

  // 主进程把克隆进度推给渲染层;拦下这些消息,断言「克隆时确实有进度」
  const cloneProgressEvents: CloneProgress[] = []
  const rawSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = ((channel: string, ...args: unknown[]) => {
    if (channel === IPC.VaultCloneProgress) {
      cloneProgressEvents.push(args[0] as CloneProgress)
    }
    return rawSend(channel, ...args)
  }) as typeof win.webContents.send

  // ---------- A. 左右结构 ----------

  console.log('\n【A】选择页是左右结构，右侧有三个动作图标')
  check('启动停在仓库选择页', await waitFor(`document.querySelector('.vault-picker')`))
  check('左侧最近仓库列表存在', await waitFor(`document.querySelector('.vault-picker-sidebar .vault-picker-list')`))
  check('右侧动作区存在', await waitFor(`document.querySelector('.vault-picker-main .vault-picker-actions')`))
  const labels = await evalJs<string[]>(
    `[...document.querySelectorAll('.vault-picker-actions button')].map(el => el.getAttribute('aria-label') || '')`
  )
  check(
    '三个动作图标：克隆 / 打开 / 新建',
    JSON.stringify(labels) ===
      JSON.stringify(['从远端克隆仓库', '打开文件夹作为仓库', '创建新仓库']),
    JSON.stringify(labels)
  )
  const actionLabels = await evalJs<string[]>(
    `[...document.querySelectorAll('.vault-picker-actions button')].map(el => el.textContent.trim())`
  )
  check(
    '三个图标带标注：克隆 / 打开 / 创建',
    JSON.stringify(actionLabels) === JSON.stringify(['克隆', '打开', '创建']),
    JSON.stringify(actionLabels)
  )
  const subtitle = await evalJs<string>(
    `document.querySelector('.vault-picker-subtitle')?.textContent.trim() ?? ''`
  )
  check('副标题改成「克隆、打开、创建一个仓库」', subtitle === '克隆、打开、创建一个仓库', subtitle)
  const skipCentered = await evalJs<boolean>(
    `document.querySelector('.vault-picker-skip')
      ? getComputedStyle(document.querySelector('.vault-picker-skip')).justifyContent === 'center'
      : false`
  )
  check('启动选项居中', skipCentered)
  check('还没有最近仓库时列表为空', await waitFor(`document.querySelector('.vault-picker-empty')`))

  // ---------- B. 从远端克隆 ----------

  console.log('\n【B】从远端克隆：真克隆 + 自动写入项目远端')
  check(
    '没填令牌也清空系统 credential helper（git 不会弹认证窗口）',
    credentialArgs(false).join(' ') === '-c credential.helper=',
    credentialArgs(false).join(' ')
  )
  check('点击「克隆」进入表单', (await click('[data-action="start-clone"]')) && (await waitFor(`document.querySelector('[data-field="clone-url"]')`)))
  check(
    '克隆表单带滑入动画',
    await evalJs<boolean>(
      `document.querySelector('.vault-picker-form')?.classList.contains('vault-picker-pane-forward')`
    )
  )
  check('填写仓库地址', await setField('[data-field="clone-url"]', cloneUrl))
  check(
    '文件夹名自动从地址推导（source-remote）',
    await waitFor(`document.querySelector('[data-field="clone-name"]').value === 'source-remote'`),
    String(await evalJs(`document.querySelector('[data-field="clone-name"]')?.value`))
  )
  check('改成自定义文件夹名', await setField('[data-field="clone-name"]', 'cloned-notes'))
  check('填写分支', await setField('[data-field="clone-branch"]', 'main'))
  check('认证方式保持访问令牌', await setField('[data-field="clone-auth"]', 'token'))
  check('填写访问令牌', await setField('[data-field="clone-secret"]', 'fake-token'))
  const authAppearance = await evalJs<string>(
    `getComputedStyle(document.querySelector('[data-field="clone-auth"]')).appearance`
  )
  check('认证方式下拉去掉原生外观（文字与 placeholder 对齐）', authAppearance === 'none', authAppearance)
  check('点击「克隆」', await click('[data-action="clone-submit"]'))

  const enteredEditor = await waitFor(`document.querySelector('.app-shell')`, 30_000)
  check('克隆成功后进入编辑器', enteredEditor)

  const progressPhases = new Set(cloneProgressEvents.map(e => e.phase))
  check('克隆过程中收到进度事件', cloneProgressEvents.length > 0, String(cloneProgressEvents.length))
  check(
    '进度覆盖对象统计与接收阶段',
    progressPhases.has('统计对象') && progressPhases.has('接收对象'),
    [...progressPhases].join('/')
  )
  check('进度最终到 100%', cloneProgressEvents.some(e => e.percent === 100), JSON.stringify(cloneProgressEvents.slice(-2)))
  check(
    '进度带对象计数',
    cloneProgressEvents.some(e => /\d+\/\d+/.test(e.detail)),
    JSON.stringify(cloneProgressEvents.slice(0, 3))
  )
  check('克隆出来的笔记在磁盘上', existsSync(join(cloned, '笔记.md')))
  check(
    '笔记内容与远端一致',
    existsSync(join(cloned, '笔记.md')) &&
      // 检出时的换行随 core.autocrlf 走(Windows 默认转 CRLF),断言归一后再比
      (await readFile(join(cloned, '笔记.md'), 'utf8')).replace(/\r\n/g, '\n') === noteBody
  )
  check(
    '克隆结果登记的仓库就是克隆目录',
    (getSettingsSync()?.vaults ?? []).includes(cloned),
    JSON.stringify(getSettingsSync()?.vaults)
  )

  const saved = projectConfigOf(cloned)
  check('项目远端已写入项目级配置', !!saved, JSON.stringify(saved))
  check('远端地址就是克隆地址', saved?.url === cloneUrl, JSON.stringify(saved))
  check('认证方式沿用表单里的 token', saved?.auth === 'token', JSON.stringify(saved))
  check('本地分支是克隆后检出的 main', saved?.localBranch === 'main', JSON.stringify(saved))
  const afterClone = await remoteOf(cloned)
  check('令牌已保存（渲染层只看到 hasSecret）', afterClone?.hasSecret === true, JSON.stringify(afterClone))
  check(
    '令牌明文可以解出来，且存在项目级密钥槽位',
    (await getSecret(projectGitSecretKey(cloned, 'token'))) === 'fake-token'
  )

  // ---------- C. 回到选择页：列表显示项目远端 ----------

  console.log('\n【C】回到选择页：项目行带 Git 标记，副标题仍是本地路径')
  win.webContents.send(IPC.MenuCommand, 'file:open-vault')
  check('回到仓库选择页', await waitFor(`document.querySelector('.vault-picker')`))
  check('列表里出现刚克隆的项目', await waitFor(`document.querySelectorAll('.vault-row').length === 1`))
  // 列表副标题永远是本地路径；远端地址只出现在 Git 标记的悬停提示与设置面板里
  check('行的路径位置显示本地路径', await waitText('.vault-row-path', cloned))
  check('行上有 Git 标记', await waitFor(`document.querySelector('.vault-row-git')`))
  check(
    '已存令牌时标记不是「未完成」样式',
    await evalJs<boolean>(`!document.querySelector('.vault-row-git')?.classList.contains('vault-row-git-missing')`)
  )

  // ---------- D. 项目 Git 设置：读回、修改、不清令牌 ----------

  console.log('\n【D】项目 Git 设置：预填、修改地址与分支，令牌保持不变')
  check('打开项目 Git 设置', (await click('[data-action="git-open"]')) && (await waitFor(`document.querySelector('[data-field="git-url"]')`)))
  const prefilled = await evalJs<{ url: string; branch: string; auth: string; placeholder: string }>(`(() => ({
    url: document.querySelector('[data-field="git-url"]').value,
    branch: document.querySelector('[data-field="git-branch"]').value,
    auth: document.querySelector('[data-field="git-auth"]').value,
    placeholder: document.querySelector('[data-field="git-secret"]')?.placeholder ?? ''
  }))()`)
  check('地址已预填', prefilled.url === cloneUrl, JSON.stringify(prefilled))
  check('分支已预填', prefilled.branch === 'main', JSON.stringify(prefilled))
  check('认证方式已预填', prefilled.auth === 'token', JSON.stringify(prefilled))
  check('令牌输入框提示「已保存」', prefilled.placeholder.includes('已保存'), prefilled.placeholder)

  const newUrl = 'https://example.com/group/other.git'
  check('修改远端地址', await setField('[data-field="git-url"]', newUrl))
  check('修改本地分支', await setField('[data-field="git-branch"]', 'dev'))
  check('令牌留空并保存', await click('[data-action="git-save"]'))
  check(
    '保存后配置里的地址/分支已更新',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        const t = projectConfigOf(cloned)
        if (t?.url === newUrl && t?.localBranch === 'dev') return true
        await sleep(60)
      }
      return false
    })(),
    JSON.stringify(projectConfigOf(cloned))
  )
  const afterSave = await remoteOf(cloned)
  check('只改地址/分支时令牌仍然在（留空 = 保持）', afterSave?.hasSecret === true, JSON.stringify(afterSave))
  check(
    '密钥槽位里仍是原来那把令牌',
    (await getSecret(projectGitSecretKey(cloned, 'token'))) === 'fake-token'
  )
  check('保存后回到动作列表', await waitFor(`document.querySelector('.vault-picker-actions')`))
  check('项目行的副标题不随远端地址变化', await waitText('.vault-row-path', cloned))

  // ---------- E. 移除项目远端 ----------

  console.log('\n【E】移除项目远端：配置、令牌、列表标记一起清掉')
  check('再次打开 Git 设置', (await click('[data-action="git-open"]')) && (await waitFor(`document.querySelector('[data-action="git-clear"]')`)))
  check('点击「移除远端配置」', await click('[data-action="git-clear"]'))
  check(
    '项目级 Git 配置已删除',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        if (!projectConfigOf(cloned)) return true
        await sleep(60)
      }
      return false
    })(),
    JSON.stringify(projectConfigOf(cloned))
  )
  check('读取接口返回 null', (await remoteOf(cloned)) === null)
  check('令牌也清掉了', (await getSecret(projectGitSecretKey(cloned, 'token'))) === null)
  check('列表上的 Git 标记消失', await waitFor(`!document.querySelector('.vault-row-git')`))
  check('列表仍显示本地路径', await waitText('.vault-row-path', cloned))

  // ---------- F. 扩展设置页：远端仓库字段读写同一份项目配置 ----------

  console.log('\n【F】扩展设置的「远端仓库」直接读写项目级配置')

  /** 打开设置页并切到「远程同步」;返回远端仓库字段是否就绪 */
  async function openGitSyncSettings(): Promise<boolean> {
    win.webContents.send(IPC.MenuCommand, 'view:settings')
    const listed = await waitFor(
      `[...document.querySelectorAll('.settings-nav-item')].some(x => x.textContent.includes('远程同步'))`
    )
    if (!listed) return false
    const clicked = await evalJs<boolean>(`(() => {
      const b = [...document.querySelectorAll('.settings-nav-item')]
        .find(x => x.textContent.includes('远程同步'))
      if (!b) return false
      b.click()
      return true
    })()`)
    return clicked && (await waitFor(`document.querySelector('.plugin-target')`))
  }

  check('重新打开克隆出来的仓库', (await click('.vault-row')) && (await waitFor(`document.querySelector('.app-shell')`, 30_000)))
  check('打开设置页并切到「远程同步」', await openGitSyncSettings())
  const sections = await evalJs<string[]>(
    `[...document.querySelectorAll('.plugin-group-title')].map(el => el.textContent.trim())`
  )
  check('有「远端仓库」分组', sections.includes('远端仓库'), JSON.stringify(sections))
  check(
    '单远端：不显示添加/删除按钮',
    await evalJs<boolean>(
      `!document.querySelector('.plugin-btn-add') &&
       !document.querySelector('.plugin-icon-btn[aria-label="删除远端"]')`
    )
  )
  check(
    '远端行有「测试连接」动作',
    await evalJs<boolean>(
      `[...document.querySelectorAll('.plugin-target-actions button')].some(b => b.title === '测试连接')`
    )
  )

  /** 按格子上的标题给 targets 字段赋值(输入框/下拉都走原型 setter) */
  const setTargetField = (label: string, value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const cell = [...document.querySelectorAll('.plugin-target-cell')]
        .find(c => (c.querySelector('span')?.textContent ?? '').trim() === ${JSON.stringify(label)})
      const el = cell?.querySelector('input, select')
      if (!el) return false
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)

  const pluginUrl = 'https://example.com/settings/notes.git'
  check('填写远程地址', await setTargetField('远程仓库', pluginUrl))
  check(
    '地址写进项目级配置（与选择页同一份）',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        const t = projectConfigOf(cloned)
        if (t?.url === pluginUrl) return true
        await sleep(60)
      }
      return false
    })(),
    JSON.stringify(projectConfigOf(cloned))
  )
  check(
    '没有写进扩展自己的配置层',
    getSettingsSync()?.extensions?.[EXT_ID]?.config?.[`${EXT_ID}.targets`] === undefined,
    JSON.stringify(getSettingsSync()?.extensions?.[EXT_ID]?.config)
  )

  check(
    '只保留远程分支输入框',
    await evalJs<boolean>(
      `![...document.querySelectorAll('.plugin-target-cell > span')]
        .some(x => x.textContent.trim() === '本地分支')`
    )
  )
  check('填写远程分支', await setTargetField('远程分支', 'dev'))
  check(
    '本地分支跟随远程分支写入项目级配置',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        const t = projectConfigOf(cloned)
        if (t?.localBranch === 'dev' && t?.remoteBranch === 'dev') return true
        await sleep(60)
      }
      return false
    })(),
    JSON.stringify(projectConfigOf(cloned))
  )

  check(
    '公开仓库没填令牌时不再提示「配置未完成」',
    await evalJs<boolean>(`!document.querySelector('.plugin-target-problems')`)
  )
  check('填写访问令牌', await setTargetField('访问令牌', 'plugin-token'))
  check(
    '令牌写进项目级密钥槽位',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        if ((await getSecret(projectGitSecretKey(cloned, 'token'))) === 'plugin-token') return true
        await sleep(80)
      }
      return false
    })(),
    String(await getSecret(projectGitSecretKey(cloned, 'token')))
  )
  check('界面显示已保存的密钥', await waitFor(`document.querySelector('.plugin-target .plugin-secret-on')`))

  check(
    '关闭设置页',
    (await evalJs<boolean>(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)) && (await waitFor(`!document.querySelector('.settings-mask')`))
  )
  check('重新打开设置页并切到「远程同步」', await openGitSyncSettings())
  check(
    '地址从项目配置回填',
    await waitFor(`(() => {
      const cell = [...document.querySelectorAll('.plugin-target-cell')]
        .find(c => (c.querySelector('span')?.textContent ?? '').trim() === '远程仓库')
      return cell?.querySelector('input')?.value === ${JSON.stringify(pluginUrl)}
    })()`)
  )
  const reloaded = await evalJs<{ remote: string; mask: boolean }>(`(() => {
    const cell = [...document.querySelectorAll('.plugin-target-cell')]
      .find(c => (c.querySelector('span')?.textContent ?? '').trim() === '远程分支')
    return {
      remote: cell?.querySelector('input')?.value ?? '',
      mask: !!document.querySelector('.plugin-target .plugin-secret-on')
    }
  })()`)
  check(
    '回填远程分支与密钥状态',
    reloaded.remote === 'dev' && reloaded.mask,
    JSON.stringify(reloaded)
  )

  check(
    '点击「清除」清掉项目级令牌',
    (await evalJs<boolean>(`(() => {
      const b = [...document.querySelectorAll('.plugin-target .plugin-btn')]
        .find(x => x.textContent.trim() === '清除')
      if (!b) return false
      b.click()
      return true
    })()`)) &&
      (await (async () => {
        const until = Date.now() + 8000
        while (Date.now() < until) {
          if ((await getSecret(projectGitSecretKey(cloned, 'token'))) === null) return true
          await sleep(80)
        }
        return false
      })())
  )

  // ---------- G. 远程仓库候选 ----------

  console.log('\n【G】远程仓库输入框:候选里列出全部已配置远程,选中后沿用')

  const sharedUrl = 'https://example.com/shared/notes.git'
  const sharedSource = join(ud, 'existing-project')
  await setProjectGitRemote(sharedSource, {
    url: sharedUrl,
    auth: 'token',
    username: '',
    localBranch: 'release',
    remoteBranch: 'release',
    secret: 'shared-token'
  })

  /**
   * 自绘候选框(SuggestInput.vue)的驱动:输入框右侧常驻箭头,点开是
   * Teleport 到 body 的 `.plugin-suggest-menu`。
   */
  const remoteCellExpr = `[...document.querySelectorAll('.plugin-target-cell')]
    .find(c => (c.querySelector('span')?.textContent ?? '').trim() === '远程仓库')`

  const remoteValue = (): Promise<string | null> =>
    evalJs<string | null>(`(() => {
      const input = (${remoteCellExpr})?.querySelector('input')
      return input ? input.value : null
    })()`)

  const openRemoteMenu = async (): Promise<boolean> => {
    const clicked = await evalJs<boolean>(`(() => {
      const btn = (${remoteCellExpr})?.querySelector('.plugin-suggest-chevron')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!clicked) return false
    return waitFor(`document.querySelectorAll('.plugin-suggest-item').length > 0`)
  }

  const remoteMenuItems = (): Promise<{ value: string; meta: string }[]> =>
    evalJs<{ value: string; meta: string }[]>(`(() =>
      [...document.querySelectorAll('.plugin-suggest-item')].map(item => ({
        value: (item.querySelector('.plugin-suggest-url')?.textContent ?? '').trim(),
        meta: (item.querySelector('.plugin-suggest-meta')?.textContent ?? '').trim()
      }))
    )()`)

  const pickRemote = (url: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const item = [...document.querySelectorAll('.plugin-suggest-item')]
        .find(i => (i.querySelector('.plugin-suggest-url')?.textContent ?? '').trim() === ${JSON.stringify(url)})
      if (!item) return false
      item.click()
      return true
    })()`)

  // 关掉再打开,让 ExtensionSettings 重新拉一次 knownRemotes
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await waitFor(`!document.querySelector('.settings-mask')`)
  check('重新打开设置页', await openGitSyncSettings())
  check('远程仓库输入框有常驻的候选箭头', await waitFor(`!!(${remoteCellExpr})?.querySelector('.plugin-suggest-chevron')`))
  check(
    '远程仓库输入框与下面的输入框左右对齐',
    await evalJs<boolean>(`(() => {
      const remote = (${remoteCellExpr})?.querySelector('input')
      const branchCell = [...document.querySelectorAll('.plugin-target-cell')]
        .find(c => (c.querySelector('span')?.textContent ?? '').trim() === '远程分支')
      const branch = branchCell?.querySelector('input')
      if (!remote || !branch) return false
      const a = remote.getBoundingClientRect()
      const b = branch.getBoundingClientRect()
      return Math.abs(a.left - b.left) <= 1 && Math.abs(a.right - b.right) <= 1
    })()`)
  )
  check(
    '展开箭头在输入框内部',
    await evalJs<boolean>(`(() => {
      const cell = ${remoteCellExpr}
      const input = cell?.querySelector('input')
      const arrow = cell?.querySelector('.plugin-suggest-chevron')
      if (!input || !arrow) return false
      const a = input.getBoundingClientRect()
      const b = arrow.getBoundingClientRect()
      return b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom
    })()`)
  )
  check('点开候选菜单', await openRemoteMenu())

  const configuredOptions = await remoteMenuItems()
  console.log(`     [候选] ${JSON.stringify(configuredOptions)}`)
  check(
    '候选里能看到全部已配置远程',
    configuredOptions.some(o => o.value === sharedUrl) &&
      configuredOptions.some(o => o.value === pluginUrl),
    JSON.stringify(configuredOptions)
  )
  check(
    '已保存令牌的远程在候选里有标记',
    configuredOptions.some(o => o.value === sharedUrl && o.meta.includes('已保存令牌')),
    JSON.stringify(configuredOptions)
  )
  check(
    '已有远端时输入框就是当前地址',
    (await remoteValue()) === pluginUrl,
    String(await remoteValue())
  )

  check('选择候选里的已有远程', await pickRemote(sharedUrl))
  check(
    '地址 / 分支 / 认证方式写进新项目',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        const t = projectConfigOf(cloned)
        if (
          t?.url === sharedUrl &&
          t?.localBranch === 'release' &&
          t?.remoteBranch === 'release' &&
          t?.auth === 'token'
        ) {
          return true
        }
        await sleep(60)
      }
      return false
    })(),
    JSON.stringify(projectConfigOf(cloned))
  )
  check(
    '令牌也从原项目沿用过来',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        if ((await getSecret(projectGitSecretKey(cloned, 'token'))) === 'shared-token') return true
        await sleep(80)
      }
      return false
    })(),
    String(await getSecret(projectGitSecretKey(cloned, 'token')))
  )
  check(
    '界面回填新地址与已保存令牌',
    await waitFor(`(() => {
      const cell = [...document.querySelectorAll('.plugin-target-cell')]
        .find(c => (c.querySelector('span')?.textContent ?? '').trim() === '远程仓库')
      return (
        cell?.querySelector('input')?.value === ${JSON.stringify(sharedUrl)} &&
        !!document.querySelector('.plugin-target .plugin-secret-on')
      )
    })()`)
  )

  // ---------- H. 没有远端时仍可从候选里挑 ----------

  console.log('\n【H】没有配置远端时,候选列表仍可用来挑已有远程')
  await setProjectGitRemote(cloned, null)
  await evalJs(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await waitFor(`!document.querySelector('.settings-mask')`)
  check('重新打开设置页', await openGitSyncSettings())
  check('远程仓库输入框有常驻的候选箭头', await waitFor(`!!(${remoteCellExpr})?.querySelector('.plugin-suggest-chevron')`))
  check('没有远端:输入框为空', (await remoteValue()) === '')
  check('没有远端:仍能点开候选菜单', await openRemoteMenu())
  const emptyOptions = await remoteMenuItems()
  console.log(`     [空配置] ${JSON.stringify(emptyOptions)}`)
  check(
    '没有远端:候选里仍有已配置远程',
    emptyOptions.some(o => o.value === sharedUrl),
    JSON.stringify(emptyOptions)
  )
  check('从候选里挑一个即可填入', await pickRemote(sharedUrl))
  check(
    '新项目也能沿用地址与令牌',
    await (async () => {
      const until = Date.now() + 8000
      while (Date.now() < until) {
        if (
          projectConfigOf(cloned)?.url === sharedUrl &&
          (await getSecret(projectGitSecretKey(cloned, 'token'))) === 'shared-token'
        ) {
          return true
        }
        await sleep(80)
      }
      return false
    })(),
    JSON.stringify({
      config: projectConfigOf(cloned),
      secret: await getSecret(projectGitSecretKey(cloned, 'token'))
    })
  )

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[vault-picker-git] 未捕获异常:', err)
  app.exit(1)
})
