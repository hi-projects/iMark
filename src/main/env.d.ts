/**
 * electron-vite/Vite 的 `?raw` 导入:把文件内容当作字符串内联进 bundle。
 *
 * 主进程侧的 tsconfig 只装了 `types: ["node"]`,没有 `vite/client`,
 * 所以这里要自己声明一次。
 *
 * 用途见 market/bundled.ts:内置的插件包以 `?raw` 字符串导入,而不是当 JSON 模块
 * ——`resolveJsonModule` 会把里面那个几十 KB 的 base64 推断成巨型字面量类型把 tsc 拖垮,
 * 而字符串还有第二个好处:它被内联进主进程 bundle,于是**完全绕开 asar 与
 * `files: [out/**]` 的打包限制**,不需要 extraResources,也不需要区分 dev/prod 路径。
 */
declare module '*?raw' {
  const content: string
  export default content
}

/**
 * electron-vite 的 `?asset` 导入:文件被复制进产物目录,导入得到运行时可用的绝对路径。
 *
 * 与上面的 `?raw` 同样绕开 asar 与 `files: [out/**]` 的限制(产物落进 out/,会被一并打包),
 * 差别在它是给**二进制**用的 —— PNG 走 `?raw` 会被当 utf-8 文本读坏,内容是乱的。
 * 用途见 window.ts:窗口图标。
 */
declare module '*?asset' {
  const src: string
  export default src
}
