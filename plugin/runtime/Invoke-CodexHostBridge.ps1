param([Parameter(Mandatory)][string]$RequestBase64)
$ErrorActionPreference = 'Stop'
function Fail-Bridge([string]$Code, [string]$Message) {
    [Console]::Error.WriteLine((@{error=@{code=$Code;message=$Message}} | ConvertTo-Json -Compress))
    exit 1
}
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
$parent = [string]$request.parentThread
if (!$parent) { Fail-Bridge 'PARENT_THREAD_REQUIRED' '当前请求缺少会话绑定；请重新打开会话或显式指定 --parent-thread。不会使用全局最近会话。' }
$context = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'session.json') -Raw | ConvertFrom-Json
$launcher = Get-Process -Id $context.LauncherPid -ErrorAction SilentlyContinue
if (!$launcher -or $launcher.StartTime.ToUniversalTime().Ticks -ne ([datetime]$context.LauncherStartedUtc).ToUniversalTime().Ticks) {
    Fail-Bridge 'STALE_RUNTIME' 'CodexHost restarted. Refresh the Windows bridge context from a managed local chat.'
}
$endpoint = [Uri]$context.Endpoint
if (!$endpoint.IsLoopback -or $endpoint.Scheme -ne 'http') { throw 'Expected local HTTP Runtime endpoint.' }
$env:CODEXHOST_RUNTIME_ENDPOINT = $context.Endpoint
$env:CODEXHOST_RUNTIME_TOKEN = [Net.NetworkCredential]::new('', (ConvertTo-SecureString $context.ProtectedToken)).Password
$env:CODEXHOST_CLI_PATH = $context.Cli
$env:CODEX_THREAD_ID = $parent
$env:CODEXHOST_THREAD_ID = $parent
try {
    if ($request.action -eq 'native-read') {
        if (!$request.harness -or !$request.nativeSessionId) { Fail-Bridge 'INVALID_ARGUMENT' 'Native history requires an explicit agent and native session ID.' }
        if ($request.harness -cne 'zcode') { Fail-Bridge 'NATIVE_HISTORY_UNSUPPORTED' 'No native-store reader is registered for this agent. Resolve an existing CodexHost mapping, or use that agent''s supported Windows native tools/import. The existing explicit native reader supports zcode only.' }
        $nativeRequest = @{action='read';thread=[string]$request.nativeSessionId;cwd=(Get-Location).Path}
        foreach ($key in @('view','cursor','limit')) {
            if ($null -ne $request.$key) { $nativeRequest[$key] = $request.$key }
        }
        $encodedRequest = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($nativeRequest | ConvertTo-Json -Compress)))
        & $context.Node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'Read-ZcodeSession.mjs') $encodedRequest
        exit $LASTEXITCODE
    }
    if ($request.action -eq 'resolve') {
        Fail-Bridge 'NATIVE_SESSION_RESOLUTION_UNAVAILABLE' '当前宿主公开 CLI 不提供按原生会话 ID 查找聊天的接口。请使用 CodexHost 聊天链接；插件不读取宿主内部 mapping-store。'
    }
    if ($request.action -ne 'cli') { Fail-Bridge 'INVALID_ARGUMENT' 'Use the harness, delegate or thread CLI commands, or resolve an explicit agent/native-session pair.' }
    if ($request.argv -isnot [array] -or @($request.argv | Where-Object { $_ -isnot [string] }).Count -ne 0) { Fail-Bridge 'INVALID_ARGUMENT' 'Expected an argument array of strings.' }
    $cliArguments = @($request.argv)
    if ($cliArguments.Count -eq 0 -or $cliArguments[0] -in @('--help','-h')) { $cliArguments = @('delegate','--help') }
    if ($cliArguments[0] -notin @('harness','delegate','thread')) { Fail-Bridge 'UNSUPPORTED_COMMAND_GROUP' 'This bridge forwards the local CodexHost harness, delegate and thread interfaces. Other Windows terminal operations use windows-run.' }
    if ($cliArguments[0] -eq 'thread' -and $cliArguments[1] -in @('read','wait','send','cancel','watch') -and $cliArguments.Count -ge 3 -and $cliArguments[2] -notlike '--*') {
        $reference = $cliArguments[2]
        $parsedId = [guid]::Empty
        if ($reference -notmatch '^(codex|thread)://' -and ![guid]::TryParse($reference,[ref]$parsedId)) {
            Fail-Bridge 'NATIVE_SESSION_REQUIRES_HARNESS' 'This is not a CodexHost chat ID. Use an explicit CodexHost chat link, or use that agent''s native tools on Windows. No agent is inferred from an ID prefix.'
        }
    }
    if ($cliArguments[0] -eq 'delegate' -and $cliArguments[1] -eq 'start' -and '--help' -notin $cliArguments) {
        if ('--cwd' -notin $cliArguments) { $cliArguments += @('--cwd',(Get-Location).Path) }
    }
    & $context.Cli @cliArguments
    $resultCode = $LASTEXITCODE
} finally {
    Remove-Item Env:CODEXHOST_RUNTIME_TOKEN -ErrorAction SilentlyContinue
}
exit $resultCode
