#!/usr/bin/env node
/**
 * Mirae Messenger — 시나리오 1·2·3 통합 부하검사
 *
 *  1) 동시 접속·트래픽 (정전복구 200명, 메시지 폭주, 크로스 대역)
 *  2) 파일·이미지 (대용량 동시, 크로스 FILE_XFER, 이미지 버스트, mirae-file 열기)
 *  3) DB 동시성 (메시지 R/W, 공지·일정 권한, 스키마 ALTER)
 *
 *   node scripts/stress-scenarios-1-3-suite.js
 *   node scripts/stress-scenarios-1-3-suite.js --quick
 *   node scripts/stress-scenarios-1-3-suite.js --json-out=/tmp/s13.json
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
const USERS = Math.max(40, parseInt(arg('users', QUICK ? '80' : '200'), 10) || 200);
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-s13-logs-'));

function scoreLevel(level) {
  if (level === 'HIGH') return 2;
  if (level === 'MEDIUM') return 1;
  return 0;
}

function runNode(scriptRel, args, timeoutMs) {
  const script = path.join(ROOT, scriptRel);
  const logFile = path.join(LOG_DIR, path.basename(scriptRel, '.js') + '.log');
  const started = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], {
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
    tail: out.trim().split('\n').slice(-20).join('\n')
  };
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    host: {
      cpus: os.cpus().length,
      totalMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMb: Math.round(os.freemem() / 1024 / 1024),
      platform: os.platform()
    },
    config: { users: USERS, quick: QUICK, logDir: LOG_DIR },
    cases: []
  };

  console.log('══════════════════════════════════════════════');
  console.log(' Mirae Messenger 시나리오 1·2·3 통합 부하검사');
  console.log(` users=${USERS} quick=${QUICK} logs=${LOG_DIR}`);
  console.log('══════════════════════════════════════════════');

  console.log('\n▶ [1/3] 동시 접속·트래픽');
  report.cases.push({
    name: 'concurrent-traffic',
    ...runNode('scripts/stress-concurrent-traffic.js', [
      `--users=${USERS}`,
      ...(QUICK ? ['--quick'] : [])
    ], QUICK ? 120000 : 300000)
  });
  console.log(report.cases[report.cases.length - 1].tail);

  console.log('\n▶ [2/3] 파일·이미지 크로스대역');
  report.cases.push({
    name: 'file-cross-subnet',
    ...runNode('scripts/stress-file-cross-subnet.js', [
      ...(QUICK ? ['--quick'] : []),
      `--concurrent=${QUICK ? 6 : 12}`,
      `--file-mb=${QUICK ? 3 : 15}`
    ], QUICK ? 180000 : 600000)
  });
  console.log(report.cases[report.cases.length - 1].tail);

  console.log('\n▶ [3/3] DB 동시성');
  report.cases.push({
    name: 'db-concurrency',
    ...runNode('scripts/stress-db-concurrency.js', [
      `--clients=${QUICK ? 12 : 24}`,
      `--ops=${QUICK ? 200 : 800}`,
      ...(QUICK ? ['--quick'] : [])
    ], 120000)
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
  console.log('──────────────────────────────────────────────');
  for (const c of report.cases) {
    const mark = c.level === 'HIGH' ? '✗' : c.level === 'MEDIUM' ? '!' : '✓';
    console.log(`  ${mark} ${c.name.padEnd(22)} ${String(c.level || '-').padEnd(8)} ${c.wallMs || 0}ms`);
    console.log(`      log: ${c.logFile}`);
  }
  if (failNames.length) console.log(`\n FAIL: ${failNames.join(', ')}`);
  if (warnNames.length) console.log(` WARN: ${warnNames.join(', ')}`);
  console.log('══════════════════════════════════════════════');

  console.log(`\n[SUMMARY] ${JSON.stringify({
    overall,
    users: USERS,
    fail: failNames,
    warn: warnNames,
    logDir: LOG_DIR
  })}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`[wrote] ${JSON_OUT}`);
  }

  if (overall === 'FAIL') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
