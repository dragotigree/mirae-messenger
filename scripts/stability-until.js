#!/usr/bin/env node
/**
 * 안정성 연속 검사 — 지정 시각(기본: Asia/Seoul 06:40)까지 스트레스 스위트 순환
 *
 *   node scripts/stability-until.js
 *   node scripts/stability-until.js --until=06:40 --tz=Asia/Seoul
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

const ROOT = path.resolve(__dirname, '..');
const TZ = arg('tz', 'Asia/Seoul');
const UNTIL = arg('until', '06:40');
const OUT_DIR = arg('out', path.join(ROOT, 'artifacts', 'stability-run'));
const NODE = process.execPath;

fs.mkdirSync(OUT_DIR, { recursive: true });

function nowInTz() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return {
    isoLocal: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
    hm: `${parts.hour}:${parts.minute}`,
    hms: `${parts.hour}:${parts.minute}:${parts.second}`,
    date: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function parseHm(hm) {
  const [h, m] = String(hm).split(':').map((x) => parseInt(x, 10));
  return (h * 60) + (m || 0);
}

/** 오늘 until 시각이 이미 지났으면 내일 until까지 */
function deadlineMs() {
  const now = nowInTz();
  const targetMin = parseHm(UNTIL);
  const nowMin = parseHm(now.hm);
  // 서버 UTC 기준 Date로 근사: 남은 분 계산
  let remainMin = targetMin - nowMin;
  if (remainMin <= 0) remainMin += 24 * 60;
  // 초 단위까지 반영
  const sec = parseInt(now.hms.split(':')[2], 10) || 0;
  const remainMs = (remainMin * 60 - sec) * 1000;
  return Date.now() + Math.max(30_000, remainMs);
}

const SUITES = [
  {
    name: 'db-concurrency',
    cmd: [path.join(ROOT, 'scripts/stress-db-concurrency.js'), '--quick', '--clients=16'],
    timeoutMs: 90_000
  },
  {
    name: 'reconnect',
    cmd: [path.join(ROOT, 'scripts/stress-reconnect-resilience.js'), '--quick'],
    timeoutMs: 120_000
  },
  {
    name: 'scheduled',
    cmd: [path.join(ROOT, 'scripts/stress-scheduled-automation.js'), '--quick'],
    timeoutMs: 90_000
  },
  {
    name: 'memory-churn',
    cmd: ['--expose-gc', path.join(ROOT, 'scripts/stress-memory-churn.js'), '--quick'],
    timeoutMs: 120_000
  },
  {
    name: 's13-quick',
    cmd: [path.join(ROOT, 'scripts/stress-scenarios-1-3-suite.js'), '--users=80', '--quick'],
    timeoutMs: 180_000
  },
  {
    name: 's46-quick',
    cmd: [path.join(ROOT, 'scripts/stress-scenarios-4-6-suite.js'), '--quick'],
    timeoutMs: 180_000
  },
  {
    name: 'hospital-quick',
    cmd: [path.join(ROOT, 'scripts/stress-hospital-load-suite.js'), '--users=200', '--quick'],
    timeoutMs: 240_000
  },
  {
    name: 'cpu-mem-quick',
    cmd: ['--expose-gc', path.join(ROOT, 'scripts/stress-cpu-mem-storm.js'), '--users=200', '--quick'],
    timeoutMs: 180_000
  },
  {
    name: 'traffic',
    cmd: [path.join(ROOT, 'scripts/stress-concurrent-traffic.js'), '--users=80', '--quick'],
    timeoutMs: 120_000
  },
  {
    name: 'presence',
    cmd: [path.join(ROOT, 'scripts/stress-presence-persist.js'), '--quick'],
    timeoutMs: 90_000
  }
];

const results = [];
const logPath = path.join(OUT_DIR, `run-${Date.now()}.log`);
const summaryPath = path.join(OUT_DIR, 'summary.json');

function log(line) {
  const msg = `[${nowInTz().isoLocal} ${TZ}] ${line}`;
  console.log(msg);
  fs.appendFileSync(logPath, msg + '\n');
}

function runOne(suite) {
  const started = Date.now();
  log(`▶ START ${suite.name}`);
  const r = spawnSync(NODE, suite.cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: suite.timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' }
  });
  const wallMs = Date.now() - started;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-20).join('\n');
  const levelMatch = out.match(/\[판정\]\s*(\w+)/);
  const summaryMatch = out.match(/\[SUMMARY\]\s*(\{.*\})/);
  let summary = null;
  if (summaryMatch) {
    try { summary = JSON.parse(summaryMatch[1]); } catch (_) {}
  }
  const exitCode = r.status == null ? (r.signal ? 1 : 0) : r.status;
  const timedOut = !!r.error && /TIMEDOUT|ETIMEOUT/i.test(String(r.error));
  const ok = exitCode === 0 && !timedOut;
  const entry = {
    name: suite.name,
    ok,
    exitCode,
    signal: r.signal || null,
    timedOut,
    wallMs,
    level: (summary && summary.level) || (levelMatch && levelMatch[1]) || null,
    summary,
    tail,
    at: nowInTz().isoLocal
  };
  results.push(entry);
  fs.writeFileSync(summaryPath, JSON.stringify({
    tz: TZ,
    until: UNTIL,
    hostname: os.hostname(),
    startedAt: results[0] && results[0].at,
    updatedAt: entry.at,
    total: results.length,
    passed: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    results
  }, null, 2));
  log(`${ok ? '✅ PASS' : '❌ FAIL'} ${suite.name} exit=${exitCode} ${wallMs}ms level=${entry.level || '-'}`);
  if (!ok) {
    log(`--- tail ${suite.name} ---\n${tail}\n--- end tail ---`);
  }
  return entry;
}

function main() {
  const deadline = deadlineMs();
  const remainMin = Math.round((deadline - Date.now()) / 60000);
  log(`안정성 연속 검사 시작 — ${TZ} ${UNTIL}까지 (약 ${remainMin}분)`);
  log(`로그: ${logPath}`);

  // 정적 스모크
  for (const file of ['main.js', 'preload.js']) {
    const r = spawnSync(NODE, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
    const ok = r.status === 0;
    results.push({ name: `syntax:${file}`, ok, exitCode: r.status, wallMs: 0, at: nowInTz().isoLocal });
    log(`${ok ? '✅' : '❌'} syntax ${file}`);
  }

  let i = 0;
  const shortSuites = SUITES.filter((s) => s.timeoutMs <= 120_000);
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    if (left < 15_000) break;
    // 남은 시간이 짧으면 짧은 스위트만 순환 (한 종류에 몰리지 않게)
    const pool = left < 90_000 ? shortSuites : SUITES;
    const suite = pool[i % pool.length];
    i += 1;
    if (left < suite.timeoutMs * 0.55) {
      const fallback = shortSuites[i % shortSuites.length];
      runOne(fallback);
    } else {
      runOne(suite);
    }
  }

  const passed = results.filter((x) => x.ok).length;
  const failed = results.filter((x) => !x.ok).length;
  log(`종료 — total=${results.length} passed=${passed} failed=${failed}`);
  fs.writeFileSync(summaryPath, JSON.stringify({
    tz: TZ,
    until: UNTIL,
    finishedAt: nowInTz().isoLocal,
    total: results.length,
    passed,
    failed,
    failedNames: results.filter((x) => !x.ok).map((x) => x.name),
    results
  }, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

main();
