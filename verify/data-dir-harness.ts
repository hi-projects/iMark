/**
 * 验收:数据目录(见 main/dataDir.ts)。
 *
 * 覆盖:
 *
 *   [A] **路径解析**(纯函数):命令行组合 + 应用目录/家目录回退各自算出什么。
 *   [B] **进程级接线**:`prepareDataDirs()` 之后 `app.getPath('userData')` 与
 *       **`sessionData`** 都要指向 profile 目录(只改 userData 会留下半个 profile)。
 *       这一段需要额外开关,跑法见下。
 *
 * 跑法:
 *   node verify/run.mjs data-dir                             # 只跑 A
 *   node verify/run.mjs data-dir --imark-data-dir=<绝对路径>  # 再加 B(会真的 setPath)
 *
 * ⚠️ `--user-data-dir` 必须由 run.mjs 传(它每次都传)。有它在,profile 就是那个
 * 临时目录,这一套**绝不会**碰到用户真实的数据目录;`--imark-data-dir` 只用于把
 * 数据根指到另一个临时目录。
 */

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  dataDirFromArgv,
  dataRoot,
  prepareDataDirs,
  profileDir,
  resolveDataPaths
} from '../src/main/dataDir'
import { userStylesDir } from '../src/main/userStyles'

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

/** Windows 上大小写不敏感,路径比较统一走这里(别写 startsWith('/')) */
function same(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

  const ud = resolve(app.getPath('userData'))
  const fakeHome = join(ud, 'fake-home')
  const fakeUserData = join(ud, 'fake-appdata', 'imarkdown')
  const fakeAppDir = join(ud, 'fake-app')
  const fakeExplicit = join(ud, 'explicit-data')
  const base = {
    argv: [] as string[],
    home: fakeHome,
    currentUserData: fakeUserData,
    userDataOverridden: false,
    appDir: fakeAppDir
  }

  // ---------- [A] 路径解析(纯函数) ----------
  console.log('\n[A] 路径解析')
  const appMode = resolveDataPaths({ ...base, appDirWritable: true })
  check(
    '默认(应用目录可写):数据根是 <appDir>/.imark',
    same(appMode.dataRoot, join(fakeAppDir, '.imark')) && appMode.mode === 'app',
    `${appMode.dataRoot} / ${appMode.mode}`
  )
  check(
    '默认:profile 是 <数据根>/profile',
    same(appMode.profileDir, join(appMode.dataRoot, 'profile')),
    appMode.profileDir
  )
  check(
    '默认:降级目标是家目录布局',
    same(appMode.fallbackRoot, join(fakeHome, '.imark')) &&
      same(appMode.fallbackProfile, join(fakeHome, '.imark', 'profile')),
    JSON.stringify(appMode)
  )

  const homeFallback = resolveDataPaths({ ...base, appDirWritable: false })
  check(
    '应用目录不可写:回退 <home>/.imark',
    same(homeFallback.dataRoot, join(fakeHome, '.imark')) && homeFallback.mode === 'home',
    `${homeFallback.dataRoot} / ${homeFallback.mode}`
  )
  check(
    '回退:profile 仍是 <数据根>/profile',
    same(homeFallback.profileDir, join(homeFallback.dataRoot, 'profile')),
    JSON.stringify(homeFallback)
  )

  const override = resolveDataPaths({ ...base, userDataOverridden: true })
  check(
    '--user-data-dir(测试的隔离模式):数据根与 profile 都指向它',
    same(override.dataRoot, fakeUserData) &&
      same(override.profileDir, fakeUserData) &&
      override.mode === 'override',
    `${override.dataRoot} / ${override.profileDir}`
  )

  const explicit = resolveDataPaths({ ...base, argv: [`--imark-data-dir=${fakeExplicit}`] })
  check('--imark-data-dir:数据根是它', same(explicit.dataRoot, fakeExplicit), explicit.dataRoot)
  check(
    '--imark-data-dir:profile 在它下面',
    same(explicit.profileDir, join(fakeExplicit, 'profile')),
    JSON.stringify(explicit)
  )

  const both = resolveDataPaths({
    ...base,
    argv: [`--imark-data-dir=${fakeExplicit}`],
    userDataOverridden: true
  })
  check(
    '两个都给:数据根取 --imark-data-dir,profile 取 --user-data-dir',
    same(both.dataRoot, fakeExplicit) && same(both.profileDir, fakeUserData),
    `${both.dataRoot} / ${both.profileDir}`
  )
  check(
    '两种写法都认(空格分开 / 后面跟开关时不算值)',
    same(String(dataDirFromArgv(['--imark-data-dir', fakeExplicit])), fakeExplicit) &&
      dataDirFromArgv(['--imark-data-dir', '--foo']) === null
  )

  // ---------- [B] 进程级接线 ----------
  console.log('\n[B] prepareDataDirs() 之后 setPath 指哪儿')
  if (!app.commandLine.hasSwitch('imark-data-dir')) {
    console.log('  (跳过:没给 --imark-data-dir;加上它才跑这段)')
  } else {
    // 这里刻意在 ready 之前调 —— 与 index.ts 的真实顺序一致
    prepareDataDirs()
    check(
      'app.getPath("userData") 指向 profile',
      same(app.getPath('userData'), profileDir()),
      `${app.getPath('userData')} vs ${profileDir()}`
    )
    check(
      'app.getPath("sessionData") **也**指向 profile(只改 userData 会留下半个 profile)',
      same(app.getPath('sessionData'), profileDir()),
      app.getPath('sessionData')
    )
    const given = dataDirFromArgv(process.argv)
    check(
      '数据根是 --imark-data-dir 给的那个',
      given !== null && same(dataRoot(), given),
      `${dataRoot()} vs ${given}`
    )
    check('数据根已经建出来', existsSync(dataRoot()), dataRoot())
    check(
      '样式目录挂在数据根下(harness 里跟着 --user-data-dir 一起被隔离)',
      same(userStylesDir(), join(dataRoot(), 'css')),
      userStylesDir()
    )
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
