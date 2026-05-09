param(
  [int]$BackendPort = 5000,
  [int]$FrontendPort = 4173,
  [string]$PublicUrl = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root "flask_server"
$FrontendDir = Join-Path $Root "spine-viz"

function Get-LocalIPv4 {
  $ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -First 1 -ExpandProperty IPAddress

  if ([string]::IsNullOrWhiteSpace($ip)) {
    return "127.0.0.1"
  }
  return $ip
}

if ([string]::IsNullOrWhiteSpace($PublicUrl)) {
  $PublicUrl = "http://$(Get-LocalIPv4):$BackendPort"
}

Write-Host "RAINA show launcher"
Write-Host "Backend PUBLIC_URL: $PublicUrl"
Write-Host "Frontend URL: http://localhost:$FrontendPort"
Write-Host ""

$PythonCommand = "py -3"
try {
  $pythonCheck = & python -c "import sys; print(sys.executable)" 2>$null
  if (-not [string]::IsNullOrWhiteSpace($pythonCheck)) {
    $PythonCommand = "python"
  }
} catch {
  $PythonCommand = "py -3"
}

$BackendCommand = @"
`$env:PUBLIC_URL='$PublicUrl'
`$env:PORT='$BackendPort'
cd '$BackendDir'
$PythonCommand app.py
"@

$FrontendCommand = @"
cd '$FrontendDir'
npm run dev -- --host 0.0.0.0 --port $FrontendPort
"@

$BackendArgs = @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $BackendCommand)
$FrontendArgs = @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $FrontendCommand)

Start-Process powershell -ArgumentList $BackendArgs -WindowStyle Normal
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList $FrontendArgs -WindowStyle Normal

Start-Sleep -Seconds 3
Start-Process "http://localhost:$FrontendPort"

Write-Host "Started. Close the two PowerShell windows to stop backend and frontend."
