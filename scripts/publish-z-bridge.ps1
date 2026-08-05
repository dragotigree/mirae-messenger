# Mirae Messenger - Z-drive bridge publish
# Old clients (folder-only updater) pull latest files from this folder, then move to GitHub updates.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\publish-z-bridge.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\publish-z-bridge.ps1 -DestDir "Z:\path\to\messenger"

param(
  [string]$SourceDir = (Split-Path -Parent $PSScriptRoot),
  [string]$DestDir = ""
)

$ErrorActionPreference = "Stop"

$DefaultZMessenger = "Z:\9.재활치료실(PT&OT&언어&임상심리)\물리치료실\messenger"
if (-not $DestDir) {
  if (Test-Path -LiteralPath "Z:\") {
    $DestDir = $DefaultZMessenger
  } else {
    $DestDir = $SourceDir
  }
}

$files = @(
  "main.js",
  "preload.js",
  "index.html",
  "package.json",
  "version.json",
  "toast.html",
  "toast-preload.js",
  "lib\minimal-xlsx.js",
  "excalidraw-editor.html",
  "preload-excalidraw.js",
  "lib\excalidraw-app.js",
  "lib\excalidraw-app.css"
)
$optional = @(
  "assets\splash.png",
  "vendor\excalidraw\asset-list.json"
)

Write-Host "Source: $SourceDir" -ForegroundColor Cyan
Write-Host "Dest:   $DestDir" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $SourceDir)) {
  Write-Host "ERROR: source folder missing" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath $DestDir)) {
  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
}

$sameRoot = ([IO.Path]::GetFullPath($SourceDir).TrimEnd('\') -eq [IO.Path]::GetFullPath($DestDir).TrimEnd('\'))
$copied = 0
foreach ($rel in $files) {
  $src = Join-Path $SourceDir $rel
  $dst = Join-Path $DestDir $rel
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Host "ERROR: missing required file - $rel" -ForegroundColor Red
    exit 1
  }
  $dstParent = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dstParent)) {
    New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
  }
  if (-not $sameRoot) {
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
  (Get-Item -LiteralPath $dst).LastWriteTime = Get-Date
  Write-Host "  ok: $rel"
  $copied++
}

foreach ($rel in $optional) {
  $src = Join-Path $SourceDir $rel
  if (-not (Test-Path -LiteralPath $src)) { continue }
  $dst = Join-Path $DestDir $rel
  $dstParent = Split-Path -Parent $dst
  if (-not (Test-Path -LiteralPath $dstParent)) {
    New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
  }
  if (-not $sameRoot) {
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
  Write-Host "  ok(optional): $rel"
}

$vendorSrc = Join-Path $SourceDir "vendor\excalidraw"
if (Test-Path -LiteralPath $vendorSrc) {
  $vendorDst = Join-Path $DestDir "vendor\excalidraw"
  if (-not $sameRoot) {
    New-Item -ItemType Directory -Force -Path $vendorDst | Out-Null
    Copy-Item -LiteralPath (Join-Path $vendorSrc "*") -Destination $vendorDst -Recurse -Force
  }
  Write-Host "  ok(optional): vendor\excalidraw\*"
}

$ver = ""
try {
  $ver = (Get-Content (Join-Path $DestDir "version.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
} catch {}

$notePath = Join-Path $DestDir "Z-BRIDGE-README.txt"
@(
  "Mirae Messenger - Z bridge deploy",
  "version: $ver",
  "time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
  "",
  "1) Old PC: connect Z: drive",
  "2) Run messenger (or Settings > Check update)",
  "3) After restart, GitHub updates apply"
) | Set-Content -Path $notePath -Encoding UTF8

Write-Host ""
Write-Host "OK - Z bridge deploy done ($copied files, version=$ver)" -ForegroundColor Green
Write-Host "Old PCs: connect Z, then open messenger / check update" -ForegroundColor Green
