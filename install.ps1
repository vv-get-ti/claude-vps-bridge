param([switch]$Disable, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer\select-python.ps1')
$bridgePython = Resolve-BridgePython
if ($env:CODEXHOST_PLUGIN_DIRECTORY -or $env:CODEXHOST_DATA_DIR) { throw 'A plugin directory override is present; inspect the active runtime before installing.' }
if ($Disable -or $Uninstall) {
    & $bridgePython (Join-Path $PSScriptRoot 'installer\disable.py')
    if ($LASTEXITCODE -ne 0) { throw '停用未完成，请查看错误信息；用户数据已保留。' }
    return
}
# Both sides are prepared and checked before switching code. State is excluded.
& $bridgePython (Join-Path $PSScriptRoot 'installer\prepare-local.py')
if ($LASTEXITCODE -ne 0) { throw 'Local dependency preparation failed; installed bridge files were not replaced.' }
& $bridgePython (Join-Path $PSScriptRoot 'installer\prepare-dependency.py')
if ($LASTEXITCODE -ne 0) { throw 'Pinned dependency preparation failed; active bridge code was not replaced.' }
# Optional MCP configuration is managed separately; upgrades never import credentials.
& $bridgePython (Join-Path $PSScriptRoot 'installer\deploy-transaction.py')
if ($LASTEXITCODE -ne 0) { throw 'Bridge transaction failed. Read its journal for rollback or recovery status.' }
