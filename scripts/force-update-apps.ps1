# Mirae Messenger — C:\Apps 패키지(exe가 읽는 코드) 강제 업데이트
# 앱이 버벅여도 이 스크립트만으로 종료·덮어쓰기 가능.
# 예:
#   powershell -ExecutionPolicy Bypass -File .\scripts\force-update-apps.ps1

param(
  [string]$RepoRawBase = 'https://raw.githubusercontent.com/dragotigree/mirae-messenger/main'
)

try {
  chcp 65001 | Out-Null
  [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}

$ErrorActionPreference = 'Stop'

$PackagedApp = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\resources\app'
$SourceApp = 'C:\Apps\Mirae Messenger'
$ExePath = 'C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64\MiraeMessenger.exe'

$files = @(
  'main.js',
  'preload.js',
  'index.html',
  'package.json',
  'version.json',
  'toast.html',
  'toast-preload.js',
  'lib/minimal-xlsx.js',
  'excalidraw-editor.html',
  'preload-excalidraw.js',
  'lib/excalidraw-app.js',
  'lib/excalidraw-app.css',
  'assets/compact/compact-overlay.css',
  'assets/compact/phosphor-paths.json',
  'assets/splash.png'
)

function Test-AppDir([string]$dir) {
  return ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'index.html')))
}

function Read-Version([string]$dir) {
  try {
    return (Get-Content -LiteralPath (Join-Path $dir 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  } catch {
    return '?'
  }
}

function Stop-MessengerHard {
  Write-Host '[1/4] MiraeMessenger / electron 강제 종료...' -ForegroundColor Yellow
  $names = @('MiraeMessenger', 'electron')
  for ($i = 0; $i -lt 3; $i++) {
    $procs = @()
    foreach ($n in $names) {
      $procs += @(Get-Process -Name $n -ErrorAction SilentlyContinue)
    }
    if ($procs.Count -eq 0) { break }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  # 잠긴 파일 방지용 짧은
  Start-Sleep -Seconds 1
}

function Update-AppDir([string]$appDir, $wc, [long]$bust) {
  if (-not (Test-AppDir $appDir)) {
    Write-Host "  skip (없음): $appDir" -ForegroundColor DarkGray
    return $null
  }
  $before = Read-Version $appDir
  Write-Host "  대상: $appDir" -ForegroundColor Cyan
  Write-Host "  이전 버전: $before"

  $ok = 0
  foreach ($rel in $files) {
    $url = ($RepoRawBase.TrimEnd('/') + '/' + ($rel -replace '\\', '/') + '?t=' + $bust)
    $dst = Join-Path $appDir ($rel -replace '/', '\')
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstDir)) {
      New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    }
    try {
      Write-Host ("    " + $rel)
      $wc.DownloadFile($url, $dst)
      $ok++
    } catch {
      if ($rel -match 'splash\.png$|compact-overlay\.css$|phosphor-paths\.json$|excalidraw-app\.(js|css)$') {
        Write-Host ("    skip optional: " + $rel) -ForegroundColor DarkGray
        continue
      }
      throw ("다운로드 실패: $rel — " + $_.Exception.Message)
    }
  }
  $after = Read-Version $appDir
  Write-Host "  완료 $ok 개 → 버전 $after" -ForegroundColor Green
  return $after
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ' Mirae Messenger 강제 업데이트 (Apps)' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'exe가 읽는 경로:'
Write-Host "  $PackagedApp"
Write-Host ''

if (-not (Test-AppDir $PackagedApp)) {
  Write-Host '패키지 경로를 찾을 수 없습니다.' -ForegroundColor Red
  Write-Host "  확인: $PackagedApp\index.html"
  Write-Host '  C:\Apps\Mirae Messenger\dist\MiraeMessenger-win32-x64 가 있는지 보세요.'
  exit 1
}

Stop-MessengerHard

Write-Host '[2/4] GitHub main 에서 파일 다운로드...' -ForegroundColor Yellow
$wc = New-Object System.Net.WebClient
$wc.Headers['User-Agent'] = 'MiraeMessenger-ForceUpdate'
$wc.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
$bust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

Write-Host '[3/4] 패키지 resources\app 덮어쓰기 (필수)...' -ForegroundColor Yellow
$ver = Update-AppDir -appDir $PackagedApp -wc $wc -bust $bust
if (-not $ver) { exit 1 }

Write-Host '[3b] 소스 폴더도 있으면 같이 맞춤...' -ForegroundColor DarkGray
if ((Test-AppDir $SourceApp) -and ($SourceApp -ne $PackagedApp)) {
  try { Update-AppDir -appDir $SourceApp -wc $wc -bust $bust | Out-Null } catch {
    Write-Host ("  소스 폴더 업데이트 경고: " + $_.Exception.Message) -ForegroundColor DarkYellow
  }
}

Write-Host ''
Write-Host '[4/4] 검증' -ForegroundColor Yellow
$pkgJson = Get-Content -LiteralPath (Join-Path $PackagedApp 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$verJson = Read-Version $PackagedApp
Write-Host ("  package.json = " + $pkgJson.version)
Write-Host ("  version.json = " + $verJson)

if ($pkgJson.version -ne $verJson) {
  Write-Host '경고: package.json 과 version.json 버전이 다릅니다.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "강제 업데이트 완료: $verJson" -ForegroundColor Green
Write-Host "실행: $ExePath" -ForegroundColor Green
Write-Host ''

if (Test-Path -LiteralPath $ExePath) {
  $ans = Read-Host '지금 MiraeMessenger.exe 를 실행할까요? (Y/N)'
  if ($ans -match '^(Y|y|예|ㅇ)') {
    Start-Process -FilePath $ExePath
  }
}
