/**
 * pdfjs-dist 的 worker 入口没有随包的 `.d.ts`（它通常由 bundler 的 worker 语法
 * 直接引用）。webview 把它和主入口打进同一个 IIFE，通过
 * `globalThis.pdfjsWorker` 走主线程伪 worker，因此这里只需要声明具名导出。
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
