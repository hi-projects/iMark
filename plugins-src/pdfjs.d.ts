/**
 * PDF.js 的 worker 入口没有随包提供类型声明，这里只声明我们用到的导出。
 * （legacy build 的 pdf.mjs 自带 pdf.d.mts，不需要额外声明。）
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
