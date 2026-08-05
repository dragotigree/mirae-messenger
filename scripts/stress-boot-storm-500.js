#!/usr/bin/env node
/**
 * Mirae Messenger — 500대 동시 전원 ON / 메신저 기동 시뮬레이션
 *
 * 한 대의 “관찰 PC” 입장에서:
 *  1) 콜드 부트 폭주: 500명이 짧은 시간에 첫 PING (wasOffline) → DB persist + 목록 재구성 + TCP 동기화 큐
 *  2) 정상 운전: 500명이 4초마다 PING (변경 없음) → skip-unchanged 효과
 *  3) UDP 송신 추정: broadcastPresence 가 서브넷 유니캐스트(508)로 뿌리는 비용
 *
 * 사용:
 *   node scripts/stress-boot-storm-500.js
 *   node scripts/stress-boot-storm-500.js --users=500 --window-ms=5000 --tcp-concurrency=8
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

const USER_COUNT = Math.max(1, parseInt(arg('users', '500'), 10) || 500);
const BOOT_WINDOW_MS = (() => {
  const raw = arg('window-ms', '3000');
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3000;
})();
const PING_INTERVAL_MS = Math.max(500, parseInt(arg('interval', '4000'), 10) || 4000);
const STEADY_SEC = Math.max(4, parseInt(arg('steady-sec', '12'), 10) || 12);
const TCP_CONCURRENCY = Math.max(1, parseInt(arg('tcp-concurrency', '8'), 10) || 8);
const SUBNET_HOSTS = Math.max(1, parseInt(arg('subnet-hosts', '508'), 10) || 508); // 2×254
const MODE = String(arg('mode', 'skip-unchanged') || 'skip-unchanged'); // always | skip-unchanged

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-boot-storm-'));
const dbPath = path.join(tmpDir, 'storm.db');

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

function makeUsers(n) {
  const users = [];
  for (let i = 1; i <= n; i++) {
    const octet = ((i - 1) % 254) + 1;
    const third = Math.floor((i - 1) / 254) + 122;
    users.push({
      ip: `192.168.${third}.${octet}`,
      username: `직원${i}`,
      rank: i % 7 === 0 ? '실장' : (i % 11 === 0 ? '' : '물리치료사'),
      dept: `재활의학과${(i % 6) + 1}`,
      floor: `${(i % 8) + 1}층`,
      extNo: String(1000 + i),
      phone: '',
      statusState: 'ONLINE',
      photo: '',
      lastSeen: Date.now() - 86400000 * ((i % 30) + 1),
      online: false
    });
  }
  return users;
}

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
    samples.push(Math.max(0, gapMs - 50));
    last = now;
  }, 50);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

/** 사이드바 목록 재구성 비용(동일인 합침 단순화) */
function buildDirectoryUserListCost(onlineMap, knownMap) {
  const t0 = process.hrtime.bigint();
  const byName = new Map();
  knownMap.forEach((u) => {
    const key = String(u.username || u.ip);
    const prev = byName.get(key);
    const online = onlineMap.has(u.ip);
    if (!prev || (online && !prev.online) || (!!online === !!prev.online && (u.lastSeen || 0) > (prev.lastSeen || 0))) {
      byName.set(key, { ...u, online });
    }
  });
  const list = Array.from(byName.values());
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, count: list.length, online: list.filter((u) => u.online).length };
}

/** 첫 등장 시 TCP 동기화(공지/그룹/사진) — 소켓 대신 지연+큐로 부하만 모사 */
function createTcpWorkQueue(concurrency, stats) {
  const q = [];
  let active = 0;
  let resolveIdle = null;

  function pump() {
    while (active < concurrency && q.length) {
      const job = q.shift();
      active += 1;
      if (active > stats.peakActive) stats.peakActive = active;
      const t0 = process.hrtime.bigint();
      // 실제 TCP connect+write+end ~ 수~수십 ms. 여기선 평균 8ms 작업으로 모사
      const workMs = 5 + Math.floor(Math.random() * 10);
      setTimeout(() => {
        stats.done += 1;
        stats.latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
        active -= 1;
        pump();
        if (active === 0 && q.length === 0 && resolveIdle) {
          const r = resolveIdle;
          resolveIdle = null;
          r();
        }
      }, workMs);
    }
  }

  return {
    enqueue(ip, kinds) {
      // wasOffline 시 requestNoticeSync + photo + wipe check ≈ 2~3 TCP
      const n = kinds || 2;
      for (let i = 0; i < n; i++) {
        q.push({ ip, i });
        stats.queued += 1;
      }
      pump();
    },
    idle() {
      if (active === 0 && q.length === 0) return Promise.resolve();
      return new Promise((r) => { resolveIdle = r; });
    },
    get pending() { return q.length + active; }
  };
}

async function seedOffline(db, users) {
  for (const u of users) {
    await run(
      db,
      `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OFFLINE', ?, ?)`,
      [u.ip, u.username, u.rank, u.dept, u.floor, u.extNo, u.phone, u.photo, u.lastSeen]
    );
  }
}

async function runBootStorm(db, users, opts) {
  const persistStats = { writes: 0, skipped: 0, errors: 0, latencies: [] };
  const tcpStats = { queued: 0, done: 0, peakActive: 0, latencies: [] };
  const listMs = [];
  const loopLag = [];
  const probe = startEventLoopProbe(loopLag);
  const onlineMap = new Map();
  const knownMap = new Map(users.map((u) => [u.ip, { ...u, online: false, statusState: 'OFFLINE' }]));
  const tcp = createTcpWorkQueue(opts.tcpConcurrency, tcpStats);

  const t0 = Date.now();
  let notifyCount = 0;
  let lastNotifyAt = 0;
  const NOTIFY_DEBOUNCE_MS = 350;

  // BOOT_WINDOW_MS 안에 균등 분산 도착 (0이면 전부 즉시)
  const arrivals = users.map((u, i) => {
    const delay = opts.windowMs <= 0
      ? 0
      : Math.floor((i / Math.max(1, users.length - 1)) * opts.windowMs);
    return { u, delay };
  });

  await new Promise((resolve) => {
    let remaining = arrivals.length;
    arrivals.forEach(({ u, delay }) => {
      setTimeout(async () => {
        const wasOffline = !onlineMap.has(u.ip);
        const profile = { ...u, online: true, statusState: 'ONLINE' };
        onlineMap.set(u.ip, profile);
        knownMap.set(u.ip, profile);
        await persistKnownUserSnapshot(db, profile, persistStats, opts);
        if (wasOffline) {
          tcp.enqueue(u.ip, 2);
          const now = Date.now();
          if (now - lastNotifyAt >= NOTIFY_DEBOUNCE_MS || notifyCount === 0) {
            lastNotifyAt = now;
            notifyCount += 1;
            listMs.push(buildDirectoryUserListCost(onlineMap, knownMap).ms);
          }
        }
        remaining -= 1;
        if (remaining === 0) resolve();
      }, delay);
    });
  });

  // 디바운스 마지막 flush
  listMs.push(buildDirectoryUserListCost(onlineMap, knownMap).ms);
  await tcp.idle();
  await new Promise((r) => setTimeout(r, 100));
  clearInterval(probe);

  return {
    kind: 'boot-storm',
    users: users.length,
    windowMs: opts.windowMs,
    mode: opts.mode,
    wallMs: Date.now() - t0,
    online: onlineMap.size,
    persist: {
      writes: persistStats.writes,
      skipped: persistStats.skipped,
      errors: persistStats.errors,
      queryMs: summarize(persistStats.latencies)
    },
    userListRebuildMs: summarize(listMs),
    notifyDebouncedCount: notifyCount,
    tcpSync: {
      concurrency: opts.tcpConcurrency,
      queued: tcpStats.queued,
      done: tcpStats.done,
      peakActive: tcpStats.peakActive,
      jobMs: summarize(tcpStats.latencies)
    },
    eventLoopLagMs: summarize(loopLag)
  };
}

async function runSteady(db, users, opts) {
  const persistStats = { writes: 0, skipped: 0, errors: 0, latencies: [], inFlight: 0, peakInFlight: 0 };
  const loopLag = [];
  const probe = startEventLoopProbe(loopLag);
  const started = Date.now();
  let cursor = 0;
  const pps = users.length / (PING_INTERVAL_MS / 1000);
  const tickMs = 50;
  const perTick = Math.max(1, Math.round((pps * tickMs) / 1000));

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (Date.now() - started >= opts.steadyMs) {
        clearInterval(timer);
        const wait = setInterval(() => {
          if (persistStats.inFlight === 0) {
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
        const profile = { ...u, online: true, statusState: 'ONLINE' };
        persistStats.inFlight += 1;
        if (persistStats.inFlight > persistStats.peakInFlight) persistStats.peakInFlight = persistStats.inFlight;
        persistKnownUserSnapshot(db, profile, persistStats, opts).finally(() => {
          persistStats.inFlight -= 1;
        });
      }
    }, tickMs);
  });

  return {
    kind: 'steady',
    users: users.length,
    mode: opts.mode,
    durationSec: opts.steadyMs / 1000,
    targetPps: +pps.toFixed(2),
    peakInFlight: persistStats.peakInFlight,
    persist: {
      writes: persistStats.writes,
      skipped: persistStats.skipped,
      errors: persistStats.errors,
      queryMs: summarize(persistStats.latencies)
    },
    eventLoopLagMs: summarize(loopLag)
  };
}

function estimateUdpOutbound() {
  // 개선 후: 평소 = 1 broadcast + 다른대역 known만 / 가끔(1/8) 전체 508 유니캐스트
  const packetBytes = 180;
  const fullEvery = 8;
  const avgUnicast = Math.round(((fullEvery - 1) * Math.min(USER_COUNT, 250) + 508) / fullEvery);
  const packetsPerTick = 1 + avgUnicast;
  const perPcPerSec = packetsPerTick / (PING_INTERVAL_MS / 1000);
  const allPcsPerSec = perPcPerSec * USER_COUNT;
  const mbps = (allPcsPerSec * packetBytes * 8) / 1e6;
  const legacyPackets = (1 + SUBNET_HOSTS) / (PING_INTERVAL_MS / 1000) * USER_COUNT;
  return {
    subnetUnicastTargets: SUBNET_HOSTS,
    avgUnicastPerInterval: avgUnicast,
    packetsPerPcPerInterval: packetsPerTick,
    packetsPerSecOnePc: +perPcPerSec.toFixed(1),
    packetsPerSecAllPcs: +allPcsPerSec.toFixed(0),
    approxMbpsAllPcs: +mbps.toFixed(2),
    legacyPacketsPerSecAllPcs: +legacyPackets.toFixed(0),
    reductionVsLegacy: `${Math.max(0, Math.round((1 - allPcsPerSec / legacyPackets) * 100))}%`,
    note: '평소는 다른 대역 기인지 상대만 유니캐스트, 전체 서브넷 프로브는 8회 중 1회.'
  };
}

function judge(boot, steady, udp) {
  const risks = [];
  if (boot.persist.queryMs.p95 > 50 || boot.wallMs > 8000) risks.push('boot-persist');
  if (boot.eventLoopLagMs.p95 > 80) risks.push('boot-event-loop');
  if (boot.tcpSync.jobMs.p95 > 200 || (boot.tcpSync.done > 0 && boot.wallMs > 15000)) risks.push('boot-tcp-queue');
  if (steady.persist.queryMs.p95 > 20 || steady.eventLoopLagMs.p95 > 40) risks.push('steady-persist');
  // 개선 후에도 5만 pkt/s 이상이면 네트워크 주의
  if (udp.packetsPerSecAllPcs > 80000) risks.push('udp-fanout');

  let level = 'LOW';
  if (risks.length >= 3) level = 'HIGH';
  else if (risks.length >= 1) level = 'MEDIUM';

  return { level, risks };
}

function print(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  console.log(`[boot-storm] users=${USER_COUNT} windowMs=${BOOT_WINDOW_MS} steadySec=${STEADY_SEC}`);
  console.log(`[boot-storm] mode=${MODE} tcpConcurrency=${TCP_CONCURRENCY} subnetHosts=${SUBNET_HOSTS}`);
  console.log(`[boot-storm] db=${dbPath}`);

  const db = await openDb();
  await setupSchema(db);
  const users = makeUsers(USER_COUNT);
  await seedOffline(db, users);

  const opts = {
    mode: MODE,
    windowMs: BOOT_WINDOW_MS,
    tcpConcurrency: TCP_CONCURRENCY,
    steadyMs: STEADY_SEC * 1000
  };

  const boot = await runBootStorm(db, users, opts);
  print(`BOOT STORM (${USER_COUNT}대, ${BOOT_WINDOW_MS}ms 창)`, boot);

  const steady = await runSteady(db, users, opts);
  print(`STEADY (${USER_COUNT}대, ~${steady.targetPps} ping/s)`, steady);

  const udp = estimateUdpOutbound();
  print('UDP OUTBOUND ESTIMATE (전원 전부 ON)', udp);

  const verdict = judge(boot, steady, udp);
  console.log(`\n[판정] ${verdict.level}`);
  if (verdict.risks.length) console.log(`[리스크] ${verdict.risks.join(', ')}`);
  console.log('기준:');
  console.log('  LOW    — 부팅 폭주·정상 운전 모두 체감 지연 낮음');
  console.log('  MEDIUM — 특정 구간(DB/TCP/UDP) 부하 있음, 스로틀·스킵 권장');
  console.log('  HIGH   — 동시 기동 시 멈칫/유실 가능성 — 즉시 최적화 필요');
  console.log('※ Electron UI 렌더·실제 소켓 I/O는 모사/추정입니다. DB·이벤트루프·큐잉은 실측입니다.');

  // 머신 판독용 요약 한 줄
  const summary = {
    ok: verdict.level !== 'HIGH',
    level: verdict.level,
    bootWallMs: boot.wallMs,
    bootPersistP95: boot.persist.queryMs.p95,
    steadyPersistP95: steady.persist.queryMs.p95,
    tcpPeak: boot.tcpSync.peakActive,
    udpPacketsPerSecAll: udp.packetsPerSecAllPcs
  };
  console.log(`\n[SUMMARY] ${JSON.stringify(summary)}`);

  await new Promise((resolve) => db.close(resolve));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  // HIGH면 exit 2 (CI/에이전트가 실패로 인지). MEDIUM/LOW는 0.
  if (verdict.level === 'HIGH') process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
