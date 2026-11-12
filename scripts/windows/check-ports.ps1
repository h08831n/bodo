# ========================================================
#  bodo ERP - Windows Port Occupancy Warning Helper
# ========================================================
# Inspects development ports (3000 and 5173).
# If occupied, displays a warning with PID and process name.
# Strictly informational: NEVER terminates any external process.
# ========================================================

$devPorts = @(3000, 5173)
$occupied = @()

foreach ($port in $devPorts) {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            $procName = if ($proc) { $proc.ProcessName } else { "Unknown" }
            $occupied += [PSCustomObject]@{
                Port        = $port
                PID         = $conn.OwningProcess
                ProcessName = $procName
            }
        }
    }
}

if ($occupied.Count -gt 0) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Yellow
    Write-Host " [WARNING] Development port(s) still in use:" -ForegroundColor Yellow
    Write-Host "========================================================" -ForegroundColor Yellow
    foreach ($item in $occupied) {
        Write-Host " - Port $($item.Port) is occupied by PID $($item.PID) ($($item.ProcessName))" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host " [NOTE] These process(es) were NOT terminated because they were" -ForegroundColor Cyan
    Write-Host "        not part of the bodo-dev-server process tree." -ForegroundColor Cyan
    Write-Host "        Please close or inspect them manually if required." -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Yellow
    Write-Host ""
}
