import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

/**
 * index.html 안의 인라인 <script> 블록 문법 검사.
 *
 * ⚠️ 예전에는 "첫 <script>부터 마지막 </script>까지"를 통째로 잘라 한 덩어리로 검사했다.
 * index.html에 인라인 블록이 2개가 되면서 그 사이의 `</script><script>`가 잘린 조각에
 * 그대로 섞여 들어가, 문법이 멀쩡한데도 항상 SyntaxError로 실패했다(상시 실패).
 * 블록마다 따로 잘라서 각각 검사한다.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// src 속성이 있는 <script src="..."> 는 본문이 없으므로 제외하고, 인라인 블록만 고른다.
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

if (blocks.length === 0) {
  console.error('인라인 <script> 블록을 찾지 못했습니다 — index.html 구조를 확인하세요.');
  process.exit(1);
}

let failed = 0;
blocks.forEach((m, i) => {
  const code = m[1];
  // 블록이 시작하는 실제 줄 번호 (오류 위치를 index.html 기준으로 환산하기 위해)
  const startLine = html.slice(0, m.index).split('\n').length;
  const tmp = path.join(root, `.tmp-script-check-${i}.js`);
  fs.writeFileSync(tmp, code);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (r.status !== 0) {
    failed++;
    console.error(`\n[블록 ${i}] index.html 약 ${startLine}행부터 시작하는 인라인 스크립트 문법 오류:`);
    console.error(r.stderr || r.stdout);
  } else {
    console.log(`블록 ${i} (index.html ${startLine}행~, ${code.length.toLocaleString()}자) SYNTAX OK`);
  }
});

if (failed) {
  console.error(`\n${failed}개 블록에서 문법 오류 발견`);
  process.exit(1);
}
console.log(`\n인라인 스크립트 ${blocks.length}개 블록 전부 SYNTAX OK`);
