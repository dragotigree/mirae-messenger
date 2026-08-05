#!/usr/bin/env node
/**
 * 로컬 글꼴 파일을 CDN에서 받아 assets/fonts 에 저장합니다.
 * 배포 전 또는 글꼴 업데이트 시: node scripts/fetch-fonts.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'assets', 'fonts');

const FILES = [
  ['SUIT-Regular.woff2', 'https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2/fonts/static/woff2/SUIT-Regular.woff2'],
  ['SUIT-Medium.woff2', 'https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2/fonts/static/woff2/SUIT-Medium.woff2'],
  ['SUIT-Bold.woff2', 'https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2/fonts/static/woff2/SUIT-Bold.woff2'],
  ['Pretendard-Regular.woff2', 'https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff2/Pretendard-Regular.woff2'],
  ['Pretendard-Bold.woff2', 'https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/woff2/Pretendard-Bold.woff2'],
  ['RIDIBatang.woff', 'https://cdn.jsdelivr.net/gh/projectnoonnu/noonfonts_twelve@1.0/RIDIBatang.woff'],
  ['Eulyoo1945-Regular.woff2', 'https://cdn.jsdelivr.net/gh/sunghyunzz/eulyoo1945/Eulyoo1945-Regular.woff2'],
  ['Eulyoo1945-SemiBold.woff2', 'https://cdn.jsdelivr.net/gh/sunghyunzz/eulyoo1945/Eulyoo1945-SemiBold.woff2'],
  ['MaruBuri-Regular.woff2', 'https://hangeul.pstatic.net/hangeul_static/webfont/MaruBuri/MaruBuri-Regular.woff2'],
  ['MaruBuri-SemiBold.woff2', 'https://hangeul.pstatic.net/hangeul_static/webfont/MaruBuri/MaruBuri-SemiBold.woff2'],
];

async function main() {
  await fs.promises.mkdir(outDir, { recursive: true });
  for (const [name, url] of FILES) {
    const dest = path.join(outDir, name);
    process.stdout.write(`fetch ${name} ... `);
    const res = await fetch(url);
    if (!res.ok) {
      console.log('FAIL', res.status);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(dest, buf);
    console.log('ok', buf.length);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
