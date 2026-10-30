# 第三方来源与依赖

本仓库采用 LGPL-3.0-only。`LICENSE` 为 LGPL v3，`LICENSE-GPL-3.0` 包含其引用的 GPL v3 正文。

| 项目 | 用途 | 声明的许可证 / 来源 |
|---|---|---|
| CodexHost 0.16.1 | Host 插件接口、受管理的远端 Claude 适配器 | LGPL-3.0-only；[v0.16.1 源码](https://github.com/BytePioneer-AI/codex-host/tree/v0.16.1) |
| picomatch 4.0.3 | 路径匹配 | MIT |
| yaml 2.8.1 | 本机规则与能力元数据 | ISC |
| @playwright/mcp 0.0.80（可选） | 本机浏览器 MCP | Apache-2.0 |
| Playwright / playwright-core（可选传递依赖） | 浏览器执行 | Apache-2.0 |

第三方 npm 包由使用者安装时按锁文件下载，不以 `node_modules` 形式提交。精确版本、完整性哈希与包来源见 `plugin/runtime/package-lock.json`。依赖自身的许可文本应随相应软件包保留。

CodexHost 适配器通过独立依赖目录安装；本仓库不复制其完整构建产物。插件仅使用公开 Harness 接口，不包含宿主输入补丁。

官方 Claude Code 和 Codex Desktop 由各自权利方提供，本仓库不分发它们的二进制、账号或凭据。它们自身的条款不因本仓库许可证而改变。

## Clawd 图形

图标中的 Clawd 轮廓来自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)，保留原路径和比例。本机终端、VPS 和连接线为本项目组合设计。Clawd 角色属于 Anthropic。

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
