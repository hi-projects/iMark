# 笔记引用面板(note-embed)

浏览当前仓库,把某篇笔记的内容插进正在写的那一篇。

这是 **restricted main + render 两层**的样板:main 在隐藏沙箱页里读仓库,render 在主窗口里画面板与插入文本,两层只传消息。

## 文件

```
note-embed/
├── manifest.json   # main.mode: "restricted" + render + permissions: ["vault:read"]
├── main.ts         # restricted main:读 vault,经 imark.render.send 交给 render
├── render.ts       # render 层:自己画面板、订阅消息、直接操作 EditorView
└── README.md
```

## 它演示了什么

- **能力只在 main 层**:`permissions` 里只有 `vault:read`。render 层没有 `vault`/`net`/`git`/`secrets`,
  它要读笔记只能 `imk.main.send('read', { path })`。
- **两层消息**:render 发 `list` / `read`;main 回 `notes` / `preview` / `note.chunk`。
  长笔记按 200k 字符分块,避开单条消息 256 KiB 的上限。
- **动作路由**:清单里的 `toggle` 有 main 层,所以路由到 main;main 用
  `imk.render.send('toggle')` 让 render 展开/收起面板。
- **render 直接拿编辑器**:插入时 `imk.editor.getView()` → `view.dispatch({ changes })`。

## 安全边界

- main 层跑在隐藏沙箱页:没有 `require`/`process`/`fs`,每次 `vault.read` 都过宿主闸门。
- render 层与主界面同 realm:能改界面/读当前文档/看键盘输入 —— 安装确认框会要求勾选。

## 打包与开发

```bash
npm run plugins:build      # 打成 src/main/market/builtin/note-embed.imkpkg.json
npm run dev -- --plugin-dev=plugins-src/note-embed
```

`plugins-src/tsconfig.restricted.json` 负责 `main.ts`,`tsconfig.render.json` 负责 `render.ts`。
