#!/usr/bin/env node
/**
 * 시나리오 6 — 예약 메시지·자동화
 *
 *  A) 예약 메시지 수백 건 동시 등록 → due claim → 정시 발송 정확도
 *  B) 자동 백업(파일 복사) + 메시지 폭주 동시
 *  C) 자리비움(TREATMENT) 자동전환 로직이 부하 중에도 동작
 *
 *   node scripts/stress-scheduled-automation.js
 *   node scripts/stress-scheduled-automation.js --quick --scheduled=300
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { VirtualPeer } = require('./lib/virtual-peer');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const QUICK = hasFlag('quick');
const SCHEDULED_N = Math.max(50, parseInt(arg('scheduled', QUICK ? '200' : '500'), 10) || 500);
const BASE_PORT = Math.max(20000, parseInt(arg('base-port', '31000'), 10) || 31000);
const HOST = '127.0.0.1';
const CHECK_EVERY_MS = 50; // 테스트용  denser (앱은 5초)
const errorLog = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-sched-'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function summarize(arr) {
  const s = (arr || []).slice().sort((a, b) => a - b);
  const pct = (p) => {
    if (!s.length) return 0;
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return +s[idx].toFixed(2);
  };
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    avg: s.length ? +(sum / s.length).toFixed(2) : 0,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
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

function parseScheduledSendAtMs(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return Date.parse(`${m[1]}T${m[2]}${m[2].length === 5 ? ':00' : ''}Z`);
  return NaN;
}

async function setupDb() {
  const dbPath = path.join(tmpDir, 'app.db');
  const db = await openDb(dbPath);
  await run(db, `PRAGMA journal_mode=WAL`);
  await run(db, `PRAGMA busy_timeout=5000`);
  await run(
    db,
    `CREATE TABLE scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_ip TEXT, is_broadcast INTEGER DEFAULT 0,
      message TEXT, send_at TEXT, sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await run(db, `CREATE INDEX idx_sched ON scheduled_messages(sent, send_at)`);
  await run(
    db,
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_name TEXT, sender_ip TEXT, receiver_ip TEXT,
      message TEXT, status TEXT, msg_uid TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await run(
    db,
    `CREATE TABLE user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT, status_state TEXT
    )`
  );
  await run(db, `INSERT INTO user_profile (id, username, status_state) VALUES (1, '테스터', 'ONLINE')`);
  return { db, dbPath };
}

/** main.js claimScheduledMessage + TCP 발송 미러 */
async function claimScheduled(db, id) {
  const r = await run(db, `UPDATE scheduled_messages SET sent = 1 WHERE id = ? AND sent = 0`, [id]);
  return r.changes > 0;
}

async function dispatchDue(db, sender, receiversByIp, nowMs, fireLatencies) {
  const rows = await all(db, `SELECT * FROM scheduled_messages WHERE sent = 0 ORDER BY send_at ASC`);
  const due = rows.filter((row) => {
    const at = parseScheduledSendAtMs(row.send_at);
    return Number.isFinite(at) && at <= nowMs;
  });
  let dispatched = 0;
  for (const row of due) {
    const claimed = await claimScheduled(db, row.id);
    if (!claimed) continue;
    const sendAt = parseScheduledSendAtMs(row.send_at);
    const delay = Date.now() - sendAt;
    fireLatencies.push(delay);

    const target = String(row.target_ip || '');
    const peer = receiversByIp.get(target);
    const uid = `sched_${row.id}_${Date.now()}`;
    if (peer) {
      const r = await sender.sendChat(HOST, peer.tcpPort, row.message, uid, { timeoutMs: 2000 });
      const status = r.ok ? 'SENT' : 'PENDING';
      await run(
        db,
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?,?,?,?,?,?)`,
        [sender.username, '192.168.122.10', target, row.message, status, uid]
      );
      if (!r.ok) errorLog.push({ scenario: 'sched-send', id: row.id, reason: r.reason });
    } else {
      await run(
        db,
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid) VALUES (?,?,?,?,?,?)`,
        [sender.username, '192.168.122.10', target, row.message, 'PENDING', uid]
      );
    }
    dispatched += 1;
  }
  return dispatched;
}

async function scenarioScheduledStorm(db, sender, receivers) {
  const t0 = Date.now();
  const fireLatencies = [];
  const receiversByIp = new Map();
  receivers.forEach((p) => receiversByIp.set(p.logicalIp, p));

  // 등록: 절반은 이미 due, 절반은 +200~800ms 후
  const insertStart = Date.now();
  for (let i = 0; i < SCHEDULED_N; i++) {
    const target = receivers[i % receivers.length].logicalIp;
    let sendAt;
    if (i < SCHEDULED_N / 2) {
      sendAt = new Date(Date.now() - 1000 - (i % 50)).toISOString();
    } else {
      sendAt = new Date(Date.now() + 200 + (i % 20) * 30).toISOString();
    }
    await run(
      db,
      `INSERT INTO scheduled_messages (target_ip, is_broadcast, message, send_at, sent) VALUES (?,?,?,?,0)`,
      [target, 0, `예약 #${i}`, sendAt]
    );
  }
  const insertMs = Date.now() - insertStart;

  let totalDisp = 0;
  const deadline = Date.now() + (QUICK ? 4000 : 8000);
  while (Date.now() < deadline) {
    totalDisp += await dispatchDue(db, sender, receiversByIp, Date.now(), fireLatencies);
    const left = await get(db, `SELECT COUNT(*) AS c FROM scheduled_messages WHERE sent=0`);
    if (left.c === 0) break;
    await sleep(CHECK_EVERY_MS);
  }

  const remaining = await get(db, `SELECT COUNT(*) AS c FROM scheduled_messages WHERE sent=0`);
  const sent = await get(db, `SELECT COUNT(*) AS c FROM scheduled_messages WHERE sent=1`);
  const pendingMsgs = await get(db, `SELECT COUNT(*) AS c FROM messages WHERE status='PENDING'`);
  const deliveredLike = await get(db, `SELECT COUNT(*) AS c FROM messages WHERE status='SENT'`);

  // 정시 정확도: due 이후 발화 지연
  const late = fireLatencies.filter((d) => d > 2000).length;
  const veryLate = fireLatencies.filter((d) => d > 5000).length;

  return {
    kind: 'scheduled-message-storm',
    registered: SCHEDULED_N,
    insertMs,
    dispatchedLoops: totalDisp,
    sentRows: sent.c,
    remainingUnsent: remaining.c,
    outboundSent: deliveredLike.c,
    outboundPending: pendingMsgs.c,
    fireDelayMs: summarize(fireLatencies),
    lateOver2s: late,
    lateOver5s: veryLate,
    wallMs: Date.now() - t0,
    note: `체크 주기 테스트=${CHECK_EVERY_MS}ms (앱=5s). p95 지연이 체크주기+α 이면 정상.`
  };
}

async function scenarioAutoBackupUnderLoad(db, dbPath) {
  const t0 = Date.now();
  const backupDir = path.join(tmpDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  let writes = 0;
  let writeErrors = 0;
  let backups = 0;
  let backupErrors = 0;
  const backupMs = [];

  const loadUntil = Date.now() + (QUICK ? 2500 : 5000);
  const writers = [];

  // 동시 메시지 쓰기
  for (let w = 0; w < 4; w++) {
    writers.push((async () => {
      while (Date.now() < loadUntil) {
        try {
          await run(
            db,
            `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
             VALUES ('부하','192.168.123.1','192.168.122.10',?, 'SENT', ?)`,
            [`backup-load ${writes}`, `bl_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`]
          );
          writes += 1;
        } catch (e) {
          writeErrors += 1;
          errorLog.push({ scenario: 'backup-load-write', error: String(e.message || e) });
        }
        await sleep(5);
      }
    })());
  }

  // 백업 루프 (copyFile)
  const backupLoop = (async () => {
    while (Date.now() < loadUntil) {
      const t = process.hrtime.bigint();
      try {
        const dest = path.join(backupDir, `auto_backup_${Date.now()}.db`);
        // WAL 체크포인트 흉내
        await run(db, `PRAGMA wal_checkpoint(PASSIVE)`);
        await fs.promises.copyFile(dbPath, dest);
        backups += 1;
        backupMs.push(Number(process.hrtime.bigint() - t) / 1e6);
        // retention: keep last 5
        const files = (await fs.promises.readdir(backupDir))
          .filter((n) => n.startsWith('auto_backup_'))
          .sort();
        while (files.length > 5) {
          const old = files.shift();
          try { await fs.promises.unlink(path.join(backupDir, old)); } catch (_) {}
        }
      } catch (e) {
        backupErrors += 1;
        errorLog.push({ scenario: 'auto-backup', error: String(e.message || e) });
      }
      await sleep(QUICK ? 200 : 300);
    }
  })();

  await Promise.all([...writers, backupLoop]);
  const kept = (await fs.promises.readdir(backupDir)).filter((n) => n.startsWith('auto_backup_'));

  return {
    kind: 'auto-backup-under-load',
    writes,
    writeErrors,
    backups,
    backupErrors,
    keptFiles: kept.length,
    backupCopyMs: summarize(backupMs),
    wallMs: Date.now() - t0
  };
}

async function scenarioAwayUnderLoad(db) {
  const t0 = Date.now();
  const IDLE_MS = QUICK ? 200 : 400;
  let autoAwayTriggered = false;
  let status = 'ONLINE';
  let awayFlips = 0;
  let onlineFlips = 0;
  let flipErrors = 0;

  const saveStatus = async (next) => {
    try {
      await run(db, `UPDATE user_profile SET status_state=? WHERE id=1`, [next]);
      status = next;
      return true;
    } catch (e) {
      flipErrors += 1;
      errorLog.push({ scenario: 'away', error: String(e.message || e) });
      return false;
    }
  };

  let idleTimer = null;
  const resetIdleTimer = () => {
    if (autoAwayTriggered) {
      autoAwayTriggered = false;
      void saveStatus('ONLINE').then((ok) => { if (ok) onlineFlips += 1; });
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      if (status === 'ONLINE') {
        autoAwayTriggered = true;
        const ok = await saveStatus('TREATMENT');
        if (ok) awayFlips += 1;
      }
    }, IDLE_MS);
  };

  // 부하: 프로필 읽기 + 메시지 insert 병행
  const end = Date.now() + (QUICK ? 2000 : 4000);
  let activityTicks = 0;
  const load = (async () => {
    while (Date.now() < end) {
      await get(db, `SELECT status_state FROM user_profile WHERE id=1`);
      await run(
        db,
        `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
         VALUES ('x','192.168.122.2','192.168.122.10','away-load','SENT',?)`,
        [`aw_${Date.now()}_${activityTicks}`]
      ).catch((e) => {
        flipErrors += 1;
        errorLog.push({ scenario: 'away-load', error: String(e.message || e) });
      });
      activityTicks += 1;
      await sleep(10);
    }
  })();

  // 초반 활동 → 자리비움 방지, 이후 방치 → TREATMENT, 다시 활동 → ONLINE
  resetIdleTimer();
  for (let i = 0; i < 5; i++) {
    resetIdleTimer();
    await sleep(IDLE_MS / 3);
  }
  // 방치
  await sleep(IDLE_MS + 150);
  const afterIdle = await get(db, `SELECT status_state AS s FROM user_profile WHERE id=1`);
  // 복귀
  resetIdleTimer();
  await sleep(80);
  const afterActivity = await get(db, `SELECT status_state AS s FROM user_profile WHERE id=1`);

  await load;
  clearTimeout(idleTimer);

  return {
    kind: 'away-auto-under-load',
    idleMs: IDLE_MS,
    awayFlips,
    onlineFlips,
    flipErrors,
    statusAfterIdle: afterIdle.s,
    statusAfterActivity: afterActivity.s,
    activityTicks,
    wallMs: Date.now() - t0
  };
}

function verdict(results) {
  const risks = [];
  const S = results.scheduled;
  const B = results.backup;
  const A = results.away;
  if (S.remainingUnsent > 0) risks.push('scheduled-unsent');
  if (S.lateOver5s > Math.ceil(S.registered * 0.05)) risks.push('scheduled-very-late');
  if (S.fireDelayMs.p95 > (QUICK ? 1500 : 3000)) risks.push('scheduled-p95-high');
  if (B.backupErrors > 0 || B.backups === 0) risks.push('backup-fail');
  if (B.writeErrors > 0) risks.push('backup-load-write-errors');
  if (A.statusAfterIdle !== 'TREATMENT') risks.push('away-not-triggered');
  if (A.statusAfterActivity !== 'ONLINE') risks.push('away-not-cleared');
  if (A.flipErrors > 0) risks.push('away-db-errors');

  let level = 'LOW';
  if (
    risks.includes('scheduled-unsent') ||
    risks.includes('backup-fail') ||
    risks.includes('away-not-triggered') ||
    risks.includes('away-not-cleared')
  ) {
    level = 'HIGH';
  } else if (risks.length) {
    level = 'MEDIUM';
  }
  return { level, risks };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 시나리오 6: 예약 메시지·자동화');
  console.log(` scheduled=${SCHEDULED_N} quick=${QUICK}`);
  console.log('══════════════════════════════════════════════');

  const { db, dbPath } = await setupDb();
  const sender = new VirtualPeer({
    id: 'sched-sender',
    username: '예약송신',
    tcpPort: BASE_PORT,
    subnet: '122',
    host: HOST,
    octet: 10
  });
  const receivers = [];
  for (let i = 0; i < Math.min(12, QUICK ? 6 : 12); i++) {
    const p = new VirtualPeer({
      id: `r${i}`,
      username: `수신${i}`,
      tcpPort: BASE_PORT + 1 + i,
      subnet: i % 2 === 0 ? '123' : '122',
      host: HOST,
      octet: 20 + i
    });
    p.on('error-log', (e) => errorLog.push(e));
    receivers.push(p);
  }
  await sender.start();
  await Promise.all(receivers.map((p) => p.start()));

  const results = {};
  console.log('\n▶ A) 예약 메시지 수백 건');
  results.scheduled = await scenarioScheduledStorm(db, sender, receivers);
  console.log(JSON.stringify(results.scheduled, null, 2));

  console.log('\n▶ B) 자동 백업 + 부하');
  results.backup = await scenarioAutoBackupUnderLoad(db, dbPath);
  console.log(JSON.stringify(results.backup, null, 2));

  console.log('\n▶ C) 자리비움 자동전환 + 부하');
  results.away = await scenarioAwayUnderLoad(db);
  console.log(JSON.stringify(results.away, null, 2));

  await sender.stop();
  await Promise.all(receivers.map((p) => p.stop()));
  await new Promise((r) => db.close(r));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const v = verdict(results);
  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(` 오류 로그: ${errorLog.length}건`);
  if (errorLog.length) console.log(JSON.stringify(errorLog.slice(0, 12), null, 2));
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    scheduledSent: results.scheduled.sentRows,
    backups: results.backup.backups,
    awayOk: results.away.statusAfterIdle === 'TREATMENT' && results.away.statusAfterActivity === 'ONLINE'
  })}`);

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
