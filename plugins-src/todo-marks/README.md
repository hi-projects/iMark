# 待办标记(todo-marks)

把正文里的 `TODO` / `FIXME` / `待办` 标出来,并列在右侧的面板里;点一条跳到那一行。

这是**编辑器扩展点 + 停靠面板**的样板:想看"插件怎么读文档、怎么在正文上画东西、
怎么把自己的界面停在主界面一侧",照着这个目录抄就行。

## 文件

```
todo-marks/
├── manifest.json   # kind: "sandboxed" + ui.dock + permissions
├── main.js         # 页面的入口:扫描、装饰、把结果画到面板里
├── ui/
│   ├── index.html  # 面板的页面
│   └── style.css
└── README.md
```

## 它演示了什么

- **`imark.editor.read()`** 拿到正文快照(不是文档句柄)—— 插件从来没有碰到过 CodeMirror。
- **`imark.editor.decorate()`** 给命中的行加标记:只给"范围 + 一个 class 名",
  颜色由自己注入的 CSS 决定。**宿主会把这些标记跟着文档一起挪**:
  你在标记前面打字,它不会错位。
- **`imark.editor.styles()`** 注入的样式被宿主包进 `@scope ([data-imk-plugin="todo-marks"])`
  —— 它只可能命中这个插件自己标出来的文字,漏不到界面上别的地方。
- **`ui.dock: "right"`** 让面板长在主界面的右侧栏里,而不是开一扇独立窗口。
  页面本身、会话、CSP、能力与独立窗口完全一样。
- **`file-open` / `doc-changed`** 两个事件:换文件时重扫,内容变化时(等停笔 800ms)再扫一次。
  `doc-changed` 已被宿主节流到最快约 400ms 一次,但每 400ms 重扫一篇长文仍然不划算,
  所以这里自己又加了一层静默期。

## 边界

- 面板的**顶栏**(插件名 + 「沙箱插件」+ 收起)由宿主画,插件改不了。
- 收起面板**不会**停掉插件 —— 它的页面还活着,只是屏幕上看不见。
- 标记属于**某一篇文档**:换文件时编辑器状态重建,装饰清空(所以要在 `file-open` 里重扫)。

## 打包与开发

```bash
npm run plugins:build                                   # 打进内置兜底包
npm run dev -- --plugin-dev=plugins-src/todo-marks      # 或者直接以目录为源跑(改完即热重载)
```
