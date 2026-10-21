/**
 * 助手形象：对话面板头像与浮动小人共用的一组定义。
 *
 * 这个文件同时被打进 chat 与 character 两个 webview，所以只放纯数据与
 * DOM 无关的工具函数，不碰任何宿主 API。
 */

export interface CharacterStyle {
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
export const PENGUIN_SVG = `
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

export const CHARACTERS: Record<string, CharacterStyle> = {
  cat: { emoji: '🐱', label: '猫咪' },
  penguin: { svg: PENGUIN_SVG, label: '企鹅' },
  robot: { emoji: '🤖', label: '机器人' },
  ghost: { emoji: '👻', label: '幽灵' },
  star: { emoji: '✨', label: '星星' }
}

/** 配置里的形象键 → 内置形象；未知值退回猫咪 */
export function characterStyleFrom(value: unknown): CharacterStyle {
  const key = typeof value === 'string' ? value : 'cat'
  return CHARACTERS[key] ?? CHARACTERS.cat
}

export function fillAvatar(el: HTMLElement, style: CharacterStyle): void {
  if (style.svg) el.innerHTML = style.svg
  else el.textContent = style.emoji ?? ''
}
