/**
 * v1 → v2 一次性清理验收。
 *
 * 这次改造是硬切：不迁移旧配置、旧密钥、旧安装记录。启动时要把 v1 的
 * `manifest.json` 插件目录、`installed.json`、`settings.plugins`、旧日志和
 * `extensions-data/<裸插件名>/` 全部删掉，然后三款官方扩展按**全新安装**处理。
 *
 * 这里真的预置一份 v1 用户数据（五款旧插件 + 旧密钥 + 旧状态 + 旧日志），
 * 走 `initExtensions()` 的真实启动路径，再断言：
 *   1. 旧数据全部消失，v1 `settings.plugins` 清空，`legacyDataCleared` 写成 2；
 *   2. 与插件无关的主进程密钥（`@market:`）和合法 v2 数据不被误删；
 *   3. 三款 v2 官方包安装后 `previousVersion === null`（不是升级）；
 *   4. 清理是**一次性**的：标记已写后不再扫描；目录级清理只删 v1 形状目录，
 *      不碰已安装的 v2 目录。
 *
 * 跑法（在仓库根目录）：node verify/run.mjs legacy-cleanup
 */

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSettings, saveSettings } from '../src/main/settings'
import { cleanupLegacyExtensionData } from '../src/main/extensions/legacy'
import {
  initExtensions,
  shutdownExtensions,
  type ExtensionService
} from '../src/main/extensions/service'

const REPO = join(__dirname, '..', '..')
const APP_VERSION = '0.1.0'
const V1_PLUGINS = ['git-sync', 'ai-for-edit', 'quick-edit', 'note-embed', 'todo-marks']
const V2_PLUGINS = ['imark.quick-edit', 'imark.git-sync', 'imark.ai-for-edit']

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs legacy-cleanup` 跑会自动带上）')
    app.exit(2)
    return
  }
  await app.whenReady()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  for (const dir of [vault, join(ud, 'plugins'), join(ud, 'extensions-data'), join(ud, 'logs')]) {
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(vault, { recursive: true })
  await writeFile(note, '# 清理验收\n\n旧数据不该活过这次启动。\n', 'utf8')

  // ---------- 预置 v1 用户数据 ----------

  const settingsPath = join(ud, 'settings.json')
  await writeJson(settingsPath, {
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: note,
    marketUrl: '',
    autoSave: false,
    legacyDataCleared: 0,
    // v1 的插件配置：这次启动后必须整段消失
    plugins: Object.fromEntries(
      V1_PLUGINS.map(id => [id, { enabled: true, config: { v1: id } }])
    ),
    // 合法 v2 偏好与旧配置混在一起：清理只清 `plugins`，不动 `extensions`
    extensions: {
      'imark.keep-me': { enabled: true, config: { keep: true } }
    }
  })

  // v1 安装登记表（`{version:1, plugins}`）
  await writeJson(join(ud, 'plugins', 'installed.json'), {
    version: 1,
    plugins: Object.fromEntries(
      V1_PLUGINS.map(id => [id, { id, version: '1.0.0', mainMode: 'node' }])
    )
  })
  // v1 插件目录：manifest.json + main.js，没有 package.json
  for (const id of V1_PLUGINS) {
    await writeJson(join(ud, 'plugins', id, 'manifest.json'), {
      id,
      name: id,
      version: '1.0.0',
      mainMode: 'node'
    })
    await writeFile(join(ud, 'plugins', id, 'main.js'), `// v1 ${id}\n`, 'utf8')
  }
  // 旧状态目录用裸插件名；合法的 v2 数据目录要留下来
  for (const id of ['git-sync', 'note-embed', 'todo-marks']) {
    await writeJson(join(ud, 'extensions-data', id, 'state.json'), { v1: id })
  }
  await writeJson(join(ud, 'extensions-data', 'imark.git-sync', 'state.json'), { v2: true })
  // 旧输出日志
  await mkdir(join(ud, 'logs', 'plugins'), { recursive: true })
  await writeFile(join(ud, 'logs', 'plugins', 'git-sync.log'), 'v1 log\n', 'utf8')
  await mkdir(join(ud, 'logs', 'extensions'), { recursive: true })
  await writeFile(join(ud, 'logs', 'extensions', 'imark.git-sync.log'), 'v2 log\n', 'utf8')
  // 密钥：v1 的、v2 的、以及主进程自己的 @market 命名空间
  const secretsPath = join(ud, 'secrets.json')
  await writeJson(secretsPath, {
    version: 1,
    entries: {
      'git-sync:targets:t1': { enc: false, v: 'old-token' },
      'note-embed:secret': { enc: false, v: 'old-note' },
      'todo-marks:secret': { enc: false, v: 'old-todo' },
      'imark.git-sync:targets:t1': { enc: false, v: 'v2-token' },
      '@market:http://127.0.0.1:8787': { enc: false, v: 'market-token' }
    }
  })

  // ---------- 一、真实启动路径：initExtensions 触发清理 ----------

  console.log('\n【1】启动清理 v1 数据')
  const service: ExtensionService = await initExtensions({ appVersion: APP_VERSION })
  const settings = await loadSettings()

  check('清理标记写成 2', settings.legacyDataCleared === 2, String(settings.legacyDataCleared))
  check('settings.plugins 已清空', Object.keys(settings.plugins).length === 0, JSON.stringify(settings.plugins))
  check(
    '合法的 v2 扩展偏好保留',
    Boolean(settings.extensions['imark.keep-me']),
    JSON.stringify(settings.extensions)
  )
  const disk = await readJson(settingsPath)
  check(
    '磁盘上的 settings.json 也不再含旧插件配置',
    Object.keys((disk.plugins as object) ?? {}).length === 0 &&
      disk.legacyDataCleared === 2,
    JSON.stringify({ plugins: disk.plugins, legacyDataCleared: disk.legacyDataCleared })
  )

  for (const id of V1_PLUGINS) {
    check(`旧插件目录 ${id}/ 已删除`, !existsSync(join(ud, 'plugins', id)))
  }
  check('v1 installed.json 已删除', !existsSync(join(ud, 'plugins', 'installed.json')))
  check('旧的 plugins 根目录没有留下空壳', !existsSync(join(ud, 'plugins')))

  for (const id of ['git-sync', 'note-embed', 'todo-marks']) {
    check(`旧状态目录 extensions-data/${id}/ 已删除`, !existsSync(join(ud, 'extensions-data', id)))
  }
  check(
    '合法 v2 状态目录保留',
    existsSync(join(ud, 'extensions-data', 'imark.git-sync', 'state.json'))
  )
  check('v1 日志目录已删除', !existsSync(join(ud, 'logs', 'plugins')))
  check(
    'v2 日志目录不受影响',
    existsSync(join(ud, 'logs', 'extensions', 'imark.git-sync.log'))
  )

  const secrets = await readJson(secretsPath)
  const entries = (secrets.entries ?? {}) as Record<string, unknown>
  check(
    '旧插件密钥已删除',
    !('git-sync:targets:t1' in entries) &&
      !('note-embed:secret' in entries) &&
      !('todo-marks:secret' in entries),
    JSON.stringify(Object.keys(entries))
  )
  check('合法 v2 密钥保留', 'imark.git-sync:targets:t1' in entries, JSON.stringify(Object.keys(entries)))
  check(
    '市场令牌（@market 命名空间）不受插件清理影响',
    '@market:http://127.0.0.1:8787' in entries,
    JSON.stringify(Object.keys(entries))
  )

  check('清理前没有把 v1 目录当成扩展加载', (await service.listExtensions()).length === 0)

  // ---------- 二、三款官方扩展按全新安装处理 ----------

  console.log('\n【2】三款官方扩展全新安装（不是升级）')
  for (const id of V2_PLUGINS) {
    const envelope = JSON.parse(
      await readFile(join(REPO, 'src/main/market/builtin', `${id}.imkpkg.json`), 'utf8')
    ) as unknown
    const outcome = await service.installPackage(envelope, { source: 'bundled' })
    check(`${id} 安装成功`, outcome.record.id === id, JSON.stringify(outcome.record))
    check(`${id} 没有被当成旧版本升级（previousVersion = null）`, outcome.previousVersion === null, String(outcome.previousVersion))
  }
  const installed = await readJson(join(ud, 'plugins', 'installed.json'))
  const installedIds = Object.keys((installed.extensions as object) ?? {}).sort()
  check(
    'installed.json 只有三款新 ID',
    JSON.stringify(installedIds) === JSON.stringify([...V2_PLUGINS].sort()),
    JSON.stringify(installedIds)
  )
  const dirs = (await readdir(join(ud, 'plugins'), { withFileTypes: true }))
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort()
  check(
    '安装目录里没有旧插件残留',
    JSON.stringify(dirs) === JSON.stringify([...V2_PLUGINS].sort()),
    JSON.stringify(dirs)
  )
  check(
    '三款扩展都能出现在扩展列表里',
    (await service.listExtensions()).map(v => v.descriptor.id).sort().join(',') ===
      [...V2_PLUGINS].sort().join(','),
    (await service.listExtensions()).map(v => v.descriptor.id).join(',')
  )

  // ---------- 三、一次性与目录级清理 ----------

  console.log('\n【3】清理只跑一次，且不碰 v2 目录')
  // 现在 installed.json 已经是 v2 形状；手动再放一个 v1 目录，重新触发一次清理
  await writeJson(join(ud, 'plugins', 'legacy-extra', 'manifest.json'), { id: 'legacy-extra' })
  await saveSettings({ legacyDataCleared: 0 })
  const ranAgain = await cleanupLegacyExtensionData()
  check('标记被重置后会再跑一次', ranAgain === true)
  check('目录级清理删掉了 v1 形状目录', !existsSync(join(ud, 'plugins', 'legacy-extra')))
  for (const id of V2_PLUGINS) {
    check(`已安装的 v2 目录 ${id}/ 保留`, existsSync(join(ud, 'plugins', id, 'package.json')))
  }
  check(
    'v2 installed.json 仍是 v2 形状',
    (await readJson(join(ud, 'plugins', 'installed.json'))).version === 2
  )

  // 标记已写后，即使磁盘上再出现旧目录也不再扫描（这是“一次性”的意义）
  await writeJson(join(ud, 'plugins', 'legacy-again', 'manifest.json'), { id: 'legacy-again' })
  const ranThird = await cleanupLegacyExtensionData()
  check('legacyDataCleared = 2 后不再执行清理', ranThird === false)
  check('因此新出现的旧目录原样保留', existsSync(join(ud, 'plugins', 'legacy-again')))

  await shutdownExtensions()
  console.log(`\n${pass} 通过，${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
