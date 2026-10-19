/**
 * 粘贴图片的资产命名规则 —— 主进程(生成)与渲染层(识别引用)、主进程(复核)
 * 共用同一份,避免「写文件的地方」与「清文件的地方」对不上。
 *
 * `saveImageAsset` 只写 `image-YYYYMMDD-HHMMSS-xxxxxxxx.<ext>` 这种名字;自动
 * 清理也只认它:`assets/` 是文档目录里的普通文件夹,用户自己放进去的文件不能
 * 因为正文里恰好没有同名引用就被回收。
 */

/**
 * 格式表与 `main/files.ts` 的 `IMAGE_EXT` 保持一致 —— 那里决定扩展名,
 * 这里决定哪些名字算「本应用生成的资产」。加格式时两处一起改。
 */
const ASSET_NAME = String.raw`image-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpg|gif|webp|bmp)`

/** 校验一个**文件名**(不含目录)是否是本应用生成的图片资产 */
export function isManagedImageName(name: string): boolean {
  return new RegExp(`^${ASSET_NAME}$`).test(name)
}

/**
 * 从文档内容里取出指向 `assets/` 的受管图片文件名。
 *
 * 按文件名而不是完整 Markdown 语法来扫:文件名自带 8 位随机后缀,足以唯一定位;
 * 这样引用式图片、HTML `<img>` 等写法也能一并覆盖。返回集合用于比较保存前后
 * 的差异。
 */
export function managedImageRefs(text: string): Set<string> {
  // `\bassets` 挡住 `xassets/` 这类前缀;目录分隔符两种都认(正文里统一写 `/`,
  // 但用户手改时可能留下 `\`)
  const re = new RegExp(String.raw`\bassets[\\/](${ASSET_NAME})\b`, 'g')
  const refs = new Set<string>()
  for (const match of text.matchAll(re)) {
    if (match[1]) refs.add(match[1])
  }
  return refs
}
