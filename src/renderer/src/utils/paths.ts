/**
 * 仓库内路径判断(跨平台)。
 *
 * Windows 用 `\`、Linux/macOS 用 `/`,这里两种都认 —— 之前把分隔符写死成
 * `parent + '\\'`,在 Linux 上会导致"文件是否在仓库内"永远为假:快速切换器里
 * 算不出仓库内相对路径、上次打开的文件不会自动恢复、重命名/删除时也认不出当前文件。
 */

/** 去掉末尾的分隔符,便于做前缀比较 */
function stripEnd(path: string): string {
  return path.replace(/[\\/]+$/, '')
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
