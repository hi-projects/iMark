# 待办标记(todo-marks)

把正文里的 `TODO` / `FIXME` / `待办` 标出来,并列在右侧面板里;点一条跳到那一行。

这是 **render-only** 的样板:没有 main 层,不申请任何系统能力,直接拿宿主的 EditorView 与 CM6 kit。

## 文件

```
todo-marks/
├── manifest.json   # render: { entry: "main.js" },没有 main、没有 permissions
├── main.ts         # render 入口:装饰、面板、点击跳转
└── README.md
```

## 它演示了什么

- **真实 EditorView**:`imk.editor.getView()` 返回宿主同一个实例。
- **共享 CM6 kit**:`imk.editor.kit.view.Decoration` / `StateField` / `RangeSetBuilder` 都来自宿主模块,
  不要自己 bundle `@codemirror/*`(否则 facet 身份不一致,扩展会静默失效)。
- **自己管装饰**:用一个 `StateField` + `StateEffect`,文档变化时 `map(tr.changes)`,重扫时整体替换。
- **自己的 DOM 与样式**:面板由插件自己创建、自己移除;样式用 `imk-todo-` 前缀并挂在
  `data-imk-plugin="todo-marks"` 下,不污染宿主。
- **文档变化**:`imk.editor.onDocChanged` + 500ms 静默期,停笔后再扫。
- **清理**:`onDisable` 里注销扩展、移除面板/样式/定时器。

## 边界

- render 层没有系统能力:要读别的文件、联网、git 都必须加 main 层并走消息。
- 标记属于某一篇文档:换文件时编辑器 state 重建,`registerExtension` 注册的扩展会由宿主的
  compartment 重新收集,`onDocChanged` 会触发重扫。

## 打包与开发

```bash
npm run plugins:build                                   # 打进内置兜底包
npm run dev -- --plugin-dev=plugins-src/todo-marks      # 或者直接以目录为源跑(改完即热重载)
```

`plugins-src/tsconfig.render.json` 负责编译 `main.ts`;render 入口会被剥掉 tsc 的 `export {}` 标记。
