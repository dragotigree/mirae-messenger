#!/usr/bin/env node
/**
 * 시나리오 4 — 연결 안정성·장애 복구
 *
 *  A) 네트워크 단절 중 발송 → PENDING → 재연결 후 재전송 (유실 여부)
 *  B) 피어 강제 종료 후 재기동 → 상대 자동 재핸드셰이크
 *  C) Wi-Fi/LAN 순간 끊김(flap) 반복
 *  D) ACK 재시도 상한 후 PENDING 복귀(영구 포기 방지) — main.js 수정과 동일 규칙
 *
 *   node scripts/stress-reconnect-resilience.js
 *   node scripts/stress-reconnect-resilience.js --quick
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
const BASE_PORT = Math.max(20000, parseInt(arg('base-port', '30000'), 10) || 30000);
const HOST = '127.0.0.1';
const FLAP_ROUNDS = Math.max(3, parseInt(arg('flaps', QUICK ? '8' : '24'), 10) || 24);
const SENT_ACK_MAX_RETRIES = 4;

const errorLog = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-reconnect-'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function summarize(msArr) {
  const s = (msArr || []).slice().sort((a, b) => a - b);
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

/** 송신측 아웃바운드 큐 (main.js PENDING/SENT + ACK 재시도 미러) */
class OutboundQueue {
  constructor(db, myIp, peer) {
    this.db = db;
    this.myIp = myIp;
    this.peer = peer; // VirtualPeer sender
    this.retryCount = new Map();
    this.delivered = new Set();
  }

  async enqueue(receiverPort, message, uid) {
    await run(
      this.db,
      `INSERT INTO messages (sender_name, sender_ip, receiver_ip, message, status, msg_uid)
       VALUES (?, ?, ?, ?, 'PENDING', ?)`,
      [this.peer.username, this.myIp, `127.0.0.1:${receiverPort}`, message, uid]
    );
  }

  async tryDeliver(receiverHost, receiverPort, row) {
    const key = row.msg_uid;
    const tries = this.retryCount.get(key) || 0;
    if (tries >= SENT_ACK_MAX_RETRIES) {
      // 수정된 규칙: PENDING 복귀 + 카운터 리셋
      this.retryCount.delete(key);
      await run(this.db, `UPDATE messages SET status='PENDING' WHERE msg_uid=? AND status IN ('SENT','PENDING')`, [key]);
      return { ok: false, abandonedToPending: true };
    }
    this.retryCount.set(key, tries + 1);
    const r = await this.peer.sendChat(receiverHost, receiverPort, row.message, key, { timeoutMs: 1500 });
    if (r.ok && r.ack) {
      this.retryCount.delete(key);
      this.delivered.add(key);
      await run(this.db, `UPDATE messages SET status='DELIVERED' WHERE msg_uid=?`, [key]);
      return { ok: true };
    }
    if (r.ok && !r.ack) {
      await run(this.db, `UPDATE messages SET status='SENT' WHERE msg_uid=? AND status='PENDING'`, [key]);
      return { ok: false, reason: 'no-ack' };
    }
    await run(this.db, `UPDATE messages SET status='PENDING' WHERE msg_uid=?`, [key]);
    return { ok: false, reason: r.reason || 'fail' };
  }

  async flush(receiverHost, receiverPort) {
    const rows = await all(
      this.db,
      `SELECT * FROM messages WHERE status IN ('PENDING','SENT') AND sender_ip=? ORDER BY id ASC`,
      [this.myIp]
    );
    const results = [];
    for (const row of rows) {
      results.push(await this.tryDeliver(receiverHost, receiverPort, row));
    }
    return results;
  }
}

async function setupDb() {
  const dbPath = path.join(tmpDir, 'out.db');
  const db = await openDb(dbPath);
  await run(db, `PRAGMA journal_mode=WAL`);
  await run(db, `PRAGMA busy_timeout=5000`);
  await run(
    db,
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_name TEXT, sender_ip TEXT, receiver_ip TEXT,
      message TEXT, status TEXT, msg_uid TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  return db;
}

async function scenarioDisconnectRecover(sender, receiver, queue) {
  const t0 = Date.now();
  const n = QUICK ? 20 : 40;
  const uids = [];

  // 단절 중 발송
  receiver.pauseAccept();
  for (let i = 0; i < n; i++) {
    const uid = `disc_${i}_${Date.now()}`;
    uids.push(uid);
    await queue.enqueue(receiver.tcpPort, `단절중 메시지 #${i}`, uid);
    const r = await sender.sendChat(HOST, receiver.tcpPort, `단절중 메시지 #${i}`, uid, { timeoutMs: 800 });
    if (r.ok && r.ack) {
      errorLog.push({ scenario: 'disconnect', issue: 'unexpected-ack-while-paused', uid });
    }
  }

  // 재연결
  receiver.resumeAccept();
  let rounds = 0;
  let delivered = 0;
  while (rounds < 12) {
    rounds += 1;
    await queue.flush(HOST, receiver.tcpPort);
    delivered = uids.filter((u) => receiver.received.has(u) || queue.delivered.has(u)).length;
    if (delivered >= n) break;
    await sleep(50);
  }

  const lost = uids.filter((u) => !receiver.received.has(u) && !queue.delivered.has(u));
  if (lost.length) {
    lost.slice(0, 20).forEach((uid) => errorLog.push({ scenario: 'disconnect-loss', uid }));
  }

  return {
    kind: 'disconnect-recover',
    sentWhileDown: n,
    flushRounds: rounds,
    delivered,
    lost: lost.length,
    wallMs: Date.now() - t0
  };
}

async function scenarioForceKillRestart(sender, receiver) {
  const t0 = Date.now();
  const port = receiver.tcpPort;
  const subnet = receiver.subnet;
  const id = receiver.id;

  // 정상 1건
  const uid1 = `kill_pre_${Date.now()}`;
  const pre = await sender.sendChat(HOST, port, '종료 전', uid1, { timeoutMs: 2000 });

  await receiver.stop();
  // 종료 중 전송 → 실패
  const uidFail = `kill_during_${Date.now()}`;
  const mid = await sender.sendChat(HOST, port, '종료 중', uidFail, { timeoutMs: 800 });

  // 재기동 (같은 포트)
  const revived = new VirtualPeer({
    id,
    username: receiver.username,
    tcpPort: port,
    subnet,
    host: HOST,
    octet: 50
  });
  revived.on('error-log', (e) => errorLog.push(e));
  await revived.start();

  const uid2 = `kill_post_${Date.now()}`;
  const post = await sender.sendChat(HOST, port, '재기동 후', uid2, { timeoutMs: 3000 });

  // 실패분 재전송
  const retry = await sender.sendChat(HOST, port, '종료 중 재전송', uidFail, { timeoutMs: 2000 });

  await revived.stop();
  // 원래 receiver 참조 갱신용으로 다시 start는 호출측에서

  return {
    kind: 'force-kill-restart',
    preOk: !!(pre.ok && pre.ack),
    midFailedAsExpected: !mid.ok || !mid.ack,
    postOk: !!(post.ok && post.ack),
    retryAfterRestartOk: !!(retry.ok && retry.ack),
    wallMs: Date.now() - t0,
    revivedPeer: revived
  };
}

async function scenarioFlap(sender, receiver) {
  const t0 = Date.now();
  let ok = 0;
  let fail = 0;
  let recovered = 0;
  const lat = [];

  for (let i = 0; i < FLAP_ROUNDS; i++) {
    // 순간 끊김
    receiver.pauseAccept();
    await sleep(QUICK ? 30 : 80);
    const uidDown = `flap_down_${i}_${Date.now()}`;
    const down = await sender.sendChat(HOST, receiver.tcpPort, `flap down ${i}`, uidDown, { timeoutMs: 500 });
    if (down.ok && down.ack) fail += 1; // unexpected
    else fail += 0;

    receiver.resumeAccept();
    await sleep(QUICK ? 20 : 40);
    const uidUp = `flap_up_${i}_${Date.now()}`;
    const t = process.hrtime.bigint();
    const up = await sender.sendChat(HOST, receiver.tcpPort, `flap up ${i}`, uidUp, { timeoutMs: 2000 });
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (up.ok && up.ack) {
      ok += 1;
      recovered += 1;
    } else {
      fail += 1;
      errorLog.push({ scenario: 'flap', i, reason: up.reason });
    }

    // dropNext 시뮬레이션 (패킷 유실)
    if (i % 3 === 0) {
      receiver.dropNext(1);
      const uidDrop = `flap_drop_${i}_${Date.now()}`;
      await sender.sendChat(HOST, receiver.tcpPort, `drop ${i}`, uidDrop, { timeoutMs: 600 });
      // 재전송
      const retry = await sender.sendChat(HOST, receiver.tcpPort, `drop retry ${i}`, uidDrop + '_r', { timeoutMs: 2000 });
      if (retry.ok && retry.ack) recovered += 1;
    }
  }

  return {
    kind: 'wifi-lan-flap',
    rounds: FLAP_ROUNDS,
    okAfterResume: ok,
    fail,
    recovered,
    rttMs: summarize(lat),
    wallMs: Date.now() - t0
  };
}

/** D) ACK 상한 후 PENDING 복귀 — 옛 버그(영구 포기) vs 수정 규칙 */
async function scenarioAckRetryCeiling(sender, receiver, queue) {
  const t0 = Date.now();
  const uid = `ack_ceil_${Date.now()}`;
  await queue.enqueue(receiver.tcpPort, 'ACK 상한 테스트', uid);

  // 수신 거부: pause로 ACK 불가
  receiver.pauseAccept();
  const attempts = [];
  for (let i = 0; i < SENT_ACK_MAX_RETRIES + 2; i++) {
    const rows = await all(queue.db, `SELECT * FROM messages WHERE msg_uid=?`, [uid]);
    const row = rows[0];
    const r = await queue.tryDeliver(HOST, receiver.tcpPort, row);
    attempts.push({ i, ...r, statusAfter: (await all(queue.db, `SELECT status FROM messages WHERE msg_uid=?`, [uid]))[0].status });
  }

  const afterCeiling = attempts[SENT_ACK_MAX_RETRIES];
  const abandonedToPending = !!(afterCeiling && afterCeiling.abandonedToPending);
  const statusPending = attempts[attempts.length - 1].statusAfter === 'PENDING';

  // 재연결 후 성공해야 함
  receiver.resumeAccept();
  let delivered = false;
  for (let i = 0; i < 6; i++) {
    await queue.flush(HOST, receiver.tcpPort);
    if (receiver.received.has(uid) || queue.delivered.has(uid)) {
      delivered = true;
      break;
    }
    await sleep(40);
  }

  if (!abandonedToPending || !delivered) {
    errorLog.push({
      scenario: 'ack-ceiling',
      abandonedToPending,
      delivered,
      attempts: attempts.map((a) => ({ i: a.i, ok: a.ok, abandoned: a.abandonedToPending, status: a.statusAfter }))
    });
  }

  return {
    kind: 'ack-retry-ceiling',
    maxRetries: SENT_ACK_MAX_RETRIES,
    abandonedToPending,
    statusPendingAfterCeiling: statusPending,
    deliveredAfterResume: delivered,
    attempts: attempts.length,
    wallMs: Date.now() - t0,
    note: '상한 도달 시 PENDING 복귀하지 않으면 장시간 단절 후 메시지 영구 유실'
  };
}

function verdict(results) {
  const risks = [];
  if (results.disconnect.lost > 0) risks.push('message-loss-after-reconnect');
  if (!results.kill.preOk || !results.kill.postOk || !results.kill.retryAfterRestartOk) risks.push('kill-restart-fail');
  if (!results.kill.midFailedAsExpected) risks.push('kill-unexpected-success');
  if (results.flap.okAfterResume < results.flap.rounds * 0.85) risks.push('flap-recover-weak');
  if (!results.ackCeiling.abandonedToPending) risks.push('ack-permanent-abandon');
  if (!results.ackCeiling.deliveredAfterResume) risks.push('ack-ceiling-no-recover');

  let level = 'LOW';
  if (
    risks.includes('message-loss-after-reconnect') ||
    risks.includes('ack-permanent-abandon') ||
    risks.includes('ack-ceiling-no-recover') ||
    risks.includes('kill-restart-fail')
  ) {
    level = 'HIGH';
  } else if (risks.length) {
    level = 'MEDIUM';
  }
  return { level, risks };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 시나리오 4: 연결 안정성·장애 복구');
  console.log(` quick=${QUICK} flaps=${FLAP_ROUNDS}`);
  console.log('══════════════════════════════════════════════');

  const sender = new VirtualPeer({
    id: 'sender',
    username: '송신PC',
    tcpPort: BASE_PORT,
    subnet: '122',
    host: HOST,
    octet: 10
  });
  let receiver = new VirtualPeer({
    id: 'receiver',
    username: '수신PC',
    tcpPort: BASE_PORT + 1,
    subnet: '123',
    host: HOST,
    octet: 20
  });
  sender.on('error-log', (e) => errorLog.push(e));
  receiver.on('error-log', (e) => errorLog.push(e));
  await sender.start();
  await receiver.start();

  const db = await setupDb();
  const queue = new OutboundQueue(db, '192.168.122.10', sender);

  const results = {};

  console.log('\n▶ A) 단절 → 재연결 재전송');
  results.disconnect = await scenarioDisconnectRecover(sender, receiver, queue);
  console.log(JSON.stringify(results.disconnect, null, 2));

  console.log('\n▶ B) 강제 종료 → 재기동');
  const kill = await scenarioForceKillRestart(sender, receiver);
  results.kill = {
    kind: kill.kind,
    preOk: kill.preOk,
    midFailedAsExpected: kill.midFailedAsExpected,
    postOk: kill.postOk,
    retryAfterRestartOk: kill.retryAfterRestartOk,
    wallMs: kill.wallMs
  };
  console.log(JSON.stringify(results.kill, null, 2));
  // revive가 포트를 점유 중일 수 있음 — revived already stopped; restart original
  try { await receiver.stop(); } catch (_) {}
  receiver = new VirtualPeer({
    id: 'receiver',
    username: '수신PC',
    tcpPort: BASE_PORT + 1,
    subnet: '123',
    host: HOST,
    octet: 20
  });
  receiver.on('error-log', (e) => errorLog.push(e));
  await receiver.start();

  console.log('\n▶ C) Wi-Fi/LAN flap');
  results.flap = await scenarioFlap(sender, receiver);
  console.log(JSON.stringify(results.flap, null, 2));

  console.log('\n▶ D) ACK 재시도 상한 → PENDING 복귀');
  results.ackCeiling = await scenarioAckRetryCeiling(sender, receiver, queue);
  console.log(JSON.stringify(results.ackCeiling, null, 2));

  await sender.stop();
  await receiver.stop();
  await new Promise((r) => db.close(r));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const v = verdict(results);
  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(` 오류 로그: ${errorLog.length}건`);
  if (errorLog.length) console.log(JSON.stringify(errorLog.slice(0, 15), null, 2));
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    lost: results.disconnect.lost,
    flapOk: results.flap.okAfterResume,
    ackRecover: results.ackCeiling.deliveredAfterResume
  })}`);

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
