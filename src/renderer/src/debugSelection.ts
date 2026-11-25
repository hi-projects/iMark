/**
 * 临时诊断:在 dev 窗口右下角显示编辑器选区与每一行的 class / 高度。
 * 排查「选中无法编辑的空行」用,定位后删除。
 *
 * 默认隐藏,F12 才显示 —— F12 是原生菜单里的「开发者工具」快捷键,主进程
 * 在打开 DevTools 的同时会发一条 `view:toggle-selection-debug` 菜单命令过来。
 */
import { api } from './services/api'

const box = document.createElement('pre')
box.id = 'imark-debug-selection'
box.style.cssText = [
  'position:fixed',
  'right:8px',
  'bottom:8px',
  'z-index:99999',
  'max-width:calc(100vw - 16px)',
  'max-height:38vh',
  'overflow:auto',
  'margin:0',
  'padding:8px 10px',
  'border-radius:6px',
  'background:rgba(0,0,0,.82)',
  'color:#6f6',
  'font:11px/1.45 Consolas,monospace',
  'white-space:pre-wrap',
  'pointer-events:none',
  // 默认不显示:按 F12 才打开
  'display:none'
].join(';')
document.body.appendChild(box)

let visible = false

function render(): void {
  const content = document.querySelector<HTMLElement & { cmTile?: { root?: { view?: unknown } } }>(
    '.cm-content'
  )
  const view = content?.cmTile?.root?.view as
    | {
        state: {
          selection: { main: { empty: boolean; anchor: number; head: number; from: number; to: number } }
          doc: { sliceString(from: number, to: number): string; lineAt(pos: number): { number: number } }
        }
      }
    | undefined
  if (!view) return
  const sel = view.state.selection.main
  const lines = [...document.querySelectorAll<HTMLElement>('.cm-content .cm-line')]
  const head = lines.map((el, i) => {
    const r = el.getBoundingClientRect()
    return `${i} ${JSON.stringify(el.textContent ?? '')} h=${Math.round(r.height)} y=${Math.round(r.top)} [${el.className}]`
  })
  const snap = (window as unknown as { __imarkSnapDebug?: unknown }).__imarkSnapDebug
  box.textContent =
    `sel empty=${sel.empty} ${sel.anchor}->${sel.head} from/to=${sel.from}/${sel.to}\n` +
    `text=${JSON.stringify(view.state.doc.sliceString(sel.from, sel.to))}\n` +
    `snap=${JSON.stringify(snap)}\n` +
    head.join('\n')
}

function toggle(): void {
  visible = !visible
  box.style.display = visible ? 'block' : 'none'
  if (visible) render()
}

api.onMenuCommand(id => {
  if (id === 'view:toggle-selection-debug') toggle()
})

window.setInterval(() => {
  if (visible) render()
}, 300)

export {}
