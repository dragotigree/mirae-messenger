# Mirae Messenger → GitHub 배포 (집/병원 공통)
#
# 사용법:
#   .\scripts\publish-to-github.ps1 "변경 요약 메시지"
#
# 예:
#   .\scripts\publish-to-github.ps1 "빠른 등록 폼 기본 숨김"
#
# 동작:
#   1) 변경 파일 git add
#   2) commit
#   3) push origin main
#
# 주의:
#   - package.json / version.json 버전을 먼저 올려 두세요.
#   - Private 저장소 push 권한이 있는 GitHub 로그인 필요.

param(
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path .git)) {
  Write-Host "ERROR: 이 폴더는 git 저장소가 아닙니다." -ForegroundColor Red
  exit 1
}

git status -sb
$status = git status --porcelain
if (-not $status) {
  Write-Host "커밋할 변경이 없습니다. 이미 최신이면 git push 만 합니다." -ForegroundColor Yellow
  git push origin main
  exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($Message)) {
  $ver = ""
  try {
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $ver = $pkg.version
  } catch {}
  if ($ver) { $Message = "chore: publish $ver" }
  else { $Message = "chore: publish update" }
}

Write-Host "Commit message: $Message" -ForegroundColor Cyan
git add -A
git commit -m $Message
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git push origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "push 실패. GitHub 로그인/권한을 확인하세요." -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "OK — GitHub main 에 반영되었습니다." -ForegroundColor Green
Write-Host "메신저는 설정 > 프로그램 업데이트 소스가 GitHub 이면 자동/수동으로 새 버전을 받습니다." -ForegroundColor Green
