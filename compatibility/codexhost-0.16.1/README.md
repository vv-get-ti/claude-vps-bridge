# CodexHost 0.16.1 附件修复

本目录维护独立修复工具和上游补丁，不包含宿主二进制。使用方法见[附件支持](../../docs/ATTACHMENTS.md)。

## 来源

- 上游：[BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host)
- 基线：`v0.16.1`，提交 `de7b58ab044a2b07e0cd2b9e7666cab4b8e98020`
- 附件改动：[PR #654](https://github.com/BytePioneer-AI/codex-host/pull/654)，提交 `679f3cb27754e8eb42df75bdb8ec74811f1a3857`
- 补丁：[attachments.patch](attachments.patch)
- 原始 Host SHA256：`d31bbef947c3f72e2cf5eb21b7db40fdd1467542adb30160d23931b2df464cf4`
- 修复 Host SHA256：`500fc46bbd4c89797eb5edb540d9340f139fe88e5c784dad17629e30b511c5cd`

官方 Windows x64 与 Linux x64 发行包的原始 Host 文件哈希相同。本修复只替换此文件；原生启动器、Renderer、Controller 及内置插件沿用官方版本，不改变发行元数据。

## 从对应源码构建

Release 提供已应用该补丁的完整上游源码快照；使用 GitHub 上的上游仓库时，先检出上述基线，再用 `git apply --unidiff-zero /path/to/attachments.patch` 应用补丁，不要重复应用到已打补丁的快照。

使用 Node.js 24，在源码根目录执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build:typescript
node packages/host-runtime/scripts/build-release.mjs --output host-runtime.mjs
```

构建命令使用上游自己的打包与依赖边界检查。将输出与 Release 中的校验值比较。

## 验证与许可

在 Windows 使用新基线与补丁完成构建，附件、追加消息、队列与路由等 187 项相关测试通过。相同 Host 文件已经在 Windows 与 Linux x64 VPS 安装验证；修复工具另有独立的应用、幂等、恢复和拒绝用例。

CodexHost 源码与修改采用 LGPL-3.0-only。二进制修复包附对应源码下载入口、LGPL/GPL 正文及第三方许可。源码快照包含构建脚本与依赖锁文件；npm 依赖由构建时下载。
