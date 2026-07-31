import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const i = html.indexOf('<script>');
const j = html.lastIndexOf('</script>');
const script = html.slice(i + 8, j);
const tmp = path.join(root, '.tmp-script-check.js');
fs.writeFileSync(tmp, script);
const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.unlinkSync(tmp);
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}
console.log('SYNTAX OK');
