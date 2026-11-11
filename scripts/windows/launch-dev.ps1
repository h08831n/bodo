param (
    [Parameter(Mandatory=$true)]
    [string]$ProjectRoot
)

$batPath = Join-Path $ProjectRoot "scripts\windows\run-dev-window.bat"
$commandLine = "cmd.exe /k `"$batPath`""

try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = $commandLine
        CurrentDirectory = $ProjectRoot
    }
    $devPid = $result.ProcessId
    if ($devPid -and $devPid -gt 0) {
        $pidFile = Join-Path $ProjectRoot ".dev-pid"
        $devPid | Set-Content -Path $pidFile -Force
        Write-Host "[INFO] Dev server window spawned with PID: $devPid"
        exit 0
    }
} catch {
    # Fallback to Start-Process if WMI is unavailable
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "`"$batPath`"" -WorkingDirectory $ProjectRoot -PassThru
    $pidFile = Join-Path $ProjectRoot ".dev-pid"
    $proc.Id | Set-Content -Path $pidFile -Force
    Write-Host "[INFO] Dev server window spawned with PID: $($proc.Id)"
    exit 0
}
