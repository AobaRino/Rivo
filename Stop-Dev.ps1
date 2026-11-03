$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot '.local/dev-pids.json'
if (-not (Test-Path -LiteralPath $taskPidFile)) {
    Write-Host '未找到本项目的运行记录。'
    exit 0
}
$taskPids = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
$taskApi = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.local/manager.exe'))
$taskVite = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'node_modules/vite/bin/vite.js'))
foreach ($taskChildId in $taskPids.children) {
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskChildId)" -ErrorAction SilentlyContinue
    if (-not $taskProcess) { continue }
    # A recorded PID may have been reused. Check the project path before stopping it.
    $taskIsApi = $taskProcess.ExecutablePath -eq $taskApi
    $taskIsVite = $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine -and $taskProcess.CommandLine.Contains($taskVite)
    if ($taskIsApi -or $taskIsVite) {
        Stop-Process -Id $taskChildId -ErrorAction SilentlyContinue
        Write-Host "已停止本项目进程 $taskChildId。"
    } else {
        Write-Host "跳过进程 $taskChildId：路径与本项目不符。"
    }
}
# The dev runner exits when either owned child exits. Saved drafts stay on disk.
