# 第三方组件声明

iMark 自身代码的许可状态见仓库说明。下面列出随应用分发、需要保留版权声明的第三方代码。

## PDF.js

AI for Edit 插件在 render 入口里内联了 [PDF.js](https://github.com/mozilla/pdf.js)
（`pdfjs-dist` 6.4.299，legacy 构建），用于从 PDF 参考文件中提取文字。

Copyright 2024 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

完整许可证文本见 `plugins-src/ai-for-edit/PDFJS-LICENSE.txt`。
