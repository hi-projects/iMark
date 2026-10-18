/**
 * 验收:安装确认框拿到的层信息。
 *
 * 不打开界面,只钉住 `previewEnvelope` 的产出 —— 界面组件是它的纯函数投影。
 * 四个内置包覆盖 node / restricted / render-only / both;另外造一个无代码
 * capability 包与一个未知形态包。
 *
 * 跑法:node verify/run.mjs install-confirm
 */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { previewEnvelope } from '../src/main/market/installer'
import { integrityInput } from '../src/shared/pluginPackage'
import gitSyncPackage from '../src/main/market/builtin/git-sync.imkpkg.json?raw'
import quickEditPackage from '../src/main/market/builtin/quick-edit.imkpkg.json?raw'
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

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

function envelopeOf(
  manifest: Record<string, unknown>,
  extraFiles: Record<string, string> = {}
): unknown {
  const contents: Record<string, Buffer> = {
    'README.md': Buffer.from('# 测试包\n', 'utf8')
  }
  for (const [name, text] of Object.entries(extraFiles)) {
    contents[name] = Buffer.from(text, 'utf8')
  }
  const files: Record<string, { encoding: 'base64'; size: number; sha256: string }> = {}
  const data: Record<string, string> = {}
  for (const [name, buf] of Object.entries(contents)) {
    files[name] = { encoding: 'base64', size: buf.byteLength, sha256: sha256(buf) }
    data[name] = buf.toString('base64')
  }
  return {
    format: 'imk-plugin',
    formatVersion: 1,
    manifest,
    files,
    data,
    integrity: sha256(integrityInput(manifest as never, files as never))
  }
}

async function main(): Promise<void> {
  await app.whenReady()
  const origin = { kind: 'local-file' as const, label: '测试包' }

  console.log('\n[A] node main')
  const git = previewEnvelope(JSON.parse(gitSyncPackage), origin)
  check('git-sync 预览成功', git.ok, git.ok ? '' : git.errors.join(';'))
  if (git.ok) {
    check('mainMode=node', git.value.mainMode === 'node', String(git.value.mainMode))
    check('没有 render 层', git.value.hasRender === false)
    check('有 main 入口哈希', Boolean(git.value.mainSha256))
    check('没有 render 入口哈希', git.value.renderSha256 === null)
    check('四权限原样带出', git.value.permissions.length === 4, git.value.permissions.join(','))
  }

  console.log('\n[B] restricted main')
  const restricted = previewEnvelope(
    envelopeOf(
      {
        id: 'restricted-demo',
        name: '受限示例',
        description: '',
        version: '1.0.0',
        main: { mode: 'restricted', entry: 'main.js' },
        permissions: ['vault:read'],
        fields: [],
        actions: []
      },
      { 'main.js': 'window.imark.plugin.handle({})\n' }
    ),
    origin
  )
  check('restricted-only 预览成功', restricted.ok, restricted.ok ? '' : restricted.errors.join(';'))
  if (restricted.ok) {
    check('mainMode=restricted', restricted.value.mainMode === 'restricted', String(restricted.value.mainMode))
    check('没有 render 层', restricted.value.hasRender === false)
    check('有 main 入口哈希', Boolean(restricted.value.mainSha256))
    check('没有 render 入口哈希', restricted.value.renderSha256 === null)
  }

  console.log('\n[C] render-only')
  const todo = previewEnvelope(JSON.parse(todoMarksPackage), origin)
  check('todo-marks 预览成功', todo.ok, todo.ok ? '' : todo.errors.join(';'))
  if (todo.ok) {
    check('没有 main 层', todo.value.mainMode === null, String(todo.value.mainMode))
    check('有 render 层', todo.value.hasRender === true)
    check('没有 main 入口哈希', todo.value.mainSha256 === null)
    check('有 render 入口哈希', Boolean(todo.value.renderSha256))
    check('没有权限', todo.value.permissions.length === 0)
  }

  console.log('\n[D] restricted main + render')
  const note = previewEnvelope(JSON.parse(noteEmbedPackage), origin)
  check('note-embed 预览成功', note.ok, note.ok ? '' : note.errors.join(';'))
  if (note.ok) {
    check('mainMode=restricted', note.value.mainMode === 'restricted')
    check('有 render 层', note.value.hasRender === true)
    check('两个入口哈希都有', Boolean(note.value.mainSha256 && note.value.renderSha256))
    check(
      '权限只有读取仓库',
      JSON.stringify(note.value.permissions) === JSON.stringify(['vault:read']),
      note.value.permissions.join(',')
    )
  }
  const quick = previewEnvelope(JSON.parse(quickEditPackage), origin)
  check('quick-edit 预览成功', quick.ok, quick.ok ? '' : quick.errors.join(';'))
  if (quick.ok) {
    check('quick-edit 是 restricted-only', quick.value.mainMode === 'restricted' && !quick.value.hasRender)
    check('quick-edit 只有 main 入口哈希', Boolean(quick.value.mainSha256) && quick.value.renderSha256 === null)
  }

  console.log('\n[E] 无代码 capability')
  const capability = previewEnvelope(
    envelopeOf({
      id: 'hook-demo',
      name: 'Webhook 示例',
      description: '',
      version: '1.0.0',
      capability: 'webhook',
      permissions: ['network'],
      fields: [{ key: 'targets', kind: 'targets', label: 't', default: [] }],
      actions: [{ id: 'test', label: '测试' }],
      targetActions: [{ id: 'test-target', label: '测试目标' }],
      targetFieldKey: 'targets'
    }),
    origin
  )
  check('capability 预览成功', capability.ok, capability.ok ? '' : capability.errors.join(';'))
  if (capability.ok) {
    check('没有 main/render', capability.value.mainMode === null && capability.value.hasRender === false)
    check('capability 字段带出', capability.value.capability === 'webhook')
    check('capability 显示名查到了', capability.value.capabilityName === 'Webhook 推送', String(capability.value.capabilityName))
  }

  console.log('\n[F] 未知形态')
  const unknown = previewEnvelope(
    envelopeOf({
      id: 'unknown-demo',
      name: '未知',
      description: '',
      version: '1.0.0',
      fields: [],
      actions: []
    }),
    origin
  )
  check(
    '没有层的包被校验拒绝',
    unknown.ok === false && unknown.errors.some(e => e.includes('至少声明')),
    unknown.ok ? '(意外通过)' : unknown.errors.join(';')
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
