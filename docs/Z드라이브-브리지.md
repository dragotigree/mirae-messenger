Mirae Messenger — Z드라이브 브리지 (옛 버전 → GitHub)
====================================================

■ 왜 필요한가?
  1.0.187 이하(대략 140~150대 포함)는 업데이트 소스가 Z폴더뿐입니다.
  GitHub에만 push 하면 이 PC들은 새 버전을 모릅니다.

■ 한 번만 하는 다리
  1) 최신 코드를 Z:\...\물리치료실\messenger 에 둔다
     (아래 스크립트)
  2) 옛 PC가 Z에서 파일을 받아 GitHub 지원 버전으로 올라간다
  3) 그다음부터는 GitHub 자동 업데이트

■ 배포 명령 (관리 PC)
  powershell -ExecutionPolicy Bypass -File .\scripts\publish-z-bridge.ps1

  또는 GitHub 배포와 함께:
  .\scripts\publish-to-github.ps1 "설명"
  .\scripts\publish-z-bridge.ps1

■ 옛 PC에서
  1) Z: 드라이브가 잡혀 있는지 확인
  2) 메신저 실행 (켜 두면 자동 확인) 또는
     설정 → 프로그램 업데이트 → 지금 확인 → 업데이트
  3) 재시작 후 버전이 1.0.196 이상인지 확인

■ 업데이트 소스 경로 (옛 버전 DB)
  정상: Z:\9.재활치료실(PT&OT&언어&임상심리)\물리치료실\messenger
  (물리치료실 까지만 되어 있으면 messenger 폴더로 맞춰 주세요)

■ 이후
  Z 브리지는 더 이상 필요 없습니다. GitHub push만 하면 됩니다.
