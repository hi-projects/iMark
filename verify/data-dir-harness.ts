/**
 * 验收:数据目录(见 main/dataDir.ts)。
 *
 * 这一套盯四件事:
 *
 *   [A] **路径解析**(纯函数):命令行组合 + 应用目录/家目录回退各自算出什么。
 *   [B] **搬迁**(真跑):两种来源布局(家目录数据根 / 旧 userData)、profile 先走、
 *       自有数据上移、幂等、目标已存在不覆盖、profile 搬不动时的完整性守卫。
 *   [C] **进程级接线**:`prepareDataDirs()` 之后 `app.getPath('userData')` 与
 *       **`sessionData`** 都要指向 profile 目录(只改 userData 会留下半个 profile)。
 *       这一段需要额外开关,跑法见下。
 *
 * 跑法:
 *   node verify/run.mjs data-dir                             # A + B
 *   node verify/run.mjs data-dir --imark-data-dir=<绝对路径>  # 再加 C(会真的 setPath)
 *
 * ⚠️ `--user-data-dir` 必须由 run.mjs 传(它每次都传)。有它在,数据根就是那个临时目录,
 * 这一套**绝不会**碰到用户真实的数据目录;`--imark-data-dir` 只用于把"数据根"指到
 * 另一个临时目录,好把搬迁在沙箱里真跑一遍。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  dataDirFromArgv,
  dataRoot,
  migrateDataLayout,
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

function writeText(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
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
    '默认:搬迁来源先家目录 .imark、再旧 userData',
    appMode.sources.length === 2 &&
      same(appMode.sources[0]!, join(fakeHome, '.imark')) &&
      same(appMode.sources[1]!, fakeUserData),
    JSON.stringify(appMode.sources)
  )
  check('默认:要搬', appMode.migrate === true)

  const homeFallback = resolveDataPaths({ ...base, appDirWritable: false })
  check(
    '应用目录不可写:回退 <home>/.imark',
    same(homeFallback.dataRoot, join(fakeHome, '.imark')) && homeFallback.mode === 'home',
    `${homeFallback.dataRoot} / ${homeFallback.mode}`
  )
  check(
    '回退:profile 仍是 <数据根>/profile,来源是旧 userData',
    same(homeFallback.profileDir, join(homeFallback.dataRoot, 'profile')) &&
      homeFallback.sources.length === 1 &&
      same(homeFallback.sources[0]!, fakeUserData),
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
  check('--user-data-dir:不搬迁(免得去动真实数据)', override.migrate === false)

  const explicit = resolveDataPaths({ ...base, argv: [`--imark-data-dir=${fakeExplicit}`] })
  check('--imark-data-dir:数据根是它', same(explicit.dataRoot, fakeExplicit), explicit.dataRoot)
  check(
    '--imark-data-dir:profile 在它下面,来源仍是旧 userData',
    same(explicit.profileDir, join(fakeExplicit, 'profile')) &&
      explicit.sources.length === 1 &&
      same(explicit.sources[0]!, fakeUserData),
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

  // ---------- [B] 搬迁 ----------
  console.log('\n[B] 搬迁')

  // B1:旧 userData 布局(profile 就在根上)
  const legacy = join(ud, 'case-b', 'legacy')
  const root = join(ud, 'case-b', 'data')
  const fixture: Record<string, string> = {
    'settings.json': '{"marker":"settings"}',
    'secrets.json': '{"version":1,"entries":{"p:f:x":{"enc":false,"v":"tok"}}}',
    'css/demo.css': 'body{}',
    'plugins/demo/manifest.json': '{"id":"demo"}',
    'Local State': 'dummy-key-material',
    'Cache/foo.bin': 'cache-bytes'
  }
  for (const [name, text] of Object.entries(fixture)) writeText(join(legacy, name), text)
  mkdirSync(root, { recursive: true })

  const report = migrateDataLayout([legacy], root, join(root, 'profile'))
  check('旧 userData:profile 整体搬过来了', report.profileMoved === true, JSON.stringify(report.warnings))
  check(
    '解密密钥(Local State)跟着 profile 走 —— 否则已存的令牌会解不开',
    readFileSync(join(root, 'profile', 'Local State'), 'utf8') === fixture['Local State']
  )
  check('缓存也跟着走', readFileSync(join(root, 'profile', 'Cache', 'foo.bin'), 'utf8') === fixture['Cache/foo.bin'])
  check(
    '四项应用自有数据都到了数据根,内容一字不差',
    ['settings.json', 'secrets.json', 'css/demo.css', 'plugins/demo/manifest.json'].every(
      n => readFileSync(join(root, n), 'utf8') === fixture[n]
    )
  )
  check(
    '旧目录里那四项已经不在(是搬走的,不是复制的)',
    !existsSync(join(legacy, 'settings.json')) && !existsSync(join(legacy, 'plugins'))
  )

  const before = listDir(root).join('|')
  const second = migrateDataLayout([legacy], root, join(root, 'profile'))
  check(
    '第二次调用完全无副作用(幂等)',
    second.moved.length === 0 && listDir(root).join('|') === before,
    JSON.stringify(second.moved)
  )

  // B2:家目录数据根布局(自有数据在根上,profile 在 <root>/profile)
  const homeRoot = join(ud, 'case-home', '.imark')
  const homeData = join(ud, 'case-home', 'app-data')
  writeText(join(homeRoot, 'settings.json'), '{"marker":"home-settings"}')
  writeText(join(homeRoot, 'plugins', 'demo', 'manifest.json'), '{"id":"home-demo"}')
  writeText(join(homeRoot, 'css', 'example.css'), '/* my style */')
  writeText(join(homeRoot, 'profile', 'Local State'), 'home-key')
  writeText(join(homeRoot, 'profile', 'Network', 'Cookies'), 'cookie-bytes')
  mkdirSync(homeData, { recursive: true })

  const homeReport = migrateDataLayout([homeRoot], homeData, join(homeData, 'profile'))
  check(
    '家目录布局:<root>/profile 整体搬过来',
    homeReport.profileMoved === true &&
      readFileSync(join(homeData, 'profile', 'Local State'), 'utf8') === 'home-key' &&
      readFileSync(join(homeData, 'profile', 'Network', 'Cookies'), 'utf8') === 'cookie-bytes',
    JSON.stringify(homeReport.warnings)
  )
  check(
    '家目录布局:自有数据(含自定义样式 css/)上移到新根',
    readFileSync(join(homeData, 'settings.json'), 'utf8') === '{"marker":"home-settings"}' &&
      existsSync(join(homeData, 'plugins', 'demo', 'manifest.json')) &&
      readFileSync(join(homeData, 'css', 'example.css'), 'utf8') === '/* my style */'
  )
  check(
    '家目录布局:源根被搬空后删掉(释放家目录/系统盘)',
    !existsSync(homeRoot),
    listDir(homeRoot).join(',')
  )

  // B3:多来源时,家目录那份优先;旧 userData 的同名项不覆盖
  const multiHome = join(ud, 'case-multi', 'home')
  const multiUd = join(ud, 'case-multi', 'ud')
  const multiData = join(ud, 'case-multi', 'data')
  writeText(join(multiHome, 'settings.json'), '{"from":"home"}')
  writeText(join(multiHome, 'profile', 'Local State'), 'home-key')
  writeText(join(multiUd, 'settings.json'), '{"from":"ud"}')
  writeText(join(multiUd, 'Local State'), 'ud-key')
  mkdirSync(multiData, { recursive: true })
  migrateDataLayout([multiHome, multiUd], multiData, join(multiData, 'profile'))
  check(
    '多来源:自家的 profile 与配置优先,旧 userData 的不覆盖',
    readFileSync(join(multiData, 'profile', 'Local State'), 'utf8') === 'home-key' &&
      readFileSync(join(multiData, 'settings.json'), 'utf8') === '{"from":"home"}'
  )

  // B4:目标已有就不覆盖
  const target = join(ud, 'case-c')
  const keep = join(target, 'data', 'settings.json')
  writeText(keep, '{"marker":"existing"}')
  writeText(join(target, 'legacy', 'settings.json'), '{"marker":"legacy"}')
  writeText(join(target, 'legacy', 'secrets.json'), '{"marker":"legacy-secret"}')
  const kept = migrateDataLayout([join(target, 'legacy')], join(target, 'data'), join(target, 'data', 'profile'))
  check(
    '目标已有就不覆盖(新根里的那份说了算)',
    readFileSync(keep, 'utf8') === '{"marker":"existing"}' && kept.skipped.some(s => s.startsWith('settings.json'))
  )
  check('同一次里没冲突的那项照常搬', existsSync(join(target, 'data', 'secrets.json')))

  // B5:来源没有 profile(全新用户/纯配置迁移)—— 不抛,自有数据照常上移
  const broken = join(ud, 'case-d')
  writeText(join(broken, 'legacy', 'settings.json'), '{"marker":"legacy"}')
  mkdirSync(join(broken, 'data'), { recursive: true })
  const degraded = migrateDataLayout(
    [join(broken, 'legacy')],
    join(broken, 'data'),
    join(broken, 'no-such-parent', 'profile')
  )
  check('来源没有 profile 时不抛(profileMoved=false)', degraded.profileMoved === false)
  check(
    '来源没有 profile 时,自有数据照样上移(数据至少在一处)',
    readFileSync(join(broken, 'data', 'settings.json'), 'utf8') === '{"marker":"legacy"}'
  )

  // B5b:来源**有** profile 但目标 profile 搬不过去(父目录不存在) ——
  // 这时必须报 warning,且一个自有数据文件都不搬(否则应用仍读旧目录,插件/令牌看起来就没了)
  const blocked = join(ud, 'case-d2')
  writeText(join(blocked, 'home', 'profile', 'Local State'), 'key')
  writeText(join(blocked, 'home', 'settings.json'), '{"marker":"home"}')
  mkdirSync(join(blocked, 'data'), { recursive: true })
  const blockedReport = migrateDataLayout(
    [join(blocked, 'home')],
    join(blocked, 'data'),
    join(blocked, 'no-such-parent', 'profile')
  )
  check(
    '来源有 profile 但搬不动:profileMoved=false 且有 warning',
    blockedReport.profileMoved === false && blockedReport.warnings.length > 0,
    JSON.stringify(blockedReport)
  )
  check(
    '来源有 profile 但搬不动:自有数据一个都不搬(防两头空)',
    !existsSync(join(blocked, 'data', 'settings.json')) &&
      existsSync(join(blocked, 'home', 'settings.json'))
  )

  // B6:目标里有一个"不像 profile"的目录(旧的半份拷贝/占位目录)——
  // 不能永远卡住:把它改名保留,本次重新搬来源的 profile。
  const split = join(ud, 'case-e')
  writeText(join(split, 'home', 'profile', 'Local State'), 'real-key')
  writeText(join(split, 'home', 'settings.json'), '{"marker":"home"}')
  writeText(join(split, 'data', 'profile', 'junk.txt'), 'not-a-profile')
  const held = migrateDataLayout([join(split, 'home')], join(split, 'data'), join(split, 'data', 'profile'))
  const staleName = listDir(join(split, 'data')).find(n => n.startsWith('profile.stale-'))
  check(
    '目标里的不完整 profile 被改名保留,来源的 profile 迁了进来',
    held.profileMoved === true &&
      readFileSync(join(split, 'data', 'profile', 'Local State'), 'utf8') === 'real-key' &&
      typeof staleName === 'string',
    JSON.stringify(held)
  )
  check(
    '被改名的那份内容没丢(原样保留)',
    typeof staleName === 'string' &&
      readFileSync(join(split, 'data', staleName!, 'junk.txt'), 'utf8') === 'not-a-profile'
  )
  check(
    '此时自有数据也随之上移',
    existsSync(join(split, 'data', 'settings.json')) &&
      !existsSync(join(split, 'home', 'settings.json'))
  )

  // ---------- [C] 进程级接线 ----------
  console.log('\n[C] prepareDataDirs() 之后 setPath 指哪儿')
  if (!app.commandLine.hasSwitch('imark-data-dir')) {
    console.log('  (跳过:没给 --imark-data-dir;加上它才跑这段)')
  } else {
    // 这里刻意在 ready 之前调 —— 与 index.ts 的真实顺序一致
    writeText(join(ud, 'settings.json'), '{"marker":"from-ud"}')
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
    check(
      '样式目录挂在数据根下(harness 里跟着 --user-data-dir 一起被隔离)',
      same(userStylesDir(), join(dataRoot(), 'css')),
      userStylesDir()
    )
    check(
      '老位置那几项被搬走了(真的按 index.ts 的顺序跑了一遍)',
      existsSync(join(dataRoot(), 'settings.json')) && !existsSync(join(ud, 'settings.json'))
    )
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
