/**
 * stream-json 输出的流式行读取。
 *
 * Claude Code 的 `--output-format stream-json` 是一行一个 JSON 事件，而一行里
 * 可能塞进整份 PDF 的 base64（几十 MB）。按行整体缓冲会让内存随输出线性上涨；
 * 设一个「单行上限」又会在正常的大附件上误报。
 *
 * 这里在字符流上直接把超长字符串改写成「前缀 + 省略标记」，输出的仍然是一行
 * 合法 JSON，后续 JSON.parse 与事件归一化完全不用改。截断只发生在字符串内容上，
 * 结构、转义和换行原样保留；每行还有字符串内容总量预算，避免大量中等字符串叠加。
 *
 * 纯函数式字符处理，不 import Node / Electron，方便在验收里直接喂分块数据。
 */

export interface LineInfo {
  /** 这一行有字符串被截断；调用方据此避免回写不完整的工具输入 */
  truncated: boolean
}

export interface StreamingLineReaderOptions {
  /** 单个字符串最多保留的字符数 */
  perString?: number
  /** 一行里所有字符串内容最多保留的字符数 */
  perLine?: number
  onLine(line: string, info: LineInfo): void
}

const DEFAULT_PER_STRING = 1024 * 1024
const DEFAULT_PER_LINE = 4 * 1024 * 1024

/** 截断标记；放在被保留的前缀后面，仍然是合法的 JSON 字符串内容 */
export function truncationMarker(skipped: number): string {
  return `…[iMark 已省略 ${skipped} 字符]`
}

const MARKER_RE = /…\[iMark 已省略 (\d+) 字符\]$/

/**
 * 字符串被截断前的真实长度（包含被省略的部分）。
 *
 * 工具摘要想显示「文件有多少字符」时用它，否则截断后的长度会被当成真实值。
 */
export function originalLength(value: string): number {
  const match = MARKER_RE.exec(value)
  return match ? value.length - truncationMarker(Number(match[1])).length + Number(match[1]) : value.length
}

export class StreamingLineReader {
  private readonly perString: number
  private readonly perLine: number
  private readonly onLine: (line: string, info: LineInfo) => void

  /** 当前行已经产出的文本（只包含保留的字符串内容与 JSON 结构） */
  private out = ''
  /** 当前行保留的字符串内容字符数 */
  private keptInLine = 0
  /** 当前字符串保留的字符数 */
  private keptInString = 0

  private inString = false
  /** 上一个字符是反斜杠，下一个字符是转义内容 */
  private escaping = false
  /** 正在消费 \uXXXX 的剩余十六进制位 */
  private unicodeLeft = 0
  /** 当前转义序列属于「已保留」的前缀，必须整段复制 */
  private keepEscape = false

  private skipping = false
  private skipped = 0
  private stringTruncated = false
  private lineTruncated = false

  constructor(options: StreamingLineReaderOptions) {
    this.perString = Math.max(1, options.perString ?? DEFAULT_PER_STRING)
    this.perLine = Math.max(1, options.perLine ?? DEFAULT_PER_LINE)
    this.onLine = options.onLine
  }

  push(chunk: string): void {
    for (const char of chunk) this.feed(char)
  }

  /** 流结束：最后一行没有换行时也要交给调用方 */
  end(): void {
    if (this.out.length > 0) this.flush()
  }

  private feed(char: string): void {
    if (!this.inString) {
      if (char === '"') {
        this.beginString()
        return
      }
      if (char === '\n') {
        this.flush()
        return
      }
      this.out += char
      return
    }
    this.feedString(char)
  }

  private beginString(): void {
    this.inString = true
    this.keptInString = 0
    this.skipping = false
    this.skipped = 0
    this.escaping = false
    this.unicodeLeft = 0
    this.keepEscape = false
    this.stringTruncated = false
    this.out += '"'
  }

  private canKeep(): boolean {
    return !this.skipping && this.keptInString < this.perString && this.keptInLine < this.perLine
  }

  private beginSkip(): void {
    if (this.skipping) return
    this.skipping = true
    this.stringTruncated = true
  }

  private keep(char: string): void {
    this.out += char
    this.keptInString += char.length
    this.keptInLine += char.length
  }

  private feedString(char: string): void {
    if (this.unicodeLeft > 0) {
      this.unicodeLeft -= 1
      if (this.keepEscape) this.keep(char)
      else this.skipped += 1
      return
    }

    if (this.escaping) {
      this.escaping = false
      if (char === 'u') this.unicodeLeft = 4
      if (this.keepEscape) this.keep(char)
      else this.skipped += 1
      return
    }

    if (char === '"') {
      this.endString()
      return
    }

    if (char === '\\') {
      if (this.canKeep()) {
        this.keep(char)
        this.escaping = true
        this.keepEscape = true
      } else {
        this.beginSkip()
        this.escaping = true
        this.keepEscape = false
        this.skipped += 1
      }
      return
    }

    if (this.canKeep()) {
      this.keep(char)
    } else {
      this.beginSkip()
      this.skipped += char.length
    }
  }

  private endString(): void {
    if (this.stringTruncated) {
      // 前缀已经保留；在真正的结束引号前补上省略标记
      this.out += truncationMarker(this.skipped)
      this.lineTruncated = true
    }
    this.out += '"'
    this.inString = false
    this.skipping = false
    this.escaping = false
    this.unicodeLeft = 0
    this.keepEscape = false
  }

  private flush(): void {
    const line = this.out.endsWith('\r') ? this.out.slice(0, -1) : this.out
    const truncated = this.lineTruncated
    this.out = ''
    this.keptInLine = 0
    this.lineTruncated = false
    if (line.length > 0) this.onLine(line, { truncated })
  }
}
