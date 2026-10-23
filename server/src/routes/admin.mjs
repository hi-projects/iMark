/**
 * 管理接口。只有一件事现在真的需要:转移扩展所有权。
 *
 * 「首次发布即认领 id」这套规则在公开注册表上有个已知的坑:官方 id
 * (如 git-sync)如果没有被先占掉,任何人都能抢走它。与其做一个「保留 id 表」
 * (那套表本身就要维护、要同步、要能被绕过),不如给管理员一个能**事后纠正**的开关 ——
 * 抢注可以发生,但可以被撤销,而且撤销是一条明确的、有日志的命令。
 */

import { HttpError, readJson, sendJson } from '../http.mjs'

export function register(router, app) {
  const { store } = app

  router.post('/api/v1/admin/packages/:id/transfer', async ({ req, res, auth, params }) => {
    app.requireAdmin(auth)
    const body = await readJson(req)
    const to = String(body.to ?? '')
      .trim()
      .toLowerCase()
    if (!to) throw new HttpError(400, '必须给出 to(新的作者用户名)', 'bad_field')

    const users = await store.readJson('users.json', { users: {} })
    if (!users.users[to]) throw new HttpError(404, `没有这个用户:${to}`, 'not_found')

    const from = await store.update('packages.json', { packages: {} }, data => {
      const pkg = data.packages[params.id]
      if (!pkg) throw new HttpError(404, `没有这个扩展:${params.id}`, 'not_found')
      const previous = pkg.owner
      pkg.owner = to
      pkg.updatedAt = Date.now()
      return previous
    })
    console.log(`[market] 所有权转移:${params.id} ${from} → ${to}(由管理员令牌执行)`)
    sendJson(res, 200, { id: params.id, from, to })
  })

  /** 只读概览:自托管时「这台机器上到底有些什么」一眼可见 */
  router.get('/api/v1/admin/stats', async ({ res, auth }) => {
    app.requireAdmin(auth)
    const [packages, users, tokens] = await Promise.all([
      store.readJson('packages.json', { packages: {} }),
      store.readJson('users.json', { users: {} }),
      store.readJson('tokens.json', { tokens: {} })
    ])
    const ids = Object.keys(packages.packages)
    let versions = 0
    let downloads = 0
    for (const pkg of Object.values(packages.packages)) {
      versions += Object.keys(pkg.versions).length
      downloads += pkg.downloads ?? 0
    }
    sendJson(res, 200, {
      packages: ids.length,
      versions,
      downloads,
      users: Object.keys(users.users).length,
      tokens: Object.keys(tokens.tokens).length
    })
  })
}
