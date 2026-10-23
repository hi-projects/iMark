/**
 * 验收:安装确认框拿到的预览字段。
 *
 * 不打开界面,只钉住 `previewEnvelope` 的产出与「需不需要风险确认」这条规则 ——
 * 界面组件是它们的纯函数投影。
 *
 * 覆盖:
 *   - 含代码包(git-sync):hasMain=true、有 mainSha256、需要勾选「以用户权限运行」;
 *   - 纯声明包:hasMain=false、没有 mainSha256、不需要勾选;
 *   - Agent Core / Claude Code 也能生成预览,并带出各自的能力声明。
 *
 * 跑法:node verify/run.mjs install-confirm
 */

import { app } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { previewEnvelope } from '../src/main/market/installer'
import { packDirectory } from '../src/main/market/pack'
import gitSyncPackage from '../src/main/market/builtin/imark.git-sync.imkpkg.json?raw'
import quickEditPackage from '../src/main/market/builtin/imark.quick-edit.imkpkg.json?raw'
import agentPackage from '../src/main/market/builtin/imark.agent.imkpkg.json?raw'
import claudeCodePackage from '../src/main/market/builtin/imark.claude-code.imkpkg.json?raw'

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

async function main(): Promise<void> {
  await app.whenReady()
  const origin = { kind: 'local-file' as const, label: '测试包', publisher: null }

  // ---------- [A] 含代码扩展 ----------
  console.log('\n[A] 含代码扩展(git-sync)')
  const git = previewEnvelope(JSON.parse(gitSyncPackage), origin)
  check('预览成功', git.ok, git.ok ? '' : git.errors.join(';'))
  if (git.ok) {
    check('hasMain = true', git.value.hasMain === true)
    check('main 指向 ./main.js', git.value.main === './main.js', String(git.value.main))
    check('有 main 入口哈希', Boolean(git.value.mainSha256) && git.value.mainSha256!.length === 64)
    check('激活事件非空', git.value.activationEvents.length > 0)
    check('能力声明带出(含 git/network)', git.value.capabilities.git === true && git.value.capabilities.network === true)
    check('贡献摘要非全零', git.value.contributesSummary.commands > 0, JSON.stringify(git.value.contributesSummary))
    check('需要勾选「以用户权限运行」', git.value.hasMain === true)
    check('本地安装时 publisher 为 null', git.value.publisher === null)
  }

  // ---------- [B] 另一个含代码包 ----------
  console.log('\n[B] 含代码扩展(quick-edit)')
  const quick = previewEnvelope(JSON.parse(quickEditPackage), origin)
  check('预览成功', quick.ok, quick.ok ? '' : quick.errors.join(';'))
  if (quick.ok) {
    check('hasMain = true', quick.value.hasMain === true)
    check('有入口哈希', Boolean(quick.value.mainSha256))
    check('需要风险确认', quick.value.hasMain === true)
  }

  // ---------- [C] Agent Core ----------
  console.log('\n[C2] 含代码扩展(agent)')
  const agent = previewEnvelope(JSON.parse(agentPackage), origin)
  check('预览成功', agent.ok, agent.ok ? '' : agent.errors.join(';'))
  if (agent.ok) {
    check('hasMain = true', agent.value.hasMain === true)
    check('显示名为 Agent Core', agent.value.name === 'Agent Core', agent.value.name)
    check('能力声明含 process', agent.value.capabilities.process === true)
    check('贡献摘要非全零', agent.value.contributesSummary.commands > 0, JSON.stringify(agent.value.contributesSummary))
  }

  // ---------- [C2] Claude Code ----------
  console.log('\n[C3] 含代码扩展(claude-code)')
  const claude = previewEnvelope(JSON.parse(claudeCodePackage), origin)
  check('预览成功', claude.ok, claude.ok ? '' : claude.errors.join(';'))
  if (claude.ok) {
    check('hasMain = true', claude.value.hasMain === true)
    check('显示名为 Claude Code', claude.value.name === 'Claude Code', claude.value.name)
    check(
      '能力声明含 network/process/shell',
      claude.value.capabilities.network === true &&
        claude.value.capabilities.process === true &&
        claude.value.capabilities.shell === true
    )
    check('不再声明 secrets 能力（令牌在 settings.json）', claude.value.capabilities.secrets !== true)
    check('贡献摘要带出配置', claude.value.contributesSummary.configuration > 0, JSON.stringify(claude.value.contributesSummary))
  }

  // ---------- [D] 纯声明扩展 ----------
  console.log('\n[D] 纯声明扩展')
  const ud = app.getPath('userData')
  const dir = join(ud, 'declarative-fixture')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        publisher: 'harness',
        name: 'declarative-demo',
        version: '1.2.3',
        displayName: '纯声明示例',
        engines: { imark: '^1.0.0' },
        contributes: {
          commands: [{ command: 'harness.declarative-demo.run', title: '运行' }],
          configuration: {
            properties: {
              'harness.declarative-demo.mode': { type: 'string', default: 'a', title: '模式' }
            }
          }
        }
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(join(dir, 'README.md'), '# declarative\n', 'utf8')
  const packed = await packDirectory(dir)
  const decl = previewEnvelope(packed.envelope, origin)
  check('预览成功', decl.ok, decl.ok ? '' : decl.errors.join(';'))
  if (decl.ok) {
    check('hasMain = false', decl.value.hasMain === false)
    check('main 为 null', decl.value.main === null)
    check('没有入口哈希', decl.value.mainSha256 === null)
    check('不需要风险确认', decl.value.hasMain === false)
    check('贡献摘要仍带出', decl.value.contributesSummary.configuration === 1)
  }

  // ---------- [E] 来源字段 ----------
  console.log('\n[E] 来源')
  const market = previewEnvelope(JSON.parse(gitSyncPackage), {
    kind: 'market',
    label: 'http://127.0.0.1:8787',
    publisher: 'imark-publisher'
  })
  check('市场来源带出 publisher', market.ok && market.value.publisher === 'imark-publisher', market.ok ? String(market.value.publisher) : market.errors.join(';'))
  check('origin 正确', market.ok && market.value.origin === 'market')

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'} —— 通过 ${pass} / 失败 ${fail}\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[harness] 崩了:', err)
  app.exit(3)
})
