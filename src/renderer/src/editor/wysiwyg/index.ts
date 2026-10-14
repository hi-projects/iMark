import type { Extension } from '@codemirror/state'
import { wysiwygViewPlugin } from './build'

/** WYSIWYG 扩展:语法树驱动的显隐装饰 + 原子区间 + Ctrl+点击链接 */
export function wysiwyg(): Extension {
  return wysiwygViewPlugin
}
