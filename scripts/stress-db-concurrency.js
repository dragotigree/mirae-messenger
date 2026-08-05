#!/usr/bin/env node
/**
 * 시나리오 3 — 데이터베이스 동시성
 *
 *  A) 다수 “클라이언트” 동시 메시지 INSERT + SELECT (WAL + busy_timeout=5000)
 *  B) 공지(notices) / 일정(hospital_schedules) 권한 기반 쓰기 동시 시도
 *  C) 스키마 ALTER 경합 + 읽기 혼합 (구버전 컬럼 추가 패턴)
 *
 *   node scripts/stress-db-concurrency.js
 *   node scripts/stress-db-concurrency.js --clients=24 --quick
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
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const CLIENTS = Math.max(4, parseInt(arg('clients', '24'), 10) || 24);
const QUICK = hasFlag('quick');
const OPS = Math.max(50, parseInt(arg('ops', QUICK ? '200' : '800'), 10) || 800);
const DURATION_MS = QUICK ? 5000 : 12000;

const errorLog = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-db-conc-'));
const dbPath = path.join(tmpDir, 'conc.db');

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

function openDb(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
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
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function setupSchema(db) {
  await run(db, `PRAGMA journal_mode = WAL`);
  await run(db, `PRAGMA synchronous = NORMAL`);
  await run(db, `PRAGMA busy_timeout = 5000`);
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_name TEXT, sender_ip TEXT, receiver_ip TEXT,
      message TEXT, status TEXT, msg_uid TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await run(db, `CREATE INDEX IF NOT EXISTS idx_pair ON messages(sender_ip, receiver_ip)`);
  await run(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_uid_recv ON messages(msg_uid, receiver_ip)
     WHERE msg_uid IS NOT NULL AND trim(msg_uid) != ''`
  );
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS notices (
      uid TEXT PRIMARY KEY,
      title TEXT, content TEXT, author_name TEXT, author_ip TEXT,
      created_at TEXT, images TEXT DEFAULT ''
    )`
  );
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS notice_operators (
      username TEXT PRIMARY KEY, password_hash TEXT, display_name TEXT,
      added_at TEXT, can_manage_duty INTEGER DEFAULT 0
    )`
  );
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS hospital_schedules (
      uid TEXT PRIMARY KEY,
      type TEXT, title TEXT, time_str TEXT,
      author_name TEXT, author_ip TEXT, created_at TEXT,
      date_str TEXT DEFAULT ''
    )`
  );
  // 시드 운영자 (권한 있는 계정만 쓰기)
  const ops = ['master', 'nurse_chief', 'admin'];
  for (const u of ops) {
    await run(
      db,
      `INSERT OR IGNORE INTO notice_operators (username, password_hash, display_name, added_at, can_manage_duty)
       VALUES (?, 'x', ?, datetime('now'), 1)`,
      [u, u]
    );
  }
}

function isOperator(username) {
  return ['master', 'nurse_chief', 'admin'].includes(username);
}

/** A) 메시지 동시 기록/조회 */
async function scenarioMessageConcurrency() {
  const t0 = Date.now();
  const connections = [];
  for (let i = 0; i < CLIENTS; i++) {
    const db = await openDb(dbPath);
    await run(db, `PRAGMA busy_timeout = 5000`);
    connections.push(db);
  }

  const writeLat = [];
  const readLat = [];
  let writes = 0;
  let reads = 0;
  let writeErrors = 0;
  let readErrors = 0;
  let busyErrors = 0;
  let uniqueErrors = 0;

  const jobs = [];
  for (let i = 0; i < OPS; i++) {
    const db = connections[i % connections.length];
    const peer = `192.168.${i % 2 === 0 ? 122 : 123}.${(i % 250) + 1}`;
    const myIp = '192.168.122.10';
    const uid = `conc_${i}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;

    jobs.push((async () => {
      const t = process.hrtime.bigint();
      try {
        await run(
          db,
          `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
           VALUES (?, ?, ?, ?, 'SENT', ?)`,
          [`클라${i % CLIENTS}`, peer, myIp, `동시성 메시지 #${i}`, uid]
        );
        writes += 1;
      } catch (e) {
        writeErrors += 1;
        const msg = String(e.message || e);
        if (/busy|locked/i.test(msg)) busyErrors += 1;
        if (/UNIQUE/i.test(msg)) uniqueErrors += 1;
        errorLog.push({ scenario: 'msg-write', i, error: msg });
      }
      writeLat.push(Number(process.hrtime.bigint() - t) / 1e6);
    })());

    if (i % 2 === 0) {
      jobs.push((async () => {
        const t = process.hrtime.bigint();
        try {
          await all(
            db,
            `SELECT id, message, msg_uid FROM messages
             WHERE (sender_ip = ? AND receiver_ip = ?) OR (sender_ip = ? AND receiver_ip = ?)
             ORDER BY id DESC LIMIT 80`,
            [myIp, peer, peer, myIp]
          );
          reads += 1;
        } catch (e) {
          readErrors += 1;
          const msg = String(e.message || e);
          if (/busy|locked/i.test(msg)) busyErrors += 1;
          errorLog.push({ scenario: 'msg-read', i, error: msg });
        }
        readLat.push(Number(process.hrtime.bigint() - t) / 1e6);
      })());
    }
  }
  await Promise.all(jobs);

  // 의도적 UNIQUE 충돌
  const db0 = connections[0];
  let dupRejected = false;
  try {
    await run(
      db0,
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
       VALUES ('a','192.168.122.1','192.168.122.10','dup','SENT','dup_uid_1')`
    );
    await run(
      db0,
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
       VALUES ('b','192.168.122.1','192.168.122.10','dup2','SENT','dup_uid_1')`
    );
  } catch (e) {
    dupRejected = /UNIQUE/i.test(String(e.message || e));
  }

  const count = await get(db0, `SELECT COUNT(*) AS c FROM messages`);
  await Promise.all(connections.map((db) => new Promise((r) => db.close(r))));

  return {
    kind: 'message-rw-concurrency',
    clients: CLIENTS,
    ops: OPS,
    writes,
    reads,
    writeErrors,
    readErrors,
    busyErrors,
    uniqueErrors,
    dupRejected,
    messageCount: count ? count.c : 0,
    writeMs: summarize(writeLat),
    readMs: summarize(readLat),
    wallMs: Date.now() - t0
  };
}

/** B) 공지·일정 권한 쓰기 동시 */
async function scenarioNoticeScheduleAuth() {
  const t0 = Date.now();
  const connections = [];
  for (let i = 0; i < Math.min(CLIENTS, 16); i++) {
    const db = await openDb(dbPath);
    await run(db, `PRAGMA busy_timeout = 5000`);
    connections.push(db);
  }

  const accounts = [
    { user: 'master', allowed: true },
    { user: 'nurse_chief', allowed: true },
    { user: 'admin', allowed: true },
    { user: 'guest1', allowed: false },
    { user: 'guest2', allowed: false },
    { user: 'random_staff', allowed: false }
  ];

  let allowedOk = 0;
  let allowedFail = 0;
  let deniedBlocked = 0;
  let deniedLeaked = 0;
  const lat = [];

  const end = Date.now() + DURATION_MS;
  let seq = 0;
  const jobs = [];

  while (Date.now() < end || seq < 60) {
    if (seq > (QUICK ? 120 : 400)) break;
    const acc = accounts[seq % accounts.length];
    const db = connections[seq % connections.length];
    const n = seq;
    seq += 1;
    jobs.push((async () => {
      const t = process.hrtime.bigint();
      // 앱과 동일: 쓰기기 전 권한 검사 (DB 자체는 막지 않음)
      if (!isOperator(acc.user)) {
        deniedBlocked += 1;
        lat.push(Number(process.hrtime.bigint() - t) / 1e6);
        return;
      }
      try {
        const uidN = `notice_${acc.user}_${n}_${Date.now()}`;
        await run(
          db,
          `INSERT INTO notices (uid, title, content, author_name, author_ip, created_at, images)
           VALUES (?, ?, ?, ?, ?, datetime('now'), '')`,
          [uidN, `공지 ${n}`, `내용 ${n}`, acc.user, '192.168.122.10']
        );
        const uidS = `sched_${acc.user}_${n}_${Date.now()}`;
        await run(
          db,
          `INSERT INTO hospital_schedules (uid, type, title, time_str, author_name, author_ip, created_at, date_str)
           VALUES (?, 'meeting', ?, '09:00', ?, ?, datetime('now'), date('now'))`,
          [uidS, `일정 ${n}`, acc.user, '192.168.122.10']
        );
        allowedOk += 1;
      } catch (e) {
        allowedFail += 1;
        errorLog.push({ scenario: 'notice-sched', user: acc.user, error: String(e.message || e) });
      }
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
    })());
  }
  await Promise.all(jobs);

  // 권한 우회 시도: guest가 직접 SQL (앱 게이트 없이) — 스키마상 가능함을 기록
  const db0 = connections[0];
  try {
    await run(
      db0,
      `INSERT INTO notices (uid, title, content, author_name, author_ip, created_at)
       VALUES ('leak_test', '무단', 'x', 'guest1', '192.168.123.50', datetime('now'))`
    );
    deniedLeaked += 1; // DB alone does not enforce — app must
  } catch (_) { /* ignore */ }

  const noticeCount = await get(db0, `SELECT COUNT(*) AS c FROM notices`);
  const schedCount = await get(db0, `SELECT COUNT(*) AS c FROM hospital_schedules`);
  await Promise.all(connections.map((db) => new Promise((r) => db.close(r))));

  return {
    kind: 'notice-schedule-auth-writes',
    allowedOk,
    allowedFail,
    deniedBlocked,
    dbAllowsUnauthorizedInsert: deniedLeaked > 0,
    noticeCount: noticeCount ? noticeCount.c : 0,
    scheduleCount: schedCount ? schedCount.c : 0,
    writeMs: summarize(lat),
    wallMs: Date.now() - t0,
    note: '권한은 앱 IPC 게이트에서 강제. SQLite 단독으로는 guest INSERT 가능 → 게이트 필수.'
  };
}

/** C) ALTER + 읽기 경합 */
async function scenarioSchemaRace() {
  const t0 = Date.now();
  const dbA = await openDb(dbPath);
  const dbB = await openDb(dbPath);
  await run(dbA, `PRAGMA busy_timeout = 5000`);
  await run(dbB, `PRAGMA busy_timeout = 5000`);

  let alterErrors = 0;
  let readErrors = 0;
  const alters = [
    `ALTER TABLE notices ADD COLUMN images TEXT DEFAULT ''`,
    `ALTER TABLE notices ADD COLUMN priority INTEGER DEFAULT 0`,
    `ALTER TABLE hospital_schedules ADD COLUMN date_str TEXT DEFAULT ''`,
    `ALTER TABLE hospital_schedules ADD COLUMN location TEXT DEFAULT ''`,
    `ALTER TABLE messages ADD COLUMN edited_at TEXT DEFAULT ''`
  ];

  const jobs = [];
  for (const sql of alters) {
    jobs.push(
      run(dbA, sql).catch((e) => {
        // duplicate column 은 정상
        if (!/duplicate column/i.test(String(e.message || e))) {
          alterErrors += 1;
          errorLog.push({ scenario: 'alter', sql, error: String(e.message || e) });
        }
      })
    );
  }
  for (let i = 0; i < 40; i++) {
    jobs.push(
      all(dbB, `SELECT uid, title FROM notices ORDER BY created_at DESC LIMIT 20`).catch((e) => {
        readErrors += 1;
        errorLog.push({ scenario: 'alter-read', error: String(e.message || e) });
      })
    );
    jobs.push(
      all(dbB, `SELECT id, msg_uid FROM messages ORDER BY id DESC LIMIT 20`).catch((e) => {
        readErrors += 1;
        errorLog.push({ scenario: 'alter-read-msg', error: String(e.message || e) });
      })
    );
  }
  await Promise.all(jobs);

  // 스키마 확인
  const cols = await all(dbA, `PRAGMA table_info(notices)`);
  await new Promise((r) => dbA.close(r));
  await new Promise((r) => dbB.close(r));

  return {
    kind: 'schema-alter-race',
    alterErrors,
    readErrors,
    noticeColumns: cols.map((c) => c.name),
    wallMs: Date.now() - t0
  };
}

function verdict(results) {
  const risks = [];
  const A = results.messages;
  const B = results.auth;
  const C = results.schema;
  if (A.writeErrors > 0 && A.busyErrors === A.writeErrors) risks.push('sqlite-busy');
  if (A.writeErrors > Math.ceil(A.ops * 0.02)) risks.push('write-errors');
  if (A.readErrors > 0) risks.push('read-errors');
  if (!A.dupRejected) risks.push('unique-not-enforced');
  if (A.writeMs.p95 > 200) risks.push('write-slow');
  if (B.allowedFail > 0) risks.push('auth-write-fail');
  if (B.deniedBlocked === 0) risks.push('auth-gate-missing-in-test');
  if (C.alterErrors > 0 || C.readErrors > 0) risks.push('schema-race-errors');

  let level = 'LOW';
  if (risks.includes('unique-not-enforced') || risks.includes('schema-race-errors') || (A.writeErrors > A.ops * 0.05)) {
    level = 'HIGH';
  } else if (risks.length) {
    level = 'MEDIUM';
  }
  return { level, risks };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 시나리오 3: 데이터베이스 동시성');
  console.log(` clients=${CLIENTS} ops=${OPS} quick=${QUICK} db=${dbPath}`);
  console.log('══════════════════════════════════════════════');

  const db = await openDb(dbPath);
  await setupSchema(db);
  await new Promise((r) => db.close(r));

  const results = {};

  console.log('\n▶ A) 메시지 동시 기록/조회');
  results.messages = await scenarioMessageConcurrency();
  console.log(JSON.stringify(results.messages, null, 2));

  console.log('\n▶ B) 공지·일정 권한 쓰기');
  results.auth = await scenarioNoticeScheduleAuth();
  console.log(JSON.stringify(results.auth, null, 2));

  console.log('\n▶ C) 스키마 ALTER 경합');
  results.schema = await scenarioSchemaRace();
  console.log(JSON.stringify(results.schema, null, 2));

  const v = verdict(results);
  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(` 오류 로그: ${errorLog.length}건`);
  if (errorLog.length) {
    console.log(' 샘플:', JSON.stringify(errorLog.slice(0, 15), null, 2));
  }
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    writes: results.messages.writes,
    writeErrors: results.messages.writeErrors,
    busyErrors: results.messages.busyErrors,
    notices: results.auth.noticeCount,
    schedules: results.auth.scheduleCount
  })}`);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
