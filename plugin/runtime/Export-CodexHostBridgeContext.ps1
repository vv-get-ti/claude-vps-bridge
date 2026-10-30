$ErrorActionPreference = 'Stop'
if (!$env:CODEXHOST_RUNTIME_ENDPOINT -or !$env:CODEXHOST_RUNTIME_TOKEN) {
    throw 'Run this script from the intended parent chat in a CodexHost-managed session.'
}
$configPath = if ($env:CLAUDE_VPS_CONFIG) { $env:CLAUDE_VPS_CONFIG } else { Join-Path (Split-Path $PSScriptRoot) 'bridge-config.json' }
if (!$env:CLAUDE_VPS_CONFIG -and !(Test-Path -LiteralPath $configPath)) { $configPath = Join-Path (Split-Path $PSScriptRoot) 'bridge-config.local.json' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$cli = Join-Path $config.hostRoot 'bin/codexhost.exe'
$inspection = (& $cli inspect --json) | ConvertFrom-Json
if (!$inspection.runtime.running) { throw 'CodexHost is not running.' }
$launcher = Get-Process -Id $inspection.runtime.launcherPid -ErrorAction Stop
$directory = Join-Path $PSScriptRoot 'runtime-context'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
$existingAcl = Get-Acl -LiteralPath $directory
$existingRules = @($existingAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$expectedAcl = $existingAcl.AreAccessRulesProtected -and $existingRules.Count -eq 2 -and @($existingRules | Where-Object { $_.IdentityReference.Value -notin $allowedSids.Value -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count -eq 0
if (!$expectedAcl) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowedSids) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($directory), $acl)
}
$context = [ordered]@{
    Endpoint = $env:CODEXHOST_RUNTIME_ENDPOINT
    ProtectedToken = (ConvertTo-SecureString $env:CODEXHOST_RUNTIME_TOKEN -AsPlainText -Force | ConvertFrom-SecureString)
    LauncherPid = $launcher.Id
    LauncherStartedUtc = $launcher.StartTime.ToUniversalTime().ToString('o')
    Cli = $cli
    Node = Join-Path $config.hostRoot 'runtime/node.exe'
}
$path = Join-Path $directory 'session.json'
$temporaryPath = Join-Path $directory ([guid]::NewGuid().ToString() + '.tmp')
$context | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding utf8NoBOM
[IO.File]::Move($temporaryPath, $path, $true)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-CodexHostBridge.ps1') -Destination (Join-Path $directory 'Invoke-CodexHostBridge.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Read-ZcodeSession.mjs') -Destination (Join-Path $directory 'Read-ZcodeSession.mjs') -Force
[pscustomobject]@{Ready=$true;Workspace='Supplied per request';TokenProtection='Windows DPAPI current user';ContextPath=$path} | ConvertTo-Json -Compress
