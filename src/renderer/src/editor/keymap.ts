import type { KeyBinding } from '@codemirror/view'
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertImage,
  insertLink,
  setHeading,
  toggleBlockQuote,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList
} from './commands'

/**
 * 编辑器兜底键位。原生菜单加速键会在 keydown 到达渲染层之前被拦截,
 * 这里主要作为菜单缺失场景的兜底;标点键同时绑定原始键与 shift 后的键名。
 */
export const editorKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-e', run: toggleInlineCode },
  { key: 'Alt-Shift-5', run: toggleStrikethrough },
  { key: 'Alt-%', run: toggleStrikethrough },
  { key: 'Mod-Shift-k', run: insertCodeBlock },
  { key: 'Mod-Shift-q', run: toggleBlockQuote },
  { key: 'Mod-Shift-]', run: toggleBulletList },
  { key: 'Mod-}', run: toggleBulletList },
  { key: 'Mod-Shift-[', run: toggleOrderedList },
  { key: 'Mod-{', run: toggleOrderedList },
  { key: 'Mod-Shift-x', run: toggleTaskList },
  { key: 'Mod-Shift--', run: insertHorizontalRule },
  { key: 'Mod-_', run: insertHorizontalRule },
  { key: 'Mod-1', run: v => setHeading(v, 1) },
  { key: 'Mod-2', run: v => setHeading(v, 2) },
  { key: 'Mod-3', run: v => setHeading(v, 3) },
  { key: 'Mod-4', run: v => setHeading(v, 4) },
  { key: 'Mod-5', run: v => setHeading(v, 5) },
  { key: 'Mod-6', run: v => setHeading(v, 6) },
  { key: 'Mod-0', run: v => setHeading(v, 0) },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-Shift-i', run: insertImage }
]
