/**
 * 验收:市场页 / 已安装列表 / 扩展设置页的渲染。
 *
 * 不开真实市场服务端:这里只回答「市场界面能不能把 ExtensionView 画出来、
 * 离线时会不会崩」。安装/校验/发布路径由 market-package 与 install-confirm 覆盖。
 *
 * 跑法:node verify/run.mjs market-ui
 */

import { app, BrowserWindow, dialog, shell } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { createMainWindow } from '../src/main/window'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'

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
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })
  // 「打开设置文件」不要真的拉起系统编辑器(无人值守会弹窗),只记下路径
  const openedPaths: string[] = []
  ;(shell as unknown as { openPath: (path: string) => Promise<string> }).openPath = async (
    path: string
  ) => {
    openedPaths.push(path)
    return ''
  }

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  await rm(vault, { recursive: true, force: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  const note = join(vault, '笔记.md')
  await writeFile(note, '# 市场 UI\n', 'utf8')
  // Claude Code 的外部设置表单读写 CLAUDE_CONFIG_DIR/settings.json。
  // 用沙箱目录,别碰真实的 ~/.claude/settings.json。
  const claudeConfigDir = join(ud, 'claude-config')
  const claudeSettingsPath = join(claudeConfigDir, 'settings.json')
  await mkdir(claudeConfigDir, { recursive: true })
  await writeFile(
    claudeSettingsPath,
    `${JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://fixture.example/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'fixture-token',
          ANTHROPIC_MODEL: 'fixture-model',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'fixture-opus',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku',
          CLAUDE_CODE_SUBAGENT_MODEL: 'fixture-subagent',
          CLAUDE_CODE_EFFORT_LEVEL: 'high',
          KEEP_ME: 'keep'
        },
        theme: 'dark',
        keepTop: { nested: true }
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        // 空地址:浏览页会立刻给出「没有设置市场地址」,不会真的打网络
        marketUrl: ''
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)

  const win: BrowserWindow = createMainWindow(settings)
  service.setRendererSender(message => {
    if (!win.isDestroyed()) win.webContents.send(IPC.ExtensionToRenderer, message)
  })
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  console.log('\n[A] 打开设置 → 浏览市场 → 已安装')
  const opened = await evalJs<boolean>(`(() => {
    const b = document.querySelector('button[title^="设置"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('设置面板打开了', opened && (await waitFor(`document.querySelector('.settings-nav')`)))
  check(
    '设置左栏不显示扩展图标',
    await evalJs<boolean>(`!document.querySelector('.settings-nav-item .plugin-icon')`)
  )

  const onMarket = await evalJs<boolean>(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check('市场页入口可点', onMarket && (await waitFor(`document.querySelector('.market-page')`)))

  const installedTab = await evalJs<boolean>(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '已安装')
    if (!t) return false
    t.click()
    return true
  })()`)
  check('已安装页签可点', installedTab)
  check('四款内置扩展出现在列表里', await waitFor(`document.querySelectorAll('.market-row').length === 4`))
  check(
    '四款扩展的图标都加载出来了',
    await waitFor(
      `[...document.querySelectorAll('.market-row .plugin-icon')]
        .filter(el => el.tagName === 'IMG' && el.naturalWidth > 0 &&
          (el.getAttribute('src') || '').startsWith('data:image/svg+xml')).length === 4`
    )
  )
  check(
    '已安装页签不显示市场地址与连接错误',
    await evalJs<boolean>(
      `!document.querySelector('.market-registry') && !document.querySelector('.market-banner-error')`
    )
  )

  const rows = await evalJs<
    { name: string; badges: string[]; sub: string; status: string; hasSha: boolean }[]
  >(`
    [...document.querySelectorAll('.market-row')].map(row => ({
      name: row.querySelector('.market-row-name b')?.textContent?.trim() ?? '',
      badges: [...row.querySelectorAll('.market-badge')].map(b => b.textContent.trim()),
      sub: row.querySelector('.market-row-sub')?.textContent?.trim() ?? '',
      status: row.querySelector('.plugin-status-dot')?.getAttribute('title') ?? '',
      hasSha: !!row.querySelector('.market-hash-chip')
    }))`)
  check(
    '不再显示安装来源，也不挂形态/来源/停用徽标',
    rows.every(
      r =>
        !['来源', '内置扩展', '市场扩展', '本地安装', '开发模式'].some(w => r.sub.includes(w)) &&
        !r.badges.some(b =>
          ['含代码', '纯声明', '内置扩展', '市场扩展', '本地安装', '已停用', '开发模式'].includes(b)
        )
    ),
    JSON.stringify(rows)
  )
  check('每行都有安装 sha256', rows.every(r => r.hasSha), JSON.stringify(rows))
  check(
    '依赖关系显示在依赖方的卡片上',
    rows.some(
      r =>
        r.name === 'Claude Code' &&
        r.badges.some(b => b.includes('依赖扩展 Agent Core'))
    ) &&
      rows.some(
        r => r.name.includes('Agent Core') && !r.badges.some(b => b.includes('依赖扩展'))
      ),
    JSON.stringify(rows)
  )

  check(
    '已安装行不再展示能力胶囊',
    await evalJs<boolean>(`document.querySelectorAll('.market-row-perm').length === 0`)
  )
  check(
    'quick-edit 默认启用、git-sync 默认停用',
    rows.some(r => r.name.includes('快速编辑') && !r.status.includes('已停用')) &&
      rows.some(r => r.name.includes('Git') && r.status.includes('已停用')),
    JSON.stringify(rows)
  )
  check(
    'Agent Core 与 Claude Code 都已装上且默认停用',
    rows.some(r => r.name.includes('Agent Core') && r.status.includes('已停用')) &&
      rows.some(r => r.name === 'Claude Code' && r.status.includes('已停用')),
    JSON.stringify(rows)
  )

  console.log('\n[B] 浏览市场:离线提示,不崩')
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '浏览市场')
    if (t) t.click()
  })()`)
  check('浏览页出现错误条而不是白屏', await waitFor(`document.querySelector('.market-banner-error')?.textContent?.includes('市场地址')`), await evalJs<string>(`document.querySelector('.market-banner-error')?.textContent ?? ''`))

  console.log('\n[C] 发布页:三个区块都渲染')
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '发布扩展')
    if (t) t.click()
  })()`)
  const publishText = await waitFor(`document.querySelectorAll('.market-block-title').length >= 3`)
  const titles = await evalJs<string[]>(`[...document.querySelectorAll('.market-block-title')].map(h => h.textContent.trim())`)
  check('发布页三个区块齐全', publishText && titles.some(t => t.includes('市场地址')) && titles.some(t => t.includes('账号')) && titles.some(t => t.includes('打包与发布')), JSON.stringify(titles))
  check(
    '发布页不显示市场连接错误',
    await evalJs<boolean>(`!document.querySelector('.market-banner-error')`)
  )

  console.log('\n[D] 扩展设置页')
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '已安装')
    if (t) t.click()
  })()`)
  await waitFor(`document.querySelectorAll('.market-row').length === 4`)
  const toSettings = await evalJs<boolean>(`(() => {
    const row = [...document.querySelectorAll('.market-row')].find(r => r.textContent.includes('快速编辑'))
    const b = row ? [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '设置') : null
    if (!b) return false
    b.click()
    return true
  })()`)
  check('从已安装行进入扩展设置', toSettings)
  check('设置页显示扩展名与启用开关', await waitFor(`document.querySelector('.plugin-detail-version') && document.querySelector('.plugin-switch')`))
  check(
    '调试区没有日志时给出空态说明',
    await waitFor(`document.querySelector('.plugin-ops-empty')?.textContent.includes('还没有日志')`)
  )
  const detailText = await evalJs<string>(`document.querySelector('.settings-main')?.innerText ?? ''`)
  const detailSections = await evalJs<string[]>(
    `[...document.querySelectorAll('.plugin-group-title')].map(h => h.textContent.trim())`
  )
  check(
    '设置页不再重复安装信息，宿主区已移出',
    !detailText.includes('安装信息') &&
      !detailText.includes('能力声明') &&
      !detailText.includes('激活事件') &&
      !detailSections.includes('扩展分配'),
    JSON.stringify(detailSections)
  )

  console.log('\n[D2] 外部配置文件入口')
  const toClaudeExternal = await evalJs<boolean>(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('Claude Code'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check(
    '外部设置分组带「打开设置文件」图标',
    toClaudeExternal &&
      (await waitFor(
        `[...document.querySelectorAll('.plugin-group-title')].some(h =>
          h.textContent.includes('settings.json') &&
          h.querySelector('button[title^="打开设置文件"]')
        )`
      ))
  )
  const clickedExternal = await evalJs<boolean>(`(() => {
    const b = document.querySelector('.plugin-group-title button[title^="打开设置文件"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(300)
  check(
    '点击图标用系统程序打开 settings.json',
    clickedExternal && openedPaths.includes(claudeSettingsPath),
    JSON.stringify({ clickedExternal, openedPaths })
  )

  console.log('\n[D3] 动作按钮不随状态文字漂移')
  // 默认停用的 git-sync 在这里临时打开:后面的宿主页需要一个真的在跑的代码扩展。
  await service.setEnabled('imark.git-sync', true)
  await service.activateExtension('imark.git-sync')
  await sleep(500)
  const toGitSettings = await evalJs<boolean>(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('定时上传'))
    if (!b) return false
    b.click()
    return true
  })()`)
  check(
    '左侧导航能切到 Git 同步',
    toGitSettings && (await waitFor(`document.querySelector('.plugin-global-actions button')`))
  )
  const placement = await evalJs<{ inCard: number; inRow: number }>(`(() => ({
    inCard: document.querySelectorAll('.plugin-status-card .plugin-global-actions').length,
    inRow: document.querySelectorAll('.plugin-global-actions button').length
  }))()`)
  check(
    '动作在状态卡下方单独一行',
    placement.inCard === 0 && placement.inRow > 0,
    JSON.stringify(placement)
  )
  const actionX = (): Promise<number> => evalJs<number>(`(() => {
    const b = document.querySelector('.plugin-global-actions button')
    return b ? Math.round(b.getBoundingClientRect().left) : -1
  })()`)
  const xBefore = await actionX()
  check(
    '点得到全局「立即上传」',
    await evalJs<boolean>(`(() => {
      const b = [...document.querySelectorAll('.plugin-global-actions button')]
        .find(x => x.textContent.trim() === '立即上传')
      if (!b) return false
      b.click()
      return true
    })()`)
  )
  check(
    '执行结果出现在状态卡里',
    await waitFor(
      `document.querySelector('.plugin-status-message')?.textContent.includes('尚未配置远端仓库')`,
      15000
    )
  )
  check(
    '执行结果不再弹通知',
    await evalJs<boolean>(
      `!(document.querySelector('.toast-host')?.textContent ?? '').includes('尚未配置远端仓库')`
    )
  )
  const xAfter = await actionX()
  check(
    '立即上传按钮位置不漂移',
    xBefore >= 0 && Math.abs(xAfter - xBefore) <= 1,
    `before=${xBefore}, after=${xAfter}`
  )

  console.log('\n[D3] 密钥输入框的小眼睛')
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('定时上传'))
    if (b) b.click()
  })()`)
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.textContent.trim() === '添加远端')
    if (b) b.click()
  })()`)
  check('进入 Git 同步设置', await waitFor(`document.querySelector('.plugin-target-secret')`))
  check(
    '密钥输入框里能看到明文',
    await evalJs<boolean>(`(() => {
      const input = document.querySelector('.plugin-target-secret')
      const eye = document.querySelector('.plugin-secret-eye')
      if (!input || !eye) return false
      input.focus()
      input.value = 'secret123'
      eye.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      eye.click()
      return true
    })()`)
  )
  await sleep(80)
  const revealedType = await evalJs<{ type: string; value: string }>(`(() => {
    const input = document.querySelector('.plugin-target-secret')
    return { type: input?.type ?? '', value: input?.value ?? '' }
  })()`)
  check(
    '点眼睛后显示明文',
    revealedType.type === 'text' && revealedType.value === 'secret123',
    JSON.stringify(revealedType)
  )
  await evalJs(`(() => {
    const eye = document.querySelector('.plugin-secret-eye')
    eye?.click()
  })()`)
  await sleep(80)
  const maskedType = await evalJs<string>(`document.querySelector('.plugin-target-secret')?.type ?? ''`)
  check('再点一次恢复密文', maskedType === 'password', maskedType)
  // 清掉测试值再离开:输入框失焦时 change 不会保存空值
  await evalJs(`(() => {
    const input = document.querySelector('.plugin-target-secret')
    if (input) input.value = ''
  })()`)

  console.log('\n[E] 扩展分配页签:集中管理全部扩展')
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (b) b.click()
  })()`)
  await waitFor(`document.querySelector('.market-page')`)
  const hostsTab = await evalJs<boolean>(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '扩展分配')
    if (!t) return false
    t.click()
    return true
  })()`)
  check('扩展分配页签可点', hostsTab)
  check(
    '进程面板渲染出来',
    await waitFor(
      `document.querySelector('.market-hosts') &&
       document.querySelector('.market-host-mode') &&
       document.querySelector('.market-host-groups .market-host-card')`
    )
  )
  check(
    '右侧标题为「扩展分配」',
    await waitFor(`document.querySelector('.settings-main-header h1')?.textContent?.trim() === '扩展分配'`)
  )
  check(
    '扩展分配页签不显示市场连接错误',
    await evalJs<boolean>(`!document.querySelector('.market-banner-error')`)
  )
  const hostPanel = await evalJs<{
    modeButtons: string[]
    modeBox: { borderWidth: string; hasTitle: boolean; presetsBelow: boolean } | null
    sectionHeads: string[]
    text: string
    quickEditInHost: boolean
    quickEditReload: boolean
    hostCardsWithoutReload: number
    hostMetas: string[]
    headDots: number
    cardTones: { meta: string; tone: string }[]
    pausedText: string
    pausedRows: { name: string; title: string }[]
    pausedAffinity: number
  }>(`(() => {
    const cards = [...document.querySelectorAll('.market-host-groups .market-host-card')]
    const card = cards.find(c => c.textContent.includes('快速编辑'))
    const paused = document.querySelector('.market-host-paused')
    const mode = document.querySelector('.market-host-mode')
    const hint = mode?.querySelector('.market-hint')
    const presets = mode?.querySelector('.settings-presets')
    return {
      modeButtons: [...document.querySelectorAll('.market-host-mode .settings-preset')]
        .map(b => b.textContent.trim()),
      modeBox:
        mode && hint && presets
          ? {
              borderWidth: getComputedStyle(mode).borderTopWidth,
              hasTitle: !!mode.querySelector('.market-host-mode-title'),
              presetsBelow: presets.getBoundingClientRect().top >= hint.getBoundingClientRect().bottom
            }
          : null,
      sectionHeads: [...document.querySelectorAll('.market-host-section-head b')]
        .map(b => b.textContent.trim()),
      text: document.querySelector('.market-hosts')?.innerText ?? '',
      quickEditInHost: !!card,
      quickEditReload: card
        ? !!card.querySelector('.plugin-icon-btn[title^="重新加载这个进程"]')
        : false,
      hostCardsWithoutReload: cards.filter(c => !c.querySelector('.plugin-icon-btn[title^="重新加载这个进程"]')).length,
      hostMetas: cards.map(c => c.querySelector('.market-host-meta')?.textContent?.trim() ?? ''),
      headDots: cards.filter(c => c.querySelector('.market-host-head .plugin-status-dot')).length,
      cardTones: cards.map(c => ({
        meta: c.querySelector('.market-host-meta')?.textContent?.trim() ?? '',
        tone: [...c.classList].find(x => x.startsWith('market-host-card-')) ?? ''
      })),
      pausedText: paused?.textContent ?? '',
      pausedRows: paused
        ? [...paused.querySelectorAll('.market-host-row')].map(row => ({
            name: row.querySelector('.market-host-name')?.textContent?.trim() ?? '',
            title: row.querySelector('.plugin-status-dot')?.getAttribute('title') ?? ''
          }))
        : [],
      pausedAffinity: paused ? paused.querySelectorAll('input.settings-number').length : -1
    }
  })()`)
  check(
    '模式切换按钮齐全',
    hostPanel.modeButtons.includes('独立进程') && hostPanel.modeButtons.includes('共享进程'),
    JSON.stringify(hostPanel.modeButtons)
  )
  check(
    '模式区不再是卡片，无「宿主模式」标题，按钮在说明下方另起一行',
    hostPanel.modeBox?.borderWidth === '0px' &&
      hostPanel.modeBox.hasTitle === false &&
      hostPanel.modeBox.presetsBelow === true,
    JSON.stringify(hostPanel.modeBox)
  )
  check(
    '面板说明运行环境与分组规则',
    hostPanel.text.includes('分配扩展运行环境') && hostPanel.text.includes('分组编号')
  )
  check(
    '已分配 / 未分配两个分区标题齐全',
    hostPanel.sectionHeads.includes('已分配') && hostPanel.sectionHeads.includes('未分配'),
    JSON.stringify(hostPanel.sectionHeads)
  )
  check('页面不再出现「宿主」字样', !hostPanel.text.includes('宿主'))
  check(
    '快速编辑出现在进程卡里，每张进程卡都有重载按钮',
    hostPanel.quickEditInHost && hostPanel.quickEditReload && hostPanel.hostCardsWithoutReload === 0
  )
  check(
    '进程卡不展示「PID —」占位符',
    hostPanel.hostMetas.length > 0 && hostPanel.hostMetas.every(meta => !meta.includes('PID —')),
    JSON.stringify(hostPanel.hostMetas)
  )
  check(
    '进程状态由卡片外框表达，头部不再挂圆点',
    hostPanel.headDots === 0 &&
      hostPanel.cardTones.some(c => c.tone === 'market-host-card-ok') &&
      hostPanel.cardTones.every(c =>
        c.meta.includes('运行中')
          ? c.tone === 'market-host-card-ok'
          : c.meta.includes('启动中')
            ? c.tone === 'market-host-card-running'
            : c.meta.includes('崩溃')
              ? c.tone === 'market-host-card-error'
              : true
      ),
    JSON.stringify(hostPanel.cardTones)
  )
  check(
    '未分配区列出已停用的内置扩展（状态由圆点提示，不再挂徽标）',
    hostPanel.pausedRows.some(r => r.name.includes('Claude Code') && r.title.includes('已停用')),
    JSON.stringify(hostPanel.pausedRows)
  )
  check(
    '已停用的含代码扩展仍可预设分组编号',
    hostPanel.pausedAffinity >= 2,
    String(hostPanel.pausedAffinity)
  )

  // 只动**已停用**扩展的编号:它不在宿主计划的候选集里,不会拉起或重启任何进程。
  // 这一段验证的是「输入 → 设置写盘 → 输入框按规范值回写」的完整回路。
  const setPausedAffinity = (value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const paused = document.querySelector('.market-host-paused')
      const row = paused
        ? [...paused.querySelectorAll('.market-host-row')].find(r => r.textContent.includes('Claude Code'))
        : null
      const input = row?.querySelector('input.settings-number')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)

  interface HostSettingsFile {
    mode?: string
    affinity?: Record<string, number>
  }
  const readHostSettings = async (): Promise<HostSettingsFile> => {
    // 主进程保存设置是「写临时文件再 rename」;Windows 上替换的瞬间可能存在
    // 读不到 settings.json 的窗口,这里重试几次而不是让整套验收崩掉。
    for (let attempt = 0; ; attempt += 1) {
      try {
        const json = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as {
          extensionHost?: HostSettingsFile
        }
        return json.extensionHost ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 5) throw err
        await sleep(50)
      }
    }
  }

  check('能给停用的代码扩展填编号', await setPausedAffinity('7'))
  await sleep(500)
  check(
    '编号写进 settings.extensionHost.affinity',
    (await readHostSettings()).affinity?.['imark.claude-code'] === 7 &&
      (await readHostSettings()).affinity?.['imark.agent'] === 7,
    JSON.stringify(await readHostSettings())
  )
  check('清空编号', await setPausedAffinity(''))
  await sleep(500)
  check(
    '清空 = 删除编号（按模式自动分组）',
    !('imark.claude-code' in ((await readHostSettings()).affinity ?? {})) &&
      !('imark.agent' in ((await readHostSettings()).affinity ?? {})),
    JSON.stringify(await readHostSettings())
  )

  // Claude Code 依赖 Agent Core:给任意一头填编号,整条依赖链一起写。
  const setRowAffinity = (name: string, value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.market-host-row')]
        .find(r => r.textContent.includes(${JSON.stringify(name)}))
      const input = row?.querySelector('input.settings-number')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  check('给 Claude Code 填编号', await setRowAffinity('Claude Code', '5'))
  await sleep(500)
  check(
    '依赖链自动同编号（Claude Code → Agent Core）',
    (await readHostSettings()).affinity?.['imark.claude-code'] === 5 &&
      (await readHostSettings()).affinity?.['imark.agent'] === 5,
    JSON.stringify(await readHostSettings())
  )
  check('清空 Agent Core 编号', await setRowAffinity('Agent Core', ''))
  await sleep(500)
  check(
    '反向依赖也一起清空',
    !('imark.agent' in ((await readHostSettings()).affinity ?? {})) &&
      !('imark.claude-code' in ((await readHostSettings()).affinity ?? {})),
    JSON.stringify(await readHostSettings())
  )

  // quick-edit 是懒激活(onCommand),此刻宿主没启动,切换模式不会真的拉起进程;
  // 这里只验证按钮 → 设置写盘 → 再切回来的回路。
  const setMode = (label: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const b = [...document.querySelectorAll('.market-host-mode .settings-preset')]
        .find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return false
      b.click()
      return true
    })()`)
  check('切换模式前先留一个手动编号', await setPausedAffinity('9'))
  await sleep(500)
  check(
    '手动编号已写盘',
    (await readHostSettings()).affinity?.['imark.claude-code'] === 9 &&
      (await readHostSettings()).affinity?.['imark.agent'] === 9,
    JSON.stringify(await readHostSettings())
  )
  check('能切换为共享进程', await setMode('共享进程'))
  await sleep(500)
  check(
    '点模式按钮会清空手动编号，按该模式的默认行为分组',
    Object.keys((await readHostSettings()).affinity ?? {}).length === 0 &&
      (await readHostSettings()).mode === 'shared',
    JSON.stringify(await readHostSettings())
  )
  check(
    '共享进程时「与同号同组」占位符不被截断',
    await evalJs<boolean>(`(() => {
      const input = document.querySelector('.market-host-affinity input.settings-number')
      if (!input || !input.placeholder.includes('与同号同组')) return false
      const cs = getComputedStyle(input)
      const ctx = document.createElement('canvas').getContext('2d')
      if (!ctx) return false
      ctx.font = [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily].join(' ')
      const textWidth = ctx.measureText(input.placeholder).width
      const contentWidth =
        input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      return contentWidth >= textWidth
    })()`)
  )
  check(
    '运行中的进程里成员图标显示为运行中',
    await waitFor(
      `(() => {
        const row = [...document.querySelectorAll('.market-host-row')]
          .find(r => r.textContent.includes('定时上传'))
        const dot = row?.querySelector('.plugin-status-dot')
        return !!dot && dot.classList.contains('plugin-status-ok')
      })()`,
      10000
    )
  )
  check(
    '深色主题下数字输入的加减按钮跟随主题（color-scheme: dark）',
    await evalJs<boolean>(`(() => {
      const input = document.querySelector('.market-host-affinity input.settings-number')
      if (!input) return false
      const root = document.documentElement
      const prev = root.getAttribute('data-theme')
      root.setAttribute('data-theme', 'dark')
      const scheme = getComputedStyle(input).colorScheme
      if (prev === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', prev)
      return scheme === 'dark'
    })()`)
  )
  check('模式写进设置', (await readHostSettings()).mode === 'shared', JSON.stringify(await readHostSettings()))
  check(
    '独立按钮排在分组编号之前',
    await evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.market-host-row')]
        .find(r => r.querySelector('button.plugin-btn'))
      const btn = row?.querySelector('button.plugin-btn')
      const label = row?.querySelector('.market-host-affinity')
      if (!btn || !label) return false
      return btn.getBoundingClientRect().right <= label.getBoundingClientRect().left
    })()`)
  )
  check('能切回独立进程', await setMode('独立进程'))
  await sleep(500)
  check('模式切回 isolated', (await readHostSettings()).mode === 'isolated', JSON.stringify(await readHostSettings()))

  // 手动分组既不是「每个扩展各自一组」也不是「全部一组」时,两个按钮都不该选中。
  // 先启用 Claude Code(会连同依赖 Agent Core 一起启用),凑够四个含代码扩展。
  await service.setEnabled('imark.claude-code', true)
  await sleep(500)
  check(
    '「依赖同组」紧跟在扩展名后面',
    await evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.market-host-row')]
        .find(r => r.textContent.includes('Agent Core'))
      const name = row?.querySelector('.market-host-name')
      const badge = row?.querySelector('.market-badge')
      if (!name || !badge || !badge.textContent.includes('依赖同组')) return false
      return badge.getBoundingClientRect().left - name.getBoundingClientRect().right <= 16
    })()`)
  )
  check('给快速编辑填编号 1', await setRowAffinity('快速编辑', '1'))
  await sleep(500)
  check('给 Git 同步填编号 1', await setRowAffinity('定时上传', '1'))
  await sleep(500)
  check(
    '分组结果两种模式都解释不了 → 两个按钮都不选中',
    service.getContributions().hostModeState === 'custom' &&
      (await evalJs<boolean>(
        `document.querySelectorAll('.market-host-mode .settings-preset-active').length === 0`
      )),
    JSON.stringify({
      state: service.getContributions().hostModeState,
      settings: await readHostSettings()
    })
  )
  check('点独立进程恢复默认分组', await setMode('独立进程'))
  await sleep(500)
  check(
    '恢复后独立进程按钮重新选中',
    (await readHostSettings()).mode === 'isolated' &&
      Object.keys((await readHostSettings()).affinity ?? {}).length === 0 &&
      (await evalJs<boolean>(
        `[...document.querySelectorAll('.market-host-mode .settings-preset')]
          .find(b => b.textContent.trim() === '独立进程')
          ?.classList.contains('settings-preset-active') === true`
      )),
    JSON.stringify(await readHostSettings())
  )

  // 依赖组也支持「独立」:点一下,整条依赖链一起挪到新进程。
  check('切到共享进程', await setMode('共享进程'))
  await sleep(500)
  const isolateButtons = await evalJs<{ agent: boolean; claude: boolean }>(`(() => {
    const has = name => {
      const row = [...document.querySelectorAll('.market-host-row')]
        .find(r => r.textContent.includes(name))
      return !!row?.querySelector('button.plugin-btn')
    }
    return { agent: has('Agent Core'), claude: has('Claude Code') }
  })()`)
  check(
    '依赖组也有独立按钮',
    isolateButtons.agent && isolateButtons.claude,
    JSON.stringify(isolateButtons)
  )
  check(
    '点得到 Claude Code 的独立',
    await evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.market-host-row')]
        .find(r => r.textContent.includes('Claude Code'))
      const b = row?.querySelector('button.plugin-btn')
      if (!b) return false
      b.click()
      return true
    })()`)
  )
  await sleep(500)
  const isolated = await readHostSettings()
  const isolatedNumber = isolated.affinity?.['imark.claude-code']
  check(
    '整条依赖链一起挪到新编号',
    typeof isolatedNumber === 'number' && isolated.affinity?.['imark.agent'] === isolatedNumber,
    JSON.stringify(isolated)
  )
  const isolatedGroups = service.getContributions().hostGroups
  const agentGroup = isolatedGroups.find(group => group.extensionIds.includes('imark.agent'))
  const claudeGroup = isolatedGroups.find(group => group.extensionIds.includes('imark.claude-code'))
  check(
    '依赖组单独成一个进程',
    !!agentGroup &&
      agentGroup.hostId === claudeGroup?.hostId &&
      agentGroup.extensionIds.length === 2 &&
      agentGroup.extensionIds.includes('imark.agent') &&
      agentGroup.extensionIds.includes('imark.claude-code'),
    JSON.stringify(isolatedGroups)
  )

  // 恢复成「两个 Agent 扩展都停用」,G 段才能验证「未安装或未启用」的结果。
  await setMode('独立进程')
  await sleep(500)
  await service.setEnabled('imark.claude-code', false)
  await service.setEnabled('imark.agent', false)
  await sleep(500)

  console.log('\n[F] 卸载确认是两段式')
  // 先回市场页(刚才在某个扩展的设置页里)
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find(x => x.textContent.includes('浏览市场'))
    if (b) b.click()
  })()`)
  await waitFor(`document.querySelector('.market-page')`)
  await evalJs(`(() => {
    const t = [...document.querySelectorAll('.market-tab')].find(b => b.textContent.trim() === '已安装')
    if (t) t.click()
  })()`)
  await waitFor(`document.querySelectorAll('.market-row').length === 4`)
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('.market-row')].find(r => r.textContent.includes('快速编辑'))
    const b = row ? row.querySelector('button[title="卸载"]') : null
    if (b) b.click()
  })()`)
  check(
    '卸载要先展开确认,并说清会删配置与密钥',
    await waitFor(`document.querySelector('.market-row-confirm')?.textContent?.includes('配置、密钥')`),
    await evalJs<string>(`document.querySelector('.market-row-confirm')?.textContent ?? ''`)
  )

  console.log('\n[G] 动作单独一行，结果写进状态卡')
  // 检测动作属于 provider 自己;Claude Code 默认关闭,先临时启用
  // (会连同依赖 Agent Core 一起启用)。放在最后跑,避免宿主启动影响前面的宿主页断言。
  const claudeOn = await service.setEnabled('imark.claude-code', true)
  check('临时启用 Claude Code', claudeOn !== null)
  // 等宿主真的起来再点动作:开启只是排期,命令执行会先等激活。
  // 不先激活的话,「检查」命令可能把 15 秒的等待窗口耗在宿主启动上。
  await service.activateExtension('imark.claude-code')
  await sleep(500)
  check(
    '状态栏用扩展自己的图标',
    await waitFor(
      `(() => {
        const buttons = [...document.querySelectorAll('.status-bar .status-plug')]
        return (
          buttons.length > 0 &&
          buttons.every(b => {
            const img = b.querySelector('img')
            return (
              !!img &&
              (img.getAttribute('src') || '').startsWith('data:') &&
              !b.querySelector('.status-plug-label')
            )
          })
        )
      })()`,
      10000
    )
  )
  const toClaudeSettings = await evalJs<boolean>(`(() => {
    const row = [...document.querySelectorAll('.market-row')].find(r => r.textContent.includes('Claude Code'))
    const b = row ? [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '设置') : null
    if (!b) return false
    b.click()
    return true
  })()`)
  check(
    '进入 Claude Code 设置页并看到动作',
    toClaudeSettings && (await waitFor(`document.querySelector('.plugin-global-actions button')`))
  )

  check(
    'settings.json 字段读进表单',
    await waitFor(`(() => {
      const row = [...document.querySelectorAll('.plugin-field-row')]
        .find(r => (r.querySelector('.plugin-field-label')?.textContent || '').includes('API 端点'))
      return row?.querySelector('input')?.value === 'https://fixture.example/anthropic'
    })()`)
  )
  check(
    '认证令牌按密码显示',
    await waitFor(`(() => {
      const row = [...document.querySelectorAll('.plugin-field-row')]
        .find(r => (r.querySelector('.plugin-field-label')?.textContent || '').includes('认证令牌'))
      const input = row?.querySelector('input')
      return input?.type === 'password' && input.value === 'fixture-token'
    })()`)
  )
  const endpointChanged = await evalJs<boolean>(`(() => {
    const row = [...document.querySelectorAll('.plugin-field-row')]
      .find(r => (r.querySelector('.plugin-field-label')?.textContent || '').includes('API 端点'))
    const input = row?.querySelector('input')
    if (!input) return false
    input.value = 'https://changed.example/anthropic'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  check('修改 API 端点', endpointChanged)
  check(
    '保存状态出现',
    await waitFor(
      `[...document.querySelectorAll('.plugin-external-status')]
        .some(el => el.textContent.trim() === '已保存')`,
      5000
    )
  )
  const savedExternal = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as {
    env?: Record<string, string>
    theme?: string
    keepTop?: unknown
  }
  check(
    'BASE_URL 写回 settings.json',
    savedExternal.env?.ANTHROPIC_BASE_URL === 'https://changed.example/anthropic',
    String(savedExternal.env?.ANTHROPIC_BASE_URL)
  )
  check(
    '未知字段原样保留',
    savedExternal.theme === 'dark' &&
      savedExternal.env?.KEEP_ME === 'keep' &&
      savedExternal.keepTop !== undefined
  )
  check(
    '其它已知字段保留',
    savedExternal.env?.ANTHROPIC_AUTH_TOKEN === 'fixture-token' &&
      savedExternal.env?.CLAUDE_CODE_SUBAGENT_MODEL === 'fixture-subagent'
  )
  const actionPlacement = await evalJs<{ labels: string[]; inCard: number }>(`(() => ({
    labels: [...document.querySelectorAll('.plugin-global-actions button')]
      .map(b => b.textContent.trim()),
    inCard: document.querySelectorAll('.plugin-status-card .plugin-global-actions').length
  }))()`)
  check(
    '动作在状态卡下方单独一行',
    actionPlacement.labels.includes('检查 Claude Code') && actionPlacement.inCard === 0,
    JSON.stringify(actionPlacement)
  )
  check(
    '点得到「检查 Claude Code」',
    await evalJs<boolean>(`(() => {
      const b = [...document.querySelectorAll('.plugin-global-actions button')]
        .find(x => x.textContent.trim() === '检查 Claude Code')
      if (!b) return false
      b.click()
      return true
    })()`)
  )
  check(
    '执行期间状态卡显示进行中',
    await waitFor(
      `document.querySelector('.plugin-status-line b')?.textContent?.trim() === '进行中'`,
      2000
    )
  )
  check(
    '检查结果写进 Claude Code 自己的状态卡',
    await waitFor(
      `document.querySelector('.plugin-status-message')?.textContent.includes('Claude Code')`,
      15000
    ),
    await evalJs<string>(`document.querySelector('.plugin-status-message')?.textContent ?? ''`)
  )
  check(
    '检查结果不再弹通知',
    await evalJs<boolean>(`(() => {
      const text = document.querySelector('.toast-host')?.textContent ?? ''
      return !text.includes('Claude Code')
    })()`)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
