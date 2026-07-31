# Mirae Messenger Windows exe 빌드 스크립트
# 경로에 & 문자가 있어도 npm run package 대신 이 스크립트를 사용하세요.

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$OutDir = if ($env:MIRAE_BUILD_OUT) { $env:MIRAE_BUILD_OUT } else { Join-Path $env:USERPROFILE 'MiraeMessenger-dist' }

Set-Location -LiteralPath $ProjectRoot

Write-Host ">> sqlite3 Electron용 재빌드..."
npx --yes @electron/rebuild -f -w sqlite3

Write-Host ">> exe 패키징 (출력: $OutDir)..."
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
node (Join-Path $ProjectRoot 'node_modules\electron-packager\bin\electron-packager.js') `
  . MiraeMessenger `
  --platform=win32 --arch=x64 `
  --out=$OutDir `
  --overwrite `
  --icon=icon.ico `
  --ignore="/dist|/\.git|/agent-transcripts"

$AppDir = Join-Path $OutDir 'MiraeMessenger-win32-x64'
$ZipPath = Join-Path $OutDir 'MiraeMessenger-win32-x64.zip'

if (Test-Path $AppDir) {
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  Compress-Archive -Path $AppDir -DestinationPath $ZipPath -Force
  Write-Host ""
  Write-Host "완료!"
  Write-Host "  실행 파일: $AppDir\MiraeMessenger.exe"
  Write-Host "  배포용 ZIP: $ZipPath"
  Write-Host ""
  Write-Host "다른 PC에 배포할 때는 ZIP 전체를 풀어서 폴더째 복사하세요. (exe만 복사하면 실행되지 않습니다)"
}
