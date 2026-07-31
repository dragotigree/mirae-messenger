import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
let s = fs.readFileSync(file, 'utf8');

const i0 = s.indexOf('const BROADCAST_CHANNEL');
const i1 = s.lastIndexOf('</script>');
if (i0 < 0) throw new Error('script not found');
const head = s.slice(0, i0);
let body = s.slice(i0, i1);
const tail = s.slice(i1);

body = body.replace(/\balert\(/g, 'await appAlert(');
body = body.replace(/\bconfirm\(/g, 'await appConfirm(');

body = body.replace(/return await appAlert\(/g, 'await appAlert(');
body = body.replace(/return await appConfirm\(/g, 'if (!(await appConfirm(');

// Fix: if (!(await appConfirm('msg')); -> if (!(await appConfirm('msg'))) return;
body = body.replace(/if \(!\(await appConfirm\(((?:[^()]*|\([^()]*\))*)\)\);/g, 'if (!(await appConfirm($1))) return;');

// Single-line: if (!x) await appAlert('y'); -> if (!x) { await appAlert('y'); return; }
body = body.replace(/if\s*\(([^)]+)\)\s+await appAlert\(([^;]+)\);/g, 'if ($1) { await appAlert($2); return; }');

// if (!x) await appConfirm - rare

// Standalone await appAlert after "return await" fix: line ends with await appAlert(...); need return on next line if parent is if without braces
body = body.replace(/^(\s*)await appAlert\(([^;]+)\);\s*$/gm, (m, indent, args) => {
  return `${indent}await appAlert(${args});\n${indent}return;`;
});

// Duplicate return; return; fix later with grep

body = body.replace(/\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g, (full, name, offset) => {
  const slice = body.slice(offset, offset + 8000);
  const endMatch = slice.match(/\n    (async )?function /);
  const end = endMatch && endMatch.index ? offset + endMatch.index : offset + 8000;
  const chunk = body.slice(offset, end);
  if ((chunk.includes('await appAlert(') || chunk.includes('await appConfirm(')) && !chunk.startsWith('async function')) {
    return `async function ${name}(`;
  }
  return full;
});

fs.writeFileSync(file, head + body + tail, 'utf8');
console.log('ok');
