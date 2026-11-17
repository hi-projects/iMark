#!/usr/bin/env node
/**
 * 把 iDraw 仓库构建好的扩展包同步进 iMark 的内置目录。
 *
 * iDraw 的画布代码与 iMark 的插件宿主是两套构建:
 *   iDraw 仓库: npm run plugin:build → dist/imark/idraw.canvas.imkpkg.json
 *   iMark 仓库: 本脚本复制到 src/main/market/builtin/
 *
 * 复制之后跑一次 `npm run plugins:build`(或直接 `npm run build`)即可让内置包
 * 参与和官方扩展完全相同的校验、安装与补装流程。
 *
 *   IDRAW_ROOT=/path/to/iDraw-main npm run idraw:builtin
 */

import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IDRAW_ROOT = resolve(process.env.IDRAW_ROOT || join(ROOT, '..', 'iDraw-main'))
const SOURCE = join(IDRAW_ROOT, 'dist', 'imark', 'idraw.canvas.imkpkg.json')
const TARGET = join(ROOT, 'src', 'main', 'market', 'builtin', 'idraw.canvas.imkpkg.json')

if (!existsSync(SOURCE)) {
  console.error(`找不到 iDraw 扩展包：${SOURCE}`)
  console.error('先在 iDraw 仓库里运行 npm run plugin:build，或用 IDRAW_ROOT 指定仓库路径。')
  process.exit(1)
}

copyFileSync(SOURCE, TARGET)
console.log(`[idraw] ${SOURCE} → src/main/market/builtin/idraw.canvas.imkpkg.json`)
