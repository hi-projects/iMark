/**
 * 启动意图:这次是被「普通方式」拉起来的,还是用户明确要一个新窗口。
 *
 * Windows 的「中键 / Shift+点击任务栏图标新开一个」不会给应用发消息,也不会
 * 自带特殊参数 —— 它只是让 shell 按窗口上登记的 `System.AppUserModel.RelaunchCommand`
 * 再启动一份进程。所以「用户要新窗口」这个意图只能由我们自己写进 RelaunchCommand
 * 的参数传进来(登记见 main/window.ts)。
 *
 * 没有这个参数时:
 *   - 勾了「启动时直接打开上次仓库」的实例会去恢复上次仓库;如果那个仓库已经
 *     开在别的窗口,不会再退出,而是改在新窗口里停在仓库选择页(见 index.ts):
 *     用户再点一次应用本来就是「再开一个」,多开要能真的多出一个窗口。
 * 带这个参数时:
 *   - 跳过恢复与占用协调,直接在新的窗口里停在仓库选择页;
 *   - 用户仍可在新窗口里选一个仓库,但那一步照常遵守「同一个仓库只开一个窗口」。
 */

import { app } from 'electron'

/**
 * 打包版与 electron-builder.yml 的 appId 一致;快捷方式、任务栏分组与通知都靠它归到一起。
 *
 * **开发版必须用另一个 ID**。Windows 11 的任务栏会按 AppUserModelID 记住图标:
 * 开发版曾经用打包版的 ID 跑过、图标落到 exe(Electron)之后,即使把窗口的
 * RelaunchIconResource 改成 iMark.ico,同一个 ID 也刷不回来(2026-10-26 实测:
 * 同样的 .ico 换一个全新 ID 立刻生效)。独立 ID 还顺带把开发版和已安装的 iMark
 * 在任务栏上分成两个按钮 —— 本来就该分开。
 */
export const APP_USER_MODEL_ID = app.isPackaged ? 'com.imarkdown.app' : 'com.imarkdown.app.dev'

/** 由任务栏 RelaunchCommand 传入:用户明确要求一个新窗口 */
export const NEW_WINDOW_FLAG = '--new-window'

/** 本进程是不是被任务栏「新开一个」拉起来的 */
export const launchedForNewWindow = process.argv.includes(NEW_WINDOW_FLAG)

/**
 * 本次实例是否**必须**停在仓库选择页。
 *
 * 启动流程认领仓库之后才知道:任务栏「新开一个」是一种,另一种是「上次仓库
 * 已经开在别的窗口」—— 那种情况下这个实例恢复不了上次仓库,但它也不该白白
 * 退出,而应当就是用户多开出来的那个新窗口。
 *
 * 建窗与渲染层都读这一份结论(渲染层据此跳过自动恢复)。
 */
let startAtPicker = false

/** 由 index.ts 的启动流程决定;只调一次 */
export function markStartAtPicker(): void {
  startAtPicker = true
}

export function startsAtPicker(): boolean {
  return startAtPicker
}
