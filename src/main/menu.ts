import { Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuCommandId } from '@shared/ipc-channels'
import { normalizeKeybinding } from './extensions/contributions'
import { getMainWindow } from './window'

function send(id: MenuCommandId): void {
  getMainWindow()?.webContents.send(IPC.MenuCommand, id)
}

function fmt(label: string, id: MenuCommandId, accelerator?: string): MenuItemConstructorOptions {
  return { label, accelerator, click: () => send(id) }
}

/** 一条准备进「扩展」菜单的命令 */
export interface ExtensionMenuCommand {
  command: string
  title: string
  category?: string
  keybinding?: string
  available: boolean
  /** 清单里的快捷键已经在贡献点快照里判定为冲突,菜单不再挂加速键 */
  dropped?: boolean
}

export interface ExtensionMenuGroup {
  extensionId: string
  extensionName: string
  commands: ExtensionMenuCommand[]
}

/** 因为撞车而被摘掉快捷键的一条 */
export interface DroppedExtensionKeybinding {
  extensionId: string
  extensionName: string
  command: string
  key: string
  takenBy: string
}

let extensionGroups: ExtensionMenuGroup[] = []
let built = false

/**
 * 更新扩展命令(扩展服务在贡献点变化时调)。
 *
 * 返回本次**因为与别的菜单项撞车**而被摘掉的快捷键;清单级别的冲突
 * (`dropped: true`)已经在贡献点快照里标好,不会重复报告。
 */
export function setExtensionCommands(groups: ExtensionMenuGroup[]): DroppedExtensionKeybinding[] {
  extensionGroups = groups
  return built ? buildAppMenu().extensionDropped : []
}

/**
 * 扩展命令那一栏。
 *
 * 点击不在这里直接调 `executeCommand`:命令的真正执行入口统一在渲染层的
 * `command.execute` 上(错误提示、忙碌状态、行首菜单参数都在那边),主进程
 * 直接把命令 id 递过去即可。原生菜单存在的意义只是让快捷键有一个宿主。
 */
function extensionMenu(groups: ExtensionMenuGroup[]): MenuItemConstructorOptions[] {
  if (groups.length === 0) return []
  const items: MenuItemConstructorOptions[] = []
  for (const g of groups) {
    items.push({
      label: g.extensionName,
      submenu: g.commands.map(c => ({
        label: c.category ? `${c.category}: ${c.title}` : c.title,
        // 清单里已判定冲突的快捷键不再挂到这里:挂上去 Electron 会随机挑一个赢家
        accelerator: c.dropped ? undefined : c.keybinding,
        enabled: c.available,
        click: () => {
          getMainWindow()?.webContents.send(IPC.ExtensionCommand, {
            command: c.command,
            from: 'keybinding'
          })
        }
      }))
    })
  }
  return [{ label: '扩展', submenu: items }]
}

interface AcceleratorOwner {
  extensionId: string
  extensionName: string
  command: string
}

/**
 * 同一份菜单里出现两次的快捷键,后者摘掉。
 *
 * **顺序即优先级**:应用自己的项排在最前,所以扩展永远抢不走 Ctrl+S。
 * 这不是为了公平,是因为 Electron 对重复快捷键的处理是"未定义里挑一个"——
 * 与其让用户得到一个随机的赢家,不如我们自己定。
 *
 * 摘掉而不是报错:一个键冲突不该让整条命令消失,它照样能从命令面板里点到。
 */
function dedupeAccelerators(
  template: MenuItemConstructorOptions[],
  locate: Map<MenuItemConstructorOptions, AcceleratorOwner>
): DroppedExtensionKeybinding[] {
  const owner = new Map<string, string>()
  const extensionDropped: DroppedExtensionKeybinding[] = []
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.accelerator) {
        const key = normalizeKeybinding(item.accelerator)
        const prev = owner.get(key)
        if (prev) {
          const who = locate.get(item)
          if (who) {
            extensionDropped.push({
              extensionId: who.extensionId,
              extensionName: who.extensionName,
              command: who.command,
              key: item.accelerator,
              takenBy: prev
            })
          }
          delete item.accelerator
        } else {
          owner.set(key, item.label ?? '')
        }
      }
      if (Array.isArray(item.submenu)) walk(item.submenu)
    }
  }
  walk(template)
  return extensionDropped
}

/** 固定菜单(不含动态生成的扩展栏) */
function baseMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: '文件',
      submenu: [
        fmt('新建', 'file:new', 'CmdOrCtrl+N'),
        fmt('打开...', 'file:open', 'CmdOrCtrl+O'),
        fmt('打开仓库...', 'file:open-vault', 'CmdOrCtrl+Alt+O'),
        fmt('快速切换文件...', 'file:quick-switch', 'CmdOrCtrl+P'),
        { type: 'separator' },
        // 标签页快捷键必须挂成原生菜单项才会生效(窗口菜单栏虽隐藏,菜单对象仍在)。
        // Ctrl+Tab / Ctrl+Shift+Tab 是跨编辑器的通用约定,与 Obsidian 一致。
        fmt('关闭标签页', 'file:close-tab', 'CmdOrCtrl+W'),
        fmt('下一个标签页', 'file:next-tab', 'Ctrl+Tab'),
        fmt('上一个标签页', 'file:prev-tab', 'Ctrl+Shift+Tab'),
        { type: 'separator' },
        fmt('保存', 'file:save', 'CmdOrCtrl+S'),
        fmt('另存为...', 'file:save-as', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        fmt('导出 HTML...', 'file:export-html', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '格式',
      submenu: [
        fmt('加粗', 'format:bold', 'CmdOrCtrl+B'),
        fmt('斜体', 'format:italic', 'CmdOrCtrl+I'),
        fmt('删除线', 'format:strike', 'Alt+Shift+5'),
        fmt('行内代码', 'format:inline-code', 'CmdOrCtrl+E'),
        fmt('代码块', 'format:code-block', 'CmdOrCtrl+Shift+K'),
        { type: 'separator' },
        fmt('引用', 'format:quote', 'CmdOrCtrl+Shift+Q'),
        fmt('无序列表', 'format:bullet-list', 'CmdOrCtrl+Shift+]'),
        fmt('有序列表', 'format:ordered-list', 'CmdOrCtrl+Shift+['),
        fmt('任务列表', 'format:task-list', 'CmdOrCtrl+Shift+X'),
        fmt('分隔线', 'format:hr', 'CmdOrCtrl+Shift+-'),
        { type: 'separator' },
        {
          label: '标题',
          submenu: [
            fmt('一级标题', 'format:h1', 'CmdOrCtrl+1'),
            fmt('二级标题', 'format:h2', 'CmdOrCtrl+2'),
            fmt('三级标题', 'format:h3', 'CmdOrCtrl+3'),
            fmt('四级标题', 'format:h4', 'CmdOrCtrl+4'),
            fmt('五级标题', 'format:h5', 'CmdOrCtrl+5'),
            fmt('六级标题', 'format:h6', 'CmdOrCtrl+6'),
            { type: 'separator' },
            fmt('正文', 'format:plain', 'CmdOrCtrl+0')
          ]
        },
        { type: 'separator' },
        fmt('链接', 'format:link', 'CmdOrCtrl+K'),
        fmt('图片', 'format:image', 'CmdOrCtrl+Shift+I')
      ]
    },
    {
      label: '视图',
      submenu: [
        fmt('文件列表', 'view:toggle-explorer', 'CmdOrCtrl+Shift+L'),
        fmt('大纲', 'view:toggle-outline', 'CmdOrCtrl+Shift+O'),
        fmt('循环切换主题', 'view:toggle-theme', 'CmdOrCtrl+J'),
        fmt('设置...', 'view:settings', 'CmdOrCtrl+,'),
        fmt('扩展市场', 'view:market', 'CmdOrCtrl+Shift+P'),
        // Ctrl+Shift+P 早被市场占了(VSCode 里它是命令面板),这里退一步用 Alt+P。
        // 与 Ctrl+Alt+O(打开仓库)是同一条腿的记忆:Alt 那一档留给"跳出去"的操作。
        fmt('命令面板...', 'view:command-palette', 'CmdOrCtrl+Alt+P'),
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '重置缩放', role: 'resetZoom' },
        { type: 'separator' },
        {
          // Ctrl+Shift+I 留给"插入图片",devtools 只绑 F12
          label: '开发者工具',
          accelerator: 'F12',
          click: () => getMainWindow()?.webContents.toggleDevTools()
        }
      ]
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 iMark', role: 'about' }]
    }
  ]
}

/**
 * 应用自己占用的快捷键集合(规范形式)。
 *
 * 扩展服务用它给 `contributes.keybindings` 做第一道冲突判定:清单里就撞车的
 * 条目会在贡献点快照里标成 `dropped`,设置页据此告诉用户"这条快捷键没生效",
 * 而不是等菜单重建时才发现某一条被悄悄摘掉。
 */
export function reservedAccelerators(): ReadonlySet<string> {
  const keys = new Set<string>()
  const walk = (items: MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.accelerator) keys.add(normalizeKeybinding(item.accelerator))
      if (Array.isArray(item.submenu)) walk(item.submenu)
    }
  }
  walk(baseMenuTemplate())
  return keys
}

export function buildAppMenu(): { extensionDropped: DroppedExtensionKeybinding[] } {
  const template = baseMenuTemplate()
  const extensionGroupsShown = extensionGroups.filter(g => g.commands.length > 0)
  const extensionBar = extensionMenu(extensionGroupsShown)
  const helpIndex = template.findIndex(item => item.label === '帮助')
  template.splice(helpIndex < 0 ? template.length : helpIndex, 0, ...extensionBar)

  // 扩展项在模板里的位置是确定的:按分组顺序展开,边展开边登记 owner,
  // 这样去重时能反查"是哪一条命令被摘了快捷键"。
  const locate = new Map<MenuItemConstructorOptions, AcceleratorOwner>()
  for (const [barIndex, bar] of extensionBar.entries()) {
    const group = extensionGroupsShown[barIndex]
    if (!group || !Array.isArray(bar.submenu)) continue
    bar.submenu.forEach((item, itemIndex) => {
      const command = group.commands[itemIndex]
      if (command) {
        locate.set(item, {
          extensionId: group.extensionId,
          extensionName: group.extensionName,
          command: command.command
        })
      }
    })
  }

  const extensionDropped = dedupeAccelerators(template, locate)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // 没有这一句,setExtensionCommands() 就永远走「还没建过,先记着」那条分支 ——
  // 菜单会冻结在启动那一刻的内容:扩展后来启停、注册新命令,菜单里一概看不见。
  built = true
  return { extensionDropped }
}
