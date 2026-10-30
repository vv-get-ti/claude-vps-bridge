# 配置与安装边界

基础桥接只负责 SSH、远端官方 Claude、本机工作区和本机执行器。Tavily、Playwright、PDF 页面渲染是独立可选能力；目前经过桥接权限验证的 MCP 是 Tavily 与 Playwright，不能据此认为任意 MCP 已自动接通。

## 初次配置

Windows 需要 PowerShell 7、OpenSSH 客户端、Python 3.11+ 和 CodexHost。Linux x64 需要 Node/npm、Python 3 与已安装并登录的官方 Claude Code。使用已有的 SSH 配置与已确认的主机密钥；安装器不关闭主机身份校验。

```powershell
python .\installer\configure.py --ssh-host my-linux-host --host-root 'D:\Apps\CodexHost'
pwsh -NoProfile -File .\install.ps1
```

`configure.py` 查询远端用户主目录与 Claude 路径，创建 `bridge-config.local.json`，不覆盖已有文件。可显式提供 `--remote-root`、`--remote-workspace-root`、`--remote-claude`。配置文件只保存非敏感连接与路径参数，不保存账号凭据。自动发现的 Claude 路径仍需实际存在；安装健康检查与真实运行验收是独立步骤。

安装器优先读取 `CLAUDE_VPS_CONFIG` 指定的文件，然后是源码目录的 `bridge-config.local.json`，最后是已安装插件的 `bridge-config.json`。运行中的插件读取其安装目录下的配置。修改配置后重新安装并正常重开宿主，使两端配置一致。

安装器把运行时配置写入插件目录、远端的 `remote-config.json` 与 `claude-path`，由同一代码事务备份和恢复。远端命令安装在桥接目录内，不覆盖 `/usr/local/bin`，不要求 root。主机、路径和代码更新不迁移已有项目映射、机器 ID 或原生历史；不要把更换远端工作区根目录当成自动数据迁移。

## 可选工具

基础安装和升级不读取本机 Codex 的 MCP 凭据，也不创建或改写远端私有 MCP 配置。没有该配置时，Claude 会使用空的可选 MCP 列表。

```powershell
# 查询并保留既有配置；首次执行会创建空目录表。
python .\installer\prepare-mcp.py

# 分别启用或禁用本机浏览器。
# 首次启用而尚未安装浏览器依赖时，先执行下面两行：
python .\installer\prepare-local.py --with-playwright
pwsh -NoProfile -File .\install.ps1
python .\installer\prepare-mcp.py --playwright enable
python .\installer\prepare-mcp.py --playwright disable

# 只有这一显式操作会读取指定文件中的 Tavily 授权，并通过 SSH stdin 传到 VPS。
python .\installer\prepare-mcp.py --import-tavily-from-codex 'C:\Users\YOUR_USER\.codex\config.toml'
python .\installer\prepare-mcp.py --disable-tavily
```

每次只改变选中的工具，其余条目和顶层配置保持不变。工具配置仍保存于 VPS `mcp-config.private.json`，权限 0600；无变化时不重写文件。有变化时保存私有备份，凭据不进入参数、输出或代码回滚。现有原生 Claude 进程保留启动时的工具目录，工具启停后应关闭并恢复对应聊天或新开聊天。

基础安装使用锁文件准备 YAML 与路径规则依赖，省略可选的 Playwright 下载；已有浏览器依赖保持原样。首次准备依赖需要 Windows Node.js/npm，实际运行使用配置的 Host Node。可选浏览器启动使用本机已安装的 Chrome，不下载或搬运日常浏览器登录资料。

暂不提供“任意 MCP 都能透明转发”的承诺。新工具需要在自己的接入模块说明执行位置、权限映射与生命周期，不能靠修改搜索工具的配置绕过这些检查。

### 本机浏览器生命周期

可在自己的桥接配置中添加 `optionalTools.playwright`。这些选项只约束已启用的本机浏览器，不会自动安装或启用 MCP：

```json
{
  "optionalTools": {
    "playwright": {
      "idleTimeoutMs": 600000,
      "requestTimeoutMs": 95000,
      "maxClients": 8,
      "maxPendingPerClient": 32,
      "maxFrameBytes": 8388608
    }
  }
}
```

默认空闲 10 分钟且没有待完成调用时关闭浏览器连接；`idleTimeoutMs: 0` 保留到聊天关闭。其他选项分别限制请求等待时间、进程数、单连接待完成请求数和单条消息字节数。所有值必须是有界整数；无效配置只阻止浏览器接入。

空闲关闭、进程崩溃或请求超时后，需要 MCP 重新初始化连接。桥接不会自动重放工具调用，也不会声称已恢复之前的页面状态。活动请求不会被空闲计时器中止；超时属于结果未知，会关闭该连接并明确返回错误。

## 本机程序与文件传输

Claude 按任务需要调用本机程序。工具路径、命令参数和处理方法由 Claude 根据本机环境选择，插件不再提供 FFmpeg 专用配置或抽帧入口。旧配置中的 `media.ffmpegExecutable` 已不使用，可自行移除。

图片/PDF 按原始字节传输，单个文件最多 5 MiB；超限会明确报错，由 Claude 决定是否转换。视频只返回本机文件信息，不自动处理。生成的图片通过 `media` 传输，文本通过文件读取或任务日志读取。

## 旧环境兼容

新配置默认 `legacy.enabled=false`，现代路径使用本机主动发起的双向 SSH，不自动安装 Windows SSH 服务。缺少现代通道时明确报错。

已有部署只有显式启用 `legacy.enabled` 时才会使用所配置的旧隧道脚本。安装器保留使用者明确选择的兼容设置，不重新分发、改写或删除旧全局命令、隧道服务和脚本。兼容脚本可能仍包含个人环境路径，不属于可移植核心。关闭兼容设置不等于卸载系统 SSH 服务；确认现代通道覆盖所需流程后，再单独处理不再需要的旧组件。

## 验证范围

安装后按[安装指南](SETUP.md#5-试用)确认工作目录、文件读写与命令执行。

本机配置示例见 [bridge-config.example.json](../examples/bridge-config.example.json)，其中全部是占位值。优先通过配置命令发现自己的实际路径，不应直接把示例当成可运行配置。
