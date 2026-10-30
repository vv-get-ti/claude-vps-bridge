# 安装与 VPS 登录

## 1. 先准备两端环境

Windows：CodexHost 0.16.1、PowerShell 7、OpenSSH **客户端**、Python 3.11+、npm 与 [ripgrep](https://github.com/BurntSushi/ripgrep#installation)。`rg --version` 应正常返回版本，项目搜索使用该程序。直接拖入或粘贴图片的版本要求与独立修复包用法见[附件支持](ATTACHMENTS.md)。npm 用于准备依赖，安装和插件运行使用 Host 自带 Node；开发检查另需 Node.js 24。可选浏览器需要本机 Chrome。

Linux：x64、Python 3、Bash、Node.js 24/npm、官方 Claude Code。使用有权写入自身主目录的普通用户即可，不要求 root。PDF 按页读取另外需要 `pdftoppm`（通常来自 poppler-utils），不影响基础聊天。

在任一系统运行本仓库的开发检查或本机配置脚本时，需要 Python 3.11+（使用标准库 `tomllib`）；这与 VPS 远端运行脚本的 Python 要求分开。

安装 CodexHost 见[发布页](https://github.com/BytePioneer-AI/codex-host/releases)，安装 Claude Code 见[官方指南](https://code.claude.com/docs/en/setup)。

## 2. 配置 SSH

在 Windows 的 SSH 配置中建立自己的别名，例如：

```sshconfig
Host my-linux-host
    HostName YOUR_VPS_HOST
    User YOUR_LINUX_USER
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

首次使用 `ssh my-linux-host` 时，核对 VPS 控制台或管理员提供的主机指纹。完成密钥授权后再检查非交互连接：

```powershell
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes my-linux-host 'echo SSH_READY'
ssh my-linux-host 'command -v python3 node npm claude'
```

连接由 Windows 主动发起，无需开启 Windows SSH 服务或开放本机端口。

自检应输出四个程序的路径。非交互 SSH 不一定加载交互终端中的 nvm/fnm 配置；安装器使用登录 shell 探测，并尝试常见用户安装位置。仍找不到时，用 `--remote-claude /绝对路径/claude` 或 `--remote-node /绝对路径/node` 明确选择。选中的 Claude 必须存在且可执行，否则不会生成配置。

默认使用 PATH 中的 SSH；需要指定客户端时给 `configure.py` 加 `--ssh-executable 'C:\Windows\System32\OpenSSH\ssh.exe'`（仅为示例）。输出会显示实际路径与版本，诊断使用同一客户端。

## 3. 在 VPS 登录 Claude Code

先打开交互式远端终端：

```powershell
ssh -t my-linux-host
```

确认提示符在自己的 VPS 上，再执行：

```bash
claude --version
claude auth login
```

按照终端提示完成浏览器授权。若要求授权码，将它粘贴回当前 VPS 终端，勿放入聊天或 Issue。

登录后启动 `claude`，确认能正常对话。登录遇到问题时，参阅[官方认证文档](https://code.claude.com/docs/en/authentication)。

浏览器可以在本机打开，登录命令在 VPS 执行，凭据保存在 VPS。

## 4. 回到 Windows 配置桥接

在仓库根目录执行：

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1
```

配置命令通过 SSH 验证远端可执行文件，生成 `bridge-config.local.json`。已有配置会保留，该文件不进入 Git。`python` 需为 3.11 及以上版本，装有 Python 启动器时也可以用 `py -3`；安装脚本优先 `py -3`，其次是真实 Python 3.11+，排除 WindowsApps 商店占位程序，全程使用选中的同一解释器。

`codexhost` 在 PATH 且能定位安装结构时可省略 `--host-root`；定位失败请明确指定含 `app` 和 `runtime` 的安装目录。可用 `(Get-Command codexhost).Source` 查看入口位置。

安装准备依赖并更新两端插件代码与启用条目，保留会话和用户数据，不修改宿主文件。命令以当前 Windows 用户权限运行。旧版插件曾给宿主打补丁的用户，请重装或升级 CodexHost 清除旧补丁，详见[停用与升级](OPERATIONS.md)。

目前安装脚本不支持 `CODEXHOST_DATA_DIR` 或 `CODEXHOST_PLUGIN_DIRECTORY` 自定义目录；发现这些覆盖项会停止，不猜测目标位置。

## 5. 试用

正常退出并重开 CodexHost，选择本机一个无敏感数据的测试目录，再选择 **Claude VPS Bridge**（旧版入口显示为 **Claude Code · VPS**）。可以依次输入：

```text
Report the current Windows project path. Do not modify any files.
Create bridge-check.txt containing exactly BRIDGE_READY, then read it back.
Run a Windows command to print the PowerShell version and the current directory.
```

成功标志：本机 `bridge-check.txt` 内容准确、命令返回当前 Windows 项目路径，重开后原聊天能续接。可运行 `node .\plugin\diagnose.mjs --json` 查看 SSH 路径/版本及远端 node-path、Claude 是否仍可执行；诊断不提交模型请求。遇到问题看[排障](OPERATIONS.md)与[FAQ](FAQ.md)。

粘贴或拖入图片后，Desktop 若在文字附件清单中提供了本机路径，插件会读取并传输该图片。没有可读路径的附件，请先保存到项目，再让 Claude 查看这个文件；它可调用 `windows-workspace media` 完成传输。

## 6. 配置可选工具

需要搜索或浏览器操作时，按[配置说明](CONFIGURATION.md)启用 Tavily 或 Playwright。
