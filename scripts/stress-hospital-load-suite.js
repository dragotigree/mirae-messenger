#!/usr/bin/env node
/**
 * Mirae Messenger — 병원용 통합 부하검사 스위트
 *
 * 목표: 500대 규모에서도 "항상" 죽지 않고 응답 가능한지 판정.
 *
 *   node scripts/stress-hospital-load-suite.js
 *   node scripts/stress-hospital-load-suite.js --users=500 --quick
 *   node scripts/stress-hospital-load-suite.js --users=500 --json-out=/tmp/hospital-load.json
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const USERS = Math.max(50, parseInt(arg('users', '500'), 10) || 500);
const QUICK = hasFlag('quick');
const JSON_OUT = arg('json-out', '');
const ROOT = path.resolve(__dirname, '..');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function summarize(msArr) {
  const s = (msArr || []).slice().sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    avg: s.length ? +(sum / s.length).toFixed(2) : 0,
    p50: +percentile(s, 50).toFixed(2),
    p95: +percentile(s, 95).toFixed(2),
    p99: +percentile(s, 99).toFixed(2),
    max: s.length ? +s[s.length - 1].toFixed(2) : 0
  };
}

function runNode(scriptRel, args, timeoutMs) {
  const script = path.join(ROOT, scriptRel);
  const started = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs || 120000,
    maxBuffer: 8 * 1024 * 1024
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  let summary = null;
  const m = out.match(/\[SUMMARY\]\s*(\{.*\})/);
  if (m) {
    try { summary = JSON.parse(m[1]); } catch (_) {}
  }
  // boot-storm / presence use different summary shapes
  const levelMatch = out.match(/\[판정\]\s*(\w+)/);
  return {
    script: scriptRel,
    args,
    wallMs: Date.now() - started,
    exitCode: r.status == null ? (r.signal ? 1 : 0) : r.status,
    signal: r.signal || null,
    level: (summary && summary.level) || (levelMatch && levelMatch[1]) || null,
    summary,
    tail: out.trim().split('\n').slice(-12).join('\n')
  };
}

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

/** 메시지 INSERT + 히스토리 조회 (get-chat-history 유사) */
async function runMessageDbStorm() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-msg-storm-'));
  const dbPath = path.join(tmpDir, 'msg.db');
  const db = await openDb(dbPath);
  await run(db, `PRAGMA journal_mode=WAL`);
  await run(db, `PRAGMA synchronous=NORMAL`);
  await run(
    db,
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_name TEXT, sender_ip TEXT, receiver_ip TEXT,
      message TEXT, status TEXT, msg_uid TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await run(db, `CREATE INDEX idx_pair ON messages(sender_ip, receiver_ip)`);
  await run(db, `CREATE UNIQUE INDEX idx_uid_recv ON messages(msg_uid, receiver_ip) WHERE msg_uid IS NOT NULL AND trim(msg_uid) != ''`);

  const myIp = '192.168.122.10';
  const peers = [];
  for (let i = 1; i <= Math.min(USERS, 200); i++) {
    peers.push(`192.168.122.${(i % 254) + 1}`);
  }

  // 시드: peer당 최근 대화 다수 (병원 PC 장기 사용)
  const seedPerPeer = QUICK ? 40 : 120;
  const insertLat = [];
  const tSeed = Date.now();
  for (const peer of peers) {
    for (let k = 0; k < seedPerPeer; k++) {
      const t0 = process.hrtime.bigint();
      const uid = `${peer}_${k}_${Math.random().toString(16).slice(2, 10)}`;
      const isMe = k % 2 === 0;
      await run(
        db,
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
         VALUES (?, ?, ?, ?, 'SENT', ?)`,
        [
          isMe ? '나' : `직원${peer.split('.').pop()}`,
          isMe ? myIp : peer,
          isMe ? peer : myIp,
          `병원 인수인계 메시지 #${k} — 환자 상태 확인 부탁드립니다.`,
          uid
        ]
      );
      insertLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  const seedWallMs = Date.now() - tSeed;

  // 동시 수신 INSERT 폭주 (500명 동시 DM 1통)
  const burstN = Math.min(USERS, 500);
  const burstLat = [];
  const burstErrors = { count: 0 };
  const tBurst = Date.now();
  await Promise.all(
    Array.from({ length: burstN }, (_, i) => {
      const peer = `192.168.123.${(i % 254) + 1}`;
      const uid = `burst_${i}_${Date.now()}`;
      const t0 = process.hrtime.bigint();
      return run(
        db,
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
         VALUES (?, ?, ?, ?, 'SENT', ?)`,
        [`송신${i}`, peer, myIp, `동시 DM 테스트 ${i}`, uid]
      ).then(() => {
        burstLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }).catch(() => {
        burstErrors.count += 1;
        burstLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      });
    })
  );
  const burstWallMs = Date.now() - tBurst;

  // 히스토리 조회 (최근 limit / beforeId 페이지)
  const histLat = [];
  const histPeer = peers[0];
  for (let i = 0; i < (QUICK ? 30 : 80); i++) {
    const t0 = process.hrtime.bigint();
    await all(
      db,
      `SELECT id, sender_name, sender_ip, receiver_ip, message, status, msg_uid,
              strftime('%H:%M', created_at, 'localtime') as created_time
       FROM messages
       WHERE (sender_ip = ? AND receiver_ip = ?) OR (sender_ip = ? AND receiver_ip = ?)
       ORDER BY id DESC LIMIT 80`,
      [myIp, histPeer, histPeer, myIp]
    );
    histLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  // beforeId 페이지네이션
  const pageLat = [];
  const newest = await all(db, `SELECT id FROM messages WHERE (sender_ip=? AND receiver_ip=?) OR (sender_ip=? AND receiver_ip=?) ORDER BY id DESC LIMIT 1`, [myIp, histPeer, histPeer, myIp]);
  let beforeId = (newest[0] && newest[0].id) || 0;
  for (let i = 0; i < 20 && beforeId > 0; i++) {
    const t0 = process.hrtime.bigint();
    const rows = await all(
      db,
      `SELECT id FROM messages
       WHERE ((sender_ip = ? AND receiver_ip = ?) OR (sender_ip = ? AND receiver_ip = ?))
         AND id < ?
       ORDER BY id DESC LIMIT 80`,
      [myIp, histPeer, histPeer, myIp, beforeId]
    );
    pageLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!rows.length) break;
    beforeId = rows[rows.length - 1].id;
  }

  const countRow = await all(db, `SELECT COUNT(*) AS c FROM messages`);
  await new Promise((r) => db.close(r));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const insertP95 = summarize(insertLat).p95;
  const burstP95 = summarize(burstLat).p95;
  const histP95 = summarize(histLat).p95;
  const pageP95 = summarize(pageLat).p95;

  let level = 'LOW';
  const risks = [];
  if (burstErrors.count > 0) risks.push('insert-errors');
  if (burstP95 > 80 || burstWallMs > 5000) risks.push('burst-insert-slow');
  if (histP95 > 40 || pageP95 > 40) risks.push('history-query-slow');
  if (insertP95 > 30) risks.push('seed-insert-slow');
  if (risks.includes('insert-errors') || risks.filter((x) => x.includes('slow')).length >= 2) level = 'HIGH';
  else if (risks.length) level = 'MEDIUM';

  return {
    kind: 'message-db-storm',
    peers: peers.length,
    seedPerPeer,
    messageCount: countRow[0] ? countRow[0].c : 0,
    seedWallMs,
    burst: { n: burstN, wallMs: burstWallMs, errors: burstErrors.count, queryMs: summarize(burstLat) },
    historyMs: summarize(histLat),
    pageMs: summarize(pageLat),
    seedInsertMs: summarize(insertLat),
    level,
    risks
  };
}

/** 혼합: 짧은 주기 persist + 메시지 INSERT 동시 */
async function runMixedLoopStress() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-mixed-'));
  const dbPath = path.join(tmpDir, 'mixed.db');
  const db = await openDb(dbPath);
  await run(db, `PRAGMA journal_mode=WAL`);
  await run(db, `PRAGMA synchronous=NORMAL`);
  await run(db, `CREATE TABLE known_users (ip TEXT PRIMARY KEY, username TEXT, rank TEXT, dept TEXT, floor TEXT, ext_no TEXT, phone_no TEXT, status_state TEXT, photo TEXT, last_seen_at INTEGER)`);
  await run(db, `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_ip TEXT, receiver_ip TEXT, message TEXT, status TEXT, msg_uid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  const lag = [];
  let last = process.hrtime.bigint();
  const probe = setInterval(() => {
    const now = process.hrtime.bigint();
    lag.push(Math.max(0, Number(now - last) / 1e6 - 50));
    last = now;
  }, 50);

  const durationMs = QUICK ? 4000 : 10000;
  const started = Date.now();
  let writes = 0;
  let errors = 0;
  let inFlight = 0;
  let peak = 0;

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (Date.now() - started >= durationMs) {
        clearInterval(tick);
        const wait = setInterval(() => {
          if (inFlight === 0) {
            clearInterval(wait);
            clearInterval(probe);
            resolve();
          }
        }, 20);
        return;
      }
      // 초당 ~125 presence + ~40 message
      for (let i = 0; i < 8; i++) {
        const ip = `192.168.122.${(writes % 250) + 1}`;
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        db.run(
          `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
           VALUES (?, ?, '', '재활', '3층', '', '', 'ONLINE', '', ?)
           ON CONFLICT(ip) DO UPDATE SET username=excluded.username, status_state=excluded.status_state`,
          [ip, `직원${writes % 500}`, Date.now()],
          (err) => {
            if (err) errors += 1;
            else writes += 1;
            inFlight -= 1;
          }
        );
      }
      for (let i = 0; i < 3; i++) {
        const peer = `192.168.123.${(writes % 250) + 1}`;
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        db.run(
          `INSERT INTO messages (sender_ip, receiver_ip, message, status, msg_uid) VALUES (?, '192.168.122.10', ?, 'SENT', ?)`,
          [peer, `혼잡메시지 ${writes}`, `${peer}_${Date.now()}_${i}`],
          (err) => {
            if (err) errors += 1;
            else writes += 1;
            inFlight -= 1;
          }
        );
      }
    }, 50);
  });

  await new Promise((r) => db.close(r));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const lagSum = summarize(lag);
  const risks = [];
  if (errors > 0) risks.push('mixed-db-errors');
  if (lagSum.p95 > 80) risks.push('mixed-event-loop');
  let level = 'LOW';
  if (errors > 0 || lagSum.p95 > 120) level = 'HIGH';
  else if (risks.length) level = 'MEDIUM';

  return {
    kind: 'mixed-loop',
    durationMs,
    writes,
    errors,
    peakInFlight: peak,
    eventLoopLagMs: lagSum,
    level,
    risks
  };
}

function scoreLevel(level) {
  if (level === 'HIGH') return 2;
  if (level === 'MEDIUM') return 1;
  return 0;
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
    config: { users: USERS, quick: QUICK },
    cases: []
  };

  console.log('══════════════════════════════════════════════');
  console.log(' Mirae Messenger 병원용 통합 부하검사');
  console.log(` users=${USERS} quick=${QUICK} cpus=${report.host.cpus} ram=${report.host.totalMb}MB`);
  console.log('══════════════════════════════════════════════');

  // 1) Presence persist
  console.log('\n▶ [1/6] Presence persist (always → skip)');
  report.cases.push({
    name: 'presence-always',
    ...runNode('scripts/stress-presence-persist.js', [
      `--users=${USERS}`,
      `--seconds=${QUICK ? 6 : 12}`,
      '--mode=always'
    ], 90000)
  });
  report.cases.push({
    name: 'presence-skip',
    ...runNode('scripts/stress-presence-persist.js', [
      `--users=${USERS}`,
      `--seconds=${QUICK ? 6 : 12}`,
      '--mode=skip-unchanged'
    ], 90000)
  });

  // 2) Boot storm
  console.log('\n▶ [2/6] Boot storm (3s window + instant)');
  report.cases.push({
    name: 'boot-window-3s',
    ...runNode('scripts/stress-boot-storm-500.js', [
      `--users=${USERS}`,
      '--window-ms=3000',
      `--steady-sec=${QUICK ? 6 : 12}`,
      '--mode=skip-unchanged',
      '--tcp-concurrency=8'
    ], 90000)
  });
  report.cases.push({
    name: 'boot-instant',
    ...runNode('scripts/stress-boot-storm-500.js', [
      `--users=${USERS}`,
      '--window-ms=0',
      `--steady-sec=${QUICK ? 6 : 12}`,
      '--mode=skip-unchanged',
      '--tcp-concurrency=8'
    ], 90000)
  });

  // 3) File / photo receive
  console.log('\n▶ [3/6] Photo & file receive');
  report.cases.push({
    name: 'photo-500',
    ...runNode('scripts/stress-file-recv-storm.js', [
      '--photos=500',
      '--files=24',
      '--file-mb=5',
      '--cap=24'
    ], 60000)
  });
  report.cases.push({
    name: 'file-500x10mb-model',
    ...runNode('scripts/stress-file-recv-storm.js', [
      '--photos=50',
      '--files=500',
      '--file-mb=10',
      '--cap=24'
    ], 60000)
  });

  // 4) Message DB
  console.log('\n▶ [4/6] Message DB storm');
  const msg = await runMessageDbStorm();
  report.cases.push({ name: 'message-db', exitCode: msg.level === 'HIGH' ? 2 : 0, level: msg.level, summary: msg, wallMs: msg.seedWallMs + msg.burst.wallMs });
  console.log(JSON.stringify(msg, null, 2));

  // 5) Mixed
  console.log('\n▶ [5/6] Mixed presence+message loop');
  const mixed = await runMixedLoopStress();
  report.cases.push({ name: 'mixed-loop', exitCode: mixed.level === 'HIGH' ? 2 : 0, level: mixed.level, summary: mixed, wallMs: mixed.durationMs });
  console.log(JSON.stringify(mixed, null, 2));

  // 6) Aggregate
  console.log('\n▶ [6/6] Aggregate verdict');
  let worst = 0;
  const failNames = [];
  const warnNames = [];
  for (const c of report.cases) {
    const lvl = c.level || (c.exitCode === 2 ? 'HIGH' : c.exitCode ? 'MEDIUM' : 'LOW');
    c.level = lvl;
    const s = scoreLevel(lvl);
    if (s > worst) worst = s;
    if (lvl === 'HIGH' || c.exitCode === 2) failNames.push(c.name);
    else if (lvl === 'MEDIUM') warnNames.push(c.name);
  }

  // 병원 기준: HIGH가 하나라도 있으면 FAIL. MEDIUM만 있으면 PASS_WITH_WARNINGS.
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
  }
  if (failNames.length) console.log(`\n FAIL 항목: ${failNames.join(', ')}`);
  if (warnNames.length) console.log(` WARN 항목: ${warnNames.join(', ')}`);
  console.log('\n 병원 운영 기준:');
  console.log('  PASS — 500대 동시 기동·PING·메시지·사진 수신 모두 안전');
  console.log('  PASS_WITH_WARNINGS — 동작하나 최악 순간 지연 가능 (스로틀 유지)');
  console.log('  FAIL — OOM/오류/장시간 정지 가능 → 배포 전 수정 필요');
  console.log('══════════════════════════════════════════════');

  console.log(`\n[SUMMARY] ${JSON.stringify({
    overall,
    users: USERS,
    fail: failNames,
    warn: warnNames
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
