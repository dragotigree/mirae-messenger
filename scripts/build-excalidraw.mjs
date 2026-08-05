#!/usr/bin/env node
/**
 * Excalidraw 에디터 번들 생성 (개발자 PC에서만 실행).
 * 결과물: lib/excalidraw-app.js, lib/excalidraw-app.css, vendor/excalidraw/*
 *
 * 필요: npm i -D react react-dom @excalidraw/excalidraw esbuild
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'scripts/excalidraw-entry.jsx');
const outJs = path.join(root, 'lib/excalidraw-app.js');
const cssSrc = path.join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/index.css');
const cssOut = path.join(root, 'lib/excalidraw-app.css');
const vendorRoot = path.join(root, 'vendor/excalidraw');
const prodRoot = path.join(root, 'node_modules/@excalidraw/excalidraw/dist/prod');

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: ${label} 없음 → ${p}`);
    console.error('먼저: npm i -D react@18 react-dom@18 @excalidraw/excalidraw@0.18.0 esbuild');
    process.exit(1);
  }
}

mustExist(entry, 'entry');
mustExist(path.join(root, 'node_modules/esbuild'), 'esbuild');
mustExist(prodRoot, '@excalidraw/excalidraw');

const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  outfile: outJs,
  format: 'iife',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.jsx': 'jsx' }
});

fs.copyFileSync(cssSrc, cssOut);

fs.rmSync(vendorRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(vendorRoot, 'fonts'), { recursive: true });
fs.mkdirSync(path.join(vendorRoot, 'locales'), { recursive: true });

const fontFamilies = ['Assistant', 'Cascadia', 'ComicShanns', 'Excalifont', 'Liberation', 'Lilita', 'Nunito', 'Virgil'];
for (const name of fontFamilies) {
  const from = path.join(prodRoot, 'fonts', name);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(vendorRoot, 'fonts', name), { recursive: true });
}

for (const f of fs.readdirSync(path.join(prodRoot, 'locales'))) {
  if (/^(ko-KR|en-|percentages)/.test(f)) {
    fs.copyFileSync(path.join(prodRoot, 'locales', f), path.join(vendorRoot, 'locales', f));
  }
}

function walkRel(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (fs.statSync(abs).isDirectory()) walkRel(abs, base, out);
    else out.push(rel);
  }
}
const assets = [];
walkRel(vendorRoot, vendorRoot, assets);
assets.sort();
fs.writeFileSync(path.join(vendorRoot, 'asset-list.json'), JSON.stringify({ version: '0.18.0', files: assets }, null, 2) + '\n');

console.log('OK:', path.relative(root, outJs), `(${(fs.statSync(outJs).size / 1024 / 1024).toFixed(1)}MB)`);
console.log('OK:', path.relative(root, cssOut));
console.log('OK: vendor/excalidraw assets:', assets.length);
