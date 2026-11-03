/**
 * Agent Core 会话过期清理验收（不需要窗口）。
 *
 * 覆盖：
 *   1 清单默认保留 1 天，0 表示永久保留；可自定义会话数据目录
 *   2 超过保留期的会话连同目录一起删除，索引同步移除
 *   3 保留期内的会话、运行中的会话不受影响
 *   4 保留期设为 0 时不清理
 *   5 数据目录解析：留空回落、~ 展开、相对路径与磁盘根目录被拒绝
 *
 * 跑法：
 *   xvfb-run -a node verify/run.mjs agent-prune
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveStorageRoot,
  SessionStore,
  type SessionMeta
} from '../plugins-src/agent/core/sessions'

const DAY_MS = 24 * 60 * 60 * 1000
const MANIFEST = join(__dirname, '..', '..', 'plugins-src', 'agent', 'package.json')

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 直接改 meta.json，把最后活动时间拨到过去（update() 总会写回当前时间） */
async function backdate(store: SessionStore, id: string, ageMs: number): Promise<void> {
  const path = store.metaPath(id)
  const meta = JSON.parse(await readFile(path, 'utf8')) as SessionMeta
  meta.updatedAt = Date.now() - ageMs
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

async function readIndex(store: SessionStore): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(store.rootPath, 'index.json'), 'utf8')) as {
    sessions?: string[]
  }
  return raw.sessions ?? []
}

async function main(): Promise<void> {
  console.log('\n【1】清单默认值')
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
    contributes?: {
      configuration?: {
        properties?: Record<
          string,
          { default?: unknown; minimum?: unknown; imark?: { kind?: string; section?: string } }
        >
      }
      commands?: { command?: string }[]
      'imark.actions'?: { command?: string; label?: string }[]
    }
  }
  const retention = manifest.contributes?.configuration?.properties?.[
    'imark.agent.sessionRetentionDays'
  ]
  check('声明了 imark.agent.sessionRetentionDays', Boolean(retention))
  check('默认保留 1 天', retention?.default === 1, String(retention?.default))
  check('允许 0（永久保留）', retention?.minimum === 0, String(retention?.minimum))

  const actions = manifest.contributes?.['imark.actions'] ?? []
  check(
    '设置页有「立即清理过期会话」动作',
    actions.some(
      action =>
        action.command === 'imark.agent.cleanupSessions' && action.label === '立即清理过期会话'
    ),
    JSON.stringify(actions)
  )
  const commands = manifest.contributes?.commands ?? []
  check(
    '清理命令已声明',
    commands.some(command => command.command === 'imark.agent.cleanupSessions'),
    JSON.stringify(commands)
  )

  const dataDir = manifest.contributes?.configuration?.properties?.[
    'imark.agent.sessionDataDir'
  ]
  check('声明了会话数据目录', Boolean(dataDir))
  check('默认留空（使用扩展目录）', dataDir?.default === '', String(dataDir?.default))
  check(
    '数据目录用文件夹选择控件',
    dataDir?.imark?.kind === 'directory',
    String(dataDir?.imark?.kind)
  )
  const attachment = manifest.contributes?.configuration?.properties?.[
    'imark.agent.attachmentMaxMB'
  ]
  check(
    '附件、清理与存储同属「会话」分组',
    attachment?.imark?.section === '会话' &&
      retention?.imark?.section === '会话' &&
      dataDir?.imark?.section === '会话',
    `${String(attachment?.imark?.section)} / ${String(retention?.imark?.section)} / ${String(dataDir?.imark?.section)}`
  )

  console.log('\n【1b】数据目录解析')
  const fallback = '/tmp/imark-fallback'
  check(
    '留空回落到默认目录',
    resolveStorageRoot('', fallback).root === fallback &&
      resolveStorageRoot('   ', fallback).root === fallback
  )
  check(
    '~ 展开到 home',
    resolveStorageRoot('~/agent', fallback, '/home/tester').root === '/home/tester/agent'
  )
  const relative = resolveStorageRoot('relative/dir', fallback)
  check(
    '相对路径被拒绝并回退',
    relative.root === fallback && Boolean(relative.error),
    JSON.stringify(relative)
  )
  const diskRoot = resolveStorageRoot('/', fallback)
  check(
    '磁盘根目录被拒绝',
    diskRoot.root === fallback && Boolean(diskRoot.error),
    JSON.stringify(diskRoot)
  )

  const root = await mkdtemp(join(tmpdir(), 'imark-agent-prune-'))
  try {
    const store = new SessionStore(root)
    await store.init()

    const old = await store.create({ provider: 'fake', workspace: null })
    const recent = await store.create({ provider: 'fake', workspace: null })
    const running = await store.create({ provider: 'fake', workspace: null })
    for (const session of [old, recent, running]) {
      await store.appendMessage(session.id, {
        role: 'user',
        text: 'hello',
        status: 'ok',
        attachmentIds: [],
        toolCalls: []
      })
    }
    await store.setStatus(running.id, 'running')
    await backdate(store, old.id, 2 * DAY_MS)
    await backdate(store, running.id, 2 * DAY_MS)

    console.log('\n【2】超过保留期')
    const removed = await store.pruneExpired(DAY_MS)
    check('只删掉过期会话', removed.length === 1 && removed[0] === old.id, removed.join(','))
    check('会话目录已删除', !(await pathExists(store.sessionDir(old.id))))
    check('meta 读不到', (await store.getMeta(old.id)) === null)
    const indexAfter = await readIndex(store)
    check('索引里已移除', !indexAfter.includes(old.id), indexAfter.join(','))
    check('保留期内的会话还在', (await store.getMeta(recent.id)) !== null)
    check('运行中的会话还在', (await store.getMeta(running.id)) !== null)
    const listed = await store.listAll(null)
    check(
      '列表只剩未过期的两个',
      listed.length === 2 && listed.every(item => item.id !== old.id),
      listed.map(item => item.id).join(',')
    )

    console.log('\n【3】保留期设为 0')
    await backdate(store, recent.id, 3 * DAY_MS)
    const kept = await store.pruneExpired(0)
    check('0 不清理任何会话', kept.length === 0, kept.join(','))
    check('三天未活动的会话仍在', (await store.getMeta(recent.id)) !== null)

    console.log('\n【4】再次按 1 天清理')
    const removedAgain = await store.pruneExpired(DAY_MS)
    check(
      '删掉新过期的会话',
      removedAgain.length === 1 && removedAgain[0] === recent.id,
      removedAgain.join(',')
    )
    check('运行中的会话始终跳过', (await store.getMeta(running.id)) !== null)
    check(
      '索引只剩运行中的会话',
      JSON.stringify(await readIndex(store)) === JSON.stringify([running.id]),
      (await readIndex(store)).join(',')
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main()
  .then(() => {
    console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch(err => {
    console.error('[agent-prune] 未捕获异常:', err)
    process.exit(1)
  })
