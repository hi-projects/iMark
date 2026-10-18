/**
 * 笔记引用面板 —— **restricted main + render 两层**样板。
 *
 * main 层跑在隐藏执行页(无 Node),负责所有仓库读取;render 层跑在主窗口里,
 * 负责界面与插入。两层只传消息,不传能力。
 */

const imk = window.imark

const CHUNK_CHARS = 200_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function maxPreview(): number {
  const n = Number(imk.getConfig().maxPreview ?? 2000)
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 200), 20000) : 2000
}

function vault(): NonNullable<typeof imk.vault> {
  if (!imk.vault) throw new Error('这个插件没有 vault:read 权限')
  return imk.vault
}

/** 递归收集 .md(vault.list 只给一层,这里自己往下走) */
async function collectNotes(dir = '', depth = 0): Promise<string[]> {
  if (depth > 4) return []
  const entries = await vault().list(dir === '' ? undefined : dir)
  const out: string[] = []
  for (const entry of entries) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.dir) out.push(...(await collectNotes(path, depth + 1)))
    else if (/\.(md|markdown)$/i.test(entry.name)) out.push(path)
  }
  return out.sort()
}

function sendPreview(path: string, text: string): void {
  const limit = maxPreview()
  imk.render?.send('preview', {
    path,
    text: text.length > limit ? `${text.slice(0, limit)}\n\n…(已截断)` : text
  })
}

/**
 * 全文可能超过单条消息 256 KiB 的上限 —— 分块发送,render 层收齐后再插入。
 */
function sendChunks(path: string, text: string): void {
  const total = Math.max(1, Math.ceil(text.length / CHUNK_CHARS))
  imk.render?.send('note.start', { path, total })
  for (let index = 0; index < total; index += 1) {
    imk.render?.send('note.chunk', {
      path,
      index,
      total,
      text: text.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS)
    })
  }
  imk.render?.send('note.end', { path, total })
}

imk.plugin.handle({
  onEnable() {
    imk.setState({ status: 'ok', lastMessage: '面板就绪' })
  },

  async runAction(actionId) {
    if (actionId !== 'toggle') return { ok: false, message: `未知动作:${actionId}` }
    imk.render?.send('toggle', null)
    return { ok: true, message: '面板已切换' }
  }
})

imk.render?.onMessage(async (channel, data) => {
  try {
    const payload = (data ?? {}) as Record<string, unknown>
    if (channel === 'list') {
      const notes = await collectNotes('')
      imk.render?.send('notes', notes)
      return
    }
    if (channel === 'read') {
      const path = String(payload.path ?? '')
      if (!path) throw new Error('缺少 path')
      const { text } = await vault().read(path)
      if (payload.mode === 'full') sendChunks(path, text)
      else sendPreview(path, text)
    }
  } catch (err) {
    imk.render?.send('error', { message: errorMessage(err) })
  }
})

export {}
