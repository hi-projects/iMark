/**
 * 应用图标(png)在运行时的实际路径;找不到返回 undefined。
 *
 * 两处用它:窗口图标(见 window.ts)与文件关联的 .ico 生成(见 system.ts)。
 *
 * 三处候选,顺序就是优先级:
 *   1. electron-vite 的 `?asset` —— 文件被复制进产物目录,再随 `files: [out/**]`
 *      一并进 asar,**打包后唯一保证命中的就是它**(那时 `app.getAppPath()` 指向
 *      app.asar,而 `build/` 不在 files 里);
 *   2. 直接从源码目录跑(仓库里的 `build/icon.png`,验收 harness 走的就是这条);
 *   3. electron-builder 打包后(图标进 resources)。
 * 都不存在就返回 undefined,让调用方决定退路 —— 总好过递一个不存在的路径。
 */

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import iconPath from '../../build/icon.png?asset'

export function appIconPng(): string | undefined {
  const candidates = [
    iconPath,
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  return candidates.find(p => existsSync(p))
}
