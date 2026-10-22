/**
 * 设置面板的内部导航状态。
 *
 * 单独一个模块(不再叫 pluginService):它只描述「设置面板现在停在哪一屏」,
 * 与扩展运行时没有任何关系。设置页、市场页与命令面板都读同一份状态,
 * 于是从菜单打开市场、点到某个扩展详情再关掉设置、重新打开,看到的还是原来那一屏。
 */

import { reactive } from 'vue'
import { openSettings } from '../stores/app'

/** 市场页内部的子导航:三个页签 + 列表页的搜索条件 */
export interface MarketNav {
  tab: 'browse' | 'installed' | 'publish'
  /** 打开某个扩展的详情页(仅 browse 页签用);null = 显示列表 */
  detailId: string | null
  query: string
  page: number
  sort: 'updated' | 'name' | 'downloads'
  /** null = 全部;true = 含代码;false = 纯声明 */
  hasMain: boolean | null
}

/** 设置面板当前选中项:外观、编辑器、系统、某个扩展的配置,或扩展市场 */
export const settingsNav = reactive<{
  page: 'appearance' | 'editor' | 'system' | 'plugin' | 'market'
  pluginId: string | null
  /**
   * 市场内部的子导航放在这里,而不是继续往 page 联合里塞 ——
   * 市场里的「列表 / 详情 / 发布」是同一页的状态,不是三个并列的设置页,
   * 拆成三个 page 会让「从哪个入口进来的」变得无从恢复。
   */
  market: MarketNav
}>({
  page: 'appearance',
  pluginId: null,
  // 默认落在「已安装」:没有市场服务端时这一页照样有内容,不会一进来就看到报错
  market: { tab: 'installed', detailId: null, query: '', page: 1, sort: 'updated', hasMain: null }
})

/** 打开设置面板并定位到扩展市场(菜单项与左栏入口用) */
export function openMarketSettings(): void {
  settingsNav.market.tab = 'browse'
  settingsNav.market.detailId = null
  settingsNav.page = 'market'
  openSettings()
}
