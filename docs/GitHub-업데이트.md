Mirae Messenger — GitHub로 업데이트하기
========================================

■ 전체 흐름
  1) Cursor에서 코드 수정
  2) 버전 올리기 (package.json + version.json)
  3) GitHub에 push
  4) 직원 PC 메신저가 GitHub version.json을 보고 자동/수동 업데이트

■ Cursor → GitHub (배포)
  Cursor 에이전트가 수정·버전업을 끝낸 뒤 자동으로 commit + push 합니다.
  (프로젝트 규칙: .cursor/rules/auto-publish-github.mdc)

  직접 배포할 때:

    npm run publish:github -- "무엇을 바꿨는지"
    # 또는
    .\scripts\publish-to-github.ps1 "무엇을 바꿨는지"

  ※ 「푸시하지 마」라고 하면 에이전트는 push를 하지 않습니다.

■ 메신저 업데이트 소스
  - 업데이트는 GitHub만 사용합니다. (Z드라이브·공유폴더는 사용하지 않음)
  - 기본 주소: https://github.com/dragotigree/mirae-messenger
  - 예전에 Z 경로가 저장돼 있어도 실행 시 자동으로 GitHub로 바뀝니다.

■ Private 저장소 인증 (필수에 가깝음)
  GitHub → Settings → Developer settings → Personal access tokens
  - Fine-grained token 권장
  - Repository: mirae-messenger
  - Permissions: Contents = Read-only

  각 PC에서:
  설정 → 「토큰 폴더 열기」 → github-update-token.txt 파일을 만들고
  토큰 문자열만 한 줄로 저장.

  위치 예:
    %APPDATA%\MiraeMessenger\github-update-token.txt

■ 병원망에서 GitHub가 막힌 경우 / 옛 버전(Z만 아는 PC)
  1) 관리 PC에서 Z 브리지 배포:
       .\scripts\publish-z-bridge.ps1
  2) 옛 PC는 Z 연결 후 메신저 실행(또는 「지금 확인」)
  3) GitHub 지원 버전으로 올라가면 이후는 GitHub만 사용
  자세한 내용: docs\Z드라이브-브리지.md

■ 새 버전 배포 체크리스트
  [ ] package.json version 증가
  [ ] version.json version + notes 수정
  [ ] git push (또는 publish-to-github.ps1)
  [ ] (옛 PC가 남아 있으면) publish-z-bridge.ps1 도 실행
  [ ] 테스트 PC에서 「지금 확인」 → 업데이트
