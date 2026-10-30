# 附件支持

## 查看本机文件

将图片、PDF 或其他文件保存到当前项目，告诉 Claude 文件路径即可。图片和 PDF 可以传给远端 Claude；其他文件由 Claude 根据任务调用本机工具处理。

插件不会自动抽帧、转码或压缩文件。大小与格式说明见 [FAQ](FAQ.md#为什么拖入的附件不可用)。

## 拖入和粘贴图片

CodexHost 0.16.1 官方发行包尚未包含 [PR #654](https://github.com/BytePioneer-AI/codex-host/pull/654) 的附件传递修复。本项目提供独立修复包，保留外部 Agent 的图片引用，并支持运行中追加图片。

- [下载附件修复包（Windows x64 / Linux x64）](https://github.com/vv-get-ti/claude-vps-bridge/releases/latest/download/codexhost-0.16.1-attachment-fix.zip)
- [下载修复所用的 CodexHost 源码](https://github.com/vv-get-ti/claude-vps-bridge/releases/latest/download/codexhost-0.16.1-attachment-fix-source.zip)
- [查看 SHA256 校验值](https://github.com/vv-get-ti/claude-vps-bridge/releases/latest/download/SHA256SUMS.txt)

修复工具需要 Python 3.11+。仅支持官方 0.16.1 的已验证宿主文件；版本或哈希不匹配时停止，不修改其他安装。只替换 `app/host-runtime.mjs`，不修改插件、模型设置、凭据或聊天。已包含同一修复时直接返回 `already-patched`。

### Windows

解压修复包，正常退出 CodexHost，在解压目录打开 PowerShell。先检查，再应用：

```powershell
python .\apply_fix.py --host-root 'D:\Apps\CodexHost' --check
python .\apply_fix.py --host-root 'D:\Apps\CodexHost'
```

替换为自己的安装目录。`codexhost` 在 PATH 且可定位安装时，可省略 `--host-root`。完成后重新打开 CodexHost，拖入或粘贴图片发送给 Claude VPS Bridge。

### Linux 远端宿主（按需）

仅在你也通过 VPS 的 CodexHost 宿主接收附件时应用。桥接插件的独立 Claude 适配器无需打此补丁。

在解压目录执行 `python3 apply_fix.py --check` 检查自动发现的安装位置。找不到时，使用 `--host-root` 指向含 `app/` 的平台包目录，通常在 `@codexhost/cli/node_modules/@codexhost/cli-linux-x64` 下。

确认没有运行中的任务后，执行：

```bash
codexhost remote stop
python3 apply_fix.py
codexhost remote start
```

如果修复失败，保留错误输出并重新启动原宿主；不要把未知版本的文件强行替换。

### 恢复

原文件保存在安装目录的 `.claude-vps-attachment-fix/0.16.1/host-runtime.original.mjs`。退出宿主后执行：

```powershell
python .\apply_fix.py --host-root 'D:\Apps\CodexHost' --restore
```

Linux 使用 `python3`，恢复前后同样停止并启动远端宿主。恢复会核对当前文件和备份哈希；备份缺失或损坏时停止。

## 更新 CodexHost

宿主升级可能替换修复文件。新版本需要对应的修复包，旧包不会覆盖未知版本。上游正式包含附件修复后，可使用相应官方版本。

插件与附件修复分开安装、升级和恢复。插件安装脚本不修改宿主，详见[维护说明](OPERATIONS.md)。修复来源与构建方法见[源码说明](../compatibility/codexhost-0.16.1/README.md)。
