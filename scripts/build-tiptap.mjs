#!/usr/bin/env node
/**
 * 공지 서식 편집기(Tiptap) 번들 생성 — 개발자 PC에서만 실행.
 * 결과물: lib/tiptap-editor.js  (index.html이 <script src>로 불러 쓴다)
 *
 * 필요: npm i -D esbuild @tiptap/core @tiptap/pm @tiptap/starter-kit \
 *              @tiptap/extension-text-style @tiptap/extension-color \
 *              @tiptap/extension-highlight @tiptap/extension-table dompurify
 *
 * ※ 병원 내부망에는 인터넷이 없으므로 CDN을 쓰지 않고 번들 결과물을 저장소에 커밋한다
 *   (Excalidraw와 동일한 방식).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'scripts/tiptap-entry.js');
const outJs = path.join(root, 'lib/tiptap-editor.js');

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: ${label} 없음 → ${p}`);
    console.error('먼저 실행: npm i -D esbuild @tiptap/core @tiptap/pm @tiptap/starter-kit @tiptap/extension-text-style @tiptap/extension-color @tiptap/extension-highlight @tiptap/extension-table dompurify');
    process.exit(1);
  }
}

mustExist(entry, 'entry');
mustExist(path.join(root, 'node_modules/esbuild'), 'esbuild');
mustExist(path.join(root, 'node_modules/@tiptap/core'), '@tiptap/core');
mustExist(path.join(root, 'node_modules/dompurify'), 'dompurify');

fs.mkdirSync(path.dirname(outJs), { recursive: true });

const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: outJs,
  format: 'iife',
  minify: true,
  target: ['chrome108'], // Electron 28 = Chromium 120. 넉넉히 잡는다.
  legalComments: 'none',
  logLevel: 'info'
});

const kb = (fs.statSync(outJs).size / 1024).toFixed(1);
console.log(`완료: ${path.relative(root, outJs)} (${kb} KB)`);
