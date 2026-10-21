/**
 * 浮动小人 webview。
 *
 * 这是一个独立的小面板（floating + transparent），只画一个形象；点击后请扩展
 * 宿主打开对话面板。形象由 `characterStyle` 配置决定，配置变化时扩展会推送
 * `{type:'config'}` 更新，不需要重建整个页面。
 */

import { characterStyleFrom, fillAvatar, type CharacterStyle } from '../characters'
import {
  announceReady,
  applyTheme,
  postPanelDragEnd,
  postPanelDragMove,
  postPanelDragStart,
  postToHost,
  readBootstrap
} from './shared'

const bootstrap = readBootstrap()
let style: CharacterStyle = characterStyleFrom(bootstrap.config.characterStyle)

const styleEl = document.createElement('style')
styleEl.textContent = `
html, body {
  margin: 0; padding: 0; width: 100%; height: 100%;
  background: transparent; overflow: hidden;
}
body {
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-editor, sans-serif);
  -webkit-user-select: none; user-select: none;
}
.ai-char {
  position: relative;
  width: 76px; height: 88px; padding: 0;
  border: none; background: transparent;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  animation: ai-char-float 3.2s ease-in-out infinite;
}
.ai-char:focus-visible { outline: 2px solid var(--accent, #4a9eff); outline-offset: 3px; border-radius: 50%; }
.ai-char-emoji {
  font-size: 42px; line-height: 1;
  animation: ai-char-wiggle 4.2s ease-in-out infinite;
  pointer-events: none;
}
.ai-char-emoji svg {
  width: 72px; height: 72px; display: block;
  filter: drop-shadow(0 4px 5px rgba(0, 0, 0, .28));
}
.ai-penguin-eye {
  transform-box: fill-box; transform-origin: center;
  animation: ai-penguin-blink 4.2s infinite;
}
.ai-penguin-flipper {
  transform-box: view-box; transform-origin: 16px 32px;
  animation: ai-penguin-wave 2.8s ease-in-out infinite;
}
@keyframes ai-penguin-blink {
  0%, 92%, 100% { transform: scaleY(1) }
  95% { transform: scaleY(.08) }
}
@keyframes ai-penguin-wave {
  0%, 100% { transform: rotate(0) }
  50% { transform: rotate(-22deg) }
}
@keyframes ai-char-float { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
@keyframes ai-char-wiggle { 0%, 100% { transform: rotate(-5deg) } 50% { transform: rotate(5deg) } }
`
document.head.append(styleEl)

const button = document.createElement('button')
button.type = 'button'
button.className = 'ai-char'
const avatar = document.createElement('span')
avatar.className = 'ai-char-emoji'
button.append(avatar)
document.body.append(button)

function render(): void {
  fillAvatar(avatar, style)
  button.setAttribute('aria-label', `和${style.label}聊聊`)
  button.title = `和${style.label}聊聊`
}

let pressing = false
let moved = false
let pressX = 0
let pressY = 0
let suppressClick = false

button.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  pressing = true
  moved = false
  suppressClick = false
  pressX = event.clientX
  pressY = event.clientY
  // 指针移出 iframe 后由宿主接管；宿主也会在没移动时把事件当点击处理
  postPanelDragStart(event.clientX, event.clientY)
})

button.addEventListener('pointermove', event => {
  if (!pressing) return
  if (!moved && Math.hypot(event.clientX - pressX, event.clientY - pressY) > 4) {
    moved = true
    suppressClick = true
  }
  postPanelDragMove(event.clientX, event.clientY)
})

function endPress(): void {
  if (!pressing) return
  pressing = false
  postPanelDragEnd()
}

button.addEventListener('pointerup', endPress)
button.addEventListener('pointercancel', endPress)

button.addEventListener('click', () => {
  if (suppressClick) {
    suppressClick = false
    return
  }
  postToHost({ type: 'chat.open' })
})

window.addEventListener('message', event => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  const type = (data as { type?: unknown }).type
  if (type === 'imark:theme') {
    applyTheme((data as { theme?: unknown }).theme)
    return
  }
  if (type !== 'imark:message') return
  const message = (data as { message?: unknown }).message
  if (!message || typeof message !== 'object') return
  const payload = message as { type?: unknown; config?: unknown }
  if (payload.type !== 'config' || !payload.config || typeof payload.config !== 'object') return
  const next = payload.config as Record<string, unknown>
  style = characterStyleFrom(next.characterStyle)
  render()
})

render()
announceReady()
