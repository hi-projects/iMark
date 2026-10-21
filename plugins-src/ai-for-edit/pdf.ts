/**
 * 从 PDF 里提取纯文本，并把没有文字层的页面渲染成图片。
 *
 * 文本是默认路径：论文里的图、公式排版不会还原，但正文、标题、摘要足够让
 * 模型理解文档内容。扫描件没有文字层，光靠文本什么都读不到，于是把这些页面
 * 渲染成 JPEG，交给支持图像输入的模型。图片是可选的 —— 调用方按设置决定。
 *
 * render 层是被注入的普通脚本，页面的 CSP 没有 worker-src（Blob Worker 也被
 * 拦），所以这里把 PDF.js 的 worker 模块一起打进入口，并用 globalThis.pdfjsWorker
 * 让 PDF.js 走主线程伪 worker。这样不 new Worker、不动态加载 workerSrc。
 */

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs'

/** 单个 PDF 最多提取这么多字符；再长对提示词也没有意义，还会拖慢解析 */
const MAX_PDF_CHARS = 48_000
/** 最多解析这么多页，避免异常文档把渲染层拖死 */
const MAX_PDF_PAGES = 300
/** 扫描页渲染出来的长边像素；再大只会让 base64 膨胀，不会明显提高可读性 */
const MAX_IMAGE_EDGE = 1400
/** 长边最小缩到这么多；再小文字就看不清了，宁可放弃这一页 */
const MIN_IMAGE_EDGE = 480
/** 单张图片 base64 的字符上限：宿主单条 render → main 消息上限是 256 KiB */
const MAX_IMAGE_CHARS = 200_000
const JPEG_QUALITIES = [0.8, 0.68, 0.58]
type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>

export interface PdfPageImage {
  /** PDF 页码，从 1 开始 */
  page: number
  mediaType: 'image/jpeg'
  /** 不带 `data:image/jpeg;base64,` 前缀的 base64 */
  data: string
  width: number
  height: number
}

export interface PdfImageProgress {
  /** 正在处理第几页（1 起） */
  page: number
  /** 已渲染的图片数 */
  rendered: number
  /** 本次最多渲染多少张 */
  max: number
}

export interface PdfExtractOptions {
  /** 是否把没有文字层的页面渲染成图片 */
  images?: boolean
  /** 最多渲染多少张扫描页图片；0 / 未填 = 不渲染 */
  maxImages?: number
  /** 这些图片的 base64 总字符上限；未填 = maxImages × 单张上限 */
  maxImageChars?: number
  /** 开始渲染一页前的进度回调；用于界面上的「正在转换扫描页」提示 */
  onImage?: (progress: PdfImageProgress) => void
}

export interface PdfTextResult {
  /** 归一化后的正文 */
  text: string
  /** 文档总页数 */
  pages: number
  /** 实际读过的页数（受 MAX_PDF_PAGES 限制） */
  pagesRead: number
  /** 其中提取到文字的页数；0 表示大概率是扫描件 */
  pagesWithText: number
  /** 是否因为页数或字符上限被截断 */
  truncated: boolean
  /** 没有文字层、需要靠图片阅读的页（可能因为图片上限没有全部渲染） */
  scannedPages: number[]
  /** 已渲染的扫描页图片，按页码升序 */
  images: PdfPageImage[]
  /** 因为张数 / 体积上限没有渲染的扫描页数 */
  imagesSkipped: number
}

/** PDF 解析失败时抛出，message 已经是可以直接展示给用户的中文 */
export class PdfExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfExtractError'
  }
}

/** 同一份 PDF.js 只需装一次伪 worker */
let workerInstalled = false
function installPdfWorker(): void {
  if (workerInstalled) return
  ;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = {
    WorkerMessageHandler
  }
  workerInstalled = true
}

function describePdfError(err: unknown): string {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : ''
  if (name === 'PasswordException') return 'PDF 已加密，需要密码'
  if (name === 'InvalidPDFException') return 'PDF 已损坏或格式不受支持'
  if (name === 'MissingPDFException') return '读不到 PDF 内容'
  if (name === 'UnexpectedResponseException') return 'PDF 数据不完整'
  if (err instanceof Error && err.message) return err.message
  return '无法解析这个 PDF'
}

/**
 * 提取 PDF 文本，并按需把没有文字层的页面渲染成图片。
 *
 * `data` 会被复制进 PDF.js，调用方之后可以丢弃原 buffer。解析失败一律抛
 * PdfExtractError；读不出文字（扫描件）不算失败，返回 pagesWithText === 0
 * 以及渲染好的 `images`。
 */
export async function extractPdfText(
  data: ArrayBuffer,
  options: PdfExtractOptions = {}
): Promise<PdfTextResult> {
  installPdfWorker()
  const task = getDocument({
    data: new Uint8Array(data),
    // 不执行 PDF 里的脚本（CSP 也不允许），不碰系统字体与字体渲染
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  })

  let doc: Awaited<typeof task.promise>
  try {
    doc = await task.promise
  } catch (err) {
    await task.destroy().catch(() => undefined)
    throw new PdfExtractError(describePdfError(err))
  }

  try {
    const pages = doc.numPages
    const pagesRead = Math.min(pages, MAX_PDF_PAGES)
    const chunks: string[] = []
    const scannedPages: number[] = []
    const images: PdfPageImage[] = []
    const maxImages = Math.max(
      0,
      Math.min(
        Math.floor(options.maxImages ?? 0),
        Math.floor((options.maxImageChars ?? Number.MAX_SAFE_INTEGER) / 20_000)
      )
    )
    const maxImageChars = Math.max(0, Math.floor(options.maxImageChars ?? 0))
    const imagesEnabled = options.images === true && maxImages > 0 && maxImageChars > 0
    let imageChars = 0
    let imagesSkipped = 0
    let pagesWithText = 0
    let chars = 0
    let truncatedByPages = pagesRead < pages

    for (let pageNo = 1; pageNo <= pagesRead; pageNo += 1) {
      // 文字到上限后，如果还没有扫描页，就按原行为停下；已经遇到扫描页时
      // 继续往后读，把混排文档里的图片页也收进来（直到图片张数上限）。
      if (
        chars >= MAX_PDF_CHARS &&
        (!imagesEnabled || scannedPages.length === 0 || images.length >= maxImages)
      ) {
        truncatedByPages = pageNo <= pagesRead
        break
      }

      const page = await doc.getPage(pageNo)
      try {
        const content = await page.getTextContent()
        const text = layoutPageText(content.items)
        if (text.trim()) {
          pagesWithText += 1
          if (chars < MAX_PDF_CHARS) {
            chunks.push(text)
            chars += text.length + 2
          }
        } else {
          scannedPages.push(pageNo)
          const remaining = maxImageChars - imageChars
          if (imagesEnabled && images.length < maxImages && remaining >= 20_000) {
            options.onImage?.({ page: pageNo, rendered: images.length, max: maxImages })
            const image = await renderPageImage(
              page,
              pageNo,
              Math.min(MAX_IMAGE_CHARS, remaining)
            )
            if (image) {
              images.push(image)
              imageChars += image.data.length
            } else {
              imagesSkipped += 1
            }
          } else {
            imagesSkipped += 1
          }
        }
      } finally {
        page.cleanup()
      }
    }

    let text = normalizeText(chunks.join('\n\n'))
    if (text.length > MAX_PDF_CHARS) {
      text = normalizeText(text.slice(0, MAX_PDF_CHARS))
      truncatedByPages = true
    }
    return {
      text,
      pages,
      pagesRead,
      pagesWithText,
      truncated: truncatedByPages,
      scannedPages,
      images,
      imagesSkipped
    }
  } catch (err) {
    if (err instanceof PdfExtractError) throw err
    throw new PdfExtractError(describePdfError(err))
  } finally {
    await task.destroy().catch(() => undefined)
  }
}

/**
 * 把一页 PDF 画到 canvas 再压成 JPEG。
 *
 * 先按长边 1400px 渲染，base64 超过上限时缩小画布重编码（不重新解析 PDF，
 * 直接把已渲染的画布 drawImage 到更小的画布上）。仍然放不下就放弃这一页 ——
 * 一张看不清的图对模型没有价值，还会白占消息与请求体积。
 */
async function renderPageImage(
  page: PdfPage,
  pageNo: number,
  maxChars: number
): Promise<PdfPageImage | null> {
  try {
    const natural = page.getViewport({ scale: 1 })
    const longest = Math.max(natural.width, natural.height)
    const scale = Math.max(0.5, Math.min(2, MAX_IMAGE_EDGE / Math.max(longest, 1)))
    const viewport = page.getViewport({ scale })

    let canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    await page.render({ canvas, viewport, background: '#ffffff' }).promise

    let quality = JPEG_QUALITIES[0] ?? 0.8
    let data = stripDataUrl(canvas.toDataURL('image/jpeg', quality))

    // 最多缩四轮；每轮按超出比例缩边，同时降一点 JPEG 质量。
    for (let attempt = 1; data.length > maxChars && attempt < 5; attempt += 1) {
      const shrink = Math.min(0.85, Math.max(0.55, Math.sqrt(maxChars / data.length) * 0.95))
      const width = Math.max(1, Math.round(canvas.width * shrink))
      const height = Math.max(1, Math.round(canvas.height * shrink))
      if (Math.max(width, height) < MIN_IMAGE_EDGE) break

      const smaller = document.createElement('canvas')
      smaller.width = width
      smaller.height = height
      const context = smaller.getContext('2d')
      if (!context) break
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
      context.drawImage(canvas, 0, 0, width, height)
      releaseCanvas(canvas)
      canvas = smaller
      quality = JPEG_QUALITIES[attempt] ?? 0.58
      data = stripDataUrl(canvas.toDataURL('image/jpeg', quality))
    }

    const width = canvas.width
    const height = canvas.height
    releaseCanvas(canvas)
    if (data.length > maxChars) return null
    return { page: pageNo, mediaType: 'image/jpeg', data, width, height }
  } catch {
    // 单页渲染失败不该让整份 PDF 失败：跳过这一页，文本部分照常可用
    return null
  }
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(',')
  if (comma < 0 || !value.slice(0, comma).startsWith('data:image/jpeg;base64')) {
    throw new PdfExtractError('无法把扫描页转换成图片')
  }
  return value.slice(comma + 1)
}

/** 尽早释放 canvas 的像素缓冲；大页面一张就是十几 MB */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

interface TextChunk {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL: boolean
}

/**
 * 把一页的文本片段还原成行。
 *
 * PDF 的 `getTextContent()` 给的是一堆带坐标的片段，不一定带换行。这里按
 * 纵向位置断行，用片段之间的水平间隙补空格（PDF 有时不编码普通空格），
 * 并在行距明显变大时保留空行（段落、标题）。
 */
function layoutPageText(items: readonly unknown[]): string {
  let out = ''
  let lineOpen = false
  let pendingBreak = false
  let lastY: number | null = null
  let lastH = 10
  let prevEndX: number | null = null

  const endLine = (): void => {
    if (!lineOpen) return
    out = out.replace(/[ \t]+$/g, '')
    out += '\n'
    lineOpen = false
    prevEndX = null
  }

  const blankLine = (): void => {
    if (!out) return
    if (!out.endsWith('\n')) out += '\n'
    if (!out.endsWith('\n\n')) out += '\n'
  }

  for (const raw of items) {
    const chunk = raw as Partial<TextChunk>
    if (typeof chunk.str !== 'string') continue
    const str = chunk.str
    const transform = Array.isArray(chunk.transform) ? chunk.transform : []
    const x = typeof transform[4] === 'number' ? transform[4] : null
    const y = typeof transform[5] === 'number' ? transform[5] : null
    const h = typeof chunk.height === 'number' && chunk.height > 0 ? chunk.height : lastH

    if ((lineOpen || pendingBreak) && lastY !== null && y !== null) {
      const dy = Math.abs(y - lastY)
      const lineHeight = Math.max(lastH, h)
      // 片段不在同一基线上：换行。行距超过 1.5 倍字高时，保留一个空行表示段落。
      if (pendingBreak || dy > lineHeight * 0.6) {
        endLine()
        if (dy > lineHeight * 1.5) blankLine()
        pendingBreak = false
      }
    } else if (pendingBreak) {
      endLine()
      pendingBreak = false
    }

    if (str) {
      if (
        lineOpen &&
        x !== null &&
        prevEndX !== null &&
        !/\s$/.test(out) &&
        !/^\s/.test(str)
      ) {
        const sameLine = lastY === null || y === null || Math.abs(y - lastY) <= Math.max(lastH, h) * 0.6
        const gap = x - prevEndX
        // 只补真正的词间距；中文相邻片段之间不插空格，避免把句子撑开。
        if (sameLine && gap > Math.max(h * 0.2, 1.2)) {
          const left = out.slice(-1)
          const right = str.charAt(0)
          if (!isCjk(left) && !isCjk(right)) out += ' '
        }
      }
      out += str
      lineOpen = true
    }

    if (chunk.hasEOL === true) {
      endLine()
      pendingBreak = true
      prevEndX = null
    } else if (str) {
      prevEndX =
        x !== null && typeof chunk.width === 'number' ? x + chunk.width : null
    }

    if (y !== null) lastY = y
    lastH = h
  }

  endLine()
  return out
}

function isCjk(char: string): boolean {
  return /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u000c/g, '\n')
    // PDF 里可能夹着控制字符；保留换行与制表符，其余扔掉
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
