/**
 * 仓库内路径判断与拼接(跨平台)。
 *
 * Windows 用 `\`、Linux/macOS 用 `/`,这里两种都认。写死成 `parent + '\\'` 会让
 * Linux 上"文件是否在仓库内"永远为假:快速切换器算不出仓库内相对路径、上次打开的
 * 文件不会自动恢复、重命名/删除时也认不出当前文件。
 *
 * 拼接同理:分隔符一律**看路径本身**,不看平台 —— `\` 在 Linux 上只是文件名的
 * 一个普通字符,拼错了不会报错,只会在仓库外面凭空多出一个名字带反斜杠的文件。
 */

/** 去掉末尾的分隔符,便于做前缀比较 */
function stripEnd(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/** 这个路径该用哪种分隔符:含 `/` 就当 POSIX,否则看它有没有反斜杠,都没有就按 POSIX */
function sepOf(path: string): string {
  if (path.includes('/')) return '/'
  return path.includes('\\') ? '\\' : '/'
}

/** 把 name 拼到父目录下(绝对路径由对话框/文件树给出,这里只管分隔符) */
export function joinPath(parent: string, name: string): string {
  const base = stripEnd(parent)
  if (!base) return name
  return base + sepOf(base) + name
}

/** 替换路径的最后一段(`/a/b.md` + `c.md` → `/a/c.md`),原分隔符原样保留 */
export function replaceName(path: string, name: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? name : path.slice(0, i + 1) + name
}

/** child 是否就是 parent 本身,或位于其下(注意 `C:\a` 不包含 `C:\ab`) */
export function isInside(parent: string, child: string): boolean {
  if (!parent || !child) return false
  const base = stripEnd(parent)
  return child === base || child.startsWith(base + '/') || child.startsWith(base + '\\')
}

/** child 相对于 parent 的路径;不在其下时返回 null */
export function relativeTo(parent: string, child: string): string | null {
  if (!isInside(parent, child)) return null
  const base = stripEnd(parent)
  return child.slice(base.length).replace(/^[\\/]+/, '')
}
