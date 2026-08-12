#!/usr/bin/env node
/** 그림판 번들 생성 (개발자 PC 전용): npm run build:draw */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'scripts/draw-entry.js');
const outJs = path.join(root, 'lib/draw-app.js');
if (!fs.existsSync(path.join(root, 'node_modules/perfect-freehand'))) {
  console.error('ERROR: perfect-freehand 없음 → npm i -D perfect-freehand');
  process.exit(1);
}
fs.mkdirSync(path.dirname(outJs), { recursive: true });
require('esbuild').buildSync({
  entryPoints: [entry], bundle: true, outfile: outJs,
  format: 'iife', minify: true, target: ['chrome108'], legalComments: 'none', logLevel: 'info'
});
console.log(`완료: lib/draw-app.js (${(fs.statSync(outJs).size / 1024).toFixed(1)} KB)`);
