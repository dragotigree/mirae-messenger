# Mirae Messenger 부하 모의 (Windows)
# 예:
#   powershell -ExecutionPolicy Bypass -File .\scripts\run-load-sim.ps1 presence -Users 200
#   powershell -ExecutionPolicy Bypass -File .\scripts\run-load-sim.ps1 presence -Mode clear
#   powershell -ExecutionPolicy Bypass -File .\scripts\run-load-sim.ps1 udp -Target 192.168.0.10 -Count 400
param(
  [Parameter(Position = 0)]
  [ValidateSet('presence', 'udp', 'tcp-chat', 'db', 'help')]
  [string]$Command = 'help',

  [int]$Users = 200,
  [ValidateSet('burst', 'sustain', 'clear')]
  [string]$Mode = 'burst',
  [int]$Seconds = 60,
  [string]$Target = '',
  [int]$Count = 300,
  [int]$Rate = 50,
  [int]$Messages = 50
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$Script = Join-Path $PSScriptRoot 'load-sim.js'
if (-not (Test-Path -LiteralPath $Script)) { throw "missing $Script" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  # packaged Electron 옆에 node가 없을 수 있음 — PATH의 node 필요
  throw 'node.exe 가 PATH에 없습니다. Node.js를 설치하거나 PATH에 추가해 주세요.'
}

$argsList = @($Script, $Command)
switch ($Command) {
  'presence' {
    $argsList += "--users=$Users"
    $argsList += "--mode=$Mode"
    $argsList += "--seconds=$Seconds"
    if ($Target) { $argsList += "--target=$Target" }
  }
  'udp' {
    if (-not $Target) { throw 'udp 모드는 -Target <ip> 가 필요합니다.' }
    $argsList += "--target=$Target"
    $argsList += "--count=$Count"
    $argsList += "--rate=$Rate"
  }
  'tcp-chat' {
    if (-not $Target) { throw 'tcp-chat 모드는 -Target <ip> 가 필요합니다.' }
    $argsList += "--target=$Target"
    $argsList += "--messages=$Messages"
  }
  'db' {
    $argsList += "--users=$Users"
    $argsList += "--seconds=$Seconds"
  }
}

Write-Host ">>> node $($argsList -join ' ')" -ForegroundColor Cyan
& node @argsList
exit $LASTEXITCODE
