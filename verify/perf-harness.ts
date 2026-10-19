/**
 * 表格存在时的输入延迟诊断(不是功能验收,暂时用于定位问题)。
 *
 * 用生产构建跑,把 EditorView 从渲染进程里取出来(CodeMirror 在每个 DOM
 * 节点上挂了 cmTile,`cmTile.root.view` 就是 EditorView),然后直接派发
 * 与打字等价的 transaction,量三类成本:
 *
 *   1. 同步 dispatch 耗时(装饰重建 + widget 更新 + DOM 写入);
 *   2. 带一帧等待的 dispatch 耗时(把 CM 的 measure/layout 也算进来);
 *   3. 期间 `.cm-md-table-widget` 的 DOM 新建/移除次数
 *      (为 0 说明走了 updateDOM 就地刷新;不为 0 说明整块 DOM 被重建)。
 *
 * 对比四种场景:
 *   A 无表格(基线)
 *   B 在表格**上方**打字(插入点之前有表 → widget 位置变化)
 *   C 在表格**下方**打字(表位置不变)
 *   D 大表格 + 下方打字
 *   E 仅移动光标(不改文档)但在表格附近
 *
 * 跑法(后台,不弹窗):
 *   xvfb-run -a -s "-screen 0 1600x1000x24" env -u ELECTRON_RUN_AS_NODE \
 *     node verify/run.mjs perf
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

interface Stats {
  p50: number
  p95: number
  max: number
  avg: number
  added: number
  removed: number
  created: number
  reattached: number
  count: number
}

function table(rows: number, cols: number): string {
  const head = `| ${Array.from({ length: cols }, (_, i) => `H${i}`).join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
  const body = Array.from(
    { length: rows - 1 },
    (_, r) => `| ${Array.from({ length: cols }, (_, c) => `r${r}c${c}`).join(' | ')} |`
  )
  return [head, sep, ...body].join('\n')
}

function paras(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i} 的内容内容内容内容内容内容内容`)
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs perf` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '性能.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await writeFile(note, paras('正文', 30).join('\n') + '\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    void wc.loadFile(join(__dirname, '../renderer/index.html'))
    await done
    await sleep(1200)
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(150)
  }

  /**
   * 在渲染进程里跑一轮基准。
   * marker:插入点所在行的行内文本片段;frame=true 时每个按键后等一帧。
   */
  async function bench(marker: string, n: number, frame: boolean, moveOnly = false): Promise<Stats> {
    const script = `
      (async () => {
        const content = document.querySelector('.cm-content')
        const view = content && content.cmTile && content.cmTile.root && content.cmTile.root.view
        if (!view) return { error: 'no view' }
        const doc = view.state.doc
        let lineNo = -1
        for (let i = 1; i <= doc.lines; i++) {
          if (doc.line(i).text.includes(${JSON.stringify(marker)})) { lineNo = i; break }
        }
        if (lineNo < 0) return { error: 'marker not found: ' + ${JSON.stringify(marker)} }
        const base = doc.line(lineNo).from
        // 滚到行附近,保证表格与插入点都在视口里
        view.dispatch({ selection: { anchor: base }, scrollIntoView: true })
        await new Promise(r => requestAnimationFrame(() => r()))

        const added = { n: 0 }
        const removed = { n: 0 }
        const created = { n: 0 }
        const reattached = { n: 0 }
        const widgetOf = node =>
          node.nodeType === 1
            ? (node.matches?.('.cm-md-table-widget') ? node : node.querySelector?.('.cm-md-table-widget'))
            : null
        const seen = new WeakSet()
        const mo = new MutationObserver(muts => {
          for (const m of muts) {
            m.addedNodes.forEach(node => {
              const w = widgetOf(node)
              if (!w) return
              added.n++
              if (seen.has(w)) reattached.n++
              else { seen.add(w); created.n++ }
            })
            m.removedNodes.forEach(node => { if (widgetOf(node)) removed.n++ })
          }
        })
        mo.observe(content, { childList: true, subtree: true })

        const raf = () => new Promise(r => requestAnimationFrame(() => r()))
        const times = []
        let at = base
        for (let i = 0; i < ${n}; i++) {
          const t0 = performance.now()
          if (${moveOnly}) {
            const next = at + (i % 2 === 0 ? 1 : -1)
            view.dispatch({ selection: { anchor: next } })
          } else {
            view.dispatch({
              changes: { from: at, insert: 'x' },
              selection: { anchor: at + 1 }
            })
            at += 1
          }
          const t1 = performance.now()
          times.push(t1 - t0)
          if (${frame}) await raf()
        }
        // 等一轮 frame,让异步 layout/measure 落定后再读计数
        await raf()
        await raf()
        mo.disconnect()
        times.sort((a, b) => a - b)
        const sum = times.reduce((a, b) => a + b, 0)
        const pick = p => times[Math.min(times.length - 1, Math.floor(times.length * p))]
        return {
          p50: +pick(0.5).toFixed(2),
          p95: +pick(0.95).toFixed(2),
          max: +times[times.length - 1].toFixed(2),
          avg: +(sum / times.length).toFixed(2),
          added: added.n,
          removed: removed.n,
          created: created.n,
          reattached: reattached.n,
          count: ${n}
        }
      })()
    `
    return evalJs<Stats>(script)
  }

  function report(label: string, s: Stats): void {
    console.log(
      `  ${label.padEnd(46)} p50=${String(s.p50).padStart(6)}ms  p95=${String(s.p95).padStart(
        7
      )}ms  max=${String(s.max).padStart(7)}ms  avg=${String(s.avg).padStart(6)}ms  ` +
        `widget +${s.added}/-${s.removed} created=${s.created} reattached=${s.reattached}`
    )
  }

  // ---------- 真实按键路径:char 事件 + 帧间隔 ----------

  interface NativeStats {
    inputs: number
    frames: number
    p50: number
    p95: number
    max: number
    over50: number
    measures: number
    widgetsAdded: number
    widgetsRemoved: number
    widgetsCreated: number
    widgetsReattached: number
    long: number[]
    error?: string
  }

  const startInstrument = (): Promise<boolean> =>
    evalJs<boolean>(`
      (() => {
        const content = document.querySelector('.cm-content')
        const view = content && content.cmTile && content.cmTile.root && content.cmTile.root.view
        if (!view) return false
        const p = window.__perf = {
          measures: 0, inputs: 0, widgetsAdded: 0, widgetsRemoved: 0,
          widgetsCreated: 0, widgetsReattached: 0,
          frames: [], long: [], running: true
        }
        const orig = view.requestMeasure.bind(view)
        view.requestMeasure = (...args) => { p.measures++; return orig(...args) }
        content.addEventListener('input', () => { p.inputs++ }, true)
        const widgetOf = n =>
          n.nodeType === 1
            ? (n.matches?.('.cm-md-table-widget') ? n : n.querySelector?.('.cm-md-table-widget'))
            : null
        // 同一个节点被重新挂载(复用)和真正新建要分清:前者只值一次 DOM 移动
        const seen = new WeakSet()
        const mo = new MutationObserver(ms => {
          for (const m of ms) {
            m.addedNodes.forEach(n => {
              const w = widgetOf(n)
              if (!w) return
              p.widgetsAdded++
              if (seen.has(w)) p.widgetsReattached++
              else { seen.add(w); p.widgetsCreated++ }
            })
            m.removedNodes.forEach(n => { if (widgetOf(n)) p.widgetsRemoved++ })
          }
        })
        mo.observe(content, { childList: true, subtree: true })
        p.stop = () => { p.running = false; mo.disconnect() }
        let last = performance.now()
        const tick = now => {
          p.frames.push(now - last)
          last = now
          if (p.running) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) p.long.push(e.duration)
          }).observe({ entryTypes: ['longtask'] })
        } catch {}
        return true
      })()`)

  const readInstrument = (): Promise<NativeStats> =>
    evalJs<NativeStats>(`
      (() => {
        const p = window.__perf
        if (!p) return { error: 'no instrument' }
        p.stop()
        const all = p.frames.slice(2)
        const frames = all.slice().sort((a, b) => a - b)
        const pick = q => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))] || 0
        return {
          inputs: p.inputs,
          frames: frames.length,
          p50: +pick(0.5).toFixed(1),
          p95: +pick(0.95).toFixed(1),
          max: +(frames[frames.length - 1] || 0).toFixed(1),
          over50: all.filter(f => f > 50).length,
          measures: p.measures,
          widgetsAdded: p.widgetsAdded,
          widgetsRemoved: p.widgetsRemoved,
          widgetsCreated: p.widgetsCreated,
          widgetsReattached: p.widgetsReattached,
          long: p.long.map(d => Math.round(d))
        }
      })()`)

  function reportNative(label: string, s: NativeStats): void {
    console.log(
      `  ${label.padEnd(46)} 帧 p50=${String(s.p50).padStart(5)}ms p95=${String(s.p95).padStart(
        6
      )}ms max=${String(s.max).padStart(6)}ms >50ms=${String(s.over50).padStart(2)}  ` +
        `input=${s.inputs} measure=${s.measures} widget added=${s.widgetsAdded} removed=${s.widgetsRemoved} ` +
        `created=${s.widgetsCreated} reattached=${s.widgetsReattached} long=[${s.long.join(',')}]`
    )
  }

  /** 真实 char 按键(和用户打字同一条路径) */
  async function typeChars(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      wc.sendInputEvent({ type: 'char', keyCode: 'x' })
      await sleep(16)
    }
    await sleep(500)
  }

  /** 点进某个渲染表格单元格(真鼠标) */
  async function clickCell(row: number, col: number): Promise<boolean> {
    const spot = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const cell = document.querySelector('.cm-md-table-widget th[data-row="${row}"][data-col="${col}"], .cm-md-table-widget td[data-row="${row}"][data-col="${col}"]')
        if (!cell) return null
        const r = cell.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!spot) return false
    wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await sleep(350)
    return evalJs<boolean>(
      `!!document.activeElement?.closest?.('.cm-md-table-widget [contenteditable]')`
    )
  }

  /** 把 CM 选区放到含 marker 的那一行并聚焦(用于真实按键的对照) */
  async function focusLine(marker: string): Promise<boolean> {
    return evalJs<boolean>(`
      (() => {
        const content = document.querySelector('.cm-content')
        const view = content && content.cmTile && content.cmTile.root && content.cmTile.root.view
        if (!view) return false
        for (let i = 1; i <= view.state.doc.lines; i++) {
          if (view.state.doc.line(i).text.includes(${JSON.stringify(marker)})) {
            view.dispatch({ selection: { anchor: view.state.doc.line(i).from }, scrollIntoView: true })
            view.focus()
            return true
          }
        }
        return false
      })()`)
  }

  console.log('\n【A】无表格(基线)')
  await loadDoc(paras('正文', 30).join('\n') + '\n')
  report('同步 dispatch ×40', await bench('正文 15', 40, false))
  report('dispatch + 一帧 ×20', await bench('正文 15', 20, true))

  console.log('\n【B】在表格上方打字(表格 8 行 × 4 列,位于插入点之后)')
  await loadDoc(
    ['表前标题', '', table(8, 4), '', ...paras('表后正文', 24), ''].join('\n')
  )
  report('同步 dispatch ×40', await bench('表前标题', 40, false))
  report('dispatch + 一帧 ×20', await bench('表前标题', 20, true))

  console.log('\n【C】在表格下方打字(表格 8 行 × 4 列,位于插入点之前)')
  await loadDoc([table(8, 4), '', ...paras('表后正文', 28), ''].join('\n'))
  report('同步 dispatch ×40', await bench('表后正文 10', 40, false))
  report('dispatch + 一帧 ×20', await bench('表后正文 10', 20, true))

  console.log('\n【D】较大的表格(15 行 × 6 列)下方打字')
  await loadDoc([table(15, 6), '', ...paras('表后正文', 28), ''].join('\n'))
  report('同步 dispatch ×40', await bench('表后正文 10', 40, false))
  report('dispatch + 一帧 ×20', await bench('表后正文 10', 20, true))

  console.log('\n【E】仅移动光标(不改文档,表格在视口里)')
  await loadDoc([table(8, 4), '', ...paras('表后正文', 28), ''].join('\n'))
  report('同步 selection ×60', await bench('表后正文 10', 60, false, true))
  report('selection + 一帧 ×30', await bench('表后正文 10', 30, true, true))

  console.log('\n【F】表格上方:仅移动光标')
  await loadDoc(['表前标题', '', table(8, 4), '', ...paras('表后正文', 24), ''].join('\n'))
  report('同步 selection ×60', await bench('表前标题', 60, false, true))

  console.log('\n【G】真实按键:光标在渲染表格的单元格里(10 行 × 4 列)')
  await loadDoc([table(10, 4), '', ...paras('表后正文', 28), ''].join('\n'))
  check('点进了第一个正文单元格', await clickCell(1, 0))
  await startInstrument()
  await typeChars(30)
  reportNative('格子里打 30 个字符', await readInstrument())

  console.log('\n【H】真实按键:同一文档,光标在表格下方正文(对照)')
  await loadDoc([table(10, 4), '', ...paras('表后正文', 28), ''].join('\n'))
  check('光标放到表格下方正文', await focusLine('表后正文 10'))
  await startInstrument()
  await typeChars(30)
  reportNative('正文里打 30 个字符', await readInstrument())

  console.log('\n【I】真实按键:表格下方有正文,光标在表格上方打字(每次按键重建 widget)')
  await loadDoc(['表前标题', '', table(8, 4), '', ...paras('表后正文', 24), ''].join('\n'))
  check('光标放到表格上方正文', await focusLine('表前标题'))
  await startInstrument()
  await typeChars(30)
  reportNative('表格上方打 30 个字符', await readInstrument())

  console.log('\n结果:见上(耗时单位 ms;widget +/- 是 DOM 新建/移除次数)')
  console.log(`步骤检查:${pass} 通过,${fail} 失败`)
}

void main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => {
    setTimeout(() => app.exit(0), 200)
  })
