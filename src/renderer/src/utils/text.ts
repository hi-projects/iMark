export interface TextStats {
  words: number
  chars: number
  lines: number
}

/** 字数统计:中文等表意文字按字符计数,拉丁/数字按词计数 */
export function computeStats(text: string): TextStats {
  const chars = Array.from(text).length
  let words = (text.match(/[A-Za-z0-9'’\-]+/g) ?? []).length
  words += (text.match(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu) ?? [])
    .length
  const lines = text.length === 0 ? 1 : text.split('\n').length
  return { words, chars, lines }
}

/** 解析图片 src:本地相对路径 → imark:// 协议 URL,http(s)/data 原样返回 */
export function resolveImageSrc(src: string, docDir: string | null): string {
  if (!src) return src
  if (/^(https?:|data:|imark:|blob:)/i.test(src)) return src
  if (src.startsWith('//')) return 'https:' + src
  if (!docDir) return src
  const base = docDir.replace(/[\\/]+$/, '')
  const rel = src.replace(/^[\\/]+/, '')
  return 'imark://img/' + encodeURIComponent(`${base}\\${rel}`)
}

/** 按 eol 约定转换行尾(内部统一 LF 存储,保存时还原) */
export function toEol(text: string, eol: 'LF' | 'CRLF'): string {
  const lf = text.replace(/\r\n/g, '\n')
  return eol === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf
}

export function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '')
}

/** 文件大小的人类可读写法(市场包、自定义样式文件都用它) */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

export function stripMarkdownExt(name: string): string {
  return name.replace(/\.(md|markdown|mdown|txt)$/i, '')
}
