/**
 * 扩展包相关接口:搜索、详情、下载、发布、下架。
 *
 * 三条贯穿本文件的设计:
 *
 *   1. **已发布的版本不可变。** 同 (id, version) 重发一律 409,没有「覆盖」这条路。
 *      这不是洁癖:客户端的安装确认框会把 integrity 显示给用户去核对,
 *      如果同一个版本号底下的字节能悄悄换人,那个 sha256 就一文不值。
 *
 *   2. **下架不是删除。** yanked 的版本从搜索、latest 与版本列表里消失,
 *      但按精确版本号仍然可下载 —— 别人锁定了这个版本装好的扩展不该被我们弄坏。
 *
 *   3. **服务端重算一切。** 收到信封后逐文件 sha256 与 integrity 全部重算,
 *      与包里声称的比对,不符就是 400。服务端不相信任何上传者(包括管理员)。
 */

import { HttpError, intParam, readJson, sendBytes, sendJson } from '../http.mjs'
import { compareVersions, extractReadme, LIMITS, validateEnvelope } from '../validate.mjs'

/** 发布走这条路由时的请求体上限:信封上限 8 MiB,JSON 转义后再留一点余量 */
const PUBLISH_BODY_LIMIT = Math.ceil(LIMITS.envelopeBytes * 1.5)

const ICON_MIME = { png: 'image/png', svg: 'image/svg+xml' }

/** 清单里的作者署名(对象形态取 name) */
function authorName(author) {
  if (typeof author === 'string') return author.trim() || null
  if (author && typeof author === 'object' && typeof author.name === 'string') {
    return author.name.trim() || null
  }
  return null
}

/** 贡献点计数 —— 与客户端 contributesSummaryOf 同口径 */
function contributesSummaryOf(manifest) {
  const contributes = manifest.contributes ?? {}
  const config = contributes.configuration
  let configuration = 0
  if (config) {
    for (const section of Array.isArray(config) ? config : [config]) {
      configuration += Object.keys(section?.properties ?? {}).length
    }
  }
  return {
    commands: contributes.commands?.length ?? 0,
    keybindings: contributes.keybindings?.length ?? 0,
    configuration,
    lineMenu: contributes['imark.lineMenu']?.length ?? 0,
    actions: contributes['imark.actions']?.length ?? 0
  }
}

/** 详情页/搜索结果里的公开字段 —— 不含包体、不含 readme(列表页用不上) */
function entryOf(id, pkg, latest) {
  const m = latest.manifest
  return {
    id,
    name: m.name,
    displayName: m.displayName?.trim() || m.name,
    description: m.description ?? '',
    version: latest.version,
    author: authorName(m.author),
    publisher: pkg.owner,
    main: m.main ?? null,
    hasMain: Boolean(m.main),
    activationEvents: m.activationEvents ?? [],
    capabilities: m.capabilities ?? {},
    contributesSummary: contributesSummaryOf(m),
    homepage: m.homepage ?? null,
    hasIcon: Boolean(latest.iconName),
    downloads: pkg.downloads,
    updatedAt: pkg.updatedAt,
    publishedAt: latest.publishedAt
  }
}

/** 非 yanked 的最高版本;全被下架时返回 null */
function latestVersion(pkg) {
  let best = null
  for (const v of Object.values(pkg.versions)) {
    if (v.yanked) continue
    if (!best || compareVersions(v.version, best.version) > 0) best = v
  }
  return best
}

function requirePackage(data, id) {
  const pkg = data.packages[id]
  if (!pkg) throw new HttpError(404, `没有这个扩展:${id}`, 'not_found')
  return pkg
}

export function register(router, app) {
  const { store } = app

  // ---------- 搜索 ----------

  router.get('/api/v1/search', async ({ query, res }) => {
    const q = (query.get('q') ?? '').trim().toLowerCase()
    const hasMain = query.get('hasMain')
    const sort = query.get('sort') ?? 'updated'
    const page = intParam(query, 'page', 1, 1, 10000)
    const pageSize = intParam(query, 'pageSize', 20, 1, 100)

    const data = await store.readJson('packages.json', { packages: {} })
    const all = []
    for (const [id, pkg] of Object.entries(data.packages)) {
      const latest = latestVersion(pkg)
      if (!latest) continue // 全部版本已下架 → 等于不存在
      if (hasMain === 'true' && !latest.manifest.main) continue
      if (hasMain === 'false' && latest.manifest.main) continue
      if (q) {
        // 作者(author,清单里写的人)与发布者(owner,市场账号)是两回事,
        // 但用户搜「iMark」时通常指的是作者署名 —— 两边都放进搜索范围。
        // 括号不能省:否则 toLowerCase 只作用在第二个模板串上,作者/名称会变成
        // 大小写敏感(搜 iMark 搜不到 iMark 的扩展)
        const hay = (
          `${id} ${latest.manifest.name} ${latest.manifest.displayName ?? ''} ` +
          `${authorName(latest.manifest.author) ?? ''} ` +
          `${latest.manifest.description ?? ''} ${pkg.owner}`
        ).toLowerCase()
        if (!hay.includes(q)) continue
      }
      all.push(entryOf(id, pkg, latest))
    }

    all.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN')
      if (sort === 'downloads') return b.downloads - a.downloads
      return b.updatedAt - a.updatedAt
    })

    const start = (page - 1) * pageSize
    sendJson(res, 200, {
      total: all.length,
      page,
      pageSize,
      items: all.slice(start, start + pageSize)
    })
  })

  // ---------- 详情 ----------

  const detail = async ({ params, res }) => {
    const data = await store.readJson('packages.json', { packages: {} })
    const pkg = requirePackage(data, params.id)
    const latest = latestVersion(pkg)
    if (!latest) throw new HttpError(404, '这个扩展的所有版本都已下架', 'not_found')
    sendJson(res, 200, {
      ...entryOf(params.id, pkg, latest),
      createdAt: pkg.createdAt,
      versions: Object.values(pkg.versions)
        .map(v => ({
          version: v.version,
          integrity: v.integrity,
          publishedAt: v.publishedAt,
          yanked: Boolean(v.yanked),
          size: v.size ?? null,
          mainSha256: v.mainSha256 ?? null
        }))
        .sort((a, b) => compareVersions(b.version, a.version)),
      readme: latest.readme ?? null
    })
  }
  router.get('/api/v1/packages/:id', detail)

  router.get('/api/v1/packages/:id/latest', async ({ params, res }) => {
    const data = await store.readJson('packages.json', { packages: {} })
    const pkg = requirePackage(data, params.id)
    const latest = latestVersion(pkg)
    if (!latest) throw new HttpError(404, '这个扩展的所有版本都已下架', 'not_found')
    sendJson(res, 200, entryOf(params.id, pkg, latest))
  })

  router.get('/api/v1/packages/:id/versions/:version', async ({ params, res }) => {
    const data = await store.readJson('packages.json', { packages: {} })
    const pkg = requirePackage(data, params.id)
    const v = pkg.versions[params.version]
    if (!v) throw new HttpError(404, `没有这个版本:${params.id}@${params.version}`, 'not_found')
    sendJson(res, 200, {
      version: v.version,
      integrity: v.integrity,
      publishedAt: v.publishedAt,
      yanked: Boolean(v.yanked),
      mainSha256: v.mainSha256 ?? null,
      manifest: v.manifest
    })
  })

  // ---------- 下载 ----------

  router.get('/api/v1/packages/:id/versions/:version/download', async ({ params, res }) => {
    const data = await store.readJson('packages.json', { packages: {} })
    const pkg = requirePackage(data, params.id)
    const v = pkg.versions[params.version]
    if (!v) throw new HttpError(404, `没有这个版本:${params.id}@${params.version}`, 'not_found')

    const envelope = await store.getBlob(v.integrity)
    if (!envelope) {
      // 索引里有、blob 没了 —— 数据目录被手工动过。这种时候必须吵,不能静默 404
      console.error(`[market] 索引指向的包体缺失:${v.integrity}`)
      throw new HttpError(500, '这个版本的包体在服务端丢失了,请联系管理员', 'blob_missing')
    }

    // 计数失败不该让下载失败:先把字节发出去,再记数
    const body = Buffer.from(JSON.stringify(envelope), 'utf8')
    sendBytes(res, 200, body, 'application/json; charset=utf-8', {
      // 客户端会核对这个头;它也是用户能拿去和发布页比对的同一个值
      'x-imk-integrity': v.integrity,
      'x-imk-version': v.version,
      'content-disposition': `attachment; filename="${params.id}-${v.version}.imkpkg.json"`
    })
    await store
      .update('packages.json', { packages: {} }, d => {
        const p = d.packages[params.id]
        if (p) p.downloads = (p.downloads ?? 0) + 1
      })
      .catch(err => console.error('[market] 下载计数失败:', err.message))
  })

  // ---------- 图标 ----------

  router.get('/api/v1/packages/:id/icon', async ({ params, res }) => {
    const data = await store.readJson('packages.json', { packages: {} })
    const pkg = requirePackage(data, params.id)
    const latest = latestVersion(pkg)
    if (!latest?.iconName) throw new HttpError(404, '这个扩展没有图标', 'not_found')
    const envelope = await store.getBlob(latest.integrity)
    const b64 = envelope?.data?.[latest.iconName]
    if (typeof b64 !== 'string') throw new HttpError(404, '图标丢失了', 'not_found')
    const ext = latest.iconName.split('.').pop().toLowerCase()
    sendBytes(res, 200, Buffer.from(b64, 'base64'), ICON_MIME[ext] ?? 'application/octet-stream', {
      // 内容按 integrity 定死,可以放心让客户端长缓存
      'cache-control': 'public, max-age=86400'
    })
  })

  // ---------- 发布 ----------

  router.post(
    '/api/v1/packages',
    async ({ req, res, auth }) => {
      const user = app.requireUser(auth)
      const raw = await readJson(req, PUBLISH_BODY_LIMIT)

      // 服务端重算:上传者说的一切都只是「声称」
      const checked = validateEnvelope(raw)
      if (!checked.ok) {
        throw new HttpError(400, `扩展包校验失败:${checked.errors.slice(0, 6).join(';')}`, 'invalid_package')
      }
      const pkgValue = checked.value
      const { id, version } = pkgValue.manifest

      // **先写包体,再写索引。** 包体按 integrity 命名,写两次是幂等的;
      // 顺序反过来的话,中途失败就会留下一条指向不存在包体的索引 ——
      // 那是一种会让下载 500 的坏数据。这个顺序最坏只留下一个没人引用的孤儿文件。
      await store.putBlob(pkgValue.integrity, raw)

      const result = await store.update('packages.json', { packages: {} }, data => {
        let pkg = data.packages[id]
        if (!pkg) {
          pkg = {
            id,
            owner: user,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            downloads: 0,
            versions: {}
          }
          data.packages[id] = pkg
        } else if (pkg.owner !== user) {
          // 首次发布即认领 id;换人必须由管理员转移,不能靠「谁先动手」
          throw new HttpError(
            403,
            `扩展 id「${id}」已被 ${pkg.owner} 占用。请换一个 id,或让管理员转移所有权。`,
            'id_taken'
          )
        }
        if (pkg.versions[version]) {
          throw new HttpError(
            409,
            `版本 ${version} 已经发布过了。已发布的版本不可覆盖,请升版本号后重发。`,
            'version_exists'
          )
        }
        const latest = latestVersion(pkg)
        if (latest && compareVersions(version, latest.version) < 0) {
          // 允许补发老版本(修一条发布线),但要让作者知道「这不是最新」
          console.warn(`[market] ${id}@${version} 低于当前最新 ${latest.version},仍然接受`)
        }

        pkg.versions[version] = {
          version,
          integrity: pkgValue.integrity,
          mainSha256: pkgValue.mainSha256,
          size: pkgValue.size,
          manifest: pkgValue.manifest,
          readme: extractReadme(raw),
          iconName: pkgValue.manifest.icon ?? null,
          publishedAt: Date.now(),
          yanked: false
        }
        pkg.updatedAt = Date.now()
        return { id, version, integrity: pkgValue.integrity }
      })

      sendJson(res, 201, {
        id: result.id,
        version: result.version,
        integrity: result.integrity,
        publisher: user
      })
    },
    { limit: PUBLISH_BODY_LIMIT }
  )

  // ---------- 下架 / 恢复 ----------

  const setYank = (yanked, message) => async ({ params, res, auth }) => {
    const user = app.requireUser(auth)
    const data = await store.readJson('packages.json', { packages: {} })
    const pkg = requirePackage(data, params.id)
    if (pkg.owner !== user && !app.isAdmin(user)) {
      throw new HttpError(403, '只有扩展作者本人能下架这个版本', 'forbidden')
    }
    if (!pkg.versions[params.version]) {
      throw new HttpError(404, `没有这个版本:${params.id}@${params.version}`, 'not_found')
    }
    await store.update('packages.json', { packages: {} }, d => {
      const v = d.packages[params.id].versions[params.version]
      v.yanked = yanked
      v.yankedAt = yanked ? Date.now() : undefined
      d.packages[params.id].updatedAt = Date.now()
    })
    sendJson(res, 200, { id: params.id, version: params.version, yanked, message })
  }

  router.post('/api/v1/packages/:id/versions/:version/yank', setYank(true, '已下架'))
  router.post('/api/v1/packages/:id/versions/:version/unyank', setYank(false, '已恢复'))

  // ---------- 某个作者的包 ----------

  router.get('/api/v1/users/:username/packages', async ({ params, res }) => {
    const data = await store.readJson('packages.json', { packages: {} })
    const items = []
    for (const [id, pkg] of Object.entries(data.packages)) {
      if (pkg.owner !== params.username) continue
      const latest = latestVersion(pkg)
      if (!latest) continue
      items.push(entryOf(id, pkg, latest))
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    sendJson(res, 200, { total: items.length, page: 1, pageSize: items.length, items })
  })
}
