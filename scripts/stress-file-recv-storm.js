#!/usr/bin/env node
/**
 * 500명 동시 사진/파일 수신 부하 추정 + 조립 메모리 모델
 *
 * 시나리오:
 *  A) 사진(CHAT, ~280KB 압축) 500건 동시 수신 → base64 디코드 + 디스크 저장
 *  B) 파일(FILE_XFER) N건 동시 조립 중 메모리 (건당 size 바이트가 RAM에 상주)
 *  C) 동시 조립 상한(cap) 적용 시 거절/지연
 *
 *   node scripts/stress-file-recv-storm.js
 *   node scripts/stress-file-recv-storm.js --photos=500 --files=50 --file-mb=5 --cap=24
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

const PHOTO_COUNT = Math.max(0, parseInt(arg('photos', '500'), 10) || 500);
const FILE_COUNT = Math.max(0, parseInt(arg('files', '50'), 10) || 50);
const FILE_MB = Math.max(0.1, parseFloat(arg('file-mb', '5')) || 5);
const CAP = Math.max(1, parseInt(arg('cap', '24'), 10) || 24);
const PHOTO_BYTES = Math.max(10 * 1024, parseInt(arg('photo-bytes', String(280 * 1024)), 10) || 280 * 1024);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirae-file-recv-'));

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

function startLagProbe(samples) {
  let last = process.hrtime.bigint();
  const h = setInterval(() => {
    const now = process.hrtime.bigint();
    samples.push(Math.max(0, Number(now - last) / 1e6 - 50));
    last = now;
  }, 50);
  if (h.unref) h.unref();
  return h;
}

/** 사진 수신: base64 → Buffer → writeFile (실제 extractAndSaveAttachments와 유사) */
async function runPhotoStorm() {
  const lag = [];
  const probe = startLagProbe(lag);
  const latencies = [];
  const t0 = Date.now();
  let errors = 0;
  let wrote = 0;

  // 동시 폭주: Promise.all
  const jobs = [];
  for (let i = 0; i < PHOTO_COUNT; i++) {
    jobs.push((async () => {
      const t = process.hrtime.bigint();
      try {
        // 압축 JPEG 상당 더미
        const buf = Buffer.alloc(PHOTO_BYTES, (i % 200) + 20);
        const b64 = buf.toString('base64'); // wire 상 존재하던 디코드 비용
        const decoded = Buffer.from(b64, 'base64');
        const name = path.join(tmpDir, `photo_${i}.jpg`);
        await fs.promises.writeFile(name, decoded);
        wrote += 1;
      } catch (e) {
        errors += 1;
      }
      latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
    })());
  }
  await Promise.all(jobs);
  clearInterval(probe);

  const peakRss = process.memoryUsage().rss;
  return {
    kind: 'photo-chat-storm',
    count: PHOTO_COUNT,
    photoBytes: PHOTO_BYTES,
    wallMs: Date.now() - t0,
    wrote,
    errors,
    writeMs: summarize(latencies),
    eventLoopLagMs: summarize(lag),
    rssMbAfter: +(peakRss / 1024 / 1024).toFixed(1)
  };
}

/** FILE_XFER 동시 조립 메모리 모델 (실제 pendingFileXfers) */
function modelFileXferMemory() {
  const size = Math.round(FILE_MB * 1024 * 1024);
  const uncappedBytes = FILE_COUNT * size;
  const cappedActive = Math.min(FILE_COUNT, CAP);
  const rejected = Math.max(0, FILE_COUNT - CAP);
  const cappedBytes = cappedActive * size;
  const freeMb = os.freemem() / 1024 / 1024;
  const totalMb = os.totalmem() / 1024 / 1024;

  // JSON+base64 수신 버퍼 오버헤드 대략 ×1.4 (라인 버퍼·Map)
  const overhead = 1.4;
  const uncappedPeakMb = (uncappedBytes * overhead) / 1024 / 1024;
  const cappedPeakMb = (cappedBytes * overhead) / 1024 / 1024;

  const risks = [];
  if (uncappedPeakMb > freeMb * 0.5) risks.push('uncapped-ram-pressure');
  if (uncappedPeakMb > 1024) risks.push('uncapped-over-1gb');
  if (FILE_COUNT * size > 2 * 1024 * 1024 * 1024) risks.push('uncapped-over-2gb');
  if (cappedPeakMb > freeMb * 0.5) risks.push('capped-still-tight');

  return {
    kind: 'file-xfer-memory-model',
    concurrentStarts: FILE_COUNT,
    fileMbEach: FILE_MB,
    sizeBytesEach: size,
    withoutCap: {
      peakRamMbApprox: +uncappedPeakMb.toFixed(1),
      note: 'pendingFileXfers에 청크 전부 상주'
    },
    withCap: {
      cap: CAP,
      accepted: cappedActive,
      rejectedOrQueued: rejected,
      peakRamMbApprox: +cappedPeakMb.toFixed(1)
    },
    host: {
      totalMb: +totalMb.toFixed(0),
      freeMb: +freeMb.toFixed(0)
    },
    risks
  };
}

/** 디스크 순차 vs 동시 write 비교 (작은 파일 다수) */
async function runDiskWriteCompare() {
  const n = Math.min(200, PHOTO_COUNT || 200);
  const buf = Buffer.alloc(64 * 1024, 7);

  const tParallel0 = Date.now();
  await Promise.all(
    Array.from({ length: n }, (_, i) =>
      fs.promises.writeFile(path.join(tmpDir, `par_${i}.bin`), buf)
    )
  );
  const parallelMs = Date.now() - tParallel0;

  const tSeq0 = Date.now();
  for (let i = 0; i < n; i++) {
    await fs.promises.writeFile(path.join(tmpDir, `seq_${i}.bin`), buf);
  }
  const sequentialMs = Date.now() - tSeq0;

  return {
    kind: 'disk-write-compare',
    count: n,
    bytesEach: buf.length,
    parallelMs,
    sequentialMs
  };
}

function judge(photo, mem, disk) {
  const risks = [...(mem.risks || [])];
  if (photo.errors > 0) risks.push('photo-write-errors');
  if (photo.eventLoopLagMs.p95 > 100) risks.push('photo-event-loop');
  if (photo.writeMs.p95 > 500) risks.push('photo-slow-write');

  let level = 'LOW';
  if (risks.includes('uncapped-over-2gb') || risks.includes('uncapped-over-1gb') || photo.errors > 0) {
    level = 'HIGH';
  } else if (risks.length) {
    level = 'MEDIUM';
  }

  return {
    level,
    risks,
    answerKo: level === 'HIGH'
      ? '오류·메모리 부족 가능성이 큼 — 동시 수신 상한 필요'
      : level === 'MEDIUM'
        ? '작은 사진 다수는 버팀. 큰 파일 다수 동시 수신은 위험 — 상한 권장'
        : '이 환경·설정에서는 큰 오류 없이 처리 가능'
  };
}

async function main() {
  console.log(`[file-recv] photos=${PHOTO_COUNT}×${PHOTO_BYTES}B files=${FILE_COUNT}×${FILE_MB}MB cap=${CAP}`);
  console.log(`[file-recv] tmp=${tmpDir}`);

  const photo = await runPhotoStorm();
  console.log('\n=== PHOTO STORM (CHAT 압축 이미지) ===');
  console.log(JSON.stringify(photo, null, 2));

  const mem = modelFileXferMemory();
  console.log('\n=== FILE_XFER MEMORY MODEL ===');
  console.log(JSON.stringify(mem, null, 2));

  const disk = await runDiskWriteCompare();
  console.log('\n=== DISK WRITE ===');
  console.log(JSON.stringify(disk, null, 2));

  const verdict = judge(photo, mem, disk);
  console.log(`\n[판정] ${verdict.level}`);
  console.log(`[답] ${verdict.answerKo}`);
  if (verdict.risks.length) console.log(`[리스크] ${verdict.risks.join(', ')}`);
  console.log('\n해석:');
  console.log('  · 사진: 장당 ~280KB로 압축되어 CHAT로 옴. 500장이면 디스크·CPU는 버티지만 잠깐 버벅일 수 있음.');
  console.log('  · 파일: 조립 중 전체가 RAM에 올라감. 상한 없으면 50MB×다수 = OOM/멈춤 가능.');
  console.log('  · 송신측 그룹 전송은 상대마다 순차(TCP)라 송신 PC는 느리지만 수신 폭주는 덜함.');

  console.log(`\n[SUMMARY] ${JSON.stringify({
    level: verdict.level,
    photoWallMs: photo.wallMs,
    photoErrors: photo.errors,
    uncappedRamMb: mem.withoutCap.peakRamMbApprox,
    cappedRamMb: mem.withCap.peakRamMbApprox
  })}`);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  if (verdict.level === 'HIGH') process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
