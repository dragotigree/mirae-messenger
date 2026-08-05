#!/usr/bin/env node
/**
 * 시나리오 2 — 파일·이미지 전송 부하
 *
 *  A) 대용량 파일(최대 50MB 앱 상한) 다수 동시 전송 + 상한 초과 거절
 *  B) 122↔123 크로스 대역 FILE_XFER 반복 (다른 층 파일 열기 경로)
 *  C) 짧은 시간 이미지(CHAT data URL) 연속 전송
 *  D) mirae-file:// 미확장 wire → 수신측 열기 실패 재현 vs expand 정상
 *
 *   node scripts/stress-file-cross-subnet.js
 *   node scripts/stress-file-cross-subnet.js --quick
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  VirtualPeer,
  expandMiraeFileUrlsToDataUrls,
  MAX_FILE_XFER_BYTES,
  MAX_PENDING_FILE_XFERS
} = require('./lib/virtual-peer');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const QUICK = hasFlag('quick');
const BASE_PORT = Math.max(20000, parseInt(arg('base-port', '29000'), 10) || 29000);
const HOST = '127.0.0.1';
const CONCURRENT = Math.max(2, parseInt(arg('concurrent', QUICK ? '8' : '16'), 10) || 16);
const FILE_MB = Math.min(50, Math.max(1, parseFloat(arg('file-mb', QUICK ? '5' : '20')) || 20));
const CROSS_ROUNDS = Math.max(1, parseInt(arg('cross-rounds', QUICK ? '4' : '12'), 10) || 12);
const IMAGE_BURST = Math.max(10, parseInt(arg('images', QUICK ? '40' : '120'), 10) || 120);
const PHOTO_BYTES = Math.max(8 * 1024, parseInt(arg('photo-bytes', String(80 * 1024)), 10) || 80 * 1024);

const errorLog = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-file-xsubnet-'));

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
    max: s.length ? +s[s.length - 1].toFixed(2) : 0
  };
}

function makeBuf(mb, seed) {
  const size = Math.round(mb * 1024 * 1024);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) {
    buf[i] = (seed + i) & 0xff;
  }
  buf.writeUInt32BE(seed >>> 0, 0);
  return buf;
}

async function createPairGrid(n) {
  const peers = [];
  for (let i = 0; i < n; i++) {
    const subnet = i % 2 === 0 ? '122' : '123';
    const peer = new VirtualPeer({
      id: `f${i}`,
      username: `파일PC${i}`,
      tcpPort: BASE_PORT + i,
      subnet,
      host: HOST,
      octet: (i % 200) + 1
    });
    peer.on('error-log', (e) => errorLog.push(e));
    peers.push(peer);
  }
  await Promise.all(peers.map((p) => p.start()));
  return peers;
}

/** A) 동시 대용량 + 상한 초과 */
async function scenarioConcurrentLarge(peers) {
  const t0 = Date.now();
  const receivers = peers.filter((p) => p.subnet === '123');
  const senders = peers.filter((p) => p.subnet === '122');
  const n = Math.min(CONCURRENT, senders.length, receivers.length);
  const size = Math.round(FILE_MB * 1024 * 1024);
  const lat = [];
  let ok = 0;
  let fail = 0;
  let abortedBusy = 0;
  const hashes = [];

  const jobs = [];
  for (let i = 0; i < n; i++) {
    const s = senders[i];
    const r = receivers[i % receivers.length];
    const buf = makeBuf(FILE_MB, 1000 + i);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    hashes.push(sha);
    jobs.push((async () => {
      const t = process.hrtime.bigint();
      const res = await s.sendFile(HOST, r.tcpPort, buf, {
        xferUid: `big_${i}_${Date.now()}`,
        fileName: `cross_${FILE_MB}mb_${i}.bin`,
        mime: 'application/octet-stream',
        msgUid: `msg_big_${i}`
      }, { timeoutMs: QUICK ? 60000 : 180000 });
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (res.ok) ok += 1;
      else {
        fail += 1;
        if (res.aborted && res.reason === 'receiver_busy') abortedBusy += 1;
        errorLog.push({ scenario: 'concurrent-large', i, reason: res.reason, aborted: res.aborted });
      }
    })());
  }
  await Promise.all(jobs);

  // 무결성: 수신 파일 sha 매칭
  let integrityOk = 0;
  let integrityFail = 0;
  for (const r of receivers) {
    for (const f of r.filesReceived) {
      if (hashes.includes(f.sha256)) integrityOk += 1;
      else integrityFail += 1;
    }
  }

  // 앱 상한(50MB) 초과 시도
  const over = Buffer.alloc(MAX_FILE_XFER_BYTES + 1024, 7);
  const overRes = await senders[0].sendFile(HOST, receivers[0].tcpPort, over, {
    xferUid: `over_${Date.now()}`,
    fileName: 'too_big.bin'
  });

  return {
    kind: 'concurrent-large-files',
    concurrent: n,
    fileMbEach: FILE_MB,
    sizeBytesEach: size,
    appMaxMb: MAX_FILE_XFER_BYTES / (1024 * 1024),
    pendingCap: MAX_PENDING_FILE_XFERS,
    ok,
    fail,
    abortedBusy,
    overLimitRejectedLocally: overRes.reason === 'over_max_50mb',
    integrityOk,
    integrityFail,
    transferMs: summarize(lat),
    wallMs: Date.now() - t0,
    note: '앱 MAX_FILE_XFER_BYTES=50MB. 수백 MB는 송신 전 거절되어야 함.'
  };
}

/** B) 크로스 대역 반복 FILE_XFER */
async function scenarioCrossSubnetFiles(peers) {
  const t0 = Date.now();
  const a = peers.filter((p) => p.subnet === '122');
  const b = peers.filter((p) => p.subnet === '123');
  const lat = [];
  let ok = 0;
  let fail = 0;
  const mb = QUICK ? 2 : 8;

  for (let round = 0; round < CROSS_ROUNDS; round++) {
    const s = a[round % a.length];
    const r = b[round % b.length];
    const buf = makeBuf(mb, 5000 + round);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const before = r.filesReceived.length;
    const t = process.hrtime.bigint();
    const res = await s.sendFile(HOST, r.tcpPort, buf, {
      xferUid: `xs_${round}_${Date.now()}`,
      fileName: `floor_cross_r${round}.bin`,
      msgUid: `xs_msg_${round}`
    }, { timeoutMs: 90000 });
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (!res.ok) {
      fail += 1;
      errorLog.push({ scenario: 'cross-file', round, from: s.logicalIp, to: r.logicalIp, reason: res.reason });
      continue;
    }
    // 수신 확인
    const got = r.filesReceived.slice(before).find((f) => f.sha256 === sha);
    if (got) ok += 1;
    else {
      fail += 1;
      errorLog.push({ scenario: 'cross-file-missing', round, sha });
    }
  }

  return {
    kind: 'cross-subnet-file-xfer',
    rounds: CROSS_ROUNDS,
    fileMb: mb,
    ok,
    fail,
    transferMs: summarize(lat),
    wallMs: Date.now() - t0
  };
}

/** C) 이미지 CHAT 버스트 */
async function scenarioImageBurst(peers) {
  const t0 = Date.now();
  const senders = peers.filter((p) => p.subnet === '122');
  const receivers = peers.filter((p) => p.subnet === '123');
  const lat = [];
  let ok = 0;
  let fail = 0;
  const jobs = [];

  for (let i = 0; i < IMAGE_BURST; i++) {
    const s = senders[i % senders.length];
    const r = receivers[i % receivers.length];
    const raw = Buffer.alloc(PHOTO_BYTES, (i % 180) + 40);
    const b64 = raw.toString('base64');
    const html = `<img class="chat-img-preview" src="data:image/jpeg;base64,${b64}" alt="shot_${i}.jpg"/>`;
    const uid = `img_${i}_${Date.now()}`;
    jobs.push((async () => {
      const t = process.hrtime.bigint();
      const res = await s.sendChat(HOST, r.tcpPort, html, uid, { timeoutMs: 8000 });
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (res.ok && res.ack) ok += 1;
      else {
        fail += 1;
        if (fail <= 20) errorLog.push({ scenario: 'image-burst', i, reason: res.reason });
      }
    })());
    // 약간의 배치 제한
    if (jobs.length >= 20) {
      await Promise.all(jobs.splice(0, jobs.length));
    }
  }
  await Promise.all(jobs);

  return {
    kind: 'image-chat-burst',
    count: IMAGE_BURST,
    photoBytes: PHOTO_BYTES,
    ok,
    fail,
    rttMs: summarize(lat),
    wallMs: Date.now() - t0
  };
}

/**
 * D) 다른 층 파일·이미지 안 열림 재현
 *  - broken: 송신 DB에만 있는 mirae-file:// 을 expand 없이 wire → 수신측 로컬 파일 없음
 *  - fixed: expandMiraeFileUrlsToDataUrls 후 wire → 수신측 data URL 저장 가능
 */
async function scenarioMiraeFileOpenBug(peers) {
  const t0 = Date.now();
  const sender = peers.find((p) => p.subnet === '122');
  const receiver = peers.find((p) => p.subnet === '123');
  const localName = `local_only_${Date.now()}.jpg`;
  const localPath = path.join(tmpDir, localName);
  const imgBuf = Buffer.alloc(12 * 1024, 90);
  fs.writeFileSync(localPath, imgBuf);

  const brokenHtml = `<img src="mirae-file://${encodeURIComponent(localName)}" alt="x.jpg"/>`;
  // broken: expand 없이 전송 (수신측은 mirae-file 로컬 해석 불가 → "안 열림")
  const uidBroken = `bug_broken_${Date.now()}`;
  await sender.sendChat(HOST, receiver.tcpPort, brokenHtml, uidBroken, { timeoutMs: 4000 });
  const gotBroken = receiver.received.get(uidBroken);
  const brokenStillMirae = !!(gotBroken && /mirae-file:\/\//i.test(gotBroken.message || ''));

  // fixed: expand 후 전송
  const expanded = expandMiraeFileUrlsToDataUrls(brokenHtml, (name) => {
    const p = path.join(tmpDir, path.basename(name));
    if (!fs.existsSync(p)) return null;
    return { buf: fs.readFileSync(p), mime: 'image/jpeg' };
  });
  const uidFixed = `bug_fixed_${Date.now()}`;
  await sender.sendChat(HOST, receiver.tcpPort, expanded, uidFixed, { timeoutMs: 4000 });
  const gotFixed = receiver.received.get(uidFixed);
  const fixedHasData = !!(gotFixed && /data:image\//i.test(gotFixed.message || ''));

  // 수신측 저장 시뮬레이션 (extractAndSaveAttachments compact)
  let savedOk = false;
  if (fixedHasData) {
    const m = String(gotFixed.message).match(/data:image\/[^;]+;base64,([^"]+)/i);
    if (m) {
      const out = path.join(tmpDir, `recv_${uidFixed}.jpg`);
      fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
      savedOk = fs.existsSync(out) && fs.statSync(out).size > 0;
    }
  }

  return {
    kind: 'mirae-file-cross-floor-open',
    brokenWireKeepsMiraeFile: brokenStillMirae,
    expandedWireHasDataUrl: fixedHasData,
    receiverSavedFile: savedOk,
    bugReproduced: brokenStillMirae,
    fixPathWorks: fixedHasData && savedOk,
    wallMs: Date.now() - t0,
    note: '다른 층에서 안 열림: 송신측이 mirae-file:// 을 expand 없이내면 수신 PC에 파일이 없음. messageHtmlForWire=expand 필수.'
  };
}

function verdict(results) {
  const risks = [];
  const A = results.concurrent;
  const B = results.crossFiles;
  const C = results.images;
  const D = results.openBug;
  if (A.integrityFail > 0) risks.push('file-integrity');
  if (A.ok === 0 && A.fail > 0) risks.push('all-large-failed');
  if (!A.overLimitRejectedLocally) risks.push('over-50mb-not-rejected');
  if (B.fail > 0) risks.push('cross-file-fail');
  if (C.fail > Math.ceil(C.count * 0.1)) risks.push('image-burst-fail');
  if (!D.bugReproduced) risks.push('bug-path-not-reproduced'); // informational — still LOW if expand works
  if (!D.fixPathWorks) risks.push('expand-fix-broken');

  let level = 'LOW';
  if (risks.includes('file-integrity') || risks.includes('all-large-failed') || risks.includes('expand-fix-broken') || risks.includes('cross-file-fail')) {
    level = 'HIGH';
  } else if (risks.filter((r) => r !== 'bug-path-not-reproduced').length) {
    level = 'MEDIUM';
  }
  // bug reproduced is expected/good for the test harness
  return { level, risks: risks.filter((r) => r !== 'bug-path-not-reproduced') };
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log(' 시나리오 2: 파일·이미지 전송 부하');
  console.log(` concurrent=${CONCURRENT} fileMb=${FILE_MB} images=${IMAGE_BURST} quick=${QUICK}`);
  console.log('══════════════════════════════════════════════');

  const peerCount = Math.max(CONCURRENT * 2, 8);
  const peers = await createPairGrid(peerCount);
  const results = {};

  console.log('\n▶ A) 동시 대용량 FILE_XFER');
  results.concurrent = await scenarioConcurrentLarge(peers);
  console.log(JSON.stringify(results.concurrent, null, 2));

  // clear received for next
  peers.forEach((p) => { p.filesReceived = []; });

  console.log('\n▶ B) 크로스 대역 파일 반복');
  results.crossFiles = await scenarioCrossSubnetFiles(peers);
  console.log(JSON.stringify(results.crossFiles, null, 2));

  console.log('\n▶ C) 이미지 연속 전송');
  results.images = await scenarioImageBurst(peers);
  console.log(JSON.stringify(results.images, null, 2));

  console.log('\n▶ D) mirae-file 미확장 vs expand (다른 층 열기)');
  results.openBug = await scenarioMiraeFileOpenBug(peers);
  console.log(JSON.stringify(results.openBug, null, 2));

  await Promise.all(peers.map((p) => p.stop().catch(() => {})));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const v = verdict(results);
  console.log('\n──────────────────────────────────────────────');
  console.log(` 판정: ${v.level}${v.risks.length ? ` (${v.risks.join(', ')})` : ''}`);
  console.log(` 오류 로그: ${errorLog.length}건`);
  console.log(`[SUMMARY] ${JSON.stringify({
    level: v.level,
    risks: v.risks,
    errorLogCount: errorLog.length,
    largeOk: results.concurrent.ok,
    crossOk: results.crossFiles.ok,
    imageOk: results.images.ok,
    expandFix: results.openBug.fixPathWorks,
    bugReproduced: results.openBug.bugReproduced
  })}`);

  if (v.level === 'HIGH') process.exitCode = 2;
  else process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  console.log(`[SUMMARY] ${JSON.stringify({ level: 'HIGH', error: String(e.message || e) })}`);
  process.exit(1);
});
