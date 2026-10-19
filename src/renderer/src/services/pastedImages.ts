/**
 * 本次会话里由粘贴创建、还没有随着任何一次保存进入正文的图片资产。
 *
 * 为什么不能只比较保存前后的正文:粘贴是「先把文件写进 assets/,再往正文插图」。
 * 用户在第一次保存前就把链接删掉时,这张图从未出现在任何一份「保存前正文」里,
 * 按前后对比永远发现不了,只能单独记账。
 *
 * 键是文档的绝对路径 —— 图片落在谁的目录里,就由谁保存时结算。
 */
const pending = new Map<string, Set<string>>()

/** 记下一张刚写盘的粘贴图片(relPath 形如 `assets/image-…png`) */
export function notePastedImage(docPath: string, relPath: string): void {
  const name = relPath.replace(/^.*[\\/]/, '')
  if (!name) return
  let names = pending.get(docPath)
  if (!names) pending.set(docPath, (names = new Set()))
  names.add(name)
}

/**
 * 取走某份文档的记账(在它成功写盘之后调用)。
 *
 * 取出即清空:从这次保存起,正文里的引用已经落盘,以后删掉它由「保存前后比较」
 * 负责;仍留在正文里的也应交给 diff,不必再惦记。
 */
export function takePastedImages(docPath: string): Set<string> {
  const names = pending.get(docPath)
  pending.delete(docPath)
  return names ?? new Set()
}
