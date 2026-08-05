#!/usr/bin/env node
/**
 * Mirae Messenger — 시나리오 4·5·6 통합 부하검사
 *
 *  4) 연결 안정성·장애 복구
 *  5) 장시간·미니모드 메모리
 *  6) 예약 메시지·자동백업·자리비움
 *
 *   node scripts/stress-scenarios-4-6-suite.js
 *   node scripts/stress-scenarios-4-6-suite.js --quick
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const QUICK = hasFlag('quick');
const JSON_OUT = arg('json-out', '');
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-s46-logs-'));

function scoreLevel(level) {
  if (level === 'HIGH') return 2;
  if (level === 'MEDIUM') return 1;
  return 0;
}

function runNode(scriptRel, args, timeoutMs, exposeGc) {
  const script = path.join(ROOT, scriptRel);
  const logFile = path.join(LOG_DIR, path.basename(scriptRel, '.js') + '.log');
  const started = Date.now();
  const nodeArgs = exposeGc ? ['--expose-gc', script, ...args] : [script, ...args];
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 300000,
    maxBuffer: 16 * 1024 * 1024
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  try { fs.writeFileSync(logFile, out); } catch (_) {}
  let summary = null;
  const m = out.match(/\[SUMMARY\]\s*(\{.*\})/);
  if (m) {
    try { summary = JSON.parse(m[1]); } catch (_) {}
  }
  const levelMatch = out.match(/판정:\s*(\w+)/);
  return {
    script: scriptRel,
    args,
    wallMs: Date.now() - started,
    exitCode: r.status == null ? (r.signal ? 1 : 0) : r.status,
    signal: r.signal || null,
    level: (summary && summary.level) || (levelMatch && levelMatch[1]) || (r.status === 2 ? 'HIGH' : r.status ? 'MEDIUM' : 'LOW'),
    summary,
    logFile,
    tail: out.trim().split('\n').slice(-18).join('\n')
  };
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    host: {
      cpus: os.cpus().length,
      totalMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMb: Math.round(os.freemem() / 1024 / 1024)
    },
    config: { quick: QUICK, logDir: LOG_DIR },
    cases: []
  };

  console.log('══════════════════════════════════════════════');
  console.log(' Mirae Messenger 시나리오 4·5·6 통합 부하검사');
  console.log(` quick=${QUICK} logs=${LOG_DIR}`);
  console.log('══════════════════════════════════════════════');

  console.log('\n▶ [4] 연결 안정성·장애 복구');
  report.cases.push({
    name: 'reconnect-resilience',
    ...runNode('scripts/stress-reconnect-resilience.js', QUICK ? ['--quick'] : [], 120000)
  });
  console.log(report.cases[report.cases.length - 1].tail);

  console.log('\n▶ [5] 메모리·미니모드');
  report.cases.push({
    name: 'memory-churn',
    ...runNode('scripts/stress-memory-churn.js', QUICK ? ['--quick'] : [], 120000, true)
  });
  console.log(report.cases[report.cases.length - 1].tail);

  console.log('\n▶ [6] 예약·백업·자리비움');
  report.cases.push({
    name: 'scheduled-automation',
    ...runNode(
      'scripts/stress-scheduled-automation.js',
      QUICK ? ['--quick', '--scheduled=200'] : ['--scheduled=500'],
      180000
    )
  });
  console.log(report.cases[report.cases.length - 1].tail);

  let worst = 0;
  const failNames = [];
  const warnNames = [];
  for (const c of report.cases) {
    const lvl = c.level || 'LOW';
    c.level = lvl;
    const s = scoreLevel(lvl);
    if (s > worst) worst = s;
    if (lvl === 'HIGH' || c.exitCode === 2) failNames.push(c.name);
    else if (lvl === 'MEDIUM') warnNames.push(c.name);
  }

  const overall = worst >= 2 ? 'FAIL' : worst === 1 ? 'PASS_WITH_WARNINGS' : 'PASS';
  report.overall = overall;
  report.failNames = failNames;
  report.warnNames = warnNames;

  console.log('\n══════════════════════════════════════════════');
  console.log(` 종합 판정: ${overall}`);
  for (const c of report.cases) {
    const mark = c.level === 'HIGH' ? '✗' : c.level === 'MEDIUM' ? '!' : '✓';
    console.log(`  ${mark} ${c.name.padEnd(24)} ${String(c.level).padEnd(8)} ${c.wallMs}ms`);
    console.log(`      log: ${c.logFile}`);
  }
  console.log('══════════════════════════════════════════════');
  console.log(`[SUMMARY] ${JSON.stringify({ overall, fail: failNames, warn: warnNames, logDir: LOG_DIR })}`);

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  if (overall === 'FAIL') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
