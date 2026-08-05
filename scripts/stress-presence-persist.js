#!/usr/bin/env node
/**
 * Mirae Messenger — presence(PING) → known_users persist 부하 실험
 *
 * 실제 main.js 의 persistKnownUserSnapshot 과 같은 SELECT + UPSERT 패턴을
 * N명 × 4초 주기 / 동시 폭주 시나리오로 돌려 event-loop lag · 쿼리 지연을 측정한다.
 *
 * 사용:
 *   node scripts/stress-presence-persist.js
 *   node scripts/stress-presence-persist.js --users=200 --seconds=12
 *   node scripts/stress-presence-persist.js --mode=skip-unchanged
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

const USER_COUNT = Math.max(1, parseInt(arg('users', '70'), 10) || 70);
const DURATION_SEC = Math.max(2, parseInt(arg('seconds', '10'), 10) || 10);
const PING_INTERVAL_MS = Math.max(500, parseInt(arg('interval', '4000'), 10) || 4000);
const MODE = String(arg('mode', 'always') || 'always'); // always | skip-unchanged
const PHOTO_BYTES = Math.max(0, parseInt(arg('photo', '0'), 10) || 0); // 프로필 사진 크기(바이트) — 0이면 빈 문자열

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-presence-stress-'));
const dbPath = path.join(tmpDir, 'stress.db');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(msArr) {
  const s = msArr.slice().sort((a, b) => a - b);
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

function openDb() {
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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function setupSchema(db) {
  await run(db, `PRAGMA journal_mode = WAL`);
  await run(db, `PRAGMA synchronous = NORMAL`);
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS known_users (
      ip TEXT PRIMARY KEY,
      username TEXT,
      rank TEXT,
      dept TEXT,
      floor TEXT,
      ext_no TEXT,
      phone_no TEXT,
      status_state TEXT,
      photo TEXT,
      last_seen_at INTEGER
    )`
  );
}

function makePhoto() {
  if (!PHOTO_BYTES) return '';
  return 'data:image/jpeg;base64,' + Buffer.alloc(PHOTO_BYTES, 0x41).toString('base64');
}

function makeUsers(n) {
  const photo = makePhoto();
  const users = [];
  for (let i = 1; i <= n; i++) {
    const octet = ((i - 1) % 254) + 1;
    const third = Math.floor((i - 1) / 254) + 122;
    users.push({
      ip: `192.168.${third}.${octet}`,
      username: `직원${i}`,
      rank: i % 5 === 0 ? '실장' : '',
      dept: `부서${(i % 12) + 1}`,
      floor: `${(i % 8) + 1}층`,
      extNo: String(1000 + i),
      phone: '',
      statusState: 'ONLINE',
      photo,
      lastSeen: Date.now() - 86400000,
      fingerprint: ''
    });
  }
  return users;
}

function fingerprint(u) {
  return [
    u.username || '',
    u.rank || '',
    u.dept || '',
    u.floor || '',
    u.extNo || '',
    u.phone || '',
    u.statusState || '',
    u.photo ? '1' : '0'
  ].join('|');
}

/** main.js persistKnownUserSnapshot 과 동일한 SELECT → UPSERT */
function persistKnownUserSnapshot(db, u, stats, opts) {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    db.get(`SELECT * FROM known_users WHERE ip = ?`, [u.ip], (err, row) => {
      if (err) {
        stats.errors += 1;
        resolve();
        return;
      }
      if (opts.mode === 'skip-unchanged' && row) {
        const same =
          (row.username || '') === (u.username || '') &&
          (row.rank || '') === (u.rank || '') &&
          (row.dept || '') === (u.dept || '') &&
          (row.floor || '') === (u.floor || '') &&
          (row.ext_no || '') === (u.extNo || '') &&
          (row.phone_no || '') === (u.phone || '') &&
          (row.status_state || '') === (u.statusState || '');
        if (same) {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          stats.latencies.push(ms);
          stats.skipped += 1;
          resolve();
          return;
        }
      }
      const lastSeen = row && row.last_seen_at ? row.last_seen_at : u.lastSeen || 0;
      db.run(
        `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET
           username = excluded.username,
           rank = excluded.rank,
           dept = CASE WHEN excluded.dept != '' THEN excluded.dept ELSE known_users.dept END,
           floor = CASE WHEN excluded.floor != '' THEN excluded.floor ELSE known_users.floor END,
           ext_no = CASE WHEN excluded.ext_no != '' THEN excluded.ext_no ELSE known_users.ext_no END,
           phone_no = CASE WHEN excluded.phone_no != '' THEN excluded.phone_no ELSE known_users.phone_no END,
           status_state = excluded.status_state,
           photo = CASE WHEN excluded.photo != '' THEN excluded.photo ELSE known_users.photo END,
           last_seen_at = MAX(COALESCE(known_users.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0))`,
        [
          u.ip,
          u.username || '',
          u.rank || '',
          u.dept || '',
          u.floor || '',
          u.extNo || '',
          u.phone || '',
          u.statusState || 'OFFLINE',
          u.photo || '',
          lastSeen
        ],
        (err2) => {
          if (err2) stats.errors += 1;
          else stats.writes += 1;
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          stats.latencies.push(ms);
          resolve();
        }
      );
    });
  });
}

function startEventLoopProbe(samples) {
  let last = process.hrtime.bigint();
  const handle = setInterval(() => {
    const now = process.hrtime.bigint();
    const gapMs = Number(now - last) / 1e6;
    // 기대 간격 50ms 대비 초과분 = lag
    samples.push(Math.max(0, gapMs - 50));
    last = now;
  }, 50);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

async function seed(db, users) {
  for (const u of users) {
    await run(
      db,
      `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.ip, u.username, u.rank, u.dept, u.floor, u.extNo, u.phone, u.statusState, u.photo, u.lastSeen]
    );
    u.fingerprint = fingerprint(u);
  }
}

async function runSteady(db, users, opts) {
  const stats = { writes: 0, skipped: 0, errors: 0, latencies: [], inFlight: 0, peakInFlight: 0 };
  const loopLag = [];
  const probe = startEventLoopProbe(loopLag);
  const started = Date.now();
  let cursor = 0;

  // 실제처럼 4초마다 전원이 한 번씩 오는 대신, 초당 USER_COUNT/4 건으로 균등 분산
  const pps = users.length / (PING_INTERVAL_MS / 1000);
  const tickMs = 50;
  const perTick = Math.max(1, Math.round((pps * tickMs) / 1000));

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() - started >= opts.durationMs) {
        clearInterval(timer);
        // in-flight 소진 대기
        const wait = setInterval(() => {
          if (stats.inFlight === 0) {
            clearInterval(wait);
            clearInterval(probe);
            resolve();
          }
        }, 20);
        return;
      }
      for (let i = 0; i < perTick; i++) {
        const u = users[cursor % users.length];
        cursor += 1;
        stats.inFlight += 1;
        if (stats.inFlight > stats.peakInFlight) stats.peakInFlight = stats.inFlight;
        persistKnownUserSnapshot(db, u, stats, opts).finally(() => {
          stats.inFlight -= 1;
        });
      }
    }, tickMs);
  });

  return {
    kind: 'steady',
    users: users.length,
    mode: opts.mode,
    durationSec: opts.durationMs / 1000,
    targetPps: +pps.toFixed(2),
    writes: stats.writes,
    skipped: stats.skipped,
    errors: stats.errors,
    peakInFlight: stats.peakInFlight,
    queryMs: summarize(stats.latencies),
    eventLoopLagMs: summarize(loopLag)
  };
}

async function runBurst(db, users, opts) {
  const stats = { writes: 0, skipped: 0, errors: 0, latencies: [], inFlight: 0, peakInFlight: 0 };
  const loopLag = [];
  const probe = startEventLoopProbe(loopLag);
  const t0 = Date.now();

  await Promise.all(
    users.map((u) => {
      stats.inFlight += 1;
      if (stats.inFlight > stats.peakInFlight) stats.peakInFlight = stats.inFlight;
      return persistKnownUserSnapshot(db, u, stats, opts).finally(() => {
        stats.inFlight -= 1;
      });
    })
  );
  // 여운 측정
  await new Promise((r) => setTimeout(r, 500));
  clearInterval(probe);

  return {
    kind: 'burst',
    users: users.length,
    mode: opts.mode,
    wallMs: Date.now() - t0,
    writes: stats.writes,
    skipped: stats.skipped,
    errors: stats.errors,
    peakInFlight: stats.peakInFlight,
    queryMs: summarize(stats.latencies),
    eventLoopLagMs: summarize(loopLag)
  };
}

function printReport(title, r) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(r, null, 2));
}

async function main() {
  console.log(`[stress] db=${dbPath}`);
  console.log(`[stress] users=${USER_COUNT} interval=${PING_INTERVAL_MS}ms seconds=${DURATION_SEC} mode=${MODE} photoBytes=${PHOTO_BYTES}`);

  const db = await openDb();
  await setupSchema(db);
  const users = makeUsers(USER_COUNT);
  await seed(db, users);

  const opts = { mode: MODE, durationMs: DURATION_SEC * 1000 };

  // 워밍업: 한 바퀴
  {
    const warm = { writes: 0, skipped: 0, errors: 0, latencies: [] };
    for (const u of users) await persistKnownUserSnapshot(db, u, warm, opts);
  }

  const steady = await runSteady(db, users, opts);
  printReport(`STEADY (${USER_COUNT} users, ~${steady.targetPps} ping/s)`, steady);

  const burst = await runBurst(db, users, opts);
  printReport(`BURST (전원 ${USER_COUNT}명 동시 PING)`, burst);

  // 해석 힌트
  const risk =
    steady.eventLoopLagMs.p95 > 40 || burst.eventLoopLagMs.p95 > 80 || burst.queryMs.p95 > 50
      ? 'HIGH'
      : steady.eventLoopLagMs.p95 > 15 || burst.queryMs.p95 > 20
        ? 'MEDIUM'
        : 'LOW';
  console.log(`\n[판정] 이 환경 기준 체감 버벅 위험도: ${risk}`);
  console.log('  - LOW: 70명 규모에서 SQLite 경로만으로는 체감 버벅 가능성 낮음');
  console.log('  - MEDIUM: 폭주 시 잠깐 지연 가능 — persist 스킵/스로틀 권장');
  console.log('  - HIGH: 상시/폭주 모두 위험 — 즉시 최적화 필요');
  console.log('  ※ Electron UI 렌더/IPC는 포함하지 않은 DB+이벤트루프 측 측정입니다.');

  await new Promise((resolve) => db.close(resolve));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
