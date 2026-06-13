# Start Anvil - run this in your OWN PowerShell terminal so the server persists
# independently of any Claude Code session.
#
#   Right-click -> Run with PowerShell, or:  ./start-anvil.ps1
#
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Pull the API key from the User environment (set via: setx ANTHROPIC_API_KEY ...).
# A terminal opened after the setx already has it; this also covers the current one.
if (-not $env:ANTHROPIC_API_KEY) {
    $env:ANTHROPIC_API_KEY = [System.Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
}
if ($env:ANTHROPIC_API_KEY) {
    Write-Host "ANTHROPIC_API_KEY detected - LLM proposer enabled." -ForegroundColor Green
} else {
    Write-Host "No ANTHROPIC_API_KEY - running deterministic proposer (loop still works)." -ForegroundColor Yellow
}

# Free port 8090 if something is already on it.
$conn = Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "Port 8090 busy - stopping PID $($conn.OwningProcess)..." -ForegroundColor Yellow
    Stop-Process -Id $conn.OwningProcess -Force
    Start-Sleep -Seconds 1
}

Write-Host "Anvil running at http://localhost:8090   (Ctrl+C to stop)" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m uvicorn anvil.backend.server:app --host 127.0.0.1 --port 8090
