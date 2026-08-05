#!/usr/bin/env node
/**
 * 시나리오 1 — 동시 접속·트래픽 부하
 *
 *  A) 200명 동시 로그인/재접속 (정전 복구) — TCP listen + PING 폭주
 *  B) 다수 사용자 초당 수십 건 대용량 메시지 발송
 *  C) 122↔123 논리 대역 크로스 DM 동시 수행
 *
 *   node scripts/stress-concurrent-traffic.js
 *   node scripts/stress-concurrent-traffic.js --users=200 --quick
 */
'use strict';

const path = require('path');
const os = require('os');
const { VirtualPeer } = require('./lib/virtual-peer');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const USERS = Math.max(20, parseInt(arg('users', '200'), 10) || 200);
const QUICK = hasFlag('quick');
const BASE_PORT = Math.max(20000, parseInt(arg('base-port', '28000'), 10) || 28000);
const HOST = '127.0.0.1';
const MSG_RATE = Math.max(10, parseInt(arg('msg-rate', QUICK ? '40' : '80'), 10) || 80); // msgs/sec aggregate
const DURATION_MS = QUICK ? 4000 : 10000;
const BIG_MSG_KB = Math.max(1, parseInt(arg('big-kb', '48'), 10) || 48);

const errorLog = [];

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createPeers(n) {
  const peers = [];
  const half = Math.ceil(n / 2);
  for (let i = 0; i < n; i++) {
    const subnet = i < half ? '122' : '123';
    const octet = (i % 250) + 1;
    const peer = new VirtualPeer({
      id: `u${i}`,
      username: `직원${i}`,
      tcpPort: BASE_PORT + i,
      udpPort: 0,
      subnet,
      host: HOST,
      octet,
      logicalIp: `192.168.${subnet}.${octet}`
    });
    peer.on('error-log', (e) => errorLog.push(e));
    peers.push(peer);
  }
  // 배치로 listen (파일 디스크립터 폭주 완화)
  const batch = QUICK ? 40 : 50;
  for (let i = 0; i < peers.length; i += batch) {
    await Promise.all(peers.slice(i, i + batch).map((p) => p.start()));
  }
  return peers;
}

async function stopPeers(peers) {
  const batch = 40;
  for (let i = 0; i < peers.length; i += batch) {
    await Promise.all(peers.slice(i, i + batch).map((p) => p.stop().catch(() => {})));
  }
}

/** A) 정전 복구: 전원 OFF → 동시 start + 크로스 PING(CHAT 핸드셰이크) */
async function scenarioPowerRestore(peers) {
  const t0 = Date.now();
  // 이미 start된 상태 → stop 후 동시 재기동
  await stopPeers(peers);
  const startLat = [];
  const batch = QUICK ? 40 : 50;
  const tBoot = Date.now();
  for (let i = 0; i < peers.length; i += batch) {
    const slice = peers.slice(i, i + batch);
    await Promise.all(slice.map(async (p) => {
      const t = process.hrtime.bigint();
      await p.start();
      startLat.push(Number(process.hrtime.bigint() - t) / 1e6);
    }));
  }
  const bootWallMs = Date.now() - tBoot;

  // 재접속 직후 서로 핸드셰이크 (샘플: 각 피어가 반대 대역 1명에게 CHAT)
  const half = Math.ceil(peers.length / 2);
  const ackLat = [];
  let ackOk = 0;
  let ackFail = 0;
  const jobs = [];
  for (let i = 0; i < half; i++) {
    const a = peers[i];
    const b = peers[half + (i % (peers.length - half))];
    if (!b) continue;
    const uid = `restore_${i}_${Date.now()}`;
    jobs.push((async () => {
      const t = process.hrtime.bigint();
      const r = await a.sendChat(HOST, b.tcpPort, `정전복구 핸드셰이크 ${i}`, uid, { timeoutMs: 4000 });
      ackLat.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (r.ok && r.ack) ackOk += 1;
      else {
        ackFail += 1;
        errorLog.push({ at: new Date().toISOString(), scenario: 'power-restore', peer: a.id, reason: r.reason || 'no-ack' });
      }
    })());
  }
  await Promise.all(jobs);

  return {
    kind: 'power-restore-200',
    users: peers.length,
    bootWallMs,
    startListenMs: summarize(startLat),
    handshake: { attempted: jobs.length, ackOk, ackFail, rttMs: summarize(ackLat) },
    wallMs: Date.now() - t0
  };
}

/** B) 초당 수십 건 대용량 메시지 */
async function scenarioMessageFlood(peers) {
  const t0 = Date.now();
  const big = '가'.repeat(Math.floor((BIG_MSG_KB * 1024) / 3)); // UTF-8 한글 ~3B
  const lat = [];
  let ok = 0;
  let fail = 0;
  let sent = 0;
  const interval = 50; // ms
  const perTick = Math.max(1, Math.round(MSG_RATE / (1000 / interval)));
  const end = Date.now() + DURATION_MS;

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (Date.now() >= end) {
        clearInterval(tick);
        resolve();
        return;
      }
      for (let k = 0; k < perTick; k++) {
        const si = sent % peers.length;
        const ri = (si + 1 + Math.floor(peers.length / 2)) % peers.length;
        const a = peers[si];
        const b = peers[ri];
        const uid = `flood_${sent}_${Date.now()}`;
        sent += 1;
        const t = process.hrtime.bigint();
        a.sendChat(HOST, b.tcpPort, `[부하] ${big.slice(0, 200)}… #${sent}`, uid, { timeoutMs: 3000 })
          .then((r) => {
            lat.push(Number(process.hrtime.bigint() - t) / 1e6);
            if (r.ok && r.ack) ok += 1;
            else {
              fail += 1;
              if (fail <= 30) {
                errorLog.push({ at: new Date().toISOString(), scenario: 'msg-flood', peer: a.id, reason: r.reason });
              }
            }
          });
      }
    }, interval);
  });
  // in-flight drain
  await sleep(3500);

  const wallMs = Date.now() - t0;
  const rate = wallMs > 0 ? +(ok / (wallMs / 1000)).toFixed(1) : 0;
  return {
    kind: 'message-flood',
    targetRate: MSG_RATE,
    bigMsgKb: BIG_MSG_KB,
    durationMs: DURATION_MS,
    sent,
    ok,
    fail,
    achievedAckPerSec: rate,
    rttMs: summarize(lat),
    wallMs
  };
}

/** C) 122↔123 크로스 DM 동시 */
async function scenarioCrossSubnet(peers) {
  const t0 = Date.now();
  const aPeers = peers.filter((p) => p.subnet === '122');
  const bPeers = peers.filter((p) => p.subnet === '123');
  const pairs = Math.min(aPeers.length, bPeers.length, QUICK ? 60 : 100);
  const lat = [];
  let ok = 0;
  let fail = 0;

  // 양방향 동시
  const jobs = [];
  for (let i = 0; i < pairs; i++) {
    const a = aPeers[i];
    const b = bPeers[i];
    jobs.push((async () => {
      const uid1 = `x122_${i}_${Date.now()}`;
      const t1 = process.hrtime.bigint();
      const r1 = await a.sendChat(HOST, b.tcpPort, `크로스 122→123 #${i} from ${a.logicalIp}`, uid1, { timeoutMs: 4000 });
      lat.push(Number(process.hrtime.bigint() - t1) / 1e6);
      if (r1.ok && r1.ack) ok += 1;
      else {
        fail += 1;
        errorLog.push({ scenario: 'cross-122-123', from: a.logicalIp, to: b.logicalIp, reason: r1.reason });
      }
    })());
    jobs.push((async () => {
      const uid2 = `x123_${i}_${Date.now()}`;
      const t2 = process.hrtime.bigint();
      const r2 = await b.sendChat(HOST, a.tcpPort, `크로스 123→122 #${i} from ${b.logicalIp}`, uid2, { timeoutMs: 4000 });
      lat.push(Number(process.hrtime.bigint() - t2) / 1e6);
      if (r2.ok && r2.ack) ok += 1;
      else {
        fail += 1;
        errorLog.push({ scenario: 'cross-123-122', from: b.logicalIp, to: a.logicalIp, reason: r2.reason });
      }
    })());
  }
  await Promise.all(jobs);

  return {
    kind: 'cross-subnet-dm',
    subnet122: aPeers.length,
    subnet123: bPeers.length,
    pairs,
    directions: pairs * 2,
    ok,
    fail,
    rttMs: summarize(lat),
    wallMs: Date.now() - t0,
    note: '실제 라우팅은 병원 LAN에서 검증. 여기서는 프로토콜·동시성·ACK 경로를 논리 대역 라벨로 재현.'
  };
}

function verdict(results) {
  const risks = [];
  const pr = results.powerRestore;
  const fl = results.messageFlood;
  const xs = results.crossSubnet;
  if (pr.handshake.ackFail > Math.ceil(pr.handshake.attempted * 0.05)) risks.push('restore-handshake-loss');
  if (fl.fail > Math.ceil(fl.sent * 0.1)) risks.push('flood-high-fail');
  if (fl.achievedAckPerSec < MSG_RATE * 0.4) risks.push('flood-throughput-low');
  if (xs.fail > 0) risks.push('cross-subnet-fail');
  if (pr.bootWallMs > 30000) risks.push('boot-slow');

  let level = 'LOW';
  if (
    xs.fail > 0 ||
    pr.handshake.ackFail > pr.handshake.attempted * 0.15 ||
    fl.fail > fl.sent * 0.2
  ) {
    level = 'HIGH';
  } else if (risks.length) {
    level = 'MEDIUM';
  }
  return { level, risks };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 시나리오 1: 동시 접속·트래픽 부하');
  console.log(` users=${USERS} quick=${QUICK} basePort=${BASE_PORT} host=${HOST}`);
  console.log(` cpus=${os.cpus().length} freeMb=${Math.round(os.freemem() / 1024 / 1024)}`);
  console.log('══════════════════════════════════════════════');

  let peers;
  try {
    peers = await createPeers(USERS);
  } catch (e) {
    console.error('피어 기동 실패:', e.message);
    console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: e.message })}`);
    process.exit(2);
    return;
  }

  const results = {};
  console.log('\n▶ A) 정전 복구 동시 재접속');
  results.powerRestore = await scenarioPowerRestore(peers);
  console.log(JSON.stringify(results.powerRestore, null, 2));

  console.log('\n▶ B) 대용량 메시지 폭주');
  results.messageFlood = await scenarioMessageFlood(peers);
  console.log(JSON.stringify(results.messageFlood, null, 2));

  console.log('\n▶ C) 크로스 대역 DM');
  results.crossSubnet = await scenarioCrossSubnet(peers);
  console.log(JSON.stringify(results.crossSubnet, null, 2));

  await stopPeers(peers);

  const v = verdict(results);
  const out = {
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    errorLogSample: errorLog.slice(0, 40),
    results,
    rssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1)
  };

  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(` 오류 로그: ${errorLog.length}건`);
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    restoreAckOk: results.powerRestore.handshake.ackOk,
    floodOk: results.messageFlood.ok,
    crossOk: results.crossSubnet.ok
  })}`);

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
