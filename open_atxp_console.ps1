param(
  [switch]$CheckOnly,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root "server.js"
$url = "http://localhost:3131"

function Show-Message($message) {
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($message, "ATXP Console") | Out-Null
  } catch {
    Write-Host $message
  }
}

function Test-ConsoleUp {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/state" -TimeoutSec 1
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-NodeServer {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Show-Message "Node.js was not found. Please install Node.js or add node.exe to PATH."
    exit 1
  }

  if (-not (Test-Path -LiteralPath $server)) {
    Show-Message "server.js was not found: $server"
    exit 1
  }

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $node.Source
  $processInfo.Arguments = "server.js"
  $processInfo.WorkingDirectory = $root
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  [System.Diagnostics.Process]::Start($processInfo) | Out-Null
}

if ($CheckOnly) {
  if (-not (Test-Path -LiteralPath $server)) {
    throw "server.js not found"
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node.exe not found"
  }
  Write-Host "Shortcut helper check passed."
  exit 0
}

if (-not (Test-ConsoleUp)) {
  Start-NodeServer
}

$ready = $false
for ($i = 0; $i -lt 30; $i += 1) {
  if (Test-ConsoleUp) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 300
}

if (-not $ready) {
  Show-Message "The local console timed out. Please check whether port 3131 is already in use."
  exit 1
}

if (-not $NoOpen) {
  $browserInfo = New-Object System.Diagnostics.ProcessStartInfo
  $browserInfo.FileName = $url
  $browserInfo.UseShellExecute = $true
  [System.Diagnostics.Process]::Start($browserInfo) | Out-Null
}
