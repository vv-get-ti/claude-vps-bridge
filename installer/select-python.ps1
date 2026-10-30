function Resolve-BridgePython {
    foreach ($name in @('py', 'python')) {
        foreach ($command in @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)) {
            if ($command.Source -match '[\\/]WindowsApps[\\/]') { continue }
            [string[]]$arguments = if ($name -eq 'py') { @('-3') } else { @() }
            try {
                $selected = & $command.Source @arguments -c 'import sys; assert sys.version_info >= (3,11); print(sys.executable)'
                if ($LASTEXITCODE -eq 0 -and $selected -and $selected -notmatch '[\\/]WindowsApps[\\/]' -and (Test-Path -LiteralPath $selected -PathType Leaf)) { return [string]$selected }
            } catch { continue }
        }
    }
    throw '未找到 Python 3.11+。请安装 Python（含 py 启动器）或将真实 python.exe 加入 PATH；WindowsApps 商店占位程序不可用。'
}
