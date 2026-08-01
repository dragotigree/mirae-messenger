Mirae Messenger — Z드라이브 브리지 (옛 버전 → GitHub)
====================================================

■ 왜 필요한가?
  예전 PC는 업데이트 소스가 Z폴더뿐인 경우가 있습니다.
  GitHub에만 push 하면 이 PC들은 새 버전을 모릅니다.

■ 자동 공유 (권장)
  1) GitHub에 새 버전 push
  2) Z가 연결된 PC에서 메신저를 GitHub로 업데이트
     → 업데이트 직후 / 실행 시 자동으로
       Z:\...\물리치료실\messenger 에 최신 파일을 미러
  3) 설정(마스터) → 프로그램 업데이트 → 「Z드라이브에 공유」로 수동 공유도 가능

■ 배포 명령 (관리 PC, Z 연결됨)
  powershell -ExecutionPolicy Bypass -File .\scripts\publish-to-github.ps1 "설명"
  (Z: 가 보이면 publish-z-bridge 도 자동 실행)

  Z만 따로:
  powershell -ExecutionPolicy Bypass -File .\scripts\publish-z-bridge.ps1

■ 옛 PC에서
  1) Z: 드라이브가 잡혀 있는지 확인
  2) 메신저 실행 (또는 설정 → 지금 확인 → 업데이트)

■ 업데이트 소스 경로 (옛 버전 DB)
  정상: Z:\9.재활치료실(PT&OT&언어&임상심리)\물리치료실\messenger
  (물리치료실 까지만 되어 있으면 messenger 폴더로 맞춰 주세요)

■ 참고
  클라우드/집 PC에서는 Z에 직접 쓸 수 없습니다.
  병원망 Z가 있는 PC가 한 대라도 최신 버전으로 올라오면 Z에 공유됩니다.
