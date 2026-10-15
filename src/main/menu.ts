import { Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuCommandId } from '@shared/ipc-channels'
import { getMainWindow } from './window'

function send(id: MenuCommandId): void {
  getMainWindow()?.webContents.send(IPC.MenuCommand, id)
}

function fmt(label: string, id: MenuCommandId, accelerator?: string): MenuItemConstructorOptions {
  return { label, accelerator, click: () => send(id) }
}

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        fmt('新建', 'file:new', 'CmdOrCtrl+N'),
        fmt('打开...', 'file:open', 'CmdOrCtrl+O'),
        fmt('打开仓库...', 'file:open-vault', 'CmdOrCtrl+Alt+O'),
        fmt('快速切换文件...', 'file:quick-switch', 'CmdOrCtrl+P'),
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
        fmt('插件市场', 'view:market', 'CmdOrCtrl+Shift+P'),
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
