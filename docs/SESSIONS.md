# VPS 会话管理

Claude Code 的原生会话保存在 VPS 上。插件提供一个管理入口，可以查看、归档、恢复和永久删除这些会话；可选的 Desktop 扩展在 CodexHost 设置里提供对应的页面。

流程与 Codex Desktop 管理聊天一致：**会话列表 → 归档（可恢复）→ 在归档列表里恢复或永久删除**。

## 安装界面扩展（可选）

不装扩展也不影响桥接的任何功能。扩展需要 CodexHost 0.23.0 或更新版本，以及插件 0.16.0 或更新版本。

1. 打开 CodexHost Console 的 **扩展** 页，选择从 GitHub 链接安装，填入本仓库 `extension` 目录的链接，例如 `https://github.com/vv-get-ti/claude-vps-bridge/tree/main/extension`；也可以把 `extension` 目录打成 zip 上传。
2. 安装后在同一页启用 **Claude VPS 会话管理**。启用和更新不需要重启 Desktop。
3. 打开 Desktop 设置，在左侧「插件设置」中进入 **VPS 会话**。

扩展默认在 `<CodexHost 数据目录>/plugins/claude-vps/admin.mjs` 找到插件。插件装在别处时，在扩展设置里填写插件目录。

> 扩展的后端以本机用户权限运行，和其他 Desktop 扩展一样，只启用你信任的代码。

## 页面说明

- **会话**：VPS 上 Claude Code 的会话，显示所属 Windows 项目、最后活动时间和大小。可以按项目、闲置天数筛选，或按标题、路径、ID 搜索。
- **归档**：已归档的会话。只有这里能恢复或永久删除。
- 角标：**运行中**、**状态未知** 的会话不能勾选；**已关联聊天** 表示 CodexHost 里有聊天正在使用它；**归档未完成** 等表示上次操作中断，可以点 **继续**。

### 归档

归档把会话的原生记录和桥接为它保存的数据（图片缓存、提示词缓存、fork 记录等）整体移到 VPS 上的归档目录。Claude 看不到、也无法续接它，但数据都在。

已关联 CodexHost 聊天的会话也能归档，确认时需要额外勾选；恢复之前，那条聊天无法继续。

### 恢复

原样移回原位置。原位置已有同名会话时拒绝恢复，不覆盖。

### 永久删除

只能对已归档的会话执行，删除后无法恢复。确认时需要勾选“我确认永久删除这些会话”。

CodexHost 中对应的聊天不会被自动删除（扩展接口不允许修改宿主的聊天），需要时请在 CodexHost 里自行删除。

## 安全规则

这些规则在 VPS 端执行，不依赖界面：

- **运行中拒绝**：会话正被桥接打开、有 Claude 进程持有它，或无法确认已停止时，归档和删除都会被拒绝。桥接打开会话时持有 Linux `flock` 租约，管理操作期间桥接也无法打开该会话。
- **执行前复核**：列表里的每个会话带一个修订标记，执行前重新计算；期间会话有任何变化就中止，提示刷新。
- **只动能确认归属的文件**：符号链接、越出目录、硬链接、归属不明的文件一律不处理。
- **移动不丢数据**：同一文件系统内用不覆盖的原子重命名；跨文件系统先复制、校验 SHA-256，再删原件。中途失败时原件仍在。
- **删除前校验**：永久删除前逐个核对归档清单里的 SHA-256，与清单不符的文件保留并报告。
- **结果未知不重试**：网络中断等原因导致无法确认结果时，返回“结果未知”，不会自动重试。刷新列表即可看到真实状态；未完成的操作会显示阶段，可以继续。

已知限制：直接在 VPS 终端里启动的 Claude Code 不经过桥接租约。管理操作会检查 `/proc` 里可见的 Claude 进程，但无法阻止检查之后才新开的终端会话。在终端里使用 Claude 时，请避免同时归档它的会话。

## 原生导入

插件实现了 CodexHost 的会话导入接口。在 Desktop 自带的“导入会话”界面里，可以看到能对应到当前 Windows 项目、未被聊天使用、确认空闲的 VPS 会话，导入后照常续接。

## 管理接口（v1）

扩展只通过这个入口工作，也可以直接在 PowerShell 中调用。入口从标准输入读取一个 JSON 请求，向标准输出写一个 JSON 响应：

```powershell
'{"apiVersion":1,"method":"sessions.list","params":{"scope":"active"}}' | node "$env:USERPROFILE\.codexhost\plugins\claude-vps\admin.mjs"
```

| 方法 | 参数 | 说明 |
|---|---|---|
| `info` | 无 | 插件版本与支持的接口版本，不连接 VPS |
| `sessions.list` | `scope`：`active` 或 `archived`；可选 `project` | 会话列表、存储占用与警告 |
| `sessions.archive` | `items`：`[{id, revision}]`；可选 `confirmBound` | 归档；已关联聊天的会话需要 `confirmBound: true` |
| `sessions.restore` | `items` | 恢复已归档的会话 |
| `sessions.delete` | `items` | 永久删除已归档的会话 |

写操作每次最多 200 项，逐项返回 `status`（`done`、`rejected`、`conflict`、`unknown`）和错误码。常见错误码：

| 错误码 | 含义 |
|---|---|
| `RUNNING` / `STATE_UNKNOWN` | 会话正在使用，或无法确认已停止 |
| `REVISION_CHANGED` | 会话在列出后发生了变化，请刷新 |
| `BOUND_REQUIRES_CONFIRMATION` | 会话关联了 CodexHost 聊天，需要确认 |
| `NOT_ARCHIVED` | 只能恢复或删除已归档的会话 |
| `RESTORE_TARGET_EXISTS` | 原位置已有同名会话，未覆盖 |
| `OWNERSHIP_UNCERTAIN` | 文件归属或路径无法核实，已停止处理 |
| `ARCHIVE_INCOMPLETE` | 上次操作未完成，请按列表中的阶段继续 |
| `RESULT_UNKNOWN` | 结果未确认，请刷新列表 |
| `SSH_UNAVAILABLE` | 无法连接 VPS |

未知字段、未知方法和不支持的接口版本会直接报错，并列出允许的值。
