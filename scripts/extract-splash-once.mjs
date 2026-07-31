import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
const outDir = path.join(root, 'assets');
const outPath = path.join(outDir, 'splash.png');

const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/id="splash-screen"[\s\S]*?<img src="data:image\/png;base64,([^"]+)"/);
if (!m) {
  console.error('splash base64 not found');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, Buffer.from(m[1], 'base64'));
console.log('Wrote', outPath, fs.statSync(outPath).size, 'bytes');

const replaced = html.replace(
  /<img src="data:image\/png;base64,[^"]+" alt="미래병원">/,
  '<img src="assets/splash.png" alt="미래병원" width="384" height="173" decoding="async">'
);
if (replaced === html) {
  console.error('HTML replace failed');
  process.exit(1);
}
fs.writeFileSync(htmlPath, replaced, 'utf8');
console.log('Updated index.html splash reference');
