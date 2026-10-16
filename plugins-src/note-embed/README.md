# 笔记引用面板(note-embed)

在自己的窗口里浏览当前仓库,把某篇笔记的内容插进正在写的那一篇。

这也是**沙箱插件的样板**:想看"一个有界面的插件最少要写哪些文件",照着这个目录抄就行。

## 文件

```
note-embed/
├── manifest.json     清单:kind: "sandboxed" + ui.entry + permissions
├── main.js           页面的入口(清单里的 main),跑在**插件自己的页面**里
├── ui/
│   ├── index.html    窗口加载的页面
│   ├── app.js        界面逻辑
│   └── style.css     样式(颜色走主题令牌,自动跟随三档主题)
└── README.md         本文件
```

## 它演示了什么

- **一个插件同时是"后台的"和"有界面的"**:清单里的 `statusBar` 让它在状态栏常驻一个入口,
  点进去才 `imark.window.show()` 把窗口亮出来。作者不必为两种形态写两套代码。
- **能力按清单注入**:`permissions` 里没写的命名空间在页面里**压根不存在**
  (不是"调用了才报错")。这个插件声明了 `ui`(开自己的窗口)、`vault:read`(读仓库)、
  `editor:write`(往当前文档插内容)—— 所以它拿不到 `imark.net`、`imark.git`、`imark.secrets`。
- **文档只由宿主来改**:面板只把文本交给 `imark.editor.insert(text)`,插到哪一行由宿主决定。
- **主题不需要额外代码**:颜色全用 `var(--…)`,令牌由宿主注入,换主题时自动跟着变。

## 沙箱插件的两条硬规矩

1. **页面里没有 Node**:没有 `require`、没有 `fs`、没有 `process`。一切经 `window.imark`。
2. **页面里不能直接联网**:CSP 的 `connect-src 'self'` 会把 `fetch('https://…')` 拦掉。
   要联网得声明 `network` 权限,然后走 `imark.net.fetch`(宿主代发,并发与频率有上限,
   默认还会拒绝连本机/内网地址)。

## 打包

```bash
npm run plugins:build      # 会把本目录打成 src/main/market/builtin/note-embed.imkpkg.json
```

开发时不必打包:直接

```bash
npm run dev -- --plugin-dev=plugins-src/note-embed
```

改完文件保存即生效(宿主盯着目录做热重载)。
