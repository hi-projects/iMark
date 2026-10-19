/**
 * AI for Edit —— render 层。
 *
 * 一个对话式助手：
 *   - 状态栏大纲按钮旁的 AI 按钮，以及编辑器右下角的浮动小人，都能打开对话；
 *   - 对话里可以直接问与当前文档相关的问题；
 *   - 顶部两个快捷动作：「生成」用于空文档，「美化」用于已有内容；
 *   - 生成/美化结果以消息形式出现，点「写入文档 / 确认替换」才真正改文档。
 *
 * 小人形象、是否显示由插件配置决定；所有界面都在停用时自己收走。
 * 网络与密钥在 main 层，这里只通过消息请求。
 */

import type { ImkRenderLayerApi } from '@shared/pluginApi'
import type {
  AiBeautifyMessage,
  AiChatMessage,
  AiGenerateMessage,
  AiReplyMessage,
  ChatHistoryItem,
  DocRequestMessage,
  PreviewOpenMessage
} from './protocol'

type EditorViewT = NonNullable<ReturnType<ImkRenderLayerApi['editor']['getView']>>
type ActionKind = 'generate' | 'beautify'
type ActionPhase = 'loading' | 'ready' | 'error'
type MessageRole = 'user' | 'assistant' | 'system'
type MessageKind = 'chat' | 'action' | 'hint'

type DiffKind = 'same' | 'del' | 'add' | 'change'

interface DiffRow {
  left: string | null
  right: string | null
  kind: DiffKind
}

interface ActionState {
  kind: ActionKind
  phase: ActionPhase
  result: string | null
  error: string
  detail: string
  original: string
  cursor: number
  prompt: string
  applied: boolean
  requestId: string | null
  /** 结果消息里的「预览 / 源码」页签 */
  tab: 'preview' | 'source'
  previewHtml?: string
  previewError?: string
}

interface ChatMessageItem {
  id: string
  role: MessageRole
  kind: MessageKind
  text: string
  requestId?: string | null
  loading?: boolean
  error?: string
  detail?: string
  truncated?: boolean
  action?: ActionState
}

interface CharacterStyle {
  label: string
  /** 一个 emoji；与 svg 恰好有一个 */
  emoji?: string
  /** 内置的矢量动画形象；与 emoji 恰好有一个 */
  svg?: string
}

/**
 * 内置的企鹅形象：黑色身体、白肚子、橙色嘴和脚、红围巾。
 * 眼睛与左翅膀带 CSS 动画（眨眼、挥手），外层的浮动由 .ai-char 负责。
 * 坐标全部用 viewBox 单位，尺寸由容器 CSS 控制。
 */
const PENGUIN_SVG = `
<svg class="ai-penguin" viewBox="0 0 64 64" aria-hidden="true">
  <ellipse cx="32" cy="59" rx="14" ry="2.8" fill="rgba(0,0,0,.18)"/>
  <path d="M32 8c-11.5 0-20 8.8-20 23 0 13.8 8.3 23.8 20 23.8s20-10 20-23.8C52 16.8 43.5 8 32 8Z" fill="#334155"/>
  <path d="M32 9c-1.6-3.6 1.2-6.4 4.2-5.8 2.3.5 2.8 2.7 2.1 4.4" fill="none" stroke="#334155" stroke-width="2.3" stroke-linecap="round"/>
  <ellipse cx="32" cy="28" rx="14.5" ry="13" fill="#fff8ec"/>
  <ellipse cx="32" cy="45" rx="11.5" ry="10.5" fill="#fff8ec"/>
  <ellipse cx="20.8" cy="33" rx="2.6" ry="1.7" fill="#ffb3c1" opacity=".9"/>
  <ellipse cx="43.2" cy="33" rx="2.6" ry="1.7" fill="#ffb3c1" opacity=".9"/>
  <g class="ai-penguin-eye">
    <ellipse cx="26" cy="27.5" rx="3.4" ry="4.1" fill="#1f2937"/>
    <circle cx="27.1" cy="26" r="1.2" fill="#fff"/>
  </g>
  <g class="ai-penguin-eye">
    <ellipse cx="38" cy="27.5" rx="3.4" ry="4.1" fill="#1f2937"/>
    <circle cx="39.1" cy="26" r="1.2" fill="#fff"/>
  </g>
  <path d="M30.2 32.4c1.1-1.6 2.5-1.6 3.6 0-1.1 2-2.5 2-3.6 0Z" fill="#ffb347"/>
  <path d="M18.5 37.5c4.5 2.6 22.5 2.6 27 0l-1 4.2c-4.5 2.4-20.5 2.4-25 0Z" fill="#ff5c7a"/>
  <path d="M42.5 40.5c3.5 1.5 5 4.5 4 7.2-.8 2-2.8 2.3-4 .5-1.1-1.7-.8-4.2-1.5-6.2Z" fill="#ff5c7a"/>
  <circle cx="32" cy="39.5" r="2.4" fill="#ff6b86"/>
  <ellipse cx="25.5" cy="57.5" rx="5.5" ry="2.6" fill="#ffb347"/>
  <ellipse cx="38.5" cy="57.5" rx="5.5" ry="2.6" fill="#ffb347"/>
  <path class="ai-penguin-flipper" d="M14 31c-3.5 4-3.8 9.5-1.2 13.3 1.3 1.9 3.2 1.6 4-.3 1.2-3 .8-7-.9-10.8-.9-2-1.5-2.7-1.9-2.2Z" fill="#334155"/>
  <path d="M50 31c3.5 4 3.8 9.5 1.2 13.3-1.3 1.9-3.2 1.6-4-.3-1.2-3-.8-7 .9-10.8.9-2 1.5-2.7 1.9-2.2Z" fill="#334155"/>
  <ellipse cx="32" cy="49.5" rx="6.5" ry="3.2" fill="#fff" opacity=".18"/>
</svg>`

const CHARACTERS: Record<string, CharacterStyle> = {
  cat: { emoji: '🐱', label: '猫咪' },
  penguin: { svg: PENGUIN_SVG, label: '企鹅' },
  robot: { emoji: '🤖', label: '机器人' },
  ghost: { emoji: '👻', label: '幽灵' },
  star: { emoji: '✨', label: '星星' }
}

const MAX_MESSAGE_CHARS = 240 * 1024
const MAX_INPUT_CHARS = 120_000
const PLUGIN_ID = 'ai-for-edit'
const CHARACTER_POS_KEY = 'ai-for-edit:character-position'
const SPARKLES_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>' +
  '<path d="M19 3v4"/><path d="M21 5h-4"/><path d="M5 17v4"/><path d="M7 19H3"/></svg>'

const PANEL_CSS = `
/* ---------- 编辑器里的浮动小人 ---------- */
.ai-char {
  position: absolute; right: 18px; bottom: 18px; z-index: 30;
  width: 52px; height: 52px; padding: 0;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: radial-gradient(circle at 35% 30%,
    color-mix(in srgb, var(--accent) 24%, var(--bg-toolbar)),
    var(--bg-toolbar));
  box-shadow: 0 6px 20px var(--shadow);
  cursor: grab;
  touch-action: none; user-select: none;
  display: flex; align-items: center; justify-content: center;
  animation: ai-char-float 3.2s ease-in-out infinite;
}
.ai-char:hover { filter: brightness(1.08); }
.ai-char:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 矢量小人（企鹅）：不套圆形气泡，就是一个透明背景的动画角色 */
.ai-char-plain {
  width: 64px; height: 72px;
  background: transparent;
  border: none; border-radius: 0; box-shadow: none;
}
.ai-char-plain::before { display: none; }
.ai-char-plain .ai-char-emoji svg {
  width: 58px; height: 58px;
  filter: drop-shadow(0 4px 5px rgba(0, 0, 0, .28));
}
.ai-char-plain .ai-char-label { right: 72px; }
.ai-char-dragging { animation: none; cursor: grabbing; }
.ai-char-dragging::before { display: none; }
.ai-char-emoji svg { width: 38px; height: 38px; display: block; }
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
.ai-char::before {
  content: ''; position: absolute; inset: -5px; border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  animation: ai-char-pulse 3.2s ease-out infinite; pointer-events: none;
}
.ai-char-emoji {
  font-size: 26px; line-height: 1; pointer-events: none;
  animation: ai-char-wiggle 4.2s ease-in-out infinite;
}
.ai-char-label {
  position: absolute; right: 60px; top: 50%; transform: translateY(-50%);
  padding: 5px 9px; border-radius: 6px;
  background: var(--bg-toolbar); border: 1px solid var(--border);
  color: var(--text-primary); font-family: var(--font-editor); font-size: 12px;
  white-space: nowrap; opacity: 0; pointer-events: none;
  transition: opacity .15s ease; box-shadow: 0 4px 12px var(--shadow);
}
.ai-char:hover .ai-char-label, .ai-char:focus-visible .ai-char-label { opacity: 1; }
@keyframes ai-char-float { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
@keyframes ai-char-wiggle { 0%, 100% { transform: rotate(-5deg) } 50% { transform: rotate(5deg) } }
@keyframes ai-char-pulse {
  0% { opacity: .5; transform: scale(.9) }
  70% { opacity: 0; transform: scale(1.25) }
  100% { opacity: 0 }
}

/* ---------- 对话窗口 ---------- */
.ai-chat-mask {
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .45);
}
.ai-chat-panel {
  display: flex; flex-direction: column;
  width: min(980px, 94vw); height: min(84vh, 900px);
  overflow: hidden;
  background: var(--bg-editor); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 24px 60px var(--shadow);
  font-family: var(--font-editor); outline: none;
}
.ai-chat-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-toolbar);
}
.ai-chat-avatar {
  width: 30px; height: 30px; flex: 0 0 30px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px;
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-editor));
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
}
.ai-chat-title { font-size: 14px; font-weight: 600; white-space: nowrap; }
.ai-chat-meta {
  flex: 1; min-width: 0;
  color: var(--text-tertiary); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-chat-head-btn {
  padding: 4px 9px;
  border: 1px solid var(--border); border-radius: 6px;
  background: transparent; color: var(--text-secondary);
  font-family: var(--font-editor); font-size: 12px; cursor: pointer;
}
.ai-chat-head-btn:hover:not(:disabled) { background: var(--bg-toolbar-btn-hover); color: var(--text-primary); }
.ai-chat-head-btn:disabled { opacity: .4; cursor: not-allowed; }
.ai-chat-close {
  width: 24px; height: 24px;
  border: none; border-radius: 4px;
  background: transparent; color: var(--text-secondary);
  font-size: 18px; line-height: 1; cursor: pointer;
}
.ai-chat-close:hover { background: var(--bg-toolbar-btn-hover); color: var(--text-primary); }
.ai-chat-actions {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.ai-chat-shortcut {
  padding: 5px 13px;
  border: 1px solid var(--border); border-radius: 999px;
  background: transparent; color: var(--text-primary);
  font-family: var(--font-editor); font-size: 12px; cursor: pointer;
}
.ai-chat-shortcut:hover:not(:disabled) {
  border-color: var(--accent); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.ai-chat-shortcut:disabled { opacity: .45; cursor: not-allowed; }
.ai-chat-actions-hint { margin-left: auto; color: var(--text-tertiary); font-size: 11.5px; }
.ai-chat-messages {
  flex: 1; min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.ai-chat-welcome {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 8px 4px; color: var(--text-secondary); font-size: 13px; line-height: 1.65;
}
.ai-chat-welcome-avatar { font-size: 24px; line-height: 1.2; }
.ai-chat-welcome-avatar svg { width: 28px; height: 28px; display: block; }
.ai-chat-avatar svg { width: 22px; height: 22px; display: block; }
.ai-chat-msg-avatar svg { width: 20px; height: 20px; display: block; }
.ai-chat-row { display: flex; gap: 8px; align-items: flex-start; }
.ai-chat-row-user { justify-content: flex-end; }
.ai-chat-msg-avatar {
  flex: 0 0 26px; width: 26px; height: 26px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid var(--border);
}
.ai-chat-bubble {
  max-width: 82%;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 13px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
}
.ai-chat-bubble-user {
  background: var(--accent); color: #fff;
  border-bottom-right-radius: 3px;
}
.ai-chat-bubble-assistant {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
}
.ai-chat-bubble-assistant.ai-chat-action { width: 100%; max-width: 100%; }
.ai-chat-hint { align-self: center; color: var(--text-tertiary); font-size: 12px; text-align: center; padding: 2px 10px; }
.ai-chat-loading { color: var(--text-tertiary); font-size: 12.5px; }
.ai-chat-dots { animation: ai-chat-blink 1.2s ease-in-out infinite; }
@keyframes ai-chat-blink { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
.ai-chat-error { color: var(--danger); font-size: 12.5px; white-space: pre-wrap; }
.ai-chat-error-detail { margin: 6px 0 0; color: var(--text-tertiary); font-size: 11.5px; white-space: pre-wrap; }
.ai-chat-truncated { margin-top: 6px; color: var(--warning, #d29922); font-size: 11.5px; }
.ai-chat-action-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.ai-chat-action-title { font-size: 12.5px; font-weight: 600; }
.ai-chat-action-status { color: var(--text-tertiary); font-size: 11.5px; }
.ai-chat-tabs {
  display: flex; gap: 6px; margin-top: 10px;
  border-bottom: 1px solid var(--border);
}
.ai-chat-tab {
  padding: 4px 10px;
  border: none; border-bottom: 2px solid transparent;
  background: transparent; color: var(--text-tertiary);
  font-family: var(--font-editor); font-size: 12px; cursor: pointer;
}
.ai-chat-tab:hover { color: var(--text-primary); }
.ai-chat-tab.is-active { color: var(--accent); border-bottom-color: var(--accent); }
.ai-chat-preview {
  max-height: 320px; overflow: auto;
  margin-top: 6px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 6px;
  background: color-mix(in srgb, var(--text) 4%, transparent);
  font-size: 13px; line-height: 1.7;
}
.ai-chat-preview > :first-child { margin-top: 0; }
.ai-chat-preview > :last-child { margin-bottom: 0; }
.ai-chat-preview h1, .ai-chat-preview h2 {
  border-bottom: 1px solid var(--border); padding-bottom: .25em;
}
.ai-chat-preview h1, .ai-chat-preview h2, .ai-chat-preview h3,
.ai-chat-preview h4, .ai-chat-preview h5, .ai-chat-preview h6 {
  margin: 1em 0 .5em; line-height: 1.35;
}
.ai-chat-preview p { margin: .6em 0; }
.ai-chat-preview ul, .ai-chat-preview ol { margin: .5em 0; padding-left: 1.6em; }
.ai-chat-preview blockquote {
  margin: .6em 0; padding: 0 1em;
  border-left: 3px solid var(--border); color: var(--text-secondary);
}
.ai-chat-preview code {
  font-family: var(--font-editor); font-size: .9em;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 4px; padding: .12em .35em;
}
.ai-chat-preview pre {
  margin: .7em 0; padding: 10px 12px;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  border-radius: 6px; overflow: auto;
}
.ai-chat-preview pre code { background: none; padding: 0; }
.ai-chat-preview table { border-collapse: collapse; margin: .7em 0; }
.ai-chat-preview th, .ai-chat-preview td {
  border: 1px solid var(--border); padding: 4px 10px;
}
.ai-chat-preview th { background: color-mix(in srgb, var(--text) 6%, transparent); }
.ai-chat-preview img { max-width: 100%; }
.ai-chat-preview hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
.ai-chat-preview a { color: var(--accent); text-decoration: none; }
.ai-chat-preview .mermaid-diagram {
  margin: .7em 0; padding: 8px;
  border: 1px solid var(--border); border-radius: 6px;
  text-align: center; overflow-x: auto;
  background: color-mix(in srgb, var(--text) 3%, transparent);
}
.ai-chat-preview .mermaid-diagram svg { max-width: 100%; height: auto; }
.ai-chat-preview .mermaid-diagram-error { color: var(--danger); text-align: left; font-size: 12px; }
.ai-chat-preview .katex-display { overflow-x: auto; }
.ai-diff-preview { display: flex; flex-direction: column; }
.ai-diff-segment {
  margin: 4px 0; padding: 2px 10px;
  border-left: 3px solid transparent; border-radius: 5px;
}
.ai-diff-segment.is-same { padding-left: 10px; }
.ai-diff-segment.is-add {
  background: color-mix(in srgb, var(--success) 11%, transparent);
  border-left-color: var(--success);
}
.ai-diff-segment.is-del {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-left-color: var(--danger);
  opacity: .82;
}
.ai-diff-segment.is-del > * {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--danger) 60%, transparent);
}
.ai-chat-preview .ai-diff-segment > :first-child { margin-top: 2px; }
.ai-chat-preview .ai-diff-segment > :last-child { margin-bottom: 2px; }
.ai-chat-preview-loading { color: var(--text-tertiary); font-size: 12.5px; padding: 8px 0; }
.ai-chat-preview-error { color: var(--danger); font-size: 12.5px; white-space: pre-wrap; }
.ai-chat-generated {
  margin: 0; padding: 8px 10px;
  max-height: 260px; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
  background: color-mix(in srgb, var(--text) 4%, transparent);
  border: 1px solid var(--border); border-radius: 6px;
  font-family: var(--font-editor); font-size: 12.5px; line-height: 1.6;
}
.ai-chat-action-buttons { display: flex; gap: 8px; margin-top: 10px; }
.ai-chat-applied { margin-top: 8px; color: var(--success); font-size: 12px; }
.ai-chat-compose {
  display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-toolbar);
}
.ai-chat-input {
  flex: 1; min-height: 44px; max-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text-primary);
  font-family: var(--font-editor); font-size: 13px; line-height: 1.5;
  resize: none;
}
.ai-chat-input:focus { outline: none; border-color: var(--accent); }
.ai-chat-send {
  padding: 8px 14px;
  border: 1px solid var(--accent); border-radius: 8px;
  background: var(--accent); color: #fff;
  font-family: var(--font-editor); font-size: 13px; cursor: pointer;
}
.ai-chat-send:disabled { opacity: .45; cursor: not-allowed; }
.ai-chat-action-buttons .line-dialog-btn:disabled,
.ai-chat-compose .ai-chat-send:disabled { opacity: .45; cursor: not-allowed; }
`

let styleEl: HTMLStyleElement | null = null
let statusButton: HTMLButtonElement | null = null
let statusRetry: number | null = null
let statusObserver: MutationObserver | null = null
let characterEl: HTMLButtonElement | null = null
let characterRetry: number | null = null
/** 本次会话内的拖动位置缓存（localStorage 不可用时也能在关/开小人后恢复） */
let cachedCharacterPos: { x: number; y: number } | null = null
let offMessage: (() => void) | null = null
let offDocChanged: (() => void) | null = null

const messages: ChatMessageItem[] = []
let draft = ''
let pendingId: string | null = null
let requestSeq = 0
let messageSeq = 0

let maskEl: HTMLDivElement | null = null
let panelEl: HTMLDivElement | null = null
let avatarEl: HTMLSpanElement | null = null
let metaEl: HTMLSpanElement | null = null
let generateBtn: HTMLButtonElement | null = null
let beautifyBtn: HTMLButtonElement | null = null
let messagesEl: HTMLDivElement | null = null
let inputEl: HTMLTextAreaElement | null = null
let sendBtn: HTMLButtonElement | null = null
let newChatBtn: HTMLButtonElement | null = null
let actionsHintEl: HTMLSpanElement | null = null
let keydownHandler: ((event: KeyboardEvent) => void) | null = null

function currentView(): EditorViewT | null {
  const view = imk.editor.getView()
  if (!view) return null
  return view.state.facet(imk.editor.kit.view.EditorView.editable) === true ? view : null
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function nextRequestId(): string {
  requestSeq += 1
  return `${Date.now().toString(36)}-${requestSeq}`
}

function nextMessageId(): string {
  messageSeq += 1
  return `m${messageSeq}-${Date.now().toString(36)}`
}

function characterStyle(): CharacterStyle {
  const config = imk.plugin.getConfig<{ characterStyle?: unknown }>()
  const key = typeof config.characterStyle === 'string' ? config.characterStyle : 'cat'
  return CHARACTERS[key] ?? CHARACTERS.cat
}

function fillAvatar(el: HTMLElement, style: CharacterStyle): void {
  if (style.svg) el.innerHTML = style.svg
  else el.textContent = style.emoji ?? ''
}

function readCharacterPosition(): { x: number; y: number } | null {
  if (cachedCharacterPos) return cachedCharacterPos
  try {
    const raw = localStorage.getItem(CHARACTER_POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      cachedCharacterPos = { x: parsed.x, y: parsed.y }
      return cachedCharacterPos
    }
  } catch {
    /* localStorage 不可用或内容坏了：用默认位置 */
  }
  return null
}

function saveCharacterPosition(x: number, y: number): void {
  cachedCharacterPos = { x, y }
  try {
    localStorage.setItem(CHARACTER_POS_KEY, JSON.stringify({ x, y }))
  } catch {
    /* 隐私模式/配额：位置不持久化也不影响使用 */
  }
}

function clampToHost(value: number, limit: number): number {
  return Math.min(Math.max(value, 4), Math.max(4, limit))
}

function applySavedCharacterPosition(button: HTMLButtonElement, host: Element): void {
  const pos = readCharacterPosition()
  if (!pos) return
  const rect = host.getBoundingClientRect()
  const width = button.offsetWidth || 52
  const height = button.offsetHeight || 52
  button.style.left = `${clampToHost(pos.x * rect.width, rect.width - width - 4)}px`
  button.style.top = `${clampToHost(pos.y * rect.height, rect.height - height - 4)}px`
  button.style.right = 'auto'
  button.style.bottom = 'auto'
}

function clampCharacterPosition(): void {
  const button = characterEl
  if (!button || !button.style.left) return
  const host = button.parentElement
  if (!host) return
  const rect = host.getBoundingClientRect()
  const width = button.offsetWidth || 52
  const height = button.offsetHeight || 52
  const left = Number.parseFloat(button.style.left) || 0
  const top = Number.parseFloat(button.style.top) || 0
  button.style.left = `${clampToHost(left, rect.width - width - 4)}px`
  button.style.top = `${clampToHost(top, rect.height - height - 4)}px`
}

function docInfo(): { hasView: boolean; empty: boolean } {
  const view = currentView()
  if (!view) return { hasView: false, empty: true }
  // 只看长度，避免每次按键都为「生成/美化」按钮把整篇文档 toString 一遍
  return { hasView: true, empty: view.state.doc.length === 0 }
}

// ---------- 状态栏按钮 ----------

function ensureStyle(): void {
  if (styleEl) return
  styleEl = document.createElement('style')
  styleEl.dataset.imkPlugin = PLUGIN_ID
  styleEl.textContent = PANEL_CSS
  document.head.append(styleEl)
}

function ensureStatusButton(): void {
  if (statusButton?.isConnected) return
  const toggles = document.querySelector('.status-toggles')
  if (!toggles) {
    if (statusRetry === null) {
      statusRetry = window.setTimeout(() => {
        statusRetry = null
        ensureStatusButton()
      }, 400)
    }
    return
  }

  const button = document.createElement('button')
  button.type = 'button'
  button.title = 'AI 对话 / 生成 / 美化'
  button.setAttribute('aria-label', 'AI 对话 / 生成 / 美化')
  button.innerHTML = SPARKLES_SVG
  button.addEventListener('click', event => {
    event.preventDefault()
    openChatPanel()
  })
  toggles.append(button)
  statusButton = button

  if (!statusObserver) {
    statusObserver = new MutationObserver(() => {
      if (!statusButton?.isConnected) ensureStatusButton()
    })
    statusObserver.observe(toggles, { childList: true })
  }
}

function removeStatusButton(): void {
  if (statusRetry !== null) {
    window.clearTimeout(statusRetry)
    statusRetry = null
  }
  statusObserver?.disconnect()
  statusObserver = null
  statusButton?.remove()
  statusButton = null
}

function setStatusButtonActive(active: boolean): void {
  statusButton?.classList.toggle('status-toggle-on', active)
}

// ---------- 浮动小人 ----------

function syncCharacter(): void {
  const config = imk.plugin.getConfig<{ characterEnabled?: unknown }>()
  if (config.characterEnabled === false) {
    removeCharacter()
    return
  }

  const host = document.querySelector('.editor-host')
  if (!host) {
    // 还在仓库选择页：编辑器挂载后再试，别把小人放到选择页上
    if (characterRetry === null) {
      characterRetry = window.setTimeout(() => {
        characterRetry = null
        syncCharacter()
      }, 700)
    }
    return
  }

  const style = characterStyle()
  if (!characterEl || !characterEl.isConnected) {
    characterEl?.remove()
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ai-char'
    button.classList.toggle('ai-char-plain', Boolean(style.svg))
    button.title = `和${style.label}聊聊`
    button.setAttribute('aria-label', '打开 AI 对话')

    const avatar = document.createElement('span')
    avatar.className = 'ai-char-emoji'
    const label = document.createElement('span')
    label.className = 'ai-char-label'
    label.textContent = '和 AI 聊聊'
    button.append(avatar, label)

    // 拖动：按住小人移动；松手保存为相对编辑器区域的比例，窗口缩放后还能夹回来。
    // 拖动结束后的 click 要吞掉，否则一次拖动会顺手把对话打开。
    // 用时间戳而不是「布尔 + setTimeout」：窗口在后台时定时器会被节流，
    // 布尔标记会一直留着，把用户下一次真正的点击也吞掉。
    let suppressClickUntil = 0
    let dragging: {
      pointerId: number
      offsetX: number
      offsetY: number
      startX: number
      startY: number
      moved: boolean
    } | null = null

    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      const rect = button.getBoundingClientRect()
      dragging = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
        moved: false
      }
      suppressClickUntil = 0
      button.classList.add('ai-char-dragging')
      try {
        button.setPointerCapture(event.pointerId)
      } catch {
        /* 合成事件没有真实指针可捕获 */
      }
    })

    button.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== dragging.pointerId) return
      const dx = event.clientX - dragging.startX
      const dy = event.clientY - dragging.startY
      if (!dragging.moved && Math.hypot(dx, dy) < 4) return
      dragging.moved = true

      const hostRect = host.getBoundingClientRect()
      const width = button.offsetWidth || 52
      const height = button.offsetHeight || 52
      const left = clampToHost(
        event.clientX - hostRect.left - dragging.offsetX,
        hostRect.width - width - 4
      )
      const top = clampToHost(
        event.clientY - hostRect.top - dragging.offsetY,
        hostRect.height - height - 4
      )
      button.style.left = `${left}px`
      button.style.top = `${top}px`
      button.style.right = 'auto'
      button.style.bottom = 'auto'
    })

    const finishDrag = (event: PointerEvent): void => {
      if (!dragging || event.pointerId !== dragging.pointerId) return
      const moved = dragging.moved
      dragging = null
      button.classList.remove('ai-char-dragging')
      try {
        button.releasePointerCapture(event.pointerId)
      } catch {
        /* 合成事件无需释放 */
      }
      if (!moved) return

      suppressClickUntil = Date.now() + 300
      const hostRect = host.getBoundingClientRect()
      const left = Number.parseFloat(button.style.left) || 0
      const top = Number.parseFloat(button.style.top) || 0
      saveCharacterPosition(
        hostRect.width > 0 ? left / hostRect.width : 0,
        hostRect.height > 0 ? top / hostRect.height : 0
      )
    }
    button.addEventListener('pointerup', finishDrag)
    button.addEventListener('pointercancel', finishDrag)

    button.addEventListener('click', event => {
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = 0
        event.preventDefault()
        return
      }
      openChatPanel()
    })

    host.append(button)
    characterEl = button
    applySavedCharacterPosition(button, host)
  }

  const avatarEl = characterEl.querySelector<HTMLSpanElement>('.ai-char-emoji')
  if (avatarEl) fillAvatar(avatarEl, style)
  characterEl.classList.toggle('ai-char-plain', Boolean(style.svg))
  characterEl.title = `和${style.label}聊聊`
}

function removeCharacter(): void {
  if (characterRetry !== null) {
    window.clearTimeout(characterRetry)
    characterRetry = null
  }
  characterEl?.remove()
  characterEl = null
}

// ---------- 对话窗口骨架 ----------

function ensurePanelDom(): void {
  if (maskEl) return

  const mask = document.createElement('div')
  mask.className = 'ai-chat-mask'

  const panel = document.createElement('div')
  panel.className = 'ai-chat-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.tabIndex = -1

  const head = document.createElement('div')
  head.className = 'ai-chat-head'
  const avatar = document.createElement('span')
  avatar.className = 'ai-chat-avatar'
  const title = document.createElement('span')
  title.className = 'ai-chat-title'
  title.textContent = 'AI for Edit'
  const meta = document.createElement('span')
  meta.className = 'ai-chat-meta'
  const newChat = document.createElement('button')
  newChat.type = 'button'
  newChat.className = 'ai-chat-head-btn'
  newChat.textContent = '新对话'
  newChat.addEventListener('click', () => newChatSession())
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'ai-chat-close'
  close.title = '关闭'
  close.textContent = '×'
  close.addEventListener('click', () => closePanel())
  head.append(avatar, title, meta, newChat, close)

  const actions = document.createElement('div')
  actions.className = 'ai-chat-actions'
  const generate = document.createElement('button')
  generate.type = 'button'
  generate.className = 'ai-chat-shortcut ai-chat-generate'
  generate.textContent = '生成'
  generate.addEventListener('click', () => runGenerateShortcut())
  const beautify = document.createElement('button')
  beautify.type = 'button'
  beautify.className = 'ai-chat-shortcut ai-chat-beautify'
  beautify.textContent = '美化'
  beautify.addEventListener('click', () => runBeautifyShortcut())
  const actionsHint = document.createElement('span')
  actionsHint.className = 'ai-chat-actions-hint'
  actionsHint.textContent = '生成用于空文档 · 美化用于已有内容'
  actions.append(generate, beautify, actionsHint)

  const list = document.createElement('div')
  list.className = 'ai-chat-messages'

  const compose = document.createElement('div')
  compose.className = 'ai-chat-compose'
  const input = document.createElement('textarea')
  input.className = 'ai-chat-input'
  input.rows = 2
  input.placeholder = '问点什么，或说说想生成什么…（Enter 发送，Shift+Enter 换行）'
  input.addEventListener('input', () => {
    draft = input.value
    syncComposeState()
  })
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendChat()
    }
  })
  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'ai-chat-send'
  send.textContent = '发送'
  send.addEventListener('click', () => sendChat())
  compose.append(input, send)

  panel.append(head, actions, list, compose)
  mask.append(panel)
  document.body.append(mask)

  maskEl = mask
  panelEl = panel
  avatarEl = avatar
  metaEl = meta
  generateBtn = generate
  beautifyBtn = beautify
  actionsHintEl = actionsHint
  messagesEl = list
  inputEl = input
  sendBtn = send
  newChatBtn = newChat

  keydownHandler = event => {
    if (event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePanel()
    }
  }
  document.addEventListener('keydown', keydownHandler, true)
  setStatusButtonActive(true)
}

function closePanel(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler, true)
    keydownHandler = null
  }
  maskEl?.remove()
  maskEl = null
  panelEl = null
  avatarEl = null
  metaEl = null
  generateBtn = null
  beautifyBtn = null
  actionsHintEl = null
  messagesEl = null
  inputEl = null
  sendBtn = null
  newChatBtn = null
  setStatusButtonActive(false)
}

function newChatSession(): void {
  if (pendingId) return
  messages.length = 0
  draft = ''
  if (inputEl) inputEl.value = ''
  renderPanel()
  inputEl?.focus()
}

function openChatPanel(): void {
  ensurePanelDom()
  renderPanel()
  inputEl?.focus()
}

// ---------- 渲染 ----------

function renderPanel(): void {
  if (!maskEl || !stateAvailable()) return
  const avatar = avatarEl
  const meta = metaEl
  if (avatar) fillAvatar(avatar, characterStyle())
  if (meta) {
    const config = imk.plugin.getConfig<{ model?: unknown }>()
    const model = typeof config.model === 'string' ? config.model.trim() : ''
    meta.textContent = model || '文档问答'
  }
  renderActions()
  renderMessages()
  syncComposeState()
  if (inputEl && document.activeElement !== inputEl && inputEl.value !== draft) {
    inputEl.value = draft
  }
}

function stateAvailable(): boolean {
  return maskEl !== null && panelEl !== null
}

function renderActions(): void {
  if (!generateBtn || !beautifyBtn || !actionsHintEl) return
  const info = docInfo()
  generateBtn.disabled = pendingId !== null || !info.hasView || !info.empty
  beautifyBtn.disabled = pendingId !== null || !info.hasView || info.empty
  generateBtn.title = !info.hasView
    ? '请先打开或新建一个文档'
    : info.empty
      ? '在下方输入想生成的内容，然后点「生成」'
      : '「生成」只用于空文档'
  beautifyBtn.title = !info.hasView
    ? '请先打开或新建一个文档'
    : info.empty
      ? '「美化」需要有内容的文档'
      : '美化当前文档'
  actionsHintEl.textContent = !info.hasView
    ? '先打开一个文档'
    : pendingId
      ? 'AI 正在处理…'
      : '生成用于空文档 · 美化用于已有内容'
}

function renderMessages(): void {
  if (!messagesEl) return
  messagesEl.replaceChildren()
  const style = characterStyle()

  if (messages.length === 0) {
    const welcome = document.createElement('div')
    welcome.className = 'ai-chat-welcome'
    const avatar = document.createElement('span')
    avatar.className = 'ai-chat-welcome-avatar'
    fillAvatar(avatar, style)
    const text = document.createElement('div')
    text.textContent =
      '你好，我是 AI for Edit。可以问我关于当前文档的问题，也可以用上面的「生成」「美化」。'
    welcome.append(avatar, text)
    messagesEl.append(welcome)
  }

  for (const message of messages) {
    messagesEl.append(renderMessage(message, style))
  }
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderMessage(message: ChatMessageItem, style: CharacterStyle): HTMLElement {
  if (message.role === 'system' || message.kind === 'hint') {
    const hint = document.createElement('div')
    hint.className = 'ai-chat-hint'
    hint.textContent = message.text
    return hint
  }

  if (message.role === 'user') {
    const row = document.createElement('div')
    row.className = 'ai-chat-row ai-chat-row-user'
    const bubble = document.createElement('div')
    bubble.className = 'ai-chat-bubble ai-chat-bubble-user'
    bubble.textContent = message.text
    row.append(bubble)
    return row
  }

  const row = document.createElement('div')
  row.className = 'ai-chat-row ai-chat-row-assistant'
  const avatar = document.createElement('span')
  avatar.className = 'ai-chat-msg-avatar'
  fillAvatar(avatar, style)
  const bubble = document.createElement('div')
  bubble.className = 'ai-chat-bubble ai-chat-bubble-assistant'
  row.append(avatar, bubble)

  if (message.kind === 'action' && message.action) {
    bubble.classList.add('ai-chat-action')
    renderActionBubble(bubble, message)
    return row
  }

  if (message.loading) {
    const loading = document.createElement('span')
    loading.className = 'ai-chat-loading'
    loading.textContent = '正在思考'
    const dots = document.createElement('span')
    dots.className = 'ai-chat-dots'
    dots.textContent = ' …'
    loading.append(dots)
    bubble.append(loading)
    return row
  }

  if (message.error) {
    const error = document.createElement('div')
    error.className = 'ai-chat-error'
    error.textContent = message.error
    bubble.append(error)
    if (message.detail) {
      const detail = document.createElement('pre')
      detail.className = 'ai-chat-error-detail'
      detail.textContent = message.detail
      bubble.append(detail)
    }
    return row
  }

  bubble.textContent = message.text
  if (message.truncated) {
    const note = document.createElement('div')
    note.className = 'ai-chat-truncated'
    note.textContent = '（回答达到输出上限，可能不完整）'
    bubble.append(note)
  }
  return row
}

function renderActionBubble(bubble: HTMLDivElement, message: ChatMessageItem): void {
  const action = message.action
  if (!action) return

  const head = document.createElement('div')
  head.className = 'ai-chat-action-head'
  const title = document.createElement('span')
  title.className = 'ai-chat-action-title'
  title.textContent = action.kind === 'beautify' ? '美化结果' : '生成结果'
  const status = document.createElement('span')
  status.className = 'ai-chat-action-status'
  status.textContent = actionStatus(action)
  head.append(title, status)
  bubble.append(head)

  if (action.phase === 'loading') {
    const loading = document.createElement('div')
    loading.className = 'ai-chat-loading'
    loading.textContent = action.kind === 'beautify' ? '正在美化…' : '正在生成…'
    bubble.append(loading)
    return
  }

  if (action.phase === 'error') {
    const error = document.createElement('div')
    error.className = 'ai-chat-error'
    error.textContent = action.error || '请求失败'
    bubble.append(error)
    if (action.detail) {
      const detail = document.createElement('pre')
      detail.className = 'ai-chat-error-detail'
      detail.textContent = action.detail
      bubble.append(detail)
    }
    appendActionButtons(bubble, message, true)
    return
  }

  if (action.result === null) return
  // 生成与美化都带「预览 / 源码」窗口：预览用宿主的 markdown-it 渲染。
  // 美化的预览本身就是差异视图：新增/修改的内容是绿底，删除的内容红底划掉；
  // 不再单独放一块逐行差异。源码页签保留最终 Markdown。
  appendResultTabs(bubble, action)

  if (action.applied) {
    const applied = document.createElement('div')
    applied.className = 'ai-chat-applied'
    applied.textContent = action.kind === 'beautify' ? '已替换文档' : '已写入文档'
    bubble.append(applied)
    return
  }

  appendActionButtons(bubble, message, false)
}

function actionStatus(action: ActionState): string {
  if (action.phase === 'loading') return '处理中'
  if (action.phase === 'error') return '失败'
  if (action.applied) return '已写入'
  if (action.kind === 'beautify') {
    const changed = action.result !== action.original
    return changed
      ? `原文 ${action.original.length} 字符 → 美化后 ${action.result?.length ?? 0} 字符`
      : '文档没有变化'
  }
  return `已生成 ${action.result?.length ?? 0} 字符`
}

function appendResultTabs(bubble: HTMLDivElement, action: ActionState): void {
  const tabs = document.createElement('div')
  tabs.className = 'ai-chat-tabs'
  tabs.append(resultTab('预览', 'preview', action), resultTab('源码', 'source', action))
  bubble.append(tabs)

  if (action.tab === 'source') {
    const pre = document.createElement('pre')
    pre.className = 'ai-chat-generated'
    pre.textContent = action.result ?? ''
    bubble.append(pre)
    return
  }

  const preview = document.createElement('div')
  preview.className = 'ai-chat-preview'
  if (action.previewHtml !== undefined) {
    preview.innerHTML = action.previewHtml
    // 预览里的链接不导航主窗口 —— 这是聊天消息，不是浏览器
    const blockLink = (event: Event): void => {
      const target = event.target as Element | null
      if (target?.closest?.('a')) event.preventDefault()
    }
    preview.addEventListener('click', blockLink)
    preview.addEventListener('auxclick', blockLink)
  } else if (action.previewError) {
    preview.textContent = `预览生成失败：${action.previewError}`
  } else {
    preview.textContent = '正在生成预览…'
  }
  bubble.append(preview)
}

function resultTab(
  label: string,
  tab: 'preview' | 'source',
  action: ActionState
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `ai-chat-tab${action.tab === tab ? ' is-active' : ''}`
  button.classList.add(tab === 'preview' ? 'ai-chat-tab-preview' : 'ai-chat-tab-source')
  button.textContent = label
  button.addEventListener('click', () => {
    action.tab = tab
    if (maskEl) renderPanel()
  })
  return button
}

function appendActionButtons(
  bubble: HTMLDivElement,
  message: ChatMessageItem,
  retryOnly: boolean
): void {
  const action = message.action
  if (!action) return
  const row = document.createElement('div')
  row.className = 'ai-chat-action-buttons'

  if (!retryOnly) {
    const confirm = document.createElement('button')
    const unchanged = action.kind === 'beautify' && action.result === action.original
    confirm.type = 'button'
    confirm.className = 'line-dialog-btn line-dialog-primary ai-chat-confirm'
    confirm.textContent = unchanged
      ? '没有变化'
      : action.kind === 'beautify'
        ? '确认替换'
        : '写入文档'
    confirm.disabled = pendingId !== null || unchanged
    confirm.addEventListener('click', () => confirmAction(message))
    row.append(confirm)
  }

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'line-dialog-btn ai-chat-retry'
  retry.textContent = retryOnly ? '重试' : '重新生成'
  retry.disabled = pendingId !== null
  retry.addEventListener('click', () => retryAction(message))
  row.append(retry)

  bubble.append(row)
}

function syncComposeState(): void {
  if (sendBtn) sendBtn.disabled = pendingId !== null || draft.trim().length === 0
  if (newChatBtn) newChatBtn.disabled = pendingId !== null
}

// ---------- 快捷动作 ----------

function pushHint(text: string): void {
  messages.push({ id: nextMessageId(), role: 'system', kind: 'hint', text })
  if (maskEl) renderPanel()
}

function runGenerateShortcut(explicitPrompt?: string): void {
  if (pendingId) return
  const prompt = (explicitPrompt ?? draft).trim()
  if (!prompt) {
    pushHint('先在下方输入想生成的内容，再点「生成」。')
    inputEl?.focus()
    return
  }
  const view = currentView()
  if (!view) {
    pushHint('请先打开或新建一个文档。')
    return
  }
  if (view.state.doc.toString().trim() !== '') {
    pushHint('「生成」只用于空文档。当前文档已有内容，可以试试「美化」，或直接提问。')
    return
  }
  if (explicitPrompt === undefined) {
    draft = ''
    if (inputEl) inputEl.value = ''
  }
  startAction('generate', prompt, `帮我生成：${prompt}`)
}

function runBeautifyShortcut(): void {
  if (pendingId) return
  const view = currentView()
  if (!view) {
    pushHint('请先打开或新建一个文档。')
    return
  }
  if (view.state.doc.toString().trim() === '') {
    pushHint('「美化」需要有内容的文档。当前文档是空的，先用「生成」写点内容吧。')
    return
  }
  // 输入框里有内容时，它就是这次美化的具体要求（例如「更正式」「精简」「分点」）；
  // 没有就交给 AI 自行整理。
  const instruction = draft.trim()
  const display = instruction
    ? `帮我美化一下这份文档：${instruction}`
    : '帮我美化一下这份文档'
  if (instruction) {
    draft = ''
    if (inputEl) inputEl.value = ''
  }
  startAction('beautify', instruction, display)
}

function startAction(kind: ActionKind, prompt: string, displayText: string): void {
  if (pendingId) return
  const view = currentView()
  if (!view) return
  const doc = view.state.doc.toString()

  messages.push({ id: nextMessageId(), role: 'user', kind: 'chat', text: displayText })
  const action: ActionState = {
    kind,
    phase: 'loading',
    result: null,
    error: '',
    detail: '',
    original: doc,
    cursor: view.state.selection.main.head,
    prompt,
    applied: false,
    requestId: null,
    tab: 'preview'
  }
  const message: ChatMessageItem = {
    id: nextMessageId(),
    role: 'assistant',
    kind: 'action',
    text: '',
    action
  }
  messages.push(message)

  const requestId = nextRequestId()
  action.requestId = requestId
  pendingId = requestId
  if (maskEl) renderPanel()

  if (kind === 'beautify' && doc.length > MAX_INPUT_CHARS) {
    action.phase = 'error'
    action.error = `文档太长（${doc.length} 字符），最多支持 ${MAX_INPUT_CHARS} 字符`
    action.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
    return
  }

  const payload: AiBeautifyMessage | AiGenerateMessage =
    kind === 'beautify'
      ? { id: requestId, text: doc, ...(prompt ? { instruction: prompt } : {}) }
      : { id: requestId, prompt }
  if (jsonLength(payload) > MAX_MESSAGE_CHARS) {
    action.phase = 'error'
    action.error = '文档太长，超过插件消息上限'
    action.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
    return
  }

  const channel = kind === 'beautify' ? 'ai.beautify' : 'ai.generate'
  void imk.main.send(channel, payload).catch(err => {
    if (action.requestId !== requestId) return
    action.phase = 'error'
    action.error = '无法与主进程通信'
    action.detail = String(err)
    action.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
  })
}

function confirmAction(message: ChatMessageItem): void {
  const action = message.action
  if (!action || action.phase !== 'ready' || action.applied || action.result === null) return
  const view = currentView()
  if (!view) {
    action.phase = 'error'
    action.error = '当前没有打开的文档'
    if (maskEl) renderPanel()
    return
  }

  const current = view.state.doc.toString()
  if (current !== action.original) {
    action.phase = 'error'
    action.error = '文档在此期间被修改，请重新生成'
    action.detail = ''
    if (maskEl) renderPanel()
    return
  }

  if (action.kind === 'generate') {
    const body = action.result.endsWith('\n') ? action.result : `${action.result}\n`
    let next = body
    if (action.original.trim() !== '') {
      const gap = current.endsWith('\n') ? '\n' : '\n\n'
      next = `${current}${gap}${body}`
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: { anchor: next.length },
      scrollIntoView: true
    })
  } else {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: action.result },
      selection: { anchor: Math.min(Math.max(action.cursor, 0), action.result.length) },
      scrollIntoView: true
    })
  }

  action.applied = true
  if (maskEl) renderPanel()
}

function retryAction(message: ChatMessageItem): void {
  const action = message.action
  if (!action || pendingId) return
  const view = currentView()
  if (!view) {
    action.phase = 'error'
    action.error = '当前没有打开的文档'
    if (maskEl) renderPanel()
    return
  }
  const doc = view.state.doc.toString()
  if (action.kind === 'generate' && doc.trim() !== '') {
    action.phase = 'error'
    action.error = '文档已有内容，不能再用「生成」写入'
    if (maskEl) renderPanel()
    return
  }
  if (action.kind === 'beautify' && doc.trim() === '') {
    action.phase = 'error'
    action.error = '文档是空的，无法美化'
    if (maskEl) renderPanel()
    return
  }

  action.original = doc
  action.cursor = view.state.selection.main.head
  action.phase = 'loading'
  action.result = null
  action.error = ''
  action.detail = ''
  action.applied = false
  action.tab = 'preview'
  action.previewHtml = undefined
  action.previewError = undefined

  const requestId = nextRequestId()
  action.requestId = requestId
  pendingId = requestId
  if (maskEl) renderPanel()

  if (action.kind === 'beautify' && doc.length > MAX_INPUT_CHARS) {
    action.phase = 'error'
    action.error = `文档太长（${doc.length} 字符），最多支持 ${MAX_INPUT_CHARS} 字符`
    action.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
    return
  }

  const payload: AiBeautifyMessage | AiGenerateMessage =
    action.kind === 'beautify'
      ? { id: requestId, text: doc, ...(action.prompt ? { instruction: action.prompt } : {}) }
      : { id: requestId, prompt: action.prompt }
  if (jsonLength(payload) > MAX_MESSAGE_CHARS) {
    action.phase = 'error'
    action.error = '文档太长，超过插件消息上限'
    action.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
    return
  }

  const channel = action.kind === 'beautify' ? 'ai.beautify' : 'ai.generate'
  void imk.main.send(channel, payload).catch(err => {
    if (action.requestId !== requestId) return
    action.phase = 'error'
    action.error = '无法与主进程通信'
    action.detail = String(err)
    action.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
  })
}

/** 预览不显示 YAML front matter：它是元数据，不是正文 */
function stripFrontMatterForPreview(text: string): string {
  if (!text.startsWith('---\n')) return text
  const lines = text.split('\n')
  let close = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---' || lines[i] === '...') {
      close = i
      break
    }
  }
  if (close < 0) return text
  return lines.slice(close + 1).join('\n').replace(/^\n+/, '')
}

function previewSource(action: ActionState, result: string): string {
  return action.kind === 'beautify' ? stripFrontMatterForPreview(result) : result
}

async function loadActionPreview(action: ActionState): Promise<void> {
  if (action.phase !== 'ready' || action.result === null) return
  const result = action.result
  action.previewHtml = undefined
  action.previewError = undefined

  if (!imk.markdown) {
    action.previewError = '当前应用版本不支持 Markdown 预览'
    if (maskEl) renderPanel()
    return
  }

  try {
    const html =
      action.kind === 'beautify'
        ? await renderBeautifyDiffPreview(action, result)
        : await imk.markdown.render(result)
    // 结果可能已经被「重新生成」换掉；旧预览不能覆盖新内容
    if (action.result !== result) return
    action.previewHtml = html
  } catch (err) {
    if (action.result !== result) return
    action.previewError = err instanceof Error ? err.message : String(err)
  }
  if (maskEl) renderPanel()
}

interface DiffSegment {
  kind: 'same' | 'add' | 'del'
  lines: string[]
}

/**
 * 把逐行差异**渲染进预览**：
 *   - 未变化的内容正常渲染；
 *   - 新增/修改的段落绿底；
 *   - 删除的段落红底并划掉。
 *
 * Markdown 必须按段渲染：把整段差异拼成一份 Markdown 再交给 markdown-it 会
 * 让代码围栏/列表跨段断裂。段数多的文档会有多次渲染调用，但每次只渲染一小段。
 */
async function renderBeautifyDiffPreview(action: ActionState, result: string): Promise<string> {
  const left = stripFrontMatterForPreview(action.original)
  const right = previewSource(action, result)
  const rows = diffRows(left, right)
  const segments: DiffSegment[] = []

  const push = (kind: DiffSegment['kind'], line: string | null): void => {
    if (line === null) return
    const last = segments[segments.length - 1]
    if (last && last.kind === kind) last.lines.push(line)
    else segments.push({ kind, lines: [line] })
  }

  for (const row of rows) {
    if (row.kind === 'same') {
      push('same', row.right)
    } else if (row.kind === 'del') {
      push('del', row.left)
    } else if (row.kind === 'add') {
      push('add', row.right)
    } else {
      push('del', row.left)
      push('add', row.right)
    }
  }

  const rendered = await Promise.all(
    segments.map(async segment => {
      const text = segment.lines.join('\n')
      if (!text.trim()) return ''
      const html = await imk.markdown.render(text)
      const kindClass =
        segment.kind === 'same' ? 'is-same' : segment.kind === 'add' ? 'is-add' : 'is-del'
      return `<div class="ai-diff-segment ${kindClass}">${html}</div>`
    })
  )

  return `<div class="ai-diff-preview">${rendered.join('')}</div>`
}

// ---------- 对话 ----------

function buildHistory(): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.kind === 'hint') continue
    if (message.kind === 'action') {
      const action = message.action
      if (!action) continue
      let summary = '（正在处理）'
      if (action.phase === 'error') summary = '（操作失败）'
      else if (action.applied) {
        summary = action.kind === 'beautify' ? '（已替换文档）' : '（已写入文档）'
      } else if (action.phase === 'ready') {
        summary = action.kind === 'beautify' ? '（已生成美化结果）' : '（已生成内容）'
      }
      out.push({ role: 'assistant', content: summary })
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.text })
    } else if (message.role === 'assistant' && !message.loading && !message.error) {
      out.push({ role: 'assistant', content: message.text })
    }
  }
  return out.slice(-10)
}

function sendChat(): void {
  if (pendingId) return
  const question = draft.trim()
  if (!question) return

  const view = currentView()
  let doc = ''
  if (view) {
    const text = view.state.doc.toString()
    doc =
      text.length > MAX_INPUT_CHARS
        ? `${text.slice(0, MAX_INPUT_CHARS)}\n\n…（文档过长，已截断）`
        : text
  }

  const history = buildHistory()
  const requestId = nextRequestId()
  const userMessage: ChatMessageItem = {
    id: nextMessageId(),
    role: 'user',
    kind: 'chat',
    text: question
  }
  const assistantMessage: ChatMessageItem = {
    id: nextMessageId(),
    role: 'assistant',
    kind: 'chat',
    text: '',
    requestId,
    loading: true
  }
  messages.push(userMessage, assistantMessage)
  draft = ''
  if (inputEl) inputEl.value = ''
  pendingId = requestId
  if (maskEl) renderPanel()

  const payload: AiChatMessage = { id: requestId, message: question, text: doc, history }
  if (jsonLength(payload) > MAX_MESSAGE_CHARS) {
    assistantMessage.loading = false
    assistantMessage.error = '文档或对话太长，暂时无法发送'
    assistantMessage.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
    return
  }

  void imk.main.send('ai.chat', payload).catch(err => {
    if (assistantMessage.requestId !== requestId) return
    assistantMessage.loading = false
    assistantMessage.error = '无法与主进程通信'
    assistantMessage.detail = String(err)
    assistantMessage.requestId = null
    pendingId = null
    if (maskEl) renderPanel()
  })
}

function handleAiReply(reply: AiReplyMessage): void {
  for (const message of messages) {
    const action = message.action
    if (action && action.requestId === reply.id) {
      action.requestId = null
      if (reply.ok && typeof reply.text === 'string') {
        action.phase = 'ready'
        action.result = reply.text
        action.error = ''
        action.detail = ''
        action.tab = 'preview'
        void loadActionPreview(action)
      } else {
        action.phase = 'error'
        action.error = typeof reply.message === 'string' ? reply.message : 'AI 请求失败'
        action.detail = typeof reply.detail === 'string' ? reply.detail : ''
      }
      break
    }
    if (message.role === 'assistant' && message.requestId === reply.id) {
      message.requestId = null
      message.loading = false
      if (reply.ok && typeof reply.text === 'string') {
        message.text = reply.text
        message.error = undefined
        message.detail = undefined
        message.truncated = reply.truncated === true
      } else {
        message.text = ''
        message.error = typeof reply.message === 'string' ? reply.message : 'AI 请求失败'
        message.detail = typeof reply.detail === 'string' ? reply.detail : ''
      }
      break
    }
  }

  if (pendingId === reply.id) pendingId = null
  if (maskEl) renderPanel()
}

// ---------- 消息 ----------

function send(channel: string, payload: Record<string, unknown>): void {
  if (jsonLength(payload) > MAX_MESSAGE_CHARS) {
    const id = typeof payload.id === 'string' ? payload.id : ''
    void imk.main
      .send(channel, { id, ok: false, message: '消息超过插件上限' })
      .catch(err => imk.plugin.log('warn', `回包发送失败：${String(err)}`))
    return
  }
  void imk.main
    .send(channel, payload)
    .catch(err => imk.plugin.log('warn', `回包发送失败：${String(err)}`))
}

function handleDocRequest(request: DocRequestMessage): void {
  const view = currentView()
  if (!view) {
    send('doc.reply', {
      id: request.id,
      ok: false,
      code: 'no-document',
      message: '当前没有打开的文档'
    })
    return
  }

  const text = view.state.doc.toString()
  const maxChars =
    typeof request.maxChars === 'number' && Number.isFinite(request.maxChars)
      ? request.maxChars
      : MAX_INPUT_CHARS
  if (text.length > maxChars) {
    send('doc.reply', {
      id: request.id,
      ok: false,
      code: 'too-large',
      message: `文档太长（${text.length} 字符），最多支持 ${maxChars} 字符`
    })
    return
  }

  const reply = { id: request.id, ok: true, text }
  if (jsonLength(reply) > MAX_MESSAGE_CHARS) {
    send('doc.reply', {
      id: request.id,
      ok: false,
      code: 'too-large',
      message: '文档太长，超过插件消息上限'
    })
    return
  }
  send('doc.reply', reply)
}

function handlePreviewOpen(message: PreviewOpenMessage): void {
  openChatPanel()
  if (message.mode === 'generate') {
    const prompt = typeof message.prompt === 'string' ? message.prompt : ''
    if (prompt) runGenerateShortcut(prompt)
  }
}

function onMessage(channel: string, data: unknown): void {
  const payload = (data ?? {}) as Record<string, unknown>
  const id = typeof payload.id === 'string' ? payload.id : ''
  try {
    if (channel === 'doc.request') {
      handleDocRequest(payload as unknown as DocRequestMessage)
      return
    }
    if (channel === 'preview.open') {
      handlePreviewOpen(payload as unknown as PreviewOpenMessage)
      return
    }
    if (channel === 'ai.reply') {
      handleAiReply(payload as unknown as AiReplyMessage)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    imk.plugin.log('warn', `处理 ${channel} 失败：${message}`)
    if (channel === 'doc.request' && id) {
      send('doc.reply', { id, ok: false, message })
    }
  }
}

// ---------- 逐行差异 ----------

function diffRows(leftText: string, rightText: string): DiffRow[] {
  const a = leftText.split('\n')
  const b = rightText.split('\n')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const am = a.slice(prefix, a.length - suffix)
  const bm = b.slice(prefix, b.length - suffix)
  const rows: DiffRow[] = []
  for (let i = 0; i < prefix; i += 1) {
    rows.push({ left: a[i] ?? '', right: b[i] ?? '', kind: 'same' })
  }

  if (am.length === 0) {
    for (const line of bm) rows.push({ left: null, right: line, kind: 'add' })
  } else if (bm.length === 0) {
    for (const line of am) rows.push({ left: line, right: null, kind: 'del' })
  } else if (am.length * bm.length <= 250_000) {
    rows.push(...lcsRows(am, bm))
  } else {
    rows.push(...fallbackRows(am, bm))
  }

  for (let i = 0; i < suffix; i += 1) {
    const li = a.length - suffix + i
    const ri = b.length - suffix + i
    rows.push({ left: a[li] ?? '', right: b[ri] ?? '', kind: 'same' })
  }
  return rows
}

interface DiffOp {
  kind: 'same' | 'del' | 'add'
  a?: string
  b?: string
}

function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = []
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', a: a[i], b: b[j] })
      i += 1
      j += 1
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      ops.push({ kind: 'del', a: a[i] })
      i += 1
    } else {
      ops.push({ kind: 'add', b: b[j] })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', a: a[i] })
    i += 1
  }
  while (j < m) {
    ops.push({ kind: 'add', b: b[j] })
    j += 1
  }
  return mergeOps(ops)
}

function mergeOps(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = []
  let k = 0
  while (k < ops.length) {
    const op = ops[k]!
    if (op.kind === 'same') {
      rows.push({ left: op.a ?? '', right: op.b ?? '', kind: 'same' })
      k += 1
      continue
    }

    const dels: string[] = []
    while (k < ops.length && ops[k]!.kind === 'del') {
      dels.push(ops[k]!.a ?? '')
      k += 1
    }
    const adds: string[] = []
    while (k < ops.length && ops[k]!.kind === 'add') {
      adds.push(ops[k]!.b ?? '')
      k += 1
    }

    const count = Math.max(dels.length, adds.length)
    for (let x = 0; x < count; x += 1) {
      const left = dels[x]
      const right = adds[x]
      const kind: DiffKind =
        left !== undefined && right !== undefined
          ? 'change'
          : left !== undefined
            ? 'del'
            : 'add'
      rows.push({ left: left ?? null, right: right ?? null, kind })
    }
  }
  return rows
}

function fallbackRows(a: string[], b: string[]): DiffRow[] {
  const rows: DiffRow[] = []
  const count = Math.max(a.length, b.length)
  for (let i = 0; i < count; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left !== undefined && right !== undefined) {
      rows.push({ left, right, kind: left === right ? 'same' : 'change' })
    } else if (left !== undefined) {
      rows.push({ left, right: null, kind: 'del' })
    } else {
      rows.push({ left: null, right: right ?? '', kind: 'add' })
    }
  }
  return rows
}

// ---------- 生命周期 ----------

imk.plugin.handle({
  onEnable() {
    ensureStyle()
    ensureStatusButton()
    syncCharacter()
    window.removeEventListener('resize', clampCharacterPosition)
    window.addEventListener('resize', clampCharacterPosition)
    offMessage?.()
    offMessage = imk.main.onMessage(onMessage)
    offDocChanged?.()
    offDocChanged = imk.editor.onDocChanged(() => {
      if (maskEl) renderActions()
    })
  },

  onDisable() {
    offMessage?.()
    offMessage = null
    offDocChanged?.()
    offDocChanged = null
    window.removeEventListener('resize', clampCharacterPosition)
    closePanel()
    removeStatusButton()
    removeCharacter()
    styleEl?.remove()
    styleEl = null
  },

  onConfigChange() {
    syncCharacter()
    if (maskEl) renderPanel()
  }
})

export {}
