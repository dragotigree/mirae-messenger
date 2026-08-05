# 미니모드 UI (Discord Overlay × 카카오톡)

- `src.css` — Tailwind 소스 (`@layer components` + Discord Overlay 토큰)
- `compact-overlay.css` — 빌드 산출물 (앱이 로드)
- `phosphor-paths.json` — Phosphor Regular 아이콘 path 캐시

## 빌드

```bash
npm run build:compact
```

스타일/아이콘을 바꾼 뒤 반드시 빌드하고 `compact-overlay.css`를 커밋하세요.
런타임에는 `node_modules`의 Tailwind·Phosphor가 필요 없습니다.
