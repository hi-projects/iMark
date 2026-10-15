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
