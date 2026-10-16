/**
 * Quick Edit —— 光标行左侧「+」菜单里的内容插入。
 *
 * 这个插件的存在本身就是那个贡献点的样板:它只做两件事 ——
 * 在清单里声明「菜单里有一条『表格』,点它要问行数与列数」,
 * 以及在 runAction 里把这两个数字变成一段 Markdown 文本。
 *
 * **它从头到尾碰不到编辑器**:按钮、菜单、对话框、光标的落点全部由宿主实现,
 * 插件只是把文本交回去(`editor` 字段)。这样即使插件写得再糟,也顶多插入一段难看的文本。
 *
 * 插件源码只允许依赖 `@shared/*` 的**类型**(import type)—— 值导入会留下
 * `require('@shared/…')`,在用户机器上直接 MODULE_NOT_FOUND。
 */

import type { ImkApi, PluginRuntime } from '@shared/pluginApi'
import type { PluginActionResult } from '@shared/plugins'

/** 行列的边界:清单里声明给对话框用,这里再夹一次 —— 插件不该假定调用方一定守规矩 */
const ROWS_MIN = 1
const ROWS_MAX = 50
const ROWS_DEFAULT = 3
const COLS_MIN = 1
const COLS_MAX = 20
const COLS_DEFAULT = 3

/** 单元格宽度:让表头、内容行与分隔行在源码里对齐 */
const CELL = '     '
const SEPARATOR_CELL = ' --- '

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * 生成一张空表。
 *
 * `rows` **含表头**:第一行是表头,第二行是 Markdown 表格必需的分隔行,之后才是内容行。
 * 分隔行写 `---` 不带冒号 —— 那是 GFM 的默认对齐(渲染成左对齐),
 * 想改对齐方式的人可以自己往单元格里加 `:`。
 */
function buildTable(rows: number, cols: number): { text: string; cursorOffset: number } {
  // 行首一个 `|`、每格后面一个 —— 直接 `|${CELL}|`.repeat(cols) 会把相邻两格的竖线
  // 叠成 `||`,而 `||` 之间那个空串在 GFM 里也算一格,列数会凭空翻倍
  const blank = `|${`${CELL}|`.repeat(cols)}`
  const lines = [blank, `|${`${SEPARATOR_CELL}|`.repeat(cols)}`]
  for (let i = 1; i < rows; i++) lines.push(blank)
  // 光标落在第一个表头单元格里,确定之后可以直接开始打字
  return { text: lines.join('\n'), cursorOffset: 2 }
}

class QuickEditPlugin {
  constructor(private readonly imk: ImkApi) {}

  /** 宿主只认「至少实现一个生命周期方法」的对象,而这个插件没有需要启动/收尾的东西 */
  onEnable(): void {
    this.imk.log('debug', 'Quick Edit 已就绪:行首「+」菜单由宿主渲染')
  }

  async runAction(
    actionId: string,
    _ctx: unknown,
    _targetId?: string,
    payload?: { values?: Record<string, unknown> }
  ): Promise<PluginActionResult> {
    if (actionId !== 'insert-table') {
      return { ok: false, message: `未知动作:${actionId}` }
    }

    const rows = clampInt(payload?.values?.rows, ROWS_MIN, ROWS_MAX, ROWS_DEFAULT)
    const cols = clampInt(payload?.values?.cols, COLS_MIN, COLS_MAX, COLS_DEFAULT)
    const { text, cursorOffset } = buildTable(rows, cols)

    return {
      ok: true,
      message: `已插入 ${rows} × ${cols} 表格`,
      editor: { text, cursorOffset }
    }
  }
}

export = (imk: ImkApi): PluginRuntime => new QuickEditPlugin(imk)
