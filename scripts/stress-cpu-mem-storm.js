#!/usr/bin/env node
/**
 * 메모리·CPU 폭주 검사
 *
 * 한 프로세스 안에서 병원 최악 패턴을 동시에 걸고:
 *  - RSS / heap 피크
 *  - 이벤트 루프 지연 (UI·타이머 먹통 지표)
 *  - process.cpuUsage 기반 CPU%
 * 를 연속 샘플링해 "폭주" 여부를 판정한다.
 *
 *   node --expose-gc scripts/stress-cpu-mem-storm.js
 *   node --expose-gc scripts/stress-cpu-mem-storm.js --users=500 --seconds=20 --quick
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { VirtualPeer, MAX_FILE_XFER_BYTES, MAX_PENDING_FILE_XFERS, MAX_PENDING_FILE_XFER_BYTES } = require('./lib/virtual-peer');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const USERS = Math.max(50, parseInt(arg('users', '500'), 10) || 500);
const SECONDS = Math.max(5, parseInt(arg('seconds', hasFlag('quick') ? '12' : '25'), 10) || 25);
const QUICK = hasFlag('quick');
const BASE_PORT = Math.max(20000, parseInt(arg('base-port', '32000'), 10) || 32000);
const HOST = '127.0.0.1';
const SAMPLE_MS = 200;
const CPUS = os.cpus().length || 1;

const samples = [];
const errorLog = [];
let peakRss = 0;
let peakHeap = 0;
let peakLag = 0;
let peakCpuPct = 0;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
function summarize(arr) {
  const s = (arr || []).slice().sort((a, b) => a - b);
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

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
    return true;
  }
  return false;
}

function memMb() {
  const m = process.memoryUsage();
  return {
    rss: m.rss / 1024 / 1024,
    heapUsed: m.heapUsed / 1024 / 1024,
    heapTotal: m.heapTotal / 1024 / 1024,
    external: m.external / 1024 / 1024
  };
}

/** 샘플러: lag + CPU% + 메모리 */
function startSampler() {
  let lastHr = process.hrtime.bigint();
  let lastCpu = process.cpuUsage();
  let lastWall = Date.now();
  const h = setInterval(() => {
    const nowHr = process.hrtime.bigint();
    const lag = Math.max(0, Number(nowHr - lastHr) / 1e6 - SAMPLE_MS);
    lastHr = nowHr;

    const wall = Date.now();
    const wallDelta = Math.max(1, wall - lastWall);
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    lastWall = wall;
    // user+system µs → % of one core, then / CPUS for overall-ish, report both
    const cpuOneCorePct = ((cpu.user + cpu.system) / 1000 / wallDelta) * 100;
    const cpuHostPct = cpuOneCorePct / CPUS;

    const m = memMb();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    if (lag > peakLag) peakLag = lag;
    if (cpuOneCorePct > peakCpuPct) peakCpuPct = cpuOneCorePct;

    samples.push({
      t: wall,
      lagMs: +lag.toFixed(2),
      cpuOneCorePct: +cpuOneCorePct.toFixed(1),
      cpuHostPct: +cpuHostPct.toFixed(1),
      rssMb: +m.rss.toFixed(1),
      heapMb: +m.heapUsed.toFixed(1)
    });
  }, SAMPLE_MS);
  if (h.unref) h.unref();
  return h;
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

/** presence persist skip-unchanged (main.js 유사) — 동시성 상한 24 */
async function runPresenceCpu(db, durationMs) {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const octet = (i % 254) + 1;
    const third = 122 + Math.floor(i / 254);
    users.push({
      ip: `192.168.${third}.${octet}`,
      username: `직원${i}`,
      rank: '',
      dept: '재활',
      floor: '3층',
      status: 'ONLINE',
      photo: ''
    });
  }
  await run(db, `CREATE TABLE IF NOT EXISTS known_users (
    ip TEXT PRIMARY KEY, username TEXT, rank TEXT, dept TEXT, floor TEXT,
    ext_no TEXT, phone_no TEXT, status_state TEXT, photo TEXT, last_seen_at INTEGER
  )`);

  const snap = new Map();
  let writes = 0;
  let skipped = 0;
  const CONC = 24;
  const end = Date.now() + durationMs;
  let tick = 0;

  const persistOne = (u) => new Promise((resolve) => {
    db.run(
      `INSERT INTO known_users (ip, username, rank, dept, floor, ext_no, phone_no, status_state, photo, last_seen_at)
       VALUES (?,?,?,?,?,'','',?, '',?)
       ON CONFLICT(ip) DO UPDATE SET username=excluded.username, status_state=excluded.status_state, last_seen_at=excluded.last_seen_at`,
      [u.ip, u.username, u.rank, u.dept, u.floor, u.status, Date.now()],
      (err) => {
        if (err) errorLog.push({ scenario: 'presence', error: String(err.message || err) });
        else writes += 1;
        resolve();
      }
    );
  });

  while (Date.now() < end) {
    tick += 1;
    const due = [];
    for (const u of users) {
      const changed = tick === 1 || (tick % 8 === 0 && (parseInt(u.ip.split('.').pop(), 10) % 17 === tick % 17));
      if (changed) u.status = tick === 1 ? 'ONLINE' : (u.status === 'ONLINE' ? 'TREATMENT' : 'ONLINE');
      const key = `${u.username}|${u.rank}|${u.dept}|${u.floor}|${u.status}|${u.photo}`;
      if (snap.get(u.ip) === key) {
        skipped += 1;
        continue;
      }
      snap.set(u.ip, key);
      due.push(u);
    }
    for (let i = 0; i < due.length; i += CONC) {
      await Promise.all(due.slice(i, i + CONC).map(persistOne));
    }
    await sleep(40);
  }
  return { writes, skipped, ticks: tick, concurrency: CONC };
}

/** 메시지 + 가상 TCP 폭주 */
async function runTrafficStorm(durationMs) {
  const peerN = Math.min(QUICK ? 24 : 40, 60);
  const peers = [];
  for (let i = 0; i < peerN; i++) {
    const p = new VirtualPeer({
      id: `p${i}`,
      username: `부하${i}`,
      tcpPort: BASE_PORT + i,
      subnet: i % 2 === 0 ? '122' : '123',
      host: HOST,
      octet: (i % 200) + 1
    });
    p.on('error-log', (e) => errorLog.push(e));
    peers.push(p);
  }
  await Promise.all(peers.map((p) => p.start()));

  let sent = 0;
  let ok = 0;
  let fail = 0;
  const end = Date.now() + durationMs;
  const big = '가'.repeat(800);

  while (Date.now() < end) {
    const batch = [];
    for (let k = 0; k < 12; k++) {
      const a = peers[sent % peers.length];
      const b = peers[(sent + Math.floor(peers.length / 2)) % peers.length];
      const uid = `storm_${sent}_${Date.now()}`;
      sent += 1;
      batch.push(
        a.sendChat(HOST, b.tcpPort, `[CPU] ${big} #${sent}`, uid, { timeoutMs: 1500 }).then((r) => {
          if (r.ok && r.ack) ok += 1;
          else fail += 1;
        })
      );
    }
    await Promise.all(batch);
    await sleep(10);
  }

  // 파일: 동시 조립 상한 모델 + 실제 소수 전송
  const fileMb = QUICK ? 2 : 5;
  const size = Math.round(fileMb * 1024 * 1024);
  let fileOk = 0;
  let fileBusy = 0;
  const senders = peers.filter((p) => p.subnet === '122');
  const receivers = peers.filter((p) => p.subnet === '123');
  const concurrent = Math.min(16, senders.length, receivers.length);
  await Promise.all(
    Array.from({ length: concurrent }, async (_, i) => {
      const buf = Buffer.alloc(size, i);
      const r = await senders[i].sendFile(HOST, receivers[i % receivers.length].tcpPort, buf, {
        xferUid: `cpu_xf_${i}_${Date.now()}`,
        fileName: `storm_${i}.bin`
      }, { timeoutMs: 60000 });
      if (r.ok) fileOk += 1;
      else if (r.reason === 'receiver_busy') fileBusy += 1;
    })
  );

  // uncapped 메모리 모델 (참고)
  const uncappedPeakMb = (500 * 10 * 1024 * 1024 * 1.4) / (1024 * 1024);
  const cappedPeakMb = Math.min(
    MAX_PENDING_FILE_XFERS * size,
    MAX_PENDING_FILE_XFER_BYTES
  ) * 1.4 / (1024 * 1024);

  await Promise.all(peers.map((p) => p.stop().catch(() => {})));

  return {
    peers: peerN,
    chatSent: sent,
    chatOk: ok,
    chatFail: fail,
    fileConcurrent: concurrent,
    fileMb,
    fileOk,
    fileBusy,
    model: {
      uncapped500x10mbPeakMb: +uncappedPeakMb.toFixed(0),
      cappedPeakMbApprox: +cappedPeakMb.toFixed(0),
      maxFileMb: MAX_FILE_XFER_BYTES / (1024 * 1024),
      pendingCap: MAX_PENDING_FILE_XFERS
    }
  };
}

/** 사진 base64 폭주 (수신측 RAM) */
async function runPhotoBurst() {
  const n = QUICK ? 120 : 300;
  const photoBytes = 120 * 1024;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-cpu-photo-'));
  let wrote = 0;
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push((async () => {
      const buf = Buffer.alloc(photoBytes, (i % 200) + 20);
      const b64 = buf.toString('base64');
      const decoded = Buffer.from(b64, 'base64');
      await fs.promises.writeFile(path.join(tmp, `p_${i}.jpg`), decoded);
      wrote += 1;
    })());
    if (jobs.length >= 40) {
      await Promise.all(jobs.splice(0, jobs.length));
    }
  }
  await Promise.all(jobs);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  return { photos: n, photoBytes, wrote };
}

function verdict(baseline, traffic, presence) {
  const lags = samples.map((s) => s.lagMs);
  const cpus = samples.map((s) => s.cpuOneCorePct);
  const rss = samples.map((s) => s.rssMb);
  const lagSum = summarize(lags);
  const cpuSum = summarize(cpus);
  const rssSum = summarize(rss);

  const risks = [];
  // 폭주 기준 (병원 PC ~8GB 가정, 메신저 단독 프로세스)
  if (peakRss > 1500) risks.push('rss-over-1.5gb');
  if (peakRss > 2500) risks.push('rss-over-2.5gb-critical');
  if (peakHeap > 1024) risks.push('heap-over-1gb');
  if (lagSum.p95 > 150) risks.push('event-loop-p95-high');
  if (lagSum.max > 500) risks.push('event-loop-stall');
  if (cpuSum.p95 > 180) risks.push('cpu-one-core-p95-high'); // >1.8 cores worth sustained in samples
  if (peakCpuPct > 350) risks.push('cpu-spike-extreme');
  if (traffic.chatFail > traffic.chatSent * 0.15) risks.push('traffic-fail-rate');
  if (presence.writes > USERS * presence.ticks * 0.5) risks.push('presence-write-storm'); // skip 미작동

  let level = 'LOW';
  if (risks.some((r) => r.includes('critical') || r.includes('stall') || r.includes('extreme') || r === 'heap-over-1gb')) {
    level = 'HIGH';
  } else if (risks.length) {
    level = 'MEDIUM';
  }

  const deltaRss = +(peakRss - baseline.rss).toFixed(1);
  return {
    level,
    risks,
    lagMs: lagSum,
    cpuOneCorePct: cpuSum,
    rssMb: rssSum,
    peaks: {
      rssMb: +peakRss.toFixed(1),
      heapMb: +peakHeap.toFixed(1),
      lagMs: +peakLag.toFixed(1),
      cpuOneCorePct: +peakCpuPct.toFixed(1)
    },
    baselineRssMb: +baseline.rss.toFixed(1),
    deltaRssMb: deltaRss
  };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 메모리·CPU 폭주 검사');
  console.log(` users=${USERS} seconds=${SECONDS} cpus=${CPUS} quick=${QUICK}`);
  console.log(` freeMb=${Math.round(os.freemem() / 1024 / 1024)} totalMb=${Math.round(os.totalmem() / 1024 / 1024)}`);
  console.log('══════════════════════════════════════════════');

  forceGc();
  const baseline = memMb();
  const sampler = startSampler();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-cpu-mem-'));
  const db = await openDb(path.join(tmpDir, 'storm.db'));
  await run(db, `PRAGMA journal_mode=WAL`);
  await run(db, `PRAGMA busy_timeout=5000`);

  const half = Math.floor((SECONDS * 1000) / 2);

  console.log('\n▶ 동시: presence + 트래픽/파일 + 사진');
  const [presence, traffic, photos] = await Promise.all([
    runPresenceCpu(db, half),
    runTrafficStorm(half),
    runPhotoBurst()
  ]);

  // 안정화 샘플
  await sleep(QUICK ? 800 : 1500);
  clearInterval(sampler);
  forceGc();
  const afterGc = memMb();

  await new Promise((r) => db.close(r));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const v = verdict(baseline, traffic, presence);
  const report = {
    kind: 'cpu-mem-storm',
    host: { cpus: CPUS, totalMb: Math.round(os.totalmem() / 1024 / 1024), freeMb: Math.round(os.freemem() / 1024 / 1024) },
    config: { users: USERS, seconds: SECONDS, quick: QUICK },
    presence,
    traffic,
    photos,
    afterGcMb: {
      rss: +afterGc.rss.toFixed(1),
      heapUsed: +afterGc.heapUsed.toFixed(1)
    },
    ...v,
    sampleCount: samples.length,
    errorLogCount: errorLog.length
  };

  console.log('\n' + JSON.stringify({
    presence,
    traffic: {
      chatSent: traffic.chatSent,
      chatOk: traffic.chatOk,
      chatFail: traffic.chatFail,
      fileOk: traffic.fileOk,
      fileBusy: traffic.fileBusy,
      model: traffic.model
    },
    photos,
    peaks: v.peaks,
    lagMs: v.lagMs,
    cpuOneCorePct: v.cpuOneCorePct,
    rssMb: v.rssMb,
    deltaRssMb: v.deltaRssMb,
    afterGcMb: report.afterGcMb
  }, null, 2));

  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(' 기준:');
  console.log('  LOW    — RSS 피크 <1.5GB, 이벤트루프 p95 <150ms, 심한 CPU 폭주 없음');
  console.log('  MEDIUM — 순간 지연/CPU 높음 (쓰로틀로 버팀)');
  console.log('  HIGH   — OOM·수초 정지·극단 CPU 가능');
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    peakRssMb: v.peaks.rssMb,
    peakHeapMb: v.peaks.heapMb,
    lagP95: v.lagMs.p95,
    cpuP95: v.cpuOneCorePct.p95,
    peakCpu: v.peaks.cpuOneCorePct
  })}`);

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
