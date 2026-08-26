# 미래병원 메신저 — 작업 시 유의사항

## 새 기능 안내(기능 가이드) 자동 동기화 — 반드시 지킬 것

`index.html`의 `FEATURE_GUIDE_ITEMS` 배열(검색: `FEATURE_GUIDE_ITEMS`)은 앱 안의
"새 기능 안내" 화면(좌측 아이콘 레일의 물음표 버튼)에 뜨는 기능 목록이다.

**사용자가 별도로 요청하지 않아도, 아래에 해당하는 변경을 하는 모든 작업에서
이 배열을 함께 갱신한다:**

- 사용자가 체감할 수 있는 새 기능을 추가했을 때 → 새 항목을 추가한다.
- 기존 기능을 제거하거나 다른 기능으로 완전히 대체했을 때 → 해당 항목을 지우거나 고친다.
- 기능의 사용 위치(메뉴 경로)나 사용 방법이 달라졌을 때 → `path`/`chips`/`tip`을 고친다.
- 단순 버그 수정이나 내부 리팩터링처럼 사용자가 쓰는 방식이 그대로인 변경은
  건드리지 않아도 된다.

항목 형식(`FEATURE_GUIDE_ITEMS` 배열의 원소):
```js
{
  cat: 'chat' | 'group' | 'notify' | 'manage', // FEATURE_GUIDE_CATS 중 하나. 새 분류가 필요하면 FEATURE_GUIDE_CATS에도 추가
  icon: '🔍',            // 이모지 1개
  color: '#2563eb',      // 아이콘 배경색(hex)
  title: '대화 검색',
  tag: '1:1·그룹 공통',   // 짧은 라벨
  path: '메인 메신저 상단 검색창 또는 <b>Ctrl+Shift+F</b>', // 이용 경로, <b> 허용
  chips: ['이름·대화내용 통합 검색', '전체 대화/안읽은 대화만 검색'], // 짧은 요약 2~4개
  tip: '한 줄 사용 팁 또는 null'
}
```

버전을 올려 배포하는 김에 이 배열도 같이 커밋에 포함시키면 되고, 이것 때문에
따로 버전을 올리거나 별도 커밋을 만들 필요는 없다 — 해당 기능을 배포하는
커밋에 자연스럽게 포함시킨다.

## 표준 작업 절차 (기존 관행)

1. `node --check main.js` + `<script>` 블록 `new Function()` 파싱 검증.
2. Xvfb(`:99`)+Electron(`--remote-debugging-port=9333 --no-sandbox`)+CDP로 실제 동작 확인.
   - Xvfb/Electron이 이미 떠 있는지 `pgrep`으로 먼저 확인하고, 없으면 각각 개별 명령으로
     띄운 뒤(체이닝하면 종종 죽는다) `curl -m 3 http://127.0.0.1:9333/json/version`이 성공할
     때까지 짧게 폴링해서 기다린다.
3. `package.json`과 `version.json`의 버전을 올리고, `version.json`의 `notes`에
   한국어로 이번 배포 내용을 적는다(사용자에게 보여지는 업데이트 노트).
4. `claude/mirae-messenger-size-optimization-vulum7` 브랜치에 커밋 → 푸시 →
   `git checkout main` → `git merge --ff-only` → 푸시.
5. 실수로 `main`에서 바로 작업하고 있지 않은지 커밋 전에 `git branch --show-current`로 확인.

## DB 손상 방지 (매우 중요)

2026-08-12에 주기적 백그라운드 작업(3~5초 간격 폴링)이 DB 연결 close/reopen과
경합해 실제 데이터 손상이 난 적이 있다. DB를 재작성/재오픈하는 새 기능(백업 복구,
VACUUM 등)은 반드시 기존 `dbRepairInProgress` 플래그를 존중해야 한다:
- 주기적으로 DB를 건드리는 작업은 시작 시 `if (dbRepairInProgress) return;`으로 건너뛴다.
- DB를 통째로 재작성하는 새 작업은 시작 시 `dbRepairInProgress = true`로 켜고
  `finally`에서 반드시 `false`로 되돌린다.
